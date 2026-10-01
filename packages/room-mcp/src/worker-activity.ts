/**
 * A worker's latest tool or file activity, read from its host's stream log (Claude stream-json, Codex
 * exec --json). The host writes that log directly, so it grows while the worker runs. The tracker reads
 * only bytes appended since its last poll. Labels never carry message text, tool output or command arguments.
 */
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { WorkerHost } from './worker-config.js'

export const ACTIVITY_MAX = 80
export interface WorkerActivity { label: string; at: number }

const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined

/** "verb subject", shortened from the front of the subject so the end of a path stays visible. */
function bounded(verb: string, subject = '', max = ACTIVITY_MAX): string {
  const label = clean(subject ? `${verb} ${subject}` : verb)
  if (label.length <= max || !subject) return label.slice(0, max)
  return `${verb} …${clean(subject).slice(-(max - verb.length - 2))}`
}

/** Worktree-relative when inside it; otherwise only the last two segments. */
function shownPath(file: string, dir: string): string {
  if (!path.isAbsolute(file)) return file
  const rel = path.relative(dir, file)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel
  return `…/${file.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}`
}

/** Subcommands that are fixed words of their program. Any other second word may be data and is never shown. */
const SUBCOMMANDS = new Map<string, readonly string[]>([
  ['git', ['status', 'diff', 'commit', 'log', 'show', 'add', 'push', 'pull', 'fetch', 'checkout', 'switch', 'branch', 'merge', 'rebase', 'stash', 'reset', 'restore', 'rm', 'mv', 'worktree', 'clone', 'grep', 'blame', 'cherry-pick', 'rev-parse', 'tag', 'remote']],
  ['npm', ['test', 'run', 'install', 'ci', 'exec']],
  ['pnpm', ['test', 'run', 'install', 'exec']],
  ['yarn', ['test', 'run', 'install']],
  ['npx', ['vitest', 'tsc', 'tsx', 'eslint', 'prettier', 'playwright']],
  ['uv', ['run', 'sync', 'add', 'lock', 'pip']],
  ['cargo', ['build', 'test', 'run', 'check', 'clippy', 'fmt']],
  ['go', ['build', 'test', 'run', 'vet', 'mod']],
])

/** Probes that say nothing about the work: the previous activity stays shown instead. */
const TRIVIAL = new Set(['env', 'printenv', 'pwd', 'which', 'echo', 'true', 'sleep', 'ls'])

/** The words after `env`'s own `-u NAME` and unquoted `NAME=value` operands; an empty list when it runs nothing. */
function afterEnv(words: string[]): string[] {
  let i = 1
  while (i < words.length) {
    if (words[i] === '-u' && /^[A-Za-z_]\w*$/.test(words[i + 1] ?? '')) i += 2
    else if (/^[A-Za-z_]\w*=[^\s'"`\\$();|&<>]*$/.test(words[i])) i++
    else break
  }
  return words.slice(i)
}

/**
 * "running <program>" from the first word of the command, and only when that word is a plain path: an env
 * assignment, quote or shell syntax there could put data in its place, so the label becomes "running a command".
 * Leading `cd <plain path> &&` steps are skipped; a quoted cd argument is not, so nothing inside quotes is read.
 * `env [-u NAME]… [NAME=value]…` is skipped to the program it runs; its names and values are never shown.
 * A trivial probe (bare `env`, `pwd`, `ls`, …) has no label, so the last meaningful one stays.
 */
function commandLabel(command: string): string | undefined {
  const wrapped = command.trim().match(/^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/)
  const script = (wrapped ? wrapped[2] : command).trim().replace(/^(?:(?:cd|pushd)\s+[\w.+/~-]+\s*&&\s*)+/, '')
  let words = script.split(/\s+/)
  if (/^(?:[\w.+/~-]*\/)?env$/.test(words[0])) {
    words = afterEnv(words)
    if (!words.length) return undefined
  }
  const [first = '', second = ''] = words
  const program = path.posix.basename(first)
  if (!/^[\w.+/~-]+$/.test(first) || first.startsWith('-') || !/^[\w.+-]{1,40}$/.test(program)) return 'running a command'
  if (TRIVIAL.has(program)) return undefined
  return bounded('running', SUBCOMMANDS.get(program)?.includes(second) ? `${program} ${second}` : program)
}

function toolLabel(name: string): string {
  const tool = name.startsWith('mcp__') ? name.split('__').at(-1) ?? name : name
  const safe = tool.replace(/[^\w.:-]/g, '').slice(0, 60)
  return safe.startsWith('room_') ? safe : `using ${safe || 'a tool'}`
}

function claudeTool(name: string, input: Record<string, unknown>, dir: string): string | undefined {
  const file = str(input.file_path) ?? str(input.notebook_path)
  switch (name) {
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return file ? bounded('editing', shownPath(file, dir)) : undefined
    case 'Read': return file ? bounded('reading', shownPath(file, dir)) : undefined
    case 'Bash': { const command = str(input.command); return command ? commandLabel(command) : undefined }
    case 'Glob': case 'Grep': return 'searching'
    case 'WebFetch': case 'WebSearch': return 'searching the web'
    case 'Task': case 'Agent': return 'running a subagent'
    default: return toolLabel(name)
  }
}

function codexItem(item: Record<string, unknown>, dir: string): string | undefined {
  switch (item.type) {
    case 'file_change': {
      if (!Array.isArray(item.changes)) return undefined
      const paths = item.changes.map(c => str((c as { path?: unknown } | null)?.path)).filter((p): p is string => !!p)
      if (!paths.length) return undefined
      const more = paths.length > 1 ? ` (+${paths.length - 1} more)` : ''
      return bounded('editing', shownPath(paths[0], dir), ACTIVITY_MAX - more.length) + more
    }
    case 'command_execution': { const command = str(item.command); return command ? commandLabel(command) : undefined }
    case 'mcp_tool_call': { const tool = str(item.tool); return tool ? toolLabel(tool) : undefined }
    case 'web_search': return 'searching the web'
    default: return undefined
  }
}

/** The activity one stream line records, if any; malformed lines and text-only events yield undefined. */
export function activityFromEvent(line: string, host: WorkerHost, dir: string): string | undefined {
  return eventActivity(line, host, dir)?.label
}

/** An event's own time, when the host writes one (ISO string or epoch milliseconds). */
function eventTime(value: unknown): number | undefined {
  const at = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(at) && at > 0 ? at : undefined
}

function eventActivity(line: string, host: WorkerHost, dir: string): { label: string; at?: number } | undefined {
  // Cheap prefilters keep large tool-result and message lines out of JSON.parse.
  if (host === 'claude' ? !line.includes('"tool_use"') : !line.includes('"item.')) return undefined
  let event: unknown
  try { event = JSON.parse(line) } catch { return undefined }
  if (!event || typeof event !== 'object') return undefined
  const label = labelOf(event as { type?: unknown; message?: { content?: unknown }; item?: unknown }, host, dir)
  return label ? { label, at: eventTime((event as { timestamp?: unknown }).timestamp) } : undefined
}

function labelOf(e: { type?: unknown; message?: { content?: unknown }; item?: unknown }, host: WorkerHost, dir: string): string | undefined {
  if (host === 'claude') {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) return undefined
    let label: string | undefined
    for (const part of e.message.content as { type?: unknown; name?: unknown; input?: unknown }[]) {
      if (part?.type !== 'tool_use' || typeof part.name !== 'string') continue
      const input = part.input && typeof part.input === 'object' ? part.input as Record<string, unknown> : {}
      label = claudeTool(part.name, input, dir) ?? label
    }
    return label
  }
  if (typeof e.type !== 'string' || !e.type.startsWith('item.') || !e.item || typeof e.item !== 'object') return undefined
  return codexItem(e.item as Record<string, unknown>, dir)
}

interface Entry { offset: number; pending: string; decoder: StringDecoder; skipPartial: boolean; polledAt?: number; latest?: WorkerActivity }

/** Per-log incremental reader. One instance serves a lead process; state is memory only. */
export class WorkerActivityTracker {
  private readonly entries = new Map<string, Entry>()
  private readonly maxRead: number
  private readonly maxEntries: number
  constructor(options: { maxRead?: number; maxEntries?: number } = {}) {
    this.maxRead = options.maxRead ?? 512 * 1024
    this.maxEntries = options.maxEntries ?? 64
  }

  /**
   * Read what the log gained since the last poll. An activity is dated by its event's timestamp when it has
   * one; otherwise by the log's last write only when it is the last line read, and by the previous poll (or,
   * on a first poll, the run start `since` or the log's creation) when later lines were written after it.
   */
  poll(logFile: string, host: WorkerHost, dir: string, now = Date.now(), since?: number): WorkerActivity | undefined {
    let fd: number | undefined
    let entry = this.entries.get(logFile)
    try {
      fd = fs.openSync(logFile, 'r')
      const stat = fs.fstatSync(fd)
      if (!entry || stat.size < entry.offset) {
        // A rewritten log's lines all came after the previous poll, so its time still bounds them.
        entry = { offset: 0, pending: '', decoder: new StringDecoder('utf8'), skipPartial: false, polledAt: entry?.polledAt }
        this.remember(logFile, entry)
      }
      if (stat.size - entry.offset > this.maxRead) {
        entry.offset = stat.size - this.maxRead
        entry.pending = ''
        entry.decoder = new StringDecoder('utf8')
        entry.skipPartial = true
      }
      const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, stat.size - entry.offset)))
      let found: { label: string; at?: number } | undefined
      let foundLast = false
      while (entry.offset < stat.size) {
        const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - entry.offset), entry.offset)
        if (!count) break
        entry.offset += count
        entry.pending += entry.decoder.write(chunk.subarray(0, count))
        let end: number
        while ((end = entry.pending.indexOf('\n')) >= 0) {
          const line = entry.pending.slice(0, end)
          entry.pending = entry.pending.slice(end + 1)
          if (entry.skipPartial) { entry.skipPartial = false; foundLast = false; continue }
          const activity = eventActivity(line, host, dir)
          if (activity) found = activity
          foundLast = !!activity
        }
        // A line longer than one read window is tool output, never activity: drop it through its newline.
        if (entry.pending.length > this.maxRead) { entry.pending = ''; entry.skipPartial = true; foundLast = false }
      }
      if (found) {
        const written = Math.min(now, stat.mtimeMs)
        const before = entry.polledAt ?? (Math.max(since ?? 0, stat.birthtimeMs || 0) || written)
        entry.latest = { label: found.label, at: Math.min(found.at ?? (foundLast ? written : before), written) }
      }
      entry.polledAt = now
      return entry.latest
    } catch { return entry?.latest }
    finally { if (fd !== undefined) fs.closeSync(fd) }
  }

  private remember(logFile: string, entry: Entry): void {
    this.entries.delete(logFile)
    this.entries.set(logFile, entry)
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!)
  }
}

const workerActivity = new WorkerActivityTracker()

/** room_state's activity for one of the lead's workers: only while its process is live. */
export function liveWorkerActivity(sessionDir: string, worker: { tag: string; host: WorkerHost; dir: string; status: string; startedAt?: number }, processGone: boolean, now = Date.now()): WorkerActivity | undefined {
  if (worker.status !== 'running' || processGone) return undefined
  return workerActivity.poll(path.join(sessionDir, '.room', 'workers', `${worker.tag}.log`), worker.host, worker.dir, now, worker.startedAt)
}
