import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkerRegistry } from '../src/worker-registry.js'
import type { LivenessProbe, WorkerRecord } from '../src/worker-status.js'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

async function fixture(liveness: LivenessProbe = () => 'alive') {
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'room-snapshot-contention-')); dirs.push(common)
  const registry = await WorkerRegistry.openReader(common, { liveness })
  const token = { pid: 31, startTime: 'start', executable: '/bin/agent', sessionId: 's', nonce: 'n' }
  const record: WorkerRecord = {
    v: 1, id: 'w_one', tag: 'one', name: 'lead+one', mode: 'local', room: 'local/repo',
    lead: { participant: 'lead', room: 'local/repo', instance: token }, host: 'codex',
    budget: { threads: 1, memGb: 1, nice: 10 }, share: 'full', task: '0',
    dir: path.join(common, 'one'), outside: false, branch: 'room/one', prep: { step: 'prepared' },
    capabilities: { resume: true, signal: true, collect: 'delta' }, phase: 'active',
    runs: [{ n: 1, mode: 'fresh', intentAt: 1, nonce: 'launch', busFrontier: 0, promptMsgIds: [],
      launcher: token, logStart: 0, launch: { outcome: 'launched', pid: token.pid, process: token } }],
    createdAt: 1, seq: 1,
  }
  const workerFile = path.join(registry.root, 'workers', `${record.id}.json`)
  const runDir = path.join(registry.root, 'runs', record.id)
  for (const dir of [path.dirname(workerFile), runDir, path.join(registry.root, 'tags')]) fs.mkdirSync(dir, { recursive: true })
  const write = (generation: number) => {
    fs.writeFileSync(workerFile, JSON.stringify({ ...record, task: String(generation), seq: generation + 1 }))
    fs.writeFileSync(path.join(runDir, '1.report.json'), JSON.stringify({ run: 1, nonce: 'launch', chain: [], joinedAt: 1,
      done: { at: generation + 1, summary: String(generation), changed: [] } }))
  }
  write(0)
  fs.writeFileSync(path.join(registry.root, 'tags', 'one.json'), JSON.stringify({ id: record.id }))
  return { registry, record, workerFile, runDir, write }
}

it('settles a burst of concurrent facts without returning a torn snapshot or a three-attempt failure', async () => {
  const { registry, runDir, write } = await fixture()
  const readDir = fs.readdirSync.bind(fs)
  let generation = 0
  vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, options?: unknown) => {
    // Run scans decode after the first revision read. Model another process
    // publishing new record/report facts during each of the first three attempts.
    if (dir === runDir && options === undefined && generation < 6) write(++generation)
    return readDir(dir, options as never)
  }) as typeof fs.readdirSync)
  const snapshot = await registry.snapshot()
  expect(generation).toBe(6)
  expect(snapshot.available).toBe(true)
  if (!snapshot.available) return
  expect(snapshot.blockers).toEqual([])
  expect(snapshot.workers[0].record.task).toBe('6')
  expect(snapshot.workers[0].reports[0].done?.summary).toBe('6')
})

it('does not invalidate selected-worker facts when another worker changes', async () => {
  const { registry, record } = await fixture()
  const before = await registry.snapshot({ workerId: record.id })
  fs.writeFileSync(path.join(registry.root, 'workers', 'w_two.json'), JSON.stringify({ ...record, id: 'w_two', tag: 'two', name: 'lead+two' }))
  const after = await registry.snapshot({ workerId: record.id })
  expect(before.available && before.revision).toBe(after.available && after.revision)
})

it('fails closed within bounded attempts when consumed facts never settle', async () => {
  const { registry, runDir, write } = await fixture()
  const readDir = fs.readdirSync.bind(fs)
  let generation = 0
  vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, options?: unknown) => {
    if (dir === runDir && options === undefined) write(++generation)
    return readDir(dir, options as never)
  }) as typeof fs.readdirSync)
  expect(await registry.snapshot()).toMatchObject({ available: false, reason: 'unavailable', detail: expect.stringContaining('kept changing') })
  expect(generation).toBeGreaterThan(6)
  expect(generation).toBeLessThanOrEqual(200)
})

it('does not invalidate a snapshot for writer ownership facts that it does not consume', async () => {
  const { registry, runDir } = await fixture()
  const readDir = fs.readdirSync.bind(fs)
  let generation = 0
  vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, options?: unknown) => {
    if (dir === runDir && options === undefined) fs.writeFileSync(path.join(runDir, '1.writer'), String(++generation))
    return readDir(dir, options as never)
  }) as typeof fs.readdirSync)
  const snapshot = await registry.snapshot()
  expect(snapshot.available).toBe(true)
  expect(generation).toBeLessThanOrEqual(2)
})

it('enriches one immutable lifecycle snapshot while later facts continue to arrive', async () => {
  let generation = 0
  const { registry, record, write } = await fixture(() => {
    // Enrichment probes after its asynchronous log scan; lifecycle facts continue
    // arriving while it interprets the earlier immutable record/report set.
    write(++generation)
    return 'alive'
  })
  expect(await registry.status(record.id)).toMatchObject({ status: 'running', summary: '0' })
  expect(generation).toBeGreaterThan(0)
  const next = String(generation)
  expect(await registry.status(record.id)).toMatchObject({ status: 'running', summary: next })
})
