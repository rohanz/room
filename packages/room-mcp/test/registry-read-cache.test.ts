import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { RoomDoc, gitBlobHash, manifestKey } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { ConflictSet } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'
import { carriedFrom, localWorkerBaseline, registrySnapshotForDir } from '../src/worker-registry.js'
import type { WorkerRecord } from '../src/worker-status.js'
import { seedRegistryWorker } from './registry-fixture.js'

const PEERS = 8, RETIRED = 100

function repo(): { dir: string; base: string; run: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'room-registry-cache-'))
  const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  run('init', '-q'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't')
  writeFileSync(join(dir, 'x'), 'old\n')
  run('add', '.'); run('commit', '-qm', 'init')
  return { dir, base: run('rev-parse', 'HEAD'), run }
}

/** `PEERS` live workers of `lead` and `RETIRED` retired incarnations in this clone's registry. */
async function populate(dir: string): Promise<{ root: string; peers: string[] }> {
  const peers: string[] = []
  let template: WorkerRecord | undefined
  for (let n = 1; n <= PEERS; n++) {
    const { record } = await seedRegistryWorker(dir, `w${n}`, { base: undefined })
    peers.push(record.name)
    template ??= record
  }
  const registry = registrySnapshotForDir(dir)
  const root = registry.root
  for (let n = 0; n < RETIRED; n++) {
    const id = registry.newId()
    // Same names as the live peers: a retired incarnation must never stand in for the current one.
    const tag = `w${(n % PEERS) + 1}`
    const record: WorkerRecord = { ...template!, id, tag, name: `lead+${tag}`, phase: 'retired', cleanup: { worktree: 'done' } }
    writeFileSync(path.join(root, 'workers', `${id}.json`), JSON.stringify(record))
  }
  return { root, peers }
}

/** Count synchronous whole-file reads under the registry root. */
function countRegistryReads(root: string) {
  const spy = vi.spyOn(fs, 'readFileSync')
  const count = () => spy.mock.calls.filter(([file]) => typeof file === 'string' && file.startsWith(root)).length
  return { count, reset: () => spy.mockClear(), restore: () => spy.mockRestore() }
}

describe('registry reads during a conflict check', () => {
  it(`stays O(peers) for ${PEERS} peers and ${RETIRED} retired records`, async () => {
    const { dir, base } = repo()
    const room = new RoomDoc()
    room.ensureRoomSalt()
    const states = new Map<number, unknown>()
    let next = 1
    const { root, peers } = await populate(dir)
    const names = ['lead', ...peers]
    for (const name of names) {
      epochPublication(room, name, base, 1)
      room.participants.set(`${name}\0id`, { name, kind: 'agent' })
      states.set(next++, { user: { name, kind: 'agent' }, sessionId: `session-${name}` })
      room.manifestHead.set(name, { base, fence: '1', coverage: { kind: 'all' }, level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true })
      const values = new Y.Map<{ change: 'A'; state: 'shared'; hash: string; at: number; fence: string }>()
      values.set(name, { change: 'A', state: 'shared', hash: gitBlobHash(name), at: 1, fence: '1' })
      room.manifest.set(manifestKey(name, '1'), values)
      room.setOverlay(manifestKey(name, '1'), name, name)
    }
    const post = vi.fn().mockImplementation((_from, body, opts) => Promise.resolve({ ok: true, msg: { ...body, ...opts } }))
    const session = { room, awareness: { getStates: () => states } as unknown as Awareness,
      provider: { synced: true, on() {}, off() {} }, me: { name: 'lead', kind: 'agent' }, dir, post,
      lease: { fence: () => '1' } } as unknown as Session
    const calls = new Map<string, number>()
    const set = new ConflictSet(session, 'lead', session, () => {}, 0, person => {
      calls.set(person, (calls.get(person) ?? 0) + 1)
      return carriedFrom(dir, person)
    }, async () => undefined)
    // Files written within the last two seconds are always reread; this pass runs after that window.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 5000)
    const reads = countRegistryReads(root)
    try {
      // Warm: the first lookup of each record reads it once.
      await set.reconcile('warm')
      const cold = reads.count()
      expect(cold).toBeLessThanOrEqual(2 * names.length)
      reads.reset(); calls.clear()
      await set.reconcile('check')
      const warm = reads.count()
      console.log(JSON.stringify({ peers: PEERS, retired: RETIRED, coldReads: cold, warmReads: warm, carriedFromCalls: Object.fromEntries(calls) }))
      // Unchanged files are not read again; nothing scales with retired records.
      expect(warm).toBe(0)
      // One carriedFrom lookup per participant per pass, guards included.
      for (const name of names) expect(calls.get(name) ?? 0).toBeLessThanOrEqual(1)
      // The inputs key reuses one lookup per participant as well.
      calls.clear()
      ;(set as unknown as { inputsKey(): string }).inputsKey()
      for (const name of names) expect(calls.get(name) ?? 0).toBeLessThanOrEqual(1)
    } finally { vi.useRealTimers(); reads.restore(); set.stop(); room.doc.destroy(); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('worker registry read cache', () => {
  it('resolves a participant to its reserved incarnation, never a retired one with the same name', async () => {
    const { dir } = repo()
    try {
      const { root } = await populate(dir)
      const reads = countRegistryReads(root)
      try {
        const live = localWorkerBaseline(dir, 'lead+w3')
        expect(live?.name).toBe('lead+w3')
        expect(registrySnapshotForDir(dir).reserved('w3')?.phase).toBe('active')
        // A reservation and a record per lookup (just written, so reread): never a scan of the retired records.
        expect(reads.count()).toBeLessThanOrEqual(4)
      } finally { reads.restore() }
      expect(localWorkerBaseline(dir, 'lead')).toBeUndefined()
      expect(localWorkerBaseline(dir, 'other+w3')).toBeUndefined()
      expect(localWorkerBaseline(dir, 'lead+missing')).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('sees another writer\'s replacement, in-place rewrite, addition and removal on the next call', async () => {
    const { dir } = repo()
    try {
      const { record } = await seedRegistryWorker(dir, 'solo')
      const registry = registrySnapshotForDir(dir)
      const file = path.join(registry.root, 'workers', `${record.id}.json`)
      expect(registry.read(record.id)?.task).toBe('test')
      expect(registry.list()).toHaveLength(1)
      // Atomic replacement (a new inode), as writeAtomic does.
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify({ ...record, task: 'tast' }))
      fs.renameSync(tmp, file)
      expect(registrySnapshotForDir(dir).read(record.id)?.task).toBe('tast')
      // Same-size in-place rewrite.
      writeFileSync(file, JSON.stringify({ ...record, task: 'tost' }))
      expect(registrySnapshotForDir(dir).read(record.id)?.task).toBe('tost')
      // A returned record is the caller's own copy.
      registrySnapshotForDir(dir).read(record.id)!.task = 'mutated'
      expect(registrySnapshotForDir(dir).read(record.id)?.task).toBe('tost')
      const id = registry.newId()
      writeFileSync(path.join(registry.root, 'workers', `${id}.json`), JSON.stringify({ ...record, id, tag: 'other', name: 'lead+other', phase: 'retired' }))
      expect(registrySnapshotForDir(dir).list().map(r => r.id).sort()).toEqual([record.id, id].sort())
      fs.rmSync(file)
      expect(registrySnapshotForDir(dir).read(record.id)).toBeUndefined()
      expect(registrySnapshotForDir(dir).list().map(r => r.id)).toEqual([id])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  /**
   * Controlled stat collisions: the files below report a fixed stat while their text changes, as two writes in
   * one timestamp tick (or a file system that keeps fewer timestamp digits than it reports) would.
   */
  const MS = 1_000_000n
  function frozenStat(paths: string[], ns: bigint) {
    const real = fs.statSync
    const frozen = new Map<string, fs.BigIntStats>()
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, options?: fs.StatSyncOptions) => {
      const key = String(file)
      if (!paths.includes(key) || !options?.bigint) return real(file, options)
      // The device, inode and size of the first stat, and the injected timestamps, on every later call.
      if (!frozen.has(key)) frozen.set(key, { ...real(file, { bigint: true }), mtimeNs: ns, ctimeNs: ns } as fs.BigIntStats)
      return frozen.get(key)!
    }) as typeof fs.statSync)
    return { restore: () => spy.mockRestore() }
  }
  const at = (ns: bigint) => vi.setSystemTime(Number(ns / MS))

  it.each([
    ['fractional', 1_700_000_000_123_456_789n],
    ['whole-second', 1_700_000_000_000_000_000n],
  ])('rereads a record rewritten in the read\'s timestamp tick (%s timestamps) and settles on the new text', async (_kind, tick) => {
    const { dir } = repo()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { record } = await seedRegistryWorker(dir, 'solo')
      const registry = registrySnapshotForDir(dir)
      const file = path.join(registry.root, 'workers', `${record.id}.json`)
      // Equal-length texts: size, inode and timestamps all collide.
      const text = (task: string) => JSON.stringify({ ...record, task })
      writeFileSync(file, text('aaaa'))
      const stat = frozenStat([file], tick)
      const reads = countRegistryReads(file)
      try {
        at(tick + 300n * MS)
        expect(registry.read(record.id)?.task).toBe('aaaa')
        // Same tick, same stat: the review's failure was every later call returning 'aaaa'.
        writeFileSync(file, text('bbbb'))
        expect(registry.read(record.id)?.task).toBe('bbbb')
        at(tick + 1500n * MS)
        writeFileSync(file, text('cccc'))
        expect(registry.read(record.id)?.task).toBe('cccc')
        // Long after the tick, the entry captured while racy is read once more, then trusted.
        writeFileSync(file, text('dddd'))
        at(tick + 10_000n * MS)
        reads.reset()
        expect(registry.read(record.id)?.task).toBe('dddd')
        expect(reads.count()).toBe(1)
        reads.reset()
        expect(registry.read(record.id)?.task).toBe('dddd')
        expect(reads.count()).toBe(0)
      } finally { reads.restore(); stat.restore() }
    } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('treats a timestamp ahead of the clock as racy', async () => {
    const { dir } = repo()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { record } = await seedRegistryWorker(dir, 'solo')
      const registry = registrySnapshotForDir(dir)
      const file = path.join(registry.root, 'workers', `${record.id}.json`)
      const tick = 1_700_000_000_500_000_000n
      const stat = frozenStat([file], tick)
      try {
        at(tick - 60_000n * MS)
        writeFileSync(file, JSON.stringify({ ...record, task: 'aaaa' }))
        expect(registry.read(record.id)?.task).toBe('aaaa')
        writeFileSync(file, JSON.stringify({ ...record, task: 'bbbb' }))
        expect(registry.read(record.id)?.task).toBe('bbbb')
      } finally { stat.restore() }
    } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('sees an addition and a removal behind a colliding directory stat', async () => {
    const { dir } = repo()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { record } = await seedRegistryWorker(dir, 'solo')
      const registry = registrySnapshotForDir(dir)
      const workers = path.join(registry.root, 'workers')
      const tick = 1_700_000_000_250_000_000n
      const stat = frozenStat([workers], tick)
      try {
        at(tick + 100n * MS)
        expect(registry.list().map(r => r.id)).toEqual([record.id])
        const id = registry.newId()
        const added = path.join(workers, `${id}.json`)
        writeFileSync(added, JSON.stringify({ ...record, id, tag: 'other', name: 'lead+other', phase: 'retired' }))
        expect(registry.list().map(r => r.id).sort()).toEqual([record.id, id].sort())
        fs.rmSync(added)
        at(tick + 10_000n * MS)
        expect(registry.list().map(r => r.id)).toEqual([record.id])
      } finally { stat.restore() }
    } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) }
  })
})
