import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { git, lead, put, setup, worker } from './collect-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { FileWorkerStore } from '../src/worker-file-store.js'
import * as refs from '../src/worker-refs.js'
import * as workerGit from '../src/worker-git.js'
import * as baseline from '@room/roomd/baseline'

async function interruptedKeptDiscard() {
  const t = setup()
  put(worker, 'file.txt', 'delivered private baseline\n')
  await t.call({ tag: 'test', keep: true })
  put(worker, 'file.txt', 'later worker bytes\n')
  const registry = await registryForDir(lead)
  await registry.beginDiscard('w_test', [])
  const original = FileWorkerStore.prototype.recordDiscardRecovery
  const fault = vi.spyOn(FileWorkerStore.prototype, 'recordDiscardRecovery').mockImplementation(async function (this: FileWorkerStore, id, facts) {
    await original.call(this, id, facts)
    if (facts.recoveryRef) throw new Error('crashed after snapshot')
  })
  try { await expect(registry.replayDiscard('w_test')).rejects.toThrow('crashed after snapshot') }
  finally { fault.mockRestore() }
  return { registry }
}

it('renews recovery retention when delayed replay destructively removes the checkout', async () => {
  const { registry } = await interruptedKeptDiscard()
  const day = 86400_000, started = Date.now(), realNow = Date.now.bind(Date)
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6 * day)
  try {
    await registry.replayDiscard('w_test')
    const ref = (await registry.read('w_test'))!.discard!.recoveryRef!
    expect(fs.existsSync(worker)).toBe(false)
    expect(refs.collectRecoveryRefs(registry.commonDir, started + 8 * day, true)).not.toContain(ref)
    expect(refs.collectRecoveryRefs(registry.commonDir, started + 14 * day, true)).toContain(ref)
  } finally { clock.mockRestore() }
})

it('retains the checkout when its recovery pin cannot be confirmed immediately before removal', async () => {
  const { registry } = await interruptedKeptDiscard()
  const original = refs.preserveWorkerBranch
  const fault = vi.spyOn(refs, 'preserveWorkerBranch').mockImplementation((common, worker, captured, renew) =>
    renew ? { tip: captured?.tip, reason: 'snapshot pin renewal refused' } : original(common, worker, captured, renew))
  try { await expect(registry.replayDiscard('w_test')).rejects.toThrow('snapshot pin renewal refused') }
  finally { fault.mockRestore() }
  expect(fs.existsSync(worker)).toBe(true)
  expect((await registry.read('w_test'))!.phase).toBe('discarding')
})

it('does not replace a complete recovery tree with a partially removed checkout on replay', async () => {
  const t = setup('failed')
  put(worker, 'file.txt', 'must survive interrupted removal\n')
  put(worker, 'survivor.txt', 'still on disk\n')
  await t.sync()
  const registry = await registryForDir(lead)
  await registry.beginDiscard('w_test', [])
  // Model an older interrupted removal with durable recovery but no removal-start marker.
  const original = FileWorkerStore.prototype.recordDiscardRecovery
  const fault = vi.spyOn(FileWorkerStore.prototype, 'recordDiscardRecovery').mockImplementation(async function (this: FileWorkerStore, id, facts) {
    await original.call(this, id, facts)
    if (facts.recoveryRef) {
      fs.unlinkSync(path.join(worker, 'file.txt'))
      throw new Error('interrupted after partial removal')
    }
  })
  try { await expect(registry.replayDiscard('w_test')).rejects.toThrow('interrupted after partial removal') }
  finally { fault.mockRestore() }
  const originalRef = (await registry.read('w_test'))!.discard!.recoveryRef!
  expect(git(lead, 'show', `${originalRef}:file.txt`)).toBe('must survive interrupted removal')
  const capturedAt = Date.now(), day = 86400_000
  const realNow = Date.now.bind(Date)
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6 * day)
  try {
    await registry.replayDiscard('w_test')
    expect(fs.existsSync(worker)).toBe(false)
    const ref = (await registry.read('w_test'))!.discard!.recoveryRef!
    expect(ref).toBe(originalRef)
    // The first complete snapshot is renewed, so it survives two days after final removal.
    refs.collectRecoveryRefs(registry.commonDir, capturedAt + 8 * day)
    git(lead, 'gc', '--prune=now')
    expect(git(lead, 'show', `${ref}:file.txt`)).toBe('must survive interrupted removal')
  } finally { clock.mockRestore() }
})

it('recaptures a missing journaled ref, retaining the checkout if that capture fails', async () => {
  const { registry } = await interruptedKeptDiscard()
  const originalRef = (await registry.read('w_test'))!.discard!.recoveryRef!
  git(lead, 'update-ref', '-d', originalRef)
  put(worker, 'file.txt', 'remaining work after ref loss\n')
  const fault = vi.spyOn(workerGit, 'saveDiscardRecovery').mockRejectedValue(new Error('capture unavailable'))
  try { await expect(registry.replayDiscard('w_test')).rejects.toThrow('capture unavailable') }
  finally { fault.mockRestore() }
  expect(fs.existsSync(worker)).toBe(true)
  expect((await registry.read('w_test'))!.discard!.recoveryRef).toBe(originalRef)
  await registry.replayDiscard('w_test')
  const ref = (await registry.read('w_test'))!.discard!.recoveryRef!
  expect(git(lead, 'show', `${ref}:file.txt`)).toBe('remaining work after ref loss')
  expect(fs.existsSync(worker)).toBe(false)
})

it('keeps the first snapshot when an explicit discard retry follows partial removal', async () => {
  const t = setup('failed')
  put(worker, 'file.txt', 'complete before removal\n')
  const original = baseline.boundedGitSync
  const fault = vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
    if (args[1].includes('worktree') && args[1].includes('remove') && args[1].includes(worker)) {
      fs.unlinkSync(path.join(worker, 'file.txt'))
      throw new Error('interrupted partial removal')
    }
    return original(...args)
  })
  let reply: string
  try { reply = await t.call({ tag: 'test', discard: true }) }
  finally { fault.mockRestore() }
  expect(reply).toContain('interrupted partial removal')
  const registry = await registryForDir(lead), interrupted = (await registry.read('w_test'))!
  const originalRef = interrupted.discard!.recoveryRef!
  expect(interrupted.phase).toBe('active')
  expect(interrupted.discard!.steps.removing).toBe(true)
  expect(fs.existsSync(path.join(worker, 'file.txt'))).toBe(false)
  expect(await t.call({ tag: 'test', discard: true })).toContain('discarded test')
  const ref = (await registry.read('w_test'))!.discard!.recoveryRef!
  expect(ref).toBe(originalRef)
  expect(git(lead, 'show', `${ref}:file.txt`)).toBe('complete before removal')
})

it('captures new edits on an explicit retry when the previous discard stopped before removal', async () => {
  const t = setup('failed')
  put(worker, 'file.txt', 'first attempt\n')
  const original = FileWorkerStore.prototype.recordDiscardRecovery
  const fault = vi.spyOn(FileWorkerStore.prototype, 'recordDiscardRecovery').mockImplementation(async function (this: FileWorkerStore, id, facts) {
    await original.call(this, id, facts)
    if (facts.recoveryRef) throw new Error('stopped before removal')
  })
  let reply: string
  try { reply = await t.call({ tag: 'test', discard: true }) }
  finally { fault.mockRestore() }
  expect(reply).toContain('stopped before removal')
  const registry = await registryForDir(lead), interrupted = (await registry.read('w_test'))!
  expect(interrupted.phase).toBe('active')
  expect(interrupted.discard!.steps.removing).toBeUndefined()
  put(worker, 'file.txt', 'new work before retry\n')
  expect(await t.call({ tag: 'test', discard: true })).toContain('discarded test')
  const ref = (await registry.read('w_test'))!.discard!.recoveryRef!
  expect(ref).not.toBe(interrupted.discard!.recoveryRef)
  expect(git(lead, 'show', `${ref}:file.txt`)).toBe('new work before retry')
})
