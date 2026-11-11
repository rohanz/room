/** The audit file grows for the server's lifetime: a listing reads only the requested tail within a
 *  byte and time budget, rotation splits it into segments, and retention that deletes old segments is
 *  reported, so neither a truncated scan nor a pruned history is ever presented as complete. */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileStore, type AuditEntry } from '../src/store.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'room-audit-')); dirs.push(d); return d }
const entry = (at: number): AuditEntry => ({ at, event: 'join', login: 'ann', room: 'local/r' })
function writeLog(file: string, ats: number[]) { fs.writeFileSync(file, ats.map(at => JSON.stringify(entry(at)) + '\n').join('')) }
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

describe('audit tail', () => {
  it('returns the newest entries, oldest first, without scanning the rest of a large log', async () => {
    const dir = tmp(); writeLog(path.join(dir, 'audit.log'), range(1, 20_000))
    const s = new FileStore({ dir })
    const line = JSON.stringify(entry(19_999)).length + 1
    const tail = await s.readAudit({ limit: 5, maxScanBytes: 100 * line })
    expect(tail).toEqual({ entries: range(19_996, 20_000).map(entry), complete: true, gaps: [] })
  })

  it('reports a scan cut short by its byte budget as incomplete, keeping what it read', async () => {
    const dir = tmp(); writeLog(path.join(dir, 'audit.log'), range(10_000, 19_999))
    const s = new FileStore({ dir })
    const line = JSON.stringify(entry(10_000)).length + 1
    // One byte more than 50 lines: the newline before the 50th line proves that line is whole.
    const tail = await s.readAudit({ limit: 1000, maxScanBytes: 50 * line + 1 })
    expect(tail.complete).toBe(false)
    expect(tail.gaps).toEqual(['scan-bytes'])
    expect(tail.entries.map(e => e.at)).toEqual(range(19_950, 19_999))
  })

  it('stops at the first entry older than since: older history does not need scanning', async () => {
    const dir = tmp(); writeLog(path.join(dir, 'audit.log'), range(1, 20_000))
    const s = new FileStore({ dir })
    const line = JSON.stringify(entry(19_000)).length + 1
    const tail = await s.readAudit({ since: 19_990, limit: 1000, maxScanBytes: 20 * line })
    expect(tail).toEqual({ entries: range(19_990, 20_000).map(entry), complete: true, gaps: [] })
  })

  it('reports a deadline that passes during the scan, keeping the newest entries read so far', async () => {
    const dir = tmp(); writeLog(path.join(dir, 'audit.log'), range(1, 20_000))
    let t = 0 // each clock reading is one millisecond later
    const tail = await new FileStore({ dir, now: () => t++ }).readAudit({ limit: 10_000, deadlineMs: 1 })
    expect(tail.complete).toBe(false)
    expect(tail.gaps).toEqual(['deadline'])
    expect(tail.entries.length).toBeGreaterThan(0)
    expect(tail.entries.length).toBeLessThan(10_000)
    expect(tail.entries.at(-1)!.at).toBe(20_000)
  })

  it('reports a deadline that passed before the first read with no entries', async () => {
    const dir = tmp(); writeLog(path.join(dir, 'audit.log'), range(1, 100))
    let t = 0
    const tail = await new FileStore({ dir, now: () => (t += 10) }).readAudit({ deadlineMs: 1 })
    expect(tail).toEqual({ entries: [], complete: false, gaps: ['deadline'] })
  })

  it('skips unreadable and overlong lines, saying so, without buffering an overlong line whole', async () => {
    const dir = tmp(), file = path.join(dir, 'audit.log')
    writeLog(file, [1, 2])
    fs.appendFileSync(file, 'not json\n' + 'x'.repeat(3 * 1048576) + '\n7\n')
    fs.appendFileSync(file, JSON.stringify(entry(3)) + '\n')
    const tail = await new FileStore({ dir }).readAudit({})
    expect(tail.entries.map(e => e.at)).toEqual([1, 2, 3])
    expect(tail).toMatchObject({ complete: false, gaps: ['unreadable'] })
  })

  it('an absent log is complete and empty', async () => {
    expect(await new FileStore({ dir: tmp() }).readAudit({})).toEqual({ entries: [], complete: true, gaps: [] })
  })

  it('the in-memory audit is incomplete once it has dropped entries the request covers', async () => {
    const s = new FileStore()
    for (let at = 1; at <= 5010; at++) await s.audit(entry(at))
    expect((await s.readAudit({ since: 0, limit: 10_000 })).gaps).toEqual(['pruned'])
    expect((await s.readAudit({ since: 0, limit: 3 })).complete).toBe(true)
    expect(await s.readAudit({ since: 5008 })).toEqual({ entries: [5008, 5009, 5010].map(entry), complete: true, gaps: [] })
  })
})

describe('audit rotation and retention', () => {
  it('rotates into segments that bounded listings cover in order', async () => {
    const dir = tmp()
    const s = new FileStore({ dir, auditRotateBytes: 600 })
    for (const at of range(1, 100)) await s.audit(entry(at))
    const segments = fs.readdirSync(dir).filter(f => /^audit\.log\.\d+$/.test(f))
    expect(segments.length).toBeGreaterThan(5)
    for (const f of segments) expect(fs.statSync(path.join(dir, f)).size).toBeLessThanOrEqual(600)
    expect(await s.readAudit({ limit: 1000 })).toEqual({ entries: range(1, 100).map(entry), complete: true, gaps: [] })
    expect(await s.readAudit({ limit: 3 })).toMatchObject({ entries: range(98, 100).map(entry), complete: true })
    // a restarted server continues the segment sequence instead of overwriting one
    const again = new FileStore({ dir, auditRotateBytes: 600 })
    for (const at of range(101, 130)) await again.audit(entry(at))
    expect((await again.readAudit({ limit: 1000 })).entries.map(e => e.at)).toEqual(range(1, 130))
  })

  it('retention deletes the oldest segments and every read that could have needed them says so', async () => {
    const dir = tmp()
    const s = new FileStore({ dir, auditRotateBytes: 600, auditKeepFiles: 2 })
    for (const at of range(1, 40)) await s.audit(entry(at))
    // Later entries carry times after any pruned segment was last written.
    const later = Date.now() + 60_000
    for (const i of range(0, 39)) await s.audit(entry(later + i))
    expect(fs.readdirSync(dir).filter(f => /^audit\.log\.\d+$/.test(f))).toHaveLength(2)
    expect(fs.existsSync(path.join(dir, 'audit.log.pruned'))).toBe(true)
    const all = await s.readAudit({ limit: 1000 })
    expect(all).toMatchObject({ complete: false, gaps: ['pruned'] })
    expect(all.entries.at(-1)!.at).toBe(later + 39)
    expect(all.entries.some(e => e.at <= 40)).toBe(false)
    // a request starting after the pruned history is unaffected
    expect(await s.readAudit({ since: later + 35 })).toEqual({ entries: range(35, 39).map(i => entry(later + i)), complete: true, gaps: [] })
    // migration evidence needs the whole audit: once anything was pruned it is never complete
    // a restart keeps that knowledge
    expect((await new FileStore({ dir }).readAudit({ limit: 1000 })).gaps).toEqual(['pruned'])
  })
})

describe('audit reads racing rotation', () => {
  const line = JSON.stringify(entry(1)).length + 1
  /** Runs `act` once each time a read opens `name` (audit.log or a segment), before the open happens. */
  async function whenOpening<T>(name: string, act: () => Promise<void> | void, read: () => Promise<T>): Promise<T> {
    const open = fs.promises.open
    fs.promises.open = (async (p: fs.PathLike, ...rest: unknown[]) => {
      if (path.basename(String(p)) === name) await act()
      return (open as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(p, ...rest)
    }) as typeof fs.promises.open
    try { return await read() } finally { fs.promises.open = open }
  }
  /** One entry per file, one segment kept: events 1 and 2 leave audit.log.1 = [1] and audit.log = [2]. */
  async function twoEvents() {
    const dir = tmp(), s = new FileStore({ dir, auditRotateBytes: line, auditKeepFiles: 1 })
    await s.audit(entry(1)); await s.audit(entry(2))
    return { dir, s }
  }

  it('retention during a read that deletes history the read began with is reported, not hidden', async () => {
    const { s } = await twoEvents()
    let rotated = false
    const tail = await whenOpening('audit.log', async () => { if (!rotated) { rotated = true; await s.audit(entry(3)) } }, () => s.readAudit({ limit: 1000 }))
    expect(rotated).toBe(true)
    expect(tail.complete).toBe(false)
    expect(tail.gaps).toContain('pruned')
    expect(tail.entries.map(e => e.at)).not.toContain(1)
    for (let i = 1; i < tail.entries.length; i++) expect(tail.entries[i]!.at).toBeGreaterThan(tail.entries[i - 1]!.at)
  })

  it('a listed segment that vanishes before it is opened makes the read incomplete', async () => {
    const dir = tmp(), s = new FileStore({ dir, auditRotateBytes: line })
    await s.audit(entry(1)); await s.audit(entry(2))
    const gone = () => fs.rmSync(path.join(dir, 'audit.log.1'), { force: true })
    const tail = await whenOpening('audit.log.1', gone, () => s.readAudit({ limit: 1000 }))
    expect(tail).toEqual({ entries: [entry(2)], complete: false, gaps: ['pruned'] })
    // event 3 rotates audit.log back into a fresh audit.log.1
    await s.audit(entry(3))
    expect(fs.existsSync(path.join(dir, 'audit.log.1'))).toBe(true)
  })

  it('an audit that keeps rotating under the read is reported as rotated, with no entries', async () => {
    const dir = tmp(), s = new FileStore({ dir, auditRotateBytes: line })
    await s.audit(entry(1)); await s.audit(entry(2))
    let at = 2
    const tail = await whenOpening('audit.log', () => s.audit(entry(++at)), () => s.readAudit({ limit: 1000 }))
    expect(tail).toEqual({ entries: [], complete: false, gaps: ['rotated'] })
  })
})
