/**
 * A worker's latest tool or file activity, read from its host's stream log (Claude stream-json, Codex
 * exec --json). The host writes that log directly, so it grows while the worker runs. The tracker reads
 * only bytes appended since its last poll. Labels never carry message text, tool output or whole commands.
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

/** Programs whose second word is a subcommand rather than an argument that might carry data. */
const SUBCOMMANDS = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'uv', 'uvx', 'cargo', 'go', 'docker', 'make', 'gh', 'pip', 'codex', 'claude', 'deno', 'tsx', 'vitest'])

/** Program and, for known tools, subcommand of the first non-cd step; never the arguments. */
function commandLabel(command: string): string {
  const wrapped = command.trim().match(/^\S*?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/)
  const script = wrapped ? wrapped[2] : command
  const step = script.split(/&&|\|\||[;|\n]/).map(s => s.trim()).find(s => s && !/^(cd|pushd)(\s|$)/.test(s)) ?? ''
  const words = step.split(/\s+/).filter(Boolean)
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0] === 'env')) words.shift()
  const program = words[0] ? path.basename(words[0]) : ''
  if (!/^[\w.+-]{1,40}$/.test(program)) return 'running a command'
  const sub = SUBCOMMANDS.has(program) && /^[A-Za-z][\w:-]{0,30}$/.test(words[1] ?? '') ? ` ${words[1]}` : ''
  return bounded('running', program + sub)
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
  // Cheap prefilters keep large tool-result and message lines out of JSON.parse.
  if (host === 'claude' ? !line.includes('"tool_use"') : !line.includes('"item.')) return undefined
  let event: unknown
  try { event = JSON.parse(line) } catch { return undefined }
  if (!event || typeof event !== 'object') return undefined
  const e = event as { type?: unknown; message?: { content?: unknown }; item?: unknown }
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

interface Entry { offset: number; pending: string; decoder: StringDecoder; skipPartial: boolean; latest?: WorkerActivity }

/** Per-log incremental reader. One instance serves a lead process; state is memory only. */
export class WorkerActivityTracker {
  private readonly entries = new Map<string, Entry>()
  private readonly maxRead: number
  private readonly maxEntries: number
  constructor(options: { maxRead?: number; maxEntries?: number } = {}) {
    this.maxRead = options.maxRead ?? 512 * 1024
    this.maxEntries = options.maxEntries ?? 64
  }

  /** Read what the log gained since the last poll; the activity is dated by the log's last write. */
  poll(logFile: string, host: WorkerHost, dir: string, now = Date.now()): WorkerActivity | undefined {
    let fd: number | undefined
    let entry = this.entries.get(logFile)
    try {
      fd = fs.openSync(logFile, 'r')
      const stat = fs.fstatSync(fd)
      if (!entry || stat.size < entry.offset) {
        entry = { offset: 0, pending: '', decoder: new StringDecoder('utf8'), skipPartial: false }
        this.remember(logFile, entry)
      }
      if (stat.size - entry.offset > this.maxRead) {
        entry.offset = stat.size - this.maxRead
        entry.pending = ''
        entry.decoder = new StringDecoder('utf8')
        entry.skipPartial = true
      }
      const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, stat.size - entry.offset)))
      let found: string | undefined
      while (entry.offset < stat.size) {
        const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - entry.offset), entry.offset)
        if (!count) break
        entry.offset += count
        entry.pending += entry.decoder.write(chunk.subarray(0, count))
        let end: number
        while ((end = entry.pending.indexOf('\n')) >= 0) {
          const line = entry.pending.slice(0, end)
          entry.pending = entry.pending.slice(end + 1)
          if (entry.skipPartial) { entry.skipPartial = false; continue }
          found = activityFromEvent(line, host, dir) ?? found
        }
        // A line longer than one read window is tool output, never activity: drop it through its newline.
        if (entry.pending.length > this.maxRead) { entry.pending = ''; entry.skipPartial = true }
      }
      if (found) entry.latest = { label: found, at: Math.min(now, stat.mtimeMs) }
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
export function liveWorkerActivity(sessionDir: string, worker: { tag: string; host: WorkerHost; dir: string; status: string }, processGone: boolean, now = Date.now()): WorkerActivity | undefined {
  if (worker.status !== 'running' || processGone) return undefined
  return workerActivity.poll(path.join(sessionDir, '.room', 'workers', `${worker.tag}.log`), worker.host, worker.dir, now)
}
