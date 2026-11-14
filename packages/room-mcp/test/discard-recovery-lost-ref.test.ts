import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { git, lead, put, setup, worker } from './collect-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { saveDiscardRecovery } from '../src/worker-git.js'

/** A discard interrupted after removal began, whose recovery ref has since been deleted. */
async function interrupted(state: 'partial' | 'gone') {
  const t = setup('failed')
  put(worker, 'file.txt', 'complete work before removal\n')
  put(worker, 'survivor.txt', 'remaining work\n')
  await t.sync()
  const registry = await registryForDir(lead)
  await registry.beginDiscard('w_test', [])
  const original = await saveDiscardRecovery(lead, t.w)
  await registry.recordDiscardRecovery('w_test', original)
  await registry.markDiscardStep('w_test', 'removing')
  const oid = git(lead, 'rev-parse', `${original.recoveryRef}^{commit}`)
  if (state === 'partial') fs.unlinkSync(path.join(worker, 'file.txt'))
  else git(lead, 'worktree', 'remove', '--force', worker)
  git(lead, 'update-ref', '-d', original.recoveryRef)
  return { registry, ref: original.recoveryRef, oid }
}

it.each(['partial', 'gone'] as const)('pins the complete commit again when its ref was lost and the checkout is %s', async state => {
  const { registry, ref, oid } = await interrupted(state)
  await registry.replayDiscard('w_test')
  const finished = (await registry.read('w_test'))!
  expect(finished.phase).toBe('retiring')
  expect(fs.existsSync(worker)).toBe(false)
  expect(finished.discard!.recoveryRef).toBe(ref)
  git(lead, 'gc', '--prune=now')
  expect(git(lead, 'rev-parse', `${ref}^{commit}`)).toBe(oid)
  expect(git(lead, 'show', `${ref}:file.txt`)).toBe('complete work before removal')
})

it('keeps the remaining files when the complete commit itself is gone and the checkout is partial', async () => {
  const { registry } = await interrupted('partial')
  git(lead, 'reflog', 'expire', '--expire=now', '--all')
  git(lead, 'gc', '--prune=now')
  await expect(registry.replayDiscard('w_test')).rejects.toThrow(/recovery commit is gone and removal had begun; remaining files kept/)
  expect((await registry.read('w_test'))!.phase).toBe('discarding')
  expect(fs.readFileSync(path.join(worker, 'survivor.txt'), 'utf8')).toBe('remaining work\n')
})

it('says so when the complete commit is gone and the checkout was already removed', async () => {
  const { registry, ref } = await interrupted('gone')
  git(lead, 'reflog', 'expire', '--expire=now', '--all')
  git(lead, 'gc', '--prune=now')
  await registry.replayDiscard('w_test')
  const finished = (await registry.read('w_test'))!
  expect(finished.phase).toBe('retiring')
  expect(finished.discard!.recoveryRef).toBeUndefined()
  expect(finished.archive!.summary).toContain(`NOT recoverable: recovery commit ${ref} is no longer in the repository`)
  expect(finished.archive!.summary).not.toContain(`; recovery ref: ${ref}`)
})
