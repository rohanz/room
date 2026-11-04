/**
 * What a worker run's host log proves, derived in one pass over the run's bytes (from its start offset in
 * the worker's shared log) and cached per run. A status projection on an unchanged log reads nothing; an
 * appended log is read from where the last pass stopped; a replaced log (other inode, shorter, or rewritten)
 * is read again from the run's start. Same inode and a larger size do not prove an append: before reusing
 * facts for a grown log, the first and last `VERIFY` bytes of the consumed region are reread and compared
 * with what was consumed, and any difference starts over. A rewrite that leaves both of those windows
 * byte-identical is not detected; the host only appends to these logs, so that check is a guard against
 * truncate-and-regrow, not a proof of identity. Every pass covers the whole run: acceptance evidence can sit anywhere in
 * it, so tailing is not enough. `scanRunLog` reads in bounded chunks and yields to the event loop between
 * them; the synchronous accessors read whatever the cache lacks without yielding.
 */
import fs from 'node:fs'

export interface HostEvent {
  type?: string; subtype?: string; session_id?: string; thread_id?: string
  result?: unknown; message?: { content?: unknown } | string; item?: { type?: string; text?: unknown }
  /** Codex: `{ message }` on turn.failed (null on tool items). Claude: an assistant message's API error category. */
  error?: { message?: unknown } | string | null; is_error?: boolean
  is_api_error_message?: boolean; api_error_status?: unknown; errors?: unknown
  num_turns?: number
  task_id?: unknown; task_type?: unknown; is_backgrounded?: unknown; patch?: { status?: unknown }
  tool_use_result?: { backgroundTaskId?: unknown }
}

/** Host-independent facts; the accessors in worker-process.ts select by host and session. */
export interface RunLogFacts {
  /** Claude sessions with model activity (an assistant event) in this run. */
  assistantSessions: Set<string>
  /** Claude sessions whose resume failed before any turn (result error_during_execution, zero turns). */
  missingSessions: Set<string>
  /** Codex threads that started a turn in this run. */
  codexTurns: Set<string>
  claudeAssistant: string
  claudeResult: string
  codexAnswer: string
}

interface Entry {
  file: string; start: number
  dev: number; ino: number; size: number; mtimeMs: number
  /** Bytes consumed so far, and the partial line after them. */
  offset: number; pending: string
  /** The first and last consumed bytes (up to VERIFY each), compared before an incremental read. */
  head: Buffer; tail: Buffer
  codexThread?: string
  facts: RunLogFacts
}

const CHUNK = 64 * 1024
const PENDING_CAP = 1024 * 1024
/** Distinct sessions or threads one run can name; more is not a real worker log. */
const ID_CAP = 64
const CACHE_ENTRIES = 256
const VERIFY = 4096
const cache = new Map<string, Entry>()
const keyOf = (file: string, start: number) => `${start}\0${file}`

function emptyFacts(): RunLogFacts {
  return { assistantSessions: new Set(), missingSessions: new Set(), codexTurns: new Set(), claudeAssistant: '', claudeResult: '', codexAnswer: '' }
}

export function assistantText(event: HostEvent): string {
  const content = typeof event.message === 'object' ? event.message?.content : undefined
  if (!Array.isArray(content)) return ''
  return content.filter((part): part is { type: string; text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n').trim()
}

const remember = (set: Set<string>, id: unknown) => { if (typeof id === 'string' && set.size < ID_CAP) set.add(id) }

function apply(entry: Entry, event: HostEvent): void {
  const facts = entry.facts
  if (event.type === 'assistant') {
    remember(facts.assistantSessions, event.session_id)
    facts.claudeAssistant = assistantText(event) || facts.claudeAssistant
  }
  if (event.type === 'result') {
    if (typeof event.result === 'string') facts.claudeResult = event.result.trim()
    if (event.subtype === 'error_during_execution' && event.is_error === true && event.num_turns === 0) remember(facts.missingSessions, event.session_id)
  }
  if (event.type === 'thread.started') entry.codexThread = event.thread_id
  if (event.type === 'turn.started') remember(facts.codexTurns, event.thread_id ?? entry.codexThread)
  if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') facts.codexAnswer = event.item.text.trim()
}

function consume(entry: Entry, text: string): void {
  let pending = entry.pending + text, end: number
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end).trim()
    pending = pending.slice(end + 1)
    if (!line.startsWith('{')) continue
    try { apply(entry, JSON.parse(line) as HostEvent) } catch { /* stderr or a partial line */ }
  }
  entry.pending = pending.length > PENDING_CAP ? '' : pending
}

function remembers(fd: number, at: number, expected: Buffer): boolean {
  if (!expected.length) return true
  const actual = Buffer.alloc(expected.length)
  return fs.readSync(fd, actual, 0, expected.length, at) === expected.length && actual.equals(expected)
}

/** Whether the bytes this entry consumed are still at their offsets in `fd`. */
function prefixIntact(entry: Entry, fd: number): boolean {
  const from = Math.min(entry.start, entry.offset)
  return remembers(fd, from, entry.head) && remembers(fd, entry.offset - entry.tail.length, entry.tail)
}

/** The cached entry when its log is the same file and has not shrunk or been rewritten; else a fresh one. */
function current(file: string, start: number, stat: fs.Stats, fd: number): Entry {
  const key = keyOf(file, start)
  const cached = cache.get(key)
  const sameFile = cached && cached.dev === stat.dev && cached.ino === stat.ino
  const unchanged = sameFile && stat.size === cached.size && stat.mtimeMs === cached.mtimeMs
  const appendedOnly = sameFile && stat.size > cached.size && prefixIntact(cached, fd)
  if (cached && (unchanged || appendedOnly)) {
    cache.delete(key); cache.set(key, cached) // least recently used goes first
    return cached
  }
  const entry: Entry = { file, start, dev: stat.dev, ino: stat.ino, size: 0, mtimeMs: 0, offset: Math.min(start, stat.size), pending: '', head: Buffer.alloc(0), tail: Buffer.alloc(0), facts: emptyFacts() }
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string)
  return entry
}

/** Reads one chunk of what the cache lacks; false once the entry has caught up with `stat`. */
function step(entry: Entry, fd: number, stat: fs.Stats, chunk: Buffer): boolean {
  const count = entry.offset < stat.size ? fs.readSync(fd, chunk, 0, Math.min(CHUNK, stat.size - entry.offset), entry.offset) : 0
  if (count) {
    entry.offset += count
    const read = chunk.subarray(0, count)
    if (entry.head.length < VERIFY) entry.head = Buffer.concat([entry.head, read.subarray(0, VERIFY - entry.head.length)])
    entry.tail = Buffer.from(count >= VERIFY ? read.subarray(count - VERIFY) : Buffer.concat([entry.tail, read]).subarray(-VERIFY))
    consume(entry, read.toString('utf8'))
    return true
  }
  entry.size = stat.size
  entry.mtimeMs = stat.mtimeMs
  return false
}

/** Brings the run's cached facts up to date without blocking the event loop for more than one chunk. */
export async function scanRunLog(file: string, start: number): Promise<RunLogFacts> {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const stat = fs.fstatSync(fd)
    const entry = current(file, start, stat, fd)
    const chunk = Buffer.alloc(CHUNK)
    while (step(entry, fd, stat, chunk)) await new Promise<void>(resolve => setImmediate(resolve))
    return entry.facts
  } catch { return emptyFacts() } // an unavailable log provides no evidence
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

/** The same facts for synchronous callers: a cache hit reads nothing, an append reads only the new bytes. */
export function runLogFacts(file: string, start: number): RunLogFacts {
  let stat: fs.Stats
  try { stat = fs.statSync(file) } catch { return emptyFacts() }
  const key = keyOf(file, start), cached = cache.get(key)
  if (cached && cached.dev === stat.dev && cached.ino === stat.ino && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.offset >= stat.size) {
    cache.delete(key); cache.set(key, cached)
    return cached.facts
  }
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const opened = fs.fstatSync(fd)
    const entry = current(file, start, opened, fd)
    const chunk = Buffer.alloc(CHUNK)
    while (step(entry, fd, opened, chunk)) { /* read the rest */ }
    return entry.facts
  } catch { return emptyFacts() }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

export function clearRunLogFactsForTests(): void { cache.clear() }
