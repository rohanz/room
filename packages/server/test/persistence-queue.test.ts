/** Persistence backpressure: a slow store keeps at most one pending registry snapshot and a bounded
 *  set of pending session operations, answers "busy" past the bound, and never loses a revocation. */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileStore, SessionWrites, SnapshotWriter, StoreBusy, type StoredSession } from '../src/store.js'

function gate() {
  let open!: () => void
  const opened = new Promise<void>(resolve => { open = resolve })
  return { opened, open }
}
const session = (at: number): StoredSession => ({ login: 'ann', provider: 'github', at })

describe('SnapshotWriter', () => {
  it('writes the first snapshot at once and coalesces the rest into one write of the newest', async () => {
    const written: number[] = [], first = gate()
    const w = new SnapshotWriter<number>(async n => { written.push(n); if (n === 1) await first.opened })
    const saves = [1, 2, 3, 4, 5].map(n => w.save(n))
    expect(written).toEqual([1])
    first.open()
    await Promise.all(saves)
    expect(written).toEqual([1, 5])
  })

  it('rejects only the callers of a failed write; the next pending snapshot still lands', async () => {
    const first = gate(), written: number[] = []
    const w = new SnapshotWriter<number>(async n => { await (n === 1 ? first.opened : undefined); if (n === 1) throw new Error('disk'); written.push(n) })
    const a = w.save(1), b = w.save(2)
    first.open()
    await expect(a).rejects.toThrow('disk')
    await b
    expect(written).toEqual([2])
  })

  it('a stalled write holds one acknowledgement per pending snapshot, however many callers wait on it', async () => {
    const first = gate(), written: number[] = []
    const w = new SnapshotWriter<number>(async n => { written.push(n); if (n === 0) await first.opened })
    const inFlight = w.save(0)
    const saves = Array.from({ length: 100_000 }, (_, i) => w.save(i + 1))
    // Every caller behind the stalled write shares the pending generation's acknowledgement.
    expect(new Set(saves).size).toBe(1)
    expect(saves[0]).not.toBe(inFlight)
    first.open()
    await Promise.all([inFlight, ...saves])
    expect(written).toEqual([0, 100_000])
  })
})

describe('SessionWrites', () => {
  it('batches operations pending behind a write; the last operation per session wins, deletes included', async () => {
    const batches: [string, StoredSession | null][][] = [], first = gate()
    const w = new SessionWrites(async ops => { batches.push([...ops]); if (batches.length === 1) await first.opened }, 100)
    const p = [w.put('a', session(1)), w.put('b', session(1))]
    for (let at = 2; at < 50; at++) p.push(w.put('a', session(at)))
    p.push(w.put('b', session(2)), w.delete('b'), w.delete('c'))
    first.open()
    await Promise.all(p)
    expect(batches).toEqual([[['a', session(1)]], [['b', null], ['a', session(49)], ['c', null]]])
  })

  it('answers busy for a new session past the pending bound, but still accepts updates to pending ones', async () => {
    const first = gate(), batches: number[] = []
    const w = new SessionWrites(async ops => { batches.push(ops.size); if (batches.length === 1) await first.opened }, 3)
    const inFlight = w.put('x', session(0))
    const pending = ['a', 'b', 'c'].map(id => w.put(id, session(1)))
    await expect(w.put('d', session(1))).rejects.toBeInstanceOf(StoreBusy)
    await expect(w.delete('e')).rejects.toThrow(/busy/)
    pending.push(w.delete('a'))
    first.open()
    await Promise.all([inFlight, ...pending])
    expect(batches).toEqual([1, 3])
    await w.put('d', session(2))
  })

  it('a failed batch rejects its callers and leaves later operations to run', async () => {
    let fail = true
    const w = new SessionWrites(async () => { if (fail) { fail = false; throw new Error('db down') } }, 10)
    await expect(w.delete('a')).rejects.toThrow('db down')
    await w.delete('a')
  })

  it('repeated operations on one session behind a stalled flush share one acknowledgement and keep the revocation', async () => {
    const first = gate(), batches: [string, StoredSession | null][][] = []
    const w = new SessionWrites(async ops => { batches.push([...ops]); if (batches.length === 1) await first.opened }, 3)
    const inFlight = w.put('x', session(0))
    const owed: Promise<void>[] = []
    for (let i = 0; i < 50_000; i++) owed.push(w.put('tok', session(i)), w.delete('tok'))
    owed.push(w.put('other', session(1)))
    expect(new Set(owed).size).toBe(1)
    first.open()
    await Promise.all([inFlight, ...owed])
    expect(batches).toEqual([[['x', session(0)]], [['tok', null], ['other', session(1)]]])
  })
})

describe('stores use them', () => {
  it('FileStore applies a batch as one read-modify-write and keeps every revocation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-store-batch-'))
    try {
      const s = new FileStore({ dir }); await s.init()
      const renames: string[] = []
      const rename = fs.renameSync
      fs.renameSync = ((a: fs.PathLike, b: fs.PathLike) => { renames.push(String(b)); rename(a, b) }) as typeof fs.renameSync
      try {
        await s.putSession('gone', session(1))
        renames.length = 0
        await Promise.all([s.putSession('a', session(1)), s.putSession('a', session(2)), s.deleteSession('gone'), s.putSession('b', session(3))])
      } finally { fs.renameSync = rename }
      expect(await s.loadSessions()).toEqual({ a: session(2), b: session(3) })
      expect(renames.filter(f => f.endsWith('sessions.json')).length).toBeLessThanOrEqual(2)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
