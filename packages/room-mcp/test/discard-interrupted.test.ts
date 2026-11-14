import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { workerLines } from '@room/shared'
import { base, git, lead, put, setup, worker } from './collect-fixture.js'
import { registryForDir, WorkerRegistry } from '../src/worker-registry.js'
import { saveDiscardRecovery } from '../src/worker-git.js'
import { autoRetire, retireIfNothingToCollect } from '../src/retire.js'
import { workerView } from '../src/worker-status.js'
import type { Rooms } from '../src/registry.js'

type Route = 'pending' | 'automatic' | 'collection' | 'nothing'

/** A discard that failed after removal began, whose recovery ref has since been deleted. */
async function interrupted(route: Route) {
  const t = setup('done')
  await t.sync()
  const registry = await registryForDir(lead)
  if (route === 'pending') {
    put(worker, 'artifact.bin', 'ignored artifact keeps the first collection pending\n')
    await t.call({ tag: 'test' })
    expect((await registry.read('w_test'))!.collectPending).toBeDefined()
  }
  put(worker, 'file.txt', 'complete output before removal\n')
  put(worker, 'survivor.txt', 'still on disk\n')
  await registry.beginDiscard('w_test', [])
  await registry.beginStop('w_test', 'discarded')
  await registry.markDiscardStep('w_test', 'stop')
  const recovery = await saveDiscardRecovery(lead, t.w)
  await registry.recordDiscardRecovery('w_test', recovery)
  await registry.markDiscardStep('w_test', 'removing')
  if (route === 'collection') fs.unlinkSync(path.join(worker, 'file.txt'))
  else git(lead, 'worktree', 'remove', '--force', worker)
  if (route === 'pending' || route === 'nothing') git(lead, 'branch', '-D', 'room/test')
  await registry.interruptDiscard('w_test', 'interrupted after removal began')
  git(lead, 'update-ref', '-d', recovery.recoveryRef)
  return { t, registry, ref: recovery.recoveryRef }
}

// Once removal began the record is a discard and nothing else: no collection or retirement route may end it.
it.each(['pending', 'automatic', 'collection', 'nothing'] as const)('only a discard finishes a discard interrupted after removal began (%s)', async route => {
  const { t, registry, ref } = await interrupted(route)
  expect((await registry.read('w_test'))!.phase).toBe('discarding')
  if (route === 'automatic') await autoRetire(t.s, { ...t.state.rooms, probe: () => null, listCwdProcesses: () => [] } as unknown as Rooms)
  else if (route === 'nothing') expect(await retireIfNothingToCollect(lead, registry, (await registry.read('w_test'))!, {})).toBe(false)
  else await t.call({ tag: 'test' })
  expect((await registry.read('w_test'))!.phase).toBe('discarding')
  await registry.replayDiscard('w_test')
  const finished = (await registry.read('w_test'))!
  expect(['retiring', 'retired']).toContain(finished.phase)
  expect(finished.archive!.summary).toContain(`recovery ref: ${ref}`)
  git(lead, 'gc', '--prune=now')
  expect(git(lead, 'show', `${ref}:file.txt`)).toBe('complete output before removal')
})

it('shows in room_state why the automatic pass cannot finish a discard', async () => {
  const { registry, ref } = await interrupted('nothing')
  git(lead, 'update-ref', ref, base)
  const sweeper = await WorkerRegistry.open(registry.commonDir, { watch: false })
  try { await sweeper.reconcile() } finally { sweeper.close() }
  const record = (await registry.read('w_test'))!, status = (await registry.status('w_test'))!
  expect(record.phase).toBe('discarding')
  expect(workerLines([{ worker: workerView(record, status, 'test'), changedCount: 0, now: Date.now() }]).join('\n')).toContain('names another commit')
})
