import { preparedTest } from './fixtures/prepared-test.js'
import { requireWorkerInventory } from '../src/worker-store.js'
import { describe, expect, it, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
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
import { localWorkerBaseline, openWorkerReader, WorkerRegistry } from '../src/worker-registry.js'
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
  const registry = (await openWorkerReader(dir))
  const root = registry.root
  for (let n = 0; n < RETIRED; n++) {
    const id = `w_retired_${n}`
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
    const set = new ConflictSet(session, 'lead', session, () => {}, 0, undefined, async () => undefined)
    // Files written within the last two seconds are always reread; this pass runs after that window.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 5000)
    const reads = countRegistryReads(root)
    try {
      // Warm: the first lookup of each record reads it once.
      await set.reconcile('warm')
      const cold = reads.count()
      expect(cold).toBeGreaterThan(0)
      expect(cold).toBeLessThanOrEqual(2 * names.length)
      reads.reset()
      await set.reconcile('check')
      const warm = reads.count()
      console.log(JSON.stringify({ peers: PEERS, retired: RETIRED, coldReads: cold, warmReads: warm }))
      expect(warm).toBe(0)
    } finally { vi.useRealTimers(); reads.restore(); set.stop(); room.doc.destroy(); rmSync(dir, { recursive: true, force: true }) }
  })
})

it('memoizes a supplied carried callback separately from production baseline acquisition', async () => {
  const { dir } = repo(), room = new RoomDoc()
  const session = { dir, room, me: { name: 'lead', kind: 'agent' },
    awareness: { getStates: () => new Map([[1, { user: { name: 'lead', kind: 'agent' } }]]) } } as unknown as Session
  const callback = vi.fn(() => undefined)
  const set = new ConflictSet(session, 'lead', session, () => {}, 0, callback)
  try {
    const pass = await (set as unknown as { carriedPass(): Promise<(name: string) => unknown> }).carriedPass()
    pass('lead'); pass('lead'); pass('lead')
    expect(callback).toHaveBeenCalledTimes(1)
  } finally { set.stop(); room.doc.destroy(); rmSync(dir, { recursive: true, force: true }) }
})

describe('worker registry read cache', () => {
  preparedTest('keeps startup, status and admission close to the pre-facade filesystem budgets at 50 and 500 workers', () => {
    // Reuse the baseline's fresh-process fixtures and fs/fs-promises instrumentation, including failed
    // calls. Freshly written files exercise the racy-cache path; no artificial aging or warmed cache.
    return promisify(execFile)(process.execPath, ['--import', 'tsx',
      fileURLToPath(new URL('../../../scripts/measure-lifecycle.mts', import.meta.url)), '50', '500', '--samples=1'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  }, measured => {
    // execFile rejects on a failed child; awaiting it leaves the fixture hook responsive.
    const summaries = measured.stdout.trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.kind === 'summary' && ['startup', 'status', 'admission'].includes(row.phase))
    expect(summaries).toHaveLength(6)
    for (const row of summaries) {
      expect(row.successfulSamples).toBe(1)
      expect(row.failedSamples).toBe(0)
      expect(row.fsCalls).toHaveLength(1)
    }
    // Per-worker cost, measured between 50 and 500 workers so the fixed module-loading cost (about 2,000 calls
    // on Linux, under 100 on macOS) drops out. Pre-facade baselines: startup 11.0 per worker on macOS and 9.3 on
    // Linux; status and admission 6.0 on both. These bounds catch repeated run inventories or quarantine scans
    // on open, and per-worker run/report/exit reads when the record alone decides occupancy.
    const calls = (phase: string, workers: number) => summaries.find(row => row.phase === phase && row.workers === workers)!.fsCalls[0] as number
    const perWorker = (phase: string) => (calls(phase, 500) - calls(phase, 50)) / 450
    expect(perWorker('startup')).toBeLessThanOrEqual(11.5)
    expect(perWorker('status')).toBeLessThanOrEqual(6.2)
    expect(perWorker('admission')).toBeLessThanOrEqual(6.2)
    // Status and admission have no platform-dependent fixed cost, so their absolute budgets hold everywhere.
    for (const workers of [50, 500]) {
      expect(calls('status', workers)).toBeLessThanOrEqual(6 * workers + 10)
      // One durable tag guard prevents sidecar cleanup racing reservation creation/reuse. On macOS
      // it adds 77 calls (72 acquire, 5 release): 62 ensure/sync directories, 1 temp scan,
      // 4 temp write, 5 exclusive publish/cleanup, then 5 release. The existing primitive
      // syncs each ancestor; this is one acquisition, not a repeated inventory. One existence
      // check avoids a failed durable create on reuse. Measured 767dfc9e: 592/3292 calls at
      // 50/500 workers; guarded admission: 670/3370 (6N + 370). Allow ten fixed calls of margin.
      expect(calls('admission', workers)).toBeLessThanOrEqual(6 * workers + 380)
    }
  })

  it('blocks checkout authority when a borrower record cannot be decoded', async () => {
    const { dir } = repo()
    try {
      const { record: owner } = await seedRegistryWorker(dir, 'owner')
      const { record: borrower } = await seedRegistryWorker(dir, 'borrower', { dir: owner.dir, sharedWith: owner.id })
      const reader = await openWorkerReader(dir)
      writeFileSync(join(reader.root, 'workers', `${borrower.id}.json`), '{malformed')
      expect(await reader.checkoutUsers(owner)).toMatchObject({ reason: 'blocked', blockers: expect.arrayContaining([expect.stringContaining(borrower.id)]) })
      expect(await reader.projectable(owner.lead.participant, owner.room)).toMatchObject({ reason: 'blocked' })
      await expect(reader.occupancy()).rejects.toThrow(borrower.id)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it.each(['report', 'exit'] as const)('startup preserves blockers for malformed %s evidence on an unlaunched worker', async kind => {
    const { dir } = repo()
    const common = join(dir, '.git')
    try {
      const { registry, record } = await seedRegistryWorker(dir, 'prepared')
      registry.close()
      const workerFile = join(registry.root, 'workers', `${record.id}.json`)
      writeFileSync(workerFile, JSON.stringify({ ...record, phase: 'prepared',
        runs: [{ ...record.runs[0], launch: undefined }] }))
      const file = join(registry.root, 'runs', record.id, `1.${kind}.json`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, '{malformed')
      const restarted = await WorkerRegistry.open(common, { watch: false, liveness: () => 'dead' })
      try {
        const snapshot = await restarted.snapshot()
        expect(snapshot.available && snapshot.blockers).toEqual(expect.arrayContaining([expect.stringContaining(`1.${kind}.json`)]))
        // The blocker prevents recovery from deciding that the dead launcher is ambiguous.
        expect(JSON.parse(fs.readFileSync(workerFile, 'utf8')).runs[0].launch).toBeUndefined()
        expect(fs.existsSync(file)).toBe(false)
        const quarantined = fs.readdirSync(join(registry.root, 'quarantine'))
        expect(quarantined).toHaveLength(1)
        expect(fs.readFileSync(join(registry.root, 'quarantine', quarantined[0]), 'utf8')).toBe('{malformed')
      } finally { restarted.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rechecks run blockers after a recovery await before adopting a launch', async () => {
    const { dir } = repo()
    try {
      const { registry, record } = await seedRegistryWorker(dir, 'prepared')
      registry.close()
      const workerFile = join(registry.root, 'workers', `${record.id}.json`)
      writeFileSync(workerFile, JSON.stringify({ ...record, phase: 'prepared',
        runs: [{ ...record.runs[0], launch: undefined }] }))
      const file = join(registry.root, 'runs', record.id, '1.report.json')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ run: 1, nonce: record.runs[0].nonce, chain: [], joinedAt: 1, hostSessionId: 'recovered' }))
      // Corrupt the report during the await that saves its recovered host-session ID.
      const rename = fs.renameSync.bind(fs)
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        rename(from, to)
        if (to === workerFile) queueMicrotask(() => writeFileSync(file, '{malformed'))
      })
      try {
        await expect(registry.reconcile()).rejects.toMatchObject({ reason: 'blocked' })
        expect(JSON.parse(fs.readFileSync(workerFile, 'utf8')).runs[0].launch).toBeUndefined()
        expect(fs.readFileSync(file, 'utf8')).toBe('{malformed')
      } finally { spy.mockRestore() }
    } finally { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('writer reads retain healthy records and blockers without quarantining until reconciliation', async () => {
    const { dir } = repo()
    try {
      const { registry, record: healthy } = await seedRegistryWorker(dir, 'healthy')
      const { record: damaged } = await seedRegistryWorker(dir, 'damaged')
      const file = join(registry.root, 'workers', `${damaged.id}.json`)
      writeFileSync(file, '{malformed')
      const rename = vi.spyOn(fs, 'renameSync')
      const inventory = await registry.list()
      expect(inventory.records.map(record => record.id)).toEqual([healthy.id])
      expect(inventory.blockers).toEqual([expect.stringContaining(damaged.id)])
      expect(() => requireWorkerInventory(inventory)).toThrow(damaged.id)
      await expect(registry.read(damaged.id)).rejects.toMatchObject({ reason: 'blocked' })
      await expect(registry.reserved(damaged.tag)).rejects.toMatchObject({ reason: 'blocked' })
      expect((await registry.snapshot()).available).toBe(true)
      expect(rename).not.toHaveBeenCalled()
      expect(fs.readFileSync(file, 'utf8')).toBe('{malformed')
      rename.mockRestore()
      await registry.reconcile()
      expect(fs.existsSync(file)).toBe(false)
      expect(fs.existsSync(join(registry.root, 'tags', `${damaged.tag}.json`))).toBe(true)
      expect((await registry.list()).blockers.length).toBeGreaterThan(0)
    } finally { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('does not quarantine a repair that replaces a record while reconciliation decodes old bytes', async () => {
    const { dir } = repo()
    try {
      const { registry, record } = await seedRegistryWorker(dir, 'repaired')
      const file = join(registry.root, 'workers', `${record.id}.json`), healthy = fs.readFileSync(file)
      writeFileSync(file, '{malformed')
      const read = fs.readFileSync.bind(fs)
      let repaired = false
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((input: fs.PathOrFileDescriptor, options?: unknown) => {
        const bytes = read(input, options as never)
        if (input === file && !repaired) {
          repaired = true
          writeFileSync(`${file}.repair`, healthy)
          fs.renameSync(`${file}.repair`, file)
        }
        return bytes
      }) as typeof fs.readFileSync)
      await registry.reconcile()
      spy.mockRestore()
      expect(repaired).toBe(true)
      expect(fs.readFileSync(file)).toEqual(healthy)
      expect((await registry.read(record.id))?.id).toBe(record.id)
    } finally { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('keeps a reservation whose payload is missing blocked rather than treating it as absence', async () => {
    const { dir } = repo()
    try {
      const { registry, record } = await seedRegistryWorker(dir, 'missing')
      fs.rmSync(join(registry.root, 'workers', `${record.id}.json`))
      const before = fs.readFileSync(join(registry.root, 'tags', `${record.tag}.json`))
      const reader = await openWorkerReader(dir), facts = await reader.snapshot()
      expect(facts.available && facts.blockers.some(value => value.includes('unavailable reserved record'))).toBe(true)
      await expect(registry.archiveOf(record, { summary: 'retire' })).rejects.toMatchObject({ reason: 'blocked' })
      await expect(reader.occupancy()).rejects.toMatchObject({ reason: 'blocked' })
      await expect(reader.reserved(record.tag)).rejects.toMatchObject({ reason: 'blocked' })
      await registry.reconcile()
      expect(fs.readFileSync(join(registry.root, 'tags', `${record.tag}.json`))).toEqual(before)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it.each(['record', 'report', 'exit'] as const)('read-only access preserves malformed %s bytes and reports blocking evidence', async kind => {
    const { dir } = repo()
    try {
      const { record } = await seedRegistryWorker(dir, 'broken')
      const reader = await openWorkerReader(dir)
      const file = kind === 'record' ? join(reader.root, 'workers', `${record.id}.json`)
        : join(reader.root, 'runs', record.id, `1.${kind}.json`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, '{malformed')
      const tree = (root: string): unknown[] => fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
        .map(entry => [entry.name, entry.isDirectory() ? tree(join(root, entry.name)) : fs.readFileSync(join(root, entry.name)).toString('hex')])
      const before = tree(reader.root)
      if (kind === 'record') {
        await expect(reader.read(record.id)).rejects.toMatchObject({ reason: 'blocked' })
        expect((await reader.list()).blockers.length).toBeGreaterThan(0)
      } else if (kind === 'report') await expect(reader.reports(record.id)).rejects.toMatchObject({ reason: 'blocked' })
      else await expect(reader.exits(record.id)).rejects.toMatchObject({ reason: 'blocked' })
      const facts = await reader.snapshot()
      expect(tree(reader.root)).toEqual(before)
      expect(facts.available && facts.blockers.some(value => value.includes(path.basename(file)))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it.each(['null', '{}', '{"id":"unsafe/id"}'])('blocks a corrupt baseline reservation (%s) without changing it', async bytes => {
    const { dir } = repo()
    try {
      await seedRegistryWorker(dir, 'broken')
      const reader = await openWorkerReader(dir), file = join(reader.root, 'tags', 'broken.json')
      writeFileSync(file, bytes)
      const snapshot = await reader.snapshot({ tag: 'broken', recordOnly: true })
      expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
      expect(snapshot.available && snapshot.blockers.some(value => value.includes('broken.json'))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('resolves a participant to its reserved incarnation, never a retired one with the same name', async () => {
    const { dir } = repo()
    try {
      const { root } = await populate(dir)
      const reads = countRegistryReads(root)
      try {
        const live = (await localWorkerBaseline(dir, 'lead+w3'))
        expect(live?.name).toBe('lead+w3')
        expect((await (await openWorkerReader(dir)).reserved('w3'))?.phase).toBe('active')
        // A reservation and a record per lookup (just written, so reread): never a scan of the retired records.
        expect(reads.count()).toBeLessThanOrEqual(4)
      } finally { reads.restore() }
      expect((await localWorkerBaseline(dir, 'lead'))).toBeUndefined()
      expect((await localWorkerBaseline(dir, 'other+w3'))).toBeUndefined()
      expect((await localWorkerBaseline(dir, 'lead+missing'))).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('sees another writer\'s replacement, in-place rewrite, addition and removal on the next call', async () => {
    const { dir } = repo()
    try {
      const { record } = await seedRegistryWorker(dir, 'solo')
      const registry = (await openWorkerReader(dir))
      const file = path.join(registry.root, 'workers', `${record.id}.json`)
      expect((await registry.read(record.id))?.task).toBe('test')
      expect((requireWorkerInventory(await registry.list()))).toHaveLength(1)
      // Atomic replacement (a new inode), as writeAtomic does.
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify({ ...record, task: 'tast' }))
      fs.renameSync(tmp, file)
      expect((await (await openWorkerReader(dir)).read(record.id))?.task).toBe('tast')
      // Same-size in-place rewrite.
      writeFileSync(file, JSON.stringify({ ...record, task: 'tost' }))
      expect((await (await openWorkerReader(dir)).read(record.id))?.task).toBe('tost')
      // A returned record is the caller's own copy.
      const callerCopy = await (await openWorkerReader(dir)).read(record.id)
      callerCopy!.task = 'mutated'
      expect((await (await openWorkerReader(dir)).read(record.id))?.task).toBe('tost')
      const id = 'w_added'
      writeFileSync(path.join(registry.root, 'workers', `${id}.json`), JSON.stringify({ ...record, id, tag: 'other', name: 'lead+other', phase: 'retired' }))
      expect((requireWorkerInventory(await (await openWorkerReader(dir)).list())).map(r => r.id).sort()).toEqual([record.id, id].sort())
      fs.rmSync(file)
      expect((await (await openWorkerReader(dir)).read(record.id))).toBeUndefined()
      expect((requireWorkerInventory(await (await openWorkerReader(dir)).list())).map(r => r.id)).toEqual([id])
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

  it('hashes racy replacement text and reuses settled revision inputs without rereading them', async () => {
    const { dir } = repo()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { record } = await seedRegistryWorker(dir, 'solo')
      const registry = await openWorkerReader(dir)
      const file = path.join(registry.root, 'workers', `${record.id}.json`)
      const tick = 1_700_000_000_000_000_000n
      const stat = frozenStat([file], tick)
      const reads = countRegistryReads(file)
      try {
        at(tick + 100n * MS)
        writeFileSync(file, JSON.stringify({ ...record, task: 'aaaa' }))
        const first = await registry.sourceToken('solo')
        writeFileSync(file, JSON.stringify({ ...record, task: 'bbbb' }))
        const second = await registry.sourceToken('solo')
        expect(second).not.toBe(first)
        expect((await registry.read(record.id))?.task).toBe('bbbb')
        at(tick + 10_000n * MS)
        expect(await registry.sourceToken('solo')).toBe(second)
        reads.reset()
        expect(await registry.sourceToken('solo')).toBe(second)
        expect(reads.count()).toBe(0)
      } finally { reads.restore(); stat.restore() }
    } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('revalidates the record after capturing status liveness', async () => {
    const { dir } = repo()
    try {
      const { record } = await seedRegistryWorker(dir, 'solo')
      const file = path.join(dir, '.git', 'room', 'registry', 'workers', `${record.id}.json`)
      writeFileSync(file, JSON.stringify({ ...record, runs: [{ ...record.runs[0], launch: undefined }] }))
      let probed = false
      const registry = await WorkerRegistry.openReader(path.join(dir, '.git'), {
        liveness: () => {
          probed = true
          // A concurrent writer changes the phase while process evidence is collected.
          writeFileSync(file, JSON.stringify({ ...record, phase: 'abandoned', seq: record.seq + 1 }))
          return 'alive'
        },
      })
      try {
        expect((await registry.status(record.id))?.status).toBe('abandoned')
        expect(probed).toBe(true)
      } finally { registry.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it.each([
    ['fractional', 1_700_000_000_123_456_789n],
    ['whole-second', 1_700_000_000_000_000_000n],
  ])('rereads a record rewritten in the read\'s timestamp tick (%s timestamps) and settles on the new text', async (_kind, tick) => {
    const { dir } = repo()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { record } = await seedRegistryWorker(dir, 'solo')
      const registry = (await openWorkerReader(dir))
      const file = path.join(registry.root, 'workers', `${record.id}.json`)
      // Equal-length texts: size, inode and timestamps all collide.
      const text = (task: string) => JSON.stringify({ ...record, task })
      writeFileSync(file, text('aaaa'))
      const stat = frozenStat([file], tick)
      const reads = countRegistryReads(file)
      try {
        at(tick + 300n * MS)
        expect((await registry.read(record.id))?.task).toBe('aaaa')
        // Same tick, same stat: the review's failure was every later call returning 'aaaa'.
        writeFileSync(file, text('bbbb'))
        expect((await registry.read(record.id))?.task).toBe('bbbb')
        at(tick + 1500n * MS)
        writeFileSync(file, text('cccc'))
        expect((await registry.read(record.id))?.task).toBe('cccc')
        // Long after the tick, the entry captured while racy is read once more, then trusted.
        writeFileSync(file, text('dddd'))
        at(tick + 10_000n * MS)
        reads.reset()
        expect((await registry.read(record.id))?.task).toBe('dddd')
        expect(reads.count()).toBe(1)
        reads.reset()
        expect((await registry.read(record.id))?.task).toBe('dddd')
        expect(reads.count()).toBe(0)
      } finally { reads.restore(); stat.restore() }
    } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('treats a timestamp ahead of the clock as racy', async () => {
    const { dir } = repo()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { record } = await seedRegistryWorker(dir, 'solo')
      const registry = (await openWorkerReader(dir))
      const file = path.join(registry.root, 'workers', `${record.id}.json`)
      const tick = 1_700_000_000_500_000_000n
      const stat = frozenStat([file], tick)
      try {
        at(tick - 60_000n * MS)
        writeFileSync(file, JSON.stringify({ ...record, task: 'aaaa' }))
        expect((await registry.read(record.id))?.task).toBe('aaaa')
        writeFileSync(file, JSON.stringify({ ...record, task: 'bbbb' }))
        expect((await registry.read(record.id))?.task).toBe('bbbb')
      } finally { stat.restore() }
    } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('sees an addition and a removal behind a colliding directory stat', async () => {
    const { dir } = repo()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { record } = await seedRegistryWorker(dir, 'solo')
      const registry = (await openWorkerReader(dir))
      const workers = path.join(registry.root, 'workers')
      const tick = 1_700_000_000_250_000_000n
      const stat = frozenStat([workers], tick)
      try {
        at(tick + 100n * MS)
        expect((requireWorkerInventory(await registry.list())).map(r => r.id)).toEqual([record.id])
        const id = 'w_added'
        const added = path.join(workers, `${id}.json`)
        writeFileSync(added, JSON.stringify({ ...record, id, tag: 'other', name: 'lead+other', phase: 'retired' }))
        expect((requireWorkerInventory(await registry.list())).map(r => r.id).sort()).toEqual([record.id, id].sort())
        fs.rmSync(added)
        at(tick + 10_000n * MS)
        expect((requireWorkerInventory(await registry.list())).map(r => r.id)).toEqual([record.id])
      } finally { stat.restore() }
    } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) }
  })
})
