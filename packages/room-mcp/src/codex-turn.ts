/** Read-only Codex turn probe. A queued wake starts a later turn, so only queue after the current one ends. */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TAIL_BYTES = 64 * 1024
const MAX_READ_BYTES = 1024 * 1024
const CONTACT_MS = 10_000
const TURN_EVENTS = new Set(['task_started', 'task_complete', 'turn_aborted'])
type TurnCursor = { file: string; offset: number; lastEvent?: string; device?: number; inode?: number }

export interface CodexTurnProbeOptions {
  home?: () => string
  /** Milliseconds since this bound host last called a Room tool or hook. */
  contactAgeMs?: () => number | undefined
}

export class CodexTurnProbe {
  private readonly cursors = new Map<string, TurnCursor>()
  constructor(private readonly options: CodexTurnProbeOptions = {}) {}

  async busy(threadId: string): Promise<boolean> {
    const file = await this.find(threadId)
    if (file) {
      try {
        const event = await this.lastTurnEvent(threadId, file)
        if (event) return event === 'task_started'
      } catch { this.cursors.delete(threadId) }
    }
    const age = this.options.contactAgeMs?.()
    return age !== undefined && age >= 0 && age < CONTACT_MS
  }

  private async find(threadId: string): Promise<string | undefined> {
    const cached = this.cursors.get(threadId)
    if (cached) return cached.file
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(threadId)) return undefined
    const root = path.join(this.options.home?.() ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions')
    try {
      const years = (await fs.readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort().reverse()
      for (const year of years) {
        if (!/^\d{4}$/.test(year)) continue
        const yearDir = path.join(root, year)
        const months = (await fs.readdir(yearDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort().reverse()
        for (const month of months) {
          if (!/^\d{2}$/.test(month)) continue
          const monthDir = path.join(yearDir, month)
          const days = (await fs.readdir(monthDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort().reverse()
          for (const day of days) {
            if (!/^\d{2}$/.test(day)) continue
            const dayDir = path.join(monthDir, day)
            const name = (await fs.readdir(dayDir)).find(n => n.startsWith('rollout-') && n.endsWith(`-${threadId}.jsonl`))
            if (name) { const file = path.join(dayDir, name); this.cursors.set(threadId, { file, offset: 0 }); return file }
          }
        }
      }
    } catch { /* no rollout yet, or inaccessible; recent host contact is the fallback */ }
    return undefined
  }

  private async lastTurnEvent(threadId: string, file: string): Promise<string | undefined> {
    const handle = await fs.open(file, 'r')
    try {
      const { size, dev, ino } = await handle.stat()
      let cursor = this.cursors.get(threadId)!
      if (size < cursor.offset || (cursor.device !== undefined && (cursor.device !== dev || cursor.inode !== ino))) {
        cursor = { file, offset: 0 }
        this.cursors.set(threadId, cursor)
      }
      cursor.device = dev; cursor.inode = ino
      const skipped = size - cursor.offset > MAX_READ_BYTES
      // Include one byte before the tail: a newline there proves its first full line is safe to parse.
      const start = skipped ? Math.max(cursor.offset, size - TAIL_BYTES - 1) : cursor.offset
      if (start === size) return cursor.lastEvent
      const buffer = Buffer.alloc(size - start)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      if (!bytesRead) return cursor.lastEvent
      const lastNewline = buffer.lastIndexOf(10, bytesRead - 1)
      if (lastNewline < 0) return cursor.lastEvent // keep the partial line for next time
      const first = start > cursor.offset ? buffer.indexOf(10) + 1 : 0 // a skip may land inside a line
      const body = buffer.toString('utf8', first, lastNewline + 1)
      for (const line of body.split('\n')) {
        if (!line.includes('task_started') && !line.includes('task_complete') && !line.includes('turn_aborted')) continue
        const record = JSON.parse(line) as { type?: unknown; payload?: { type?: unknown } }
        if (record.type === 'event_msg' && typeof record.payload?.type === 'string' && TURN_EVENTS.has(record.payload.type)) cursor.lastEvent = record.payload.type
      }
      cursor.offset = start + lastNewline + 1
      return cursor.lastEvent
    } finally { await handle.close() }
  }
}
