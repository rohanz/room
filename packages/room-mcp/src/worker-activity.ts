/**
 * A worker's latest tool or file activity, read from its host's stream log (Claude stream-json, Codex
 * exec --json). The host writes that log directly, so it grows while the worker runs. The tracker reads
 * only bytes appended since its last poll. Labels never carry message text, tool output or command arguments.
 */
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { WorkerHost } from './worker-config.js'
import { createLogDecoder, logDecoderKey } from './hosts/index.js'
import type { HostLogDecoder, LogContext } from './hosts/types.js'
import { decodeLogLine } from './run-log-facts.js'

export interface WorkerActivity { label: string; at: number }

function eventActivity(line: string, decoder: HostLogDecoder): { label: string; at?: number } | undefined {
  const activity = decodeLogLine(decoder, line).find(fact => fact.kind === 'activity')
  return activity?.kind === 'activity' ? { label: activity.text, at: activity.eventTimeMs } : undefined
}

interface Entry { hostDecoder: HostLogDecoder; offset: number; pending: string; decoder: StringDecoder; skipPartial: boolean; polledAt?: number; latest?: WorkerActivity }

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
  poll(logFile: string, host: WorkerHost, dir: string, now = Date.now(), since?: number, identity?: Pick<LogContext, 'workerId' | 'run'>): WorkerActivity | undefined {
    let fd: number | undefined
    const context: LogContext = { workerId: logFile, run: 0, ...identity, logStart: 0, dir, scope: 'activity-window' }
    const key = JSON.stringify([logFile, since, logDecoderKey(host, context)])
    let entry = this.entries.get(key)
    try {
      fd = fs.openSync(logFile, 'r')
      const stat = fs.fstatSync(fd)
      if (!entry || stat.size < entry.offset) {
        // A rewritten log's lines all came after the previous poll, so its time still bounds them.
        entry = { hostDecoder: createLogDecoder(host, context), offset: 0, pending: '', decoder: new StringDecoder('utf8'), skipPartial: false, polledAt: entry?.polledAt }
        this.remember(key, entry)
      }
      if (stat.size - entry.offset > this.maxRead) {
        entry.offset = stat.size - this.maxRead
        entry.pending = ''
        entry.decoder = new StringDecoder('utf8')
        entry.hostDecoder = createLogDecoder(host, context)
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
          const activity = eventActivity(line, entry.hostDecoder)
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
export function liveWorkerActivity(sessionDir: string, worker: { id?: string; run?: number; tag: string; host: WorkerHost; dir: string; status: string; startedAt?: number }, processGone: boolean, now = Date.now()): WorkerActivity | undefined {
  if (worker.status !== 'running' || processGone) return undefined
  return workerActivity.poll(path.join(sessionDir, '.room', 'workers', `${worker.tag}.log`), worker.host, worker.dir, now, worker.startedAt, { workerId: worker.id ?? worker.tag, run: worker.run ?? 0 })
}
