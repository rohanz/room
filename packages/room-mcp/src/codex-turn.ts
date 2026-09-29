/** Read-only Codex turn probe. A queued wake starts a later turn, so only queue after the current one ends. */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TAIL_BYTES = 64 * 1024
const MAX_READ_BYTES = 1024 * 1024
const MAX_SCAN_BYTES = 8 * 1024 * 1024
const CONTACT_MS = 10_000
const TURN_EVENTS = new Set(['task_started', 'task_complete', 'turn_aborted'])
type BackwardScan = { size: number; position: number; carry: Buffer; skipPartial: boolean; completeEnd?: number }
type TurnCursor = { file: string; offset: number; lastEvent?: string; device?: number; inode?: number; scan?: BackwardScan }

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
        if (event === null) return true // no turn event found within this call's scan budget
        if (event) return event === 'task_started'
      } catch { this.cursors.delete(threadId); return true }
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

  private async lastTurnEvent(threadId: string, file: string): Promise<string | undefined | null> {
    const handle = await fs.open(file, 'r')
    try {
      const { size, dev, ino } = await handle.stat()
      let cursor = this.cursors.get(threadId)!
      if (size < cursor.offset || (cursor.device !== undefined && (cursor.device !== dev || cursor.inode !== ino))) {
        cursor = { file, offset: 0 }
        this.cursors.set(threadId, cursor)
      }
      cursor.device = dev; cursor.inode = ino
      if (cursor.scan && cursor.scan.size !== size) cursor.scan = undefined
      if (cursor.scan || size - cursor.offset > MAX_READ_BYTES) {
        // A gap makes lastEvent unknown. Keep scanning the same snapshot on later polls.
        const scan = cursor.scan ?? { size, position: size, carry: Buffer.alloc(0), skipPartial: true }
        cursor.scan = scan
        cursor.lastEvent = undefined
        let scanned = 0
        while (scan.position > 0 && scanned < MAX_SCAN_BYTES) {
          const length = Math.min(TAIL_BYTES, scan.position, MAX_SCAN_BYTES - scanned)
          const start = scan.position - length
          const chunk = Buffer.alloc(length)
          const { bytesRead } = await handle.read(chunk, 0, length, start)
          if (bytesRead !== length) { cursor.scan = undefined; return null } // retry a fresh snapshot
          scan.position = start
          scanned += length
          let data = Buffer.concat([chunk, scan.carry])
          if (scan.skipPartial) {
            const lastNewline = data.lastIndexOf(10)
            if (lastNewline < 0) { await new Promise<void>(resolve => setImmediate(resolve)); continue }
            scan.completeEnd = start + lastNewline + 1
            data = data.subarray(0, lastNewline + 1)
            scan.skipPartial = false
          }
          let end = data.length
          while (end > 0) {
            const previousNewline = end > 1 ? data.lastIndexOf(10, end - 2) : -1
            if (previousNewline < 0) break
            const event = this.parseEvent(data.subarray(previousNewline + 1, end - 1))
            if (event) {
              cursor.offset = scan.completeEnd!
              cursor.lastEvent = event
              cursor.scan = undefined
              return event
            }
            end = previousNewline + 1
          }
          scan.carry = Buffer.from(data.subarray(0, end))
          await new Promise<void>(resolve => setImmediate(resolve))
        }
        if (scan.position > 0) return null
        const event = this.parseEvent(scan.carry.subarray(0, Math.max(0, scan.carry.length - 1)))
        cursor.offset = scan.completeEnd ?? 0
        cursor.lastEvent = event
        cursor.scan = undefined
        return event
      }
      if (cursor.offset === size) return cursor.lastEvent
      const buffer = Buffer.alloc(size - cursor.offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset)
      if (bytesRead !== buffer.length) return null
      const lastNewline = buffer.lastIndexOf(10)
      if (lastNewline < 0) return cursor.lastEvent // retain the partial line for the next poll
      const body = buffer.toString('utf8', 0, lastNewline + 1)
      for (const line of body.split('\n')) {
        const event = this.parseEvent(line)
        if (event) cursor.lastEvent = event
      }
      cursor.offset += lastNewline + 1
      return cursor.lastEvent
    } finally { await handle.close() }
  }

  private parseEvent(line: string | Buffer): string | undefined {
    const text = typeof line === 'string' ? line : line.toString('utf8')
    if (!text.includes('task_started') && !text.includes('task_complete') && !text.includes('turn_aborted')) return undefined
    try {
      const record = JSON.parse(text) as { type?: unknown; payload?: { type?: unknown } }
      if (record.type === 'event_msg' && typeof record.payload?.type === 'string' && TURN_EVENTS.has(record.payload.type)) return record.payload.type
    } catch { /* malformed or partial JSONL record */ }
    return undefined
  }
}
