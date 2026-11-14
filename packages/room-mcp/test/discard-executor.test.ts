import fs from 'node:fs'
import { expect, it, vi } from 'vitest'
import { git, lead, put, setup, worker } from './collect-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { FileWorkerStore } from '../src/worker-file-store.js'

it.each(['live', 'kept', 'replay'] as const)('%s discard journals children and stop before snapshot, and cleanup before retirement', async route => {
  const t = setup('done')
  await t.sync()
  const registry = await registryForDir(lead)
  if (route === 'kept') {
    const record = (await registry.read('w_test'))!
    const archive = { ...await registry.archiveOf(record, { summary: 'collected', disposition: 'collected' }), keptWorktree: worker }
    await registry.beginRetirement(record.id, archive, { keptWorktree: worker })
    await registry.finishCleanup(record.id, t.s.roomName)
    t.s.room.retireWorker(record.id, archive, () => {})
  }
  put(worker, 'file.txt', 'snapshot contents\n')
  put(worker, 'artifact.bin', 'ignored contents\n')
  const events: string[] = []
  const recovery = FileWorkerStore.prototype.ensureDiscardRecovery
  const removal = FileWorkerStore.prototype.markDiscardStep
  const retirement = FileWorkerStore.prototype.beginRetirement
  const spies = [
    vi.spyOn(FileWorkerStore.prototype, 'ensureDiscardRecovery').mockImplementation(async function (this: FileWorkerStore, ...args) {
      expect((await registry.read(args[0]))!.discard!.steps).toMatchObject({ children: true, stop: true })
      expect(fs.existsSync(worker)).toBe(true)
      events.push('snapshot')
      return recovery.apply(this, args)
    }),
    vi.spyOn(FileWorkerStore.prototype, 'markDiscardStep').mockImplementation(async function (this: FileWorkerStore, id, step) {
      if (step === 'removing') { events.push('removing'); expect(fs.existsSync(worker)).toBe(true) }
      if (step === 'cleanup') { events.push('cleanup'); expect(fs.existsSync(worker)).toBe(false) }
      return removal.call(this, id, step)
    }),
    vi.spyOn(FileWorkerStore.prototype, 'beginRetirement').mockImplementation(async function (this: FileWorkerStore, ...args) {
      events.push('retirement')
      expect((await registry.read(args[0]))!.discard!.steps.cleanup).toBe(true)
      return retirement.apply(this, args)
    }),
  ]
  try {
    if (route === 'replay') { await registry.beginDiscard('w_test', []); await registry.replayDiscard('w_test') }
    else {
      const reply = await t.call({ tag: 'test', discard: true })
      const record = (await registry.read('w_test'))!
      expect(reply).toBe(`discarded test; recovery ref: ${record.discard!.recoveryRef} (kept for seven days); restore: git worktree add <dir> ${record.discard!.recoveryRef}; deleted without a copy: artifact.bin`)
    }
  } finally { spies.forEach(spy => spy.mockRestore()) }
  expect(events).toEqual(['snapshot', 'removing', 'cleanup', 'retirement'])
  expect((await registry.read('w_test'))!.discard!.steps).not.toHaveProperty('prune')
  const record = (await registry.read('w_test'))!
  expect(record.archive!.summary).toBe(`discarded; recovery ref: ${record.discard!.recoveryRef} (kept for seven days); restore: git worktree add <dir> ${record.discard!.recoveryRef}; deleted without a copy: artifact.bin`)
})

const interruptions = (['live', 'kept', 'replay'] as const).flatMap(route =>
  (['children', 'stop', 'removing', 'cleanup'] as const).flatMap(step =>
    [false, true].map(after => ({ route, step, after }))))

it.each(interruptions)('resumes $route discard interrupted at $step (after=$after)', async ({ route, step: milestone, after }) => {
  const t = setup('done')
  await t.sync()
  const registry = await registryForDir(lead)
  if (route === 'kept') {
    const record = (await registry.read('w_test'))!
    const archive = { ...await registry.archiveOf(record, { summary: 'collected', disposition: 'collected' }), keptWorktree: worker }
    await registry.beginRetirement(record.id, archive, { keptWorktree: worker })
    await registry.finishCleanup(record.id, t.s.roomName)
    t.s.room.retireWorker(record.id, archive, () => {})
  }
  put(worker, 'file.txt', 'complete recovery contents\n')
  const original = FileWorkerStore.prototype.markDiscardStep
  let injected = false
  const fault = vi.spyOn(FileWorkerStore.prototype, 'markDiscardStep').mockImplementation(async function (this: FileWorkerStore, id, step) {
    if (step !== milestone) return original.call(this, id, step)
    injected = true
    if (after) await original.call(this, id, step)
    throw new Error('interrupted journal write')
  })
  try {
    if (route === 'replay') {
      await registry.beginDiscard('w_test', [])
      await expect(registry.replayDiscard('w_test')).rejects.toThrow('interrupted journal write')
    } else expect(await t.call({ tag: 'test', discard: true })).toContain('interrupted journal write')
  } finally { fault.mockRestore() }
  expect(injected).toBe(true)
  const interrupted = (await registry.read('w_test'))!
  expect(interrupted.phase).toBe(route === 'replay' || interrupted.discard!.steps.removing ? 'discarding' : 'active')
  if (interrupted.phase === 'discarding') await registry.replayDiscard('w_test')
  else expect(await t.call({ tag: 'test', discard: true })).toContain('discarded test')
  const completed = (await registry.read('w_test'))!
  expect(['retiring', 'retired']).toContain(completed.phase)
  expect(fs.existsSync(worker)).toBe(false)
  expect(git(lead, 'show', completed.discard!.recoveryRef + ':file.txt')).toBe('complete recovery contents')
  if (interrupted.discard!.steps.removing) expect(completed.discard!.recoveryRef).toBe(interrupted.discard!.recoveryRef)
})

it('loads an old prune milestone and finishes its existing discard plan', async () => {
  const t = setup('done')
  await t.sync()
  const registry = await registryForDir(lead)
  await registry.beginDiscard('w_test', [])
  const { mutateWorkerFixture } = await import('./fixtures/worker-record.js')
  await mutateWorkerFixture(registry, 'w_test', old => ({ ...old, discard: { ...old.discard!, steps: { ...old.discard!.steps, prune: true } }, seq: old.seq + 1 }))
  await registry.replayDiscard('w_test')
  expect(['retiring', 'retired']).toContain((await registry.read('w_test'))!.phase)
  expect(fs.existsSync(worker)).toBe(false)
})
