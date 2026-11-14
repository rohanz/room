import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FileWorkerStore } from '../src/worker-file-store.js'
import type { WorkerRecord } from '../src/worker-status.js'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
type UpdateEffects = { update(id: string, edit: (record: WorkerRecord) => WorkerRecord): Promise<WorkerRecord> }
const token = { pid: 31, startTime: 'start', executable: '/bin/agent', sessionId: 's', nonce: 'n' }
const intent = (): WorkerRecord => ({
  v: 1, id: 'w_01', tag: 'tests', name: 'lead+tests', mode: 'local', room: 'local/repo',
  lead: { participant: 'lead', room: 'local/repo', instance: token }, host: 'codex',
  budget: { threads: 1, memGb: 1, nice: 10 }, share: 'declared', task: 'tests',
  dir: '/tmp/repo/.room/workers/tests', outside: false, branch: 'room/tests', prep: { step: 'prepared' },
  capabilities: { resume: true, signal: true, collect: 'delta' }, phase: 'collecting',
  runs: [{ n: 1, mode: 'fresh', intentAt: 1, nonce: 'launch-nonce', busFrontier: 0, promptMsgIds: [], launcher: token, logStart: 0 }], createdAt: 1, seq: 1,
})
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

it('does not let a second reconcile act on a record held by the first pass', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-recovery-')); dirs.push(dir)
  const store = await FileWorkerStore.open(dir, { watch: false, liveness: () => 'dead' })
  await store.writeIntent(intent())
  const record = intent()
  record.runs[0].launch = { outcome: 'never', error: 'launch failed' }
  fs.writeFileSync(path.join(store.root, 'workers/w_01.json'), JSON.stringify(record))
  fs.rmSync(path.join(store.root, 'workers/w_01.op'))
  const entered = deferred(), release = deferred()
  const effects = store as unknown as UpdateEffects
  const update = effects.update.bind(store)
  let acting = 0, maximum = 0
  const calls = vi.spyOn(effects, 'update').mockImplementation(async (...args) => {
    maximum = Math.max(maximum, ++acting)
    entered.resolve()
    await release.promise
    try { return await update(...args) } finally { acting-- }
  })
  const first = store.reconcile()
  await entered.promise
  const second = store.reconcile()
  // Both calls have reached their first await; no timers or filesystem races.
  await Promise.resolve()
  const overlapped = maximum
  release.resolve()
  await Promise.all([first, second])
  store.close()
  expect(overlapped).toBe(1)
  expect(calls).toHaveBeenCalledTimes(1)
})

it('coalesces a burst into one follow-up, including requests during that follow-up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-recovery-')); dirs.push(dir)
  const store = await FileWorkerStore.open(dir, { watch: false })
  const effects = store as unknown as { reconcilePass(): Promise<void> }
  const firstEntered = deferred(), firstRelease = deferred(), nextEntered = deferred(), nextRelease = deferred()
  const thirdEntered = deferred(), thirdRelease = deferred()
  let calls = 0, active = 0, maximum = 0
  vi.spyOn(effects, 'reconcilePass').mockImplementation(async () => {
    maximum = Math.max(maximum, ++active)
    const n = ++calls
    if (n === 1) { firstEntered.resolve(); await firstRelease.promise }
    if (n === 2) { nextEntered.resolve(); await nextRelease.promise }
    if (n === 3) { thirdEntered.resolve(); await thirdRelease.promise }
    active--
  })
  const first = store.reconcile()
  await firstEntered.promise
  const burst = Array.from({ length: 20 }, () => store.reconcile())
  let settled = false
  void burst[0].then(() => { settled = true })
  firstRelease.resolve()
  await first // Later requests cannot hold the first caller behind their pass.
  await nextEntered.promise
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  expect(calls).toBe(2)
  const followUp = store.reconcile()
  nextRelease.resolve()
  await thirdEntered.promise
  await Promise.all(burst) // Their post-request pass finished; the third is still held.
  let thirdSettled = false
  void followUp.then(() => { thirdSettled = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(settled).toBe(true)
  expect(thirdSettled).toBe(false)
  thirdRelease.resolve()
  await followUp
  expect(calls).toBe(3)
  expect(maximum).toBe(1)
  await store.reconcile()
  expect(calls).toBe(4)
  store.close()
})

it('rejects only the failed pass while the requested follow-up and later requests complete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-recovery-')); dirs.push(dir)
  const store = await FileWorkerStore.open(dir, { watch: false })
  const effects = store as unknown as { reconcilePass(): Promise<void> }
  const entered = deferred(), release = deferred()
  let calls = 0
  vi.spyOn(effects, 'reconcilePass').mockImplementation(async () => {
    if (++calls === 1) { entered.resolve(); await release.promise; throw new Error('failed pass') }
  })
  const first = store.reconcile()
  const failure = expect(first).rejects.toThrow('failed pass')
  await entered.promise
  const followUp = expect(store.reconcile()).resolves.toBeUndefined()
  release.resolve()
  await Promise.all([failure, followUp])
  expect(calls).toBe(2)
  await store.reconcile()
  expect(calls).toBe(3)
  store.close()
})

it('a requested follow-up observes facts written while the first reconcile was running', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-recovery-')); dirs.push(dir)
  const store = await FileWorkerStore.open(dir, { watch: false, liveness: () => 'dead' })
  const firstRecord = intent()
  await store.writeIntent(firstRecord)
  fs.rmSync(path.join(store.root, 'workers/w_01.op'))
  const entered = deferred(), release = deferred()
  const effects = store as unknown as UpdateEffects
  const update = effects.update.bind(store)
  let firstUpdate = true
  vi.spyOn(effects, 'update').mockImplementation(async (...args) => {
    if (firstUpdate) { firstUpdate = false; entered.resolve(); await release.promise }
    return update(...args)
  })
  const first = store.reconcile()
  await entered.promise
  await store.writeIntent({ ...intent(), id: 'w_02', tag: 'later', name: 'lead+later' })
  fs.rmSync(path.join(store.root, 'workers/w_02.op'))
  const followUps = Array.from({ length: 5 }, () => store.reconcile())
  release.resolve()
  await Promise.all([first, ...followUps])
  const record = JSON.parse(fs.readFileSync(path.join(store.root, 'workers/w_02.json'), 'utf8'))
  expect(record.phase).toBe('active')
  expect(record.interrupted?.detail).toBe('collection stopped; partial apply may remain')
  store.close()
})

it.each(['alive', 'dead'] as const)('preserves a held collection and refreshes liveness after a yield (%s)', async state => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-recovery-')); dirs.push(dir)
  const alive = vi.fn(() => 'alive' as 'alive' | 'dead')
  const store = await FileWorkerStore.open(dir, { watch: false, liveness: alive })
  await store.writeIntent(intent())
  const record = intent()
  record.runs[0].launch = { outcome: 'never', error: 'launch failed' }
  fs.writeFileSync(path.join(store.root, 'workers/w_01.json'), JSON.stringify(record))
  alive.mockClear()
  if (state === 'dead') alive.mockReturnValueOnce('dead')
  await store.reconcile()
  expect(JSON.parse(fs.readFileSync(path.join(store.root, 'workers/w_01.json'), 'utf8')).phase).toBe('collecting')
  store.close()
})

it('preserves empty-directory reconciliation after the common directory is removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-recovery-')); dirs.push(dir)
  const store = await FileWorkerStore.open(dir, { watch: false })
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
  // Preserve reconciliation's existing empty-directory behavior, including queued callbacks after close.
  await expect(store.reconcile()).resolves.toBeUndefined()
})
