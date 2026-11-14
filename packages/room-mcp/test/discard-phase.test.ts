import { expect, it, vi } from 'vitest'
import { workerLines } from '@room/shared'
import { base, git, lead, put, setup, worker } from './collect-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { FileWorkerStore } from '../src/worker-file-store.js'
import { workerView } from '../src/worker-status.js'
import { saveDiscardRecovery } from '../src/worker-git.js'
import fs from 'node:fs'
import path from 'node:path'

it.each(['done', 'session-stopped'] as const)('shows automatic replay failure after explicit discard of a %s worker', async prior => {
  const t = setup(prior === 'done' ? 'done' : 'dismissed')
  if (prior === 'session-stopped') t.set('test', { ...t.w, status: 'dismissed', stopReason: 'lead-session-ended' })
  put(worker, 'file.txt', 'complete work\n')
  await t.sync()
  const registry = await registryForDir(lead)
  const original = FileWorkerStore.prototype.markDiscardStep
  const fault = vi.spyOn(FileWorkerStore.prototype, 'markDiscardStep').mockImplementation(async function (this: FileWorkerStore, id, step) {
    const record = await original.call(this, id, step)
    if (step === 'removing') throw new Error('injected failure after removal journal')
    return record
  })
  let reply: string
  try { reply = await t.call({ tag: 'test', discard: true }) } finally { fault.mockRestore() }
  expect(reply).toContain('injected failure after removal journal')
  const interrupted = (await registry.read('w_test'))!
  expect(interrupted.phase).toBe('discarding')
  expect(interrupted.discard!.steps.removing).toBe(true)
  git(lead, 'update-ref', interrupted.discard!.recoveryRef!, base)
  await registry.reconcile()
  const record = (await registry.read('w_test'))!, status = (await registry.status('w_test'))!
  expect(record.interrupted!.detail).toContain('names another commit')
  const view = workerLines([{ worker: workerView(record, status, 'test'), changedCount: 1 }]).join('\n')
  expect(view).toContain('names another commit')
})

it('does not reactivate an interrupted discard when another reconcile observes its held lease', async () => {
  const t = setup('done')
  t.set('test', { ...t.w, pid: 4_190_001 })
  put(worker, 'file.txt', 'complete work before removal\n')
  put(worker, 'survivor.txt', 'surviving output\n')
  await t.sync()
  const registry = await registryForDir(lead)
  const before = (await registry.read('w_test'))!, run = before.runs[0]
  if (run.launch?.outcome !== 'launched') throw new Error('fixture must have a launched host')
  const report = (await registry.reports('w_test'))[0]
  await registry.writeReport('w_test', { ...report, hostProcess: run.launch.process })
  // A delivered spawn with an uncertain launcher outcome, followed by a host admission/report.
  await registry.command('w_test', { type: 'launch', run: run.n, launch: { outcome: 'ambiguous', at: Date.now() } })
  await registry.beginDiscard('w_test', [])
  await registry.beginStop('w_test', 'discarded')
  await registry.markDiscardStep('w_test', 'stop')
  const recovery = await saveDiscardRecovery(lead, t.w)
  await registry.recordDiscardRecovery('w_test', recovery)
  await registry.markDiscardStep('w_test', 'removing')
  fs.unlinkSync(path.join(worker, 'file.txt'))
  await registry.interruptDiscard('w_test', 'partial removal failed')
  const oid = git(lead, 'rev-parse', `${recovery.recoveryRef}^{commit}`)
  git(lead, 'update-ref', '-d', recovery.recoveryRef)
  const original = FileWorkerStore.prototype.ensureDiscardRecovery
  let interleaved = false
  const secondPass = vi.spyOn(FileWorkerStore.prototype, 'ensureDiscardRecovery').mockImplementation(async function (this: FileWorkerStore, ...args) {
    // The timer/watch callbacks can start a second pass while the first awaits filesystem work.
    if (!interleaved) { interleaved = true; await registry.reconcile() }
    return original.apply(this, args)
  })
  try { await registry.reconcile() } finally { secondPass.mockRestore() }
  expect(interleaved).toBe(true)
  // The second pass left the held discard alone, so the first finished it with the original snapshot pinned again.
  const finished = (await registry.read('w_test'))!
  expect(['retiring', 'retired']).toContain(finished.phase)
  expect(finished.discard!.recoveryRef).toBe(recovery.recoveryRef)
  git(lead, 'gc', '--prune=now')
  expect(git(lead, 'rev-parse', `${recovery.recoveryRef}^{commit}`)).toBe(oid)
  expect(git(lead, 'show', `${recovery.recoveryRef}:file.txt`)).toBe('complete work before removal')
})
