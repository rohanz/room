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
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { createLogDecoder, logDecoderKey, logHosts } from './hosts/index.js'
import type { HostId, HostLogDecoder, LogContext, NormalizedHostFailure, NormalizedLogFact } from './hosts/types.js'

/** Host-neutral evidence, partitioned by adapter so identical session ids never cross hosts. */
interface RunLogEvidence {
  acceptedSessions: Set<string>
  missingSessions: Set<string>
  preferredText: string
  fallbackText: string
}
export type RunLogFacts = ReadonlyMap<HostId, RunLogEvidence>

interface Entry {
  file: string; start: number
  dev: number; ino: number; size: number; mtimeMs: number
  /** Bytes consumed so far, and the partial line after them. */
  offset: number; pending: string
  /** The first and last consumed bytes (up to VERIFY each), compared before an incremental read. */
  head: Buffer; tail: Buffer
  decoders: Map<HostId, HostLogDecoder>
  facts: RunLogFacts
}

const CHUNK = 64 * 1024
const PENDING_CAP = 1024 * 1024
/** Distinct sessions or threads one run can name; more is not a real worker log. */
const ID_CAP = 64
const CACHE_ENTRIES = 256
const VERIFY = 4096
const cache = new Map<string, Entry>()
export type RunLogIdentity = Pick<LogContext, 'workerId' | 'run' | 'dir'>
export const runLogIdentity = (record: { id?: string; dir: string }, run: { n?: number; logStart: number }): RunLogIdentity =>
  ({ workerId: record.id ?? record.dir, run: run.n ?? 0, dir: record.dir })
/** Compatibility calls have no durable record: file/start remain their identity, with run zero unknown. */
const contextOf = (file: string, start: number, scope: LogContext['scope'], identity?: RunLogIdentity): LogContext =>
  ({ workerId: file, run: 0, dir: path.dirname(file), ...identity, logStart: start, scope })
/** The old two-argument scans still warm both independent adapters for synchronous status accessors. */
const keyOf = (file: string, start: number, identity?: RunLogIdentity) =>
  JSON.stringify([file, start, ...logHosts.map(host => logDecoderKey(host, contextOf(file, start, 'whole-run', identity)))])

function emptyFacts(): RunLogFacts {
  return new Map(logHosts.map(host => [host, { acceptedSessions: new Set<string>(), missingSessions: new Set<string>(), preferredText: '', fallbackText: '' }]))
}

/** Shared framing only; event fields and activity prefilters belong to the selected decoder. */
export function decodeLogLine(decoder: HostLogDecoder, line: string): readonly NormalizedLogFact[] {
  if (!decoder.acceptsLine(line)) return []
  try { return decoder.push(JSON.parse(line)) } catch { return [] }
}

const remember = (set: Set<string>, id: string) => { if (set.size < ID_CAP) set.add(id) }
function apply(facts: RunLogEvidence, decoded: readonly NormalizedLogFact[]): void {
  for (const fact of decoded) {
    if (fact.kind === 'resume-accepted') remember(facts.acceptedSessions, fact.id)
    else if (fact.kind === 'session-missing') remember(facts.missingSessions, fact.id)
    else if (fact.kind === 'final') {
      if (fact.slot === 'preferred') facts.preferredText = fact.text
      else facts.fallbackText = fact.text
    }
  }
}

function consume(entry: Entry, text: string): void {
  let pending = entry.pending + text, end: number
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end).trim()
    pending = pending.slice(end + 1)
    if (!line.startsWith('{')) continue
    let raw: unknown
    try { raw = JSON.parse(line) } catch { continue }
    for (const [host, decoder] of entry.decoders) {
      try { apply(entry.facts.get(host)!, decoder.push(raw)) } catch { /* malformed host event */ }
    }
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
function current(file: string, start: number, stat: fs.Stats, fd: number, identity?: RunLogIdentity): Entry {
  const key = keyOf(file, start, identity)
  const cached = cache.get(key)
  const sameFile = cached && cached.dev === stat.dev && cached.ino === stat.ino
  const unchanged = sameFile && stat.size === cached.size && stat.mtimeMs === cached.mtimeMs
  const appendedOnly = sameFile && stat.size > cached.size && prefixIntact(cached, fd)
  if (cached && (unchanged || appendedOnly)) {
    cache.delete(key); cache.set(key, cached) // least recently used goes first
    return cached
  }
  const entry: Entry = { file, start, dev: stat.dev, ino: stat.ino, size: 0, mtimeMs: 0, offset: Math.min(start, stat.size), pending: '', head: Buffer.alloc(0), tail: Buffer.alloc(0), facts: emptyFacts(),
    decoders: new Map(logHosts.map(host => [host, createLogDecoder(host, contextOf(file, start, 'whole-run', identity))])) }
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
export async function scanRunLog(file: string, start: number, identity?: RunLogIdentity): Promise<RunLogFacts> {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const stat = fs.fstatSync(fd)
    const entry = current(file, start, stat, fd, identity)
    const chunk = Buffer.alloc(CHUNK)
    while (step(entry, fd, stat, chunk)) await new Promise<void>(resolve => setImmediate(resolve))
    return entry.facts
  } catch { return emptyFacts() } // an unavailable log provides no evidence
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

/** The same facts for synchronous callers: a cache hit reads nothing, an append reads only the new bytes. */
export function runLogFacts(file: string, start: number, identity?: RunLogIdentity): RunLogFacts {
  let stat: fs.Stats
  try { stat = fs.statSync(file) } catch { return emptyFacts() }
  const key = keyOf(file, start, identity), cached = cache.get(key)
  if (cached && cached.dev === stat.dev && cached.ino === stat.ino && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.offset >= stat.size) {
    cache.delete(key); cache.set(key, cached)
    return cached.facts
  }
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const opened = fs.fstatSync(fd)
    const entry = current(file, start, opened, fd, identity)
    const chunk = Buffer.alloc(CHUNK)
    while (step(entry, fd, opened, chunk)) { /* read the rest */ }
    return entry.facts
  } catch { return emptyFacts() }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

export function clearRunLogFactsForTests(): void { cache.clear() }

/** The run's last 64 KB at most, ANSI-free, even for multi-GB logs; throws when the log is unreadable. */
export function runLogSuffix(logFile: string, logStart: number): string[] {
  const fd = fs.openSync(logFile, 'r')
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(Math.min(size, logStart), size - 64 * 1024, 0)
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    return stripVTControlCharacters(buffer.toString('utf8')).split(/\r?\n|\r/)
  } finally { fs.closeSync(fd) }
}

/** Read complete JSON lines from one run, starting at its byte offset in the shared log. */
function* completeLogLines(file: string, start = 0): Generator<string> {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    let offset = Math.max(0, Math.min(start, size)), pending = ''
    const chunk = Buffer.alloc(64 * 1024)
    while (offset < size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset)
      if (!count) break
      offset += count
      pending += chunk.toString('utf8', 0, count)
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim()
        pending = pending.slice(end + 1)
        if (!line.startsWith('{')) continue
        yield line
      }
      if (pending.length > 1024 * 1024) pending = ''
    }
  } catch { /* unavailable logs provide no acceptance evidence */ }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

/** New decoder state for each diagnostic suffix: whole-run facts never fill missing suffix history. */
function diagnosticDecoders(file: string, start: number, hosts: readonly HostId[], identity?: RunLogIdentity): HostLogDecoder[] {
  return hosts.map(host => createLogDecoder(host, contextOf(file, start, 'diagnostic-suffix', identity)))
}

export function readLogTail(file: string, start: number, identity?: RunLogIdentity): string {
  try {
    const decoders = diagnosticDecoders(file, start, logHosts, identity)
    return runLogSuffix(file, start).flatMap(raw => {
      const line = raw.trim()
      if (!line.startsWith('{')) return []
      return decoders.flatMap(decoder => decodeLogLine(decoder, line))
        .flatMap(fact => fact.kind === 'final' ? [fact.text] : [])
    }).map(text => stripVTControlCharacters(text)).filter(Boolean).slice(-5).join('\n').slice(-600)
  } catch { return '' }
}

export function readLogFailure(file: string, host: HostId, start: number, identity?: RunLogIdentity): NormalizedHostFailure | undefined {
  try {
    const [decoder] = diagnosticDecoders(file, start, [host], identity)
    let failure: NormalizedHostFailure | undefined
    for (const raw of runLogSuffix(file, start)) {
      const line = raw.trim()
      if (!line.startsWith('{')) continue
      for (const fact of decodeLogLine(decoder, line)) if (fact.kind === 'failure') failure = fact.failure
    }
    return failure
  } catch { return undefined }
}

export function readBackgroundTasks(file: string, start: number, host: HostId, identity?: RunLogIdentity): { kind: 'observed'; count: number } | { kind: 'unknown' } {
  const [decoder] = diagnosticDecoders(file, start, [host], identity)
  if (decoder.backgroundTasks === 'unknown') return { kind: 'unknown' }
  let size: number
  try { size = fs.statSync(file).size } catch { return { kind: 'observed', count: 0 } }
  const shells = new Map<string, boolean>(), backgrounded = new Set<string>(), open = new Set<string>()
  let atResult: Set<string> | undefined
  for (const line of completeLogLines(file, Math.max(start, size - 16 * 1024 * 1024))) {
    for (const fact of decodeLogLine(decoder, line)) {
      if (fact.kind !== 'background') continue
      if (fact.state === 'result-boundary') atResult = new Set(open)
      else if (fact.state === 'backgrounded') backgrounded.add(fact.id)
      else if (fact.state === 'closed') open.delete(fact.id)
      else if (fact.state === 'open') { shells.set(fact.id, fact.shell); open.add(fact.id) }
    }
  }
  const killed = new Set([...atResult ?? [], ...open])
  return { kind: 'observed', count: [...killed].filter(id => backgrounded.has(id) && shells.get(id) === true).length }
}
