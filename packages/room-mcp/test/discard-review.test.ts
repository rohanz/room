import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { git, lead, put, setup, worker, root } from './collect-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { FileWorkerStore } from '../src/worker-file-store.js'
import { collectRecoveryRefs, preserveWorkerBranch } from '../src/worker-refs.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { createHash } from 'node:crypto'

it('review: discard replay preserves ordinary work and reports the ignored files it deleted', async () => {
  const t = setup('failed')
  put(worker, 'file.txt', 'tracked recovery\n')
  put(worker, 'ordinary.txt', 'untracked recovery\n')
  put(worker, 'artifact.bin', 'irreplaceable ignored output')
  await t.sync()
  const registry = await registryForDir(lead)
  await registry.beginDiscard('w_test', [])
  await registry.replayDiscard('w_test')
  expect(fs.existsSync(worker)).toBe(false)
  const r = (await registry.read('w_test'))!
  const ref = r.discard!.recoveryRef!
  const recovered = path.join(root, 'recover')
  git(lead, 'worktree', 'add', '--detach', recovered, ref)
  expect(fs.readFileSync(path.join(recovered, 'file.txt'), 'utf8')).toBe('tracked recovery\n')
  expect(fs.readFileSync(path.join(recovered, 'ordinary.txt'), 'utf8')).toBe('untracked recovery\n')
  expect(r.discard!.ignored).toEqual(['artifact.bin'])
  expect(r.archive!.summary).toContain('deleted without a copy: artifact.bin')
  await registry.replayDiscard('w_test')
  expect((await registry.read('w_test'))!.archive!.summary).toBe(r.archive!.summary)
})

it('review: discarding a legacy kept checkout reports ignored output created during shutdown', async () => {
  const t = setup()
  await t.sync()
  const registry = await registryForDir(lead)
  const record = (await registry.read('w_test'))!
  const archive = { ...await registry.archiveOf(record, { summary: 'collected', disposition: 'collected' }), keptWorktree: worker }
  await registry.beginRetirement(record.id, archive, { keptWorktree: worker })
  await registry.finishCleanup(record.id, t.s.roomName)
  t.s.room.retireWorker(record.id, archive, () => {})
  // The cwd inspection happens after the initial ignored-file enumeration.
  // Model output that a process finishes writing before it has been stopped.
  t.state.ctx!.listCwdProcesses = () => { put(worker, 'artifact.bin', 'late ignored output'); return [] }
  const reply = await t.call({ tag: 'test', discard: true })
  expect(reply).toContain('discarded test')
  expect(fs.existsSync(worker)).toBe(false)
  expect(reply).toContain('deleted without a copy: artifact.bin')
})

it.each([false, true])('review: discard after keep retains the recovery tree independently of the lead working tree (force=%s)', async force => {
  const t = setup()
  const delivered = Array.from({ length: 30 }, (_, i) => `delivered line ${i + 1}`).join('\n') + '\n'
  put(worker, 'file.txt', delivered)
  expect(await t.call({ tag: 'test', keep: true })).toContain('kept test')
  const registry = await registryForDir(lead)
  put(lead, 'file.txt', 'lead moved on\n')
  put(worker, 'file.txt', delivered.replace('delivered line 25', 'later worker output'))
  put(worker, 'ordinary.txt', 'new work after keep\n')
  put(worker, 'artifact.bin', 'ignored output')
  const reply = await t.call({ tag: 'test', discard: true, force })
  expect(reply).toContain('discarded test')
  expect(fs.existsSync(worker)).toBe(false)
  const discarded = (await registry.read('w_test'))!
  const ref = discarded.discard!.recoveryRef!
  expect(discarded.discard!.patch).toBeUndefined()
  expect(discarded.discard!.baseRef).toBeUndefined()
  expect(reply).toContain(`recovery ref: ${ref} (kept for seven days)`)
  const recovered = path.join(root, 'recover-kept')
  git(lead, 'worktree', 'add', '--detach', recovered, ref)
  expect(fs.readFileSync(path.join(recovered, 'file.txt'), 'utf8')).toBe(delivered.replace('delivered line 25', 'later worker output'))
  expect(fs.readFileSync(path.join(recovered, 'ordinary.txt'), 'utf8')).toBe('new work after keep\n')
  git(lead, 'reflog', 'expire', '--expire=now', '--all')
  git(lead, 'gc', '--prune=now', '--quiet')
  expect(git(lead, 'show', `${ref}:file.txt`)).toBe(delivered.replace('delivered line 25', 'later worker output').trim())
})

it('retains a kept tree independently of HEAD', async () => {
  const t = setup()
  put(worker, 'file.txt', 'delivered without later changes\n')
  await t.call({ tag: 'test', keep: true })
  put(lead, 'file.txt', 'lead moved on\n')
  const reply = await t.call({ tag: 'test', discard: true })
  const record = (await (await registryForDir(lead)).read('w_test'))!
  expect(record.discard!.patch).toBeUndefined()
  expect(reply).toContain(`recovery ref: ${record.discard!.recoveryRef}`)
  expect(git(lead, 'show', `${record.discard!.recoveryRef}:file.txt`)).toBe('delivered without later changes')
})

it('replays an old patch journal with unchanged carried files, independently of the lead copy', async () => {
  const t = setup('failed')
  put(worker, 'notes.txt', 'carried input\n')
  const sha = git(worker, 'hash-object', '-w', 'notes.txt')
  t.set('test', { ...t.w, carriedUntracked: [{ path: 'notes.txt', sha, mode: 0o644 }] })
  put(worker, 'file.txt', 'worker edit\n')
  await t.sync()
  const registry = await registryForDir(lead)
  await registry.beginDiscard('w_test', [])
  // Journal the old format without using the removed patch writer.
  const patch = path.join(registry.commonDir, 'room/registry/patches/w_test.patch')
  const bytes = git(worker, 'diff', 'HEAD') + '\n'
  put(path.dirname(patch), path.basename(patch), bytes)
  await mutateWorkerFixture(registry, 'w_test', old => ({ ...old, discard: { ...old.discard!,
    baseRef: preserveWorkerBranch(registry.commonDir, old).recoveryRef,
    patch: { path: patch, sha256: createHash('sha256').update(bytes).digest('hex') }, steps: { ...old.discard!.steps, patch: true } }, seq: old.seq + 1 }))
  expect(fs.existsSync(path.join(lead, 'notes.txt'))).toBe(false)
  await registry.replayDiscard('w_test')
  const record = (await registry.read('w_test'))!
  const recovered = path.join(root, 'recovered-carried')
  git(lead, 'worktree', 'add', '--detach', recovered, record.discard!.recoveryRef!)
  expect(fs.readFileSync(path.join(recovered, 'file.txt'), 'utf8')).toBe('worker edit\n')
  expect(fs.readFileSync(path.join(recovered, 'notes.txt'), 'utf8')).toBe('carried input\n')
})

it('reports durable ignored deletions after replay is interrupted just after checkout removal', async () => {
  const t = setup('failed')
  put(worker, 'artifact.bin', 'ignored output\n')
  await t.sync()
  const registry = await registryForDir(lead)
  await registry.beginDiscard('w_test', [])
  const original = FileWorkerStore.prototype.markDiscardStep
  const fail = vi.spyOn(FileWorkerStore.prototype, 'markDiscardStep').mockImplementation(async function (this: FileWorkerStore, id, step) {
    if (step === 'cleanup') throw new Error('interrupted after removal')
    return original.call(this, id, step)
  })
  try { await expect(registry.replayDiscard('w_test')).rejects.toThrow('interrupted after removal') }
  finally { fail.mockRestore() }
  expect(fs.existsSync(worker)).toBe(false)
  expect((await registry.read('w_test'))!.discard!.ignored).toEqual(['artifact.bin'])
  await registry.replayDiscard('w_test')
  expect((await registry.read('w_test'))!.archive!.summary).toContain('deleted without a copy: artifact.bin')
})

it('gives the snapshot pin a full recovery lifetime', async () => {
  const t = setup('failed')
  await t.sync()
  const registry = await registryForDir(lead)
  const record = (await registry.read('w_test'))!
  const now = Date.now(), day = 86400_000
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 6 * day)
  let ref: string
  try { ref = preserveWorkerBranch(registry.commonDir, record).recoveryRef! }
  finally { clock.mockRestore() }
  expect(collectRecoveryRefs(registry.commonDir, now + 2 * day, true)).toContain(ref)
  put(worker, 'file.txt', 'recovery after prior pin\n')
  await t.call({ tag: 'test', discard: true })
  ref = (await registry.read('w_test'))!.discard!.recoveryRef!
  expect(collectRecoveryRefs(registry.commonDir, now + 2 * day, true)).not.toContain(ref)
  expect(collectRecoveryRefs(registry.commonDir, now + 8 * day, true)).toContain(ref)
})

it('keeps an existing legacy direct recovery pin usable without assigning it an expiry', async () => {
  const t = setup('failed')
  const head = git(worker, 'rev-parse', 'HEAD')
  const ref = `refs/room/recovery/test/${head}`
  git(lead, 'update-ref', ref, head)
  put(worker, 'file.txt', 'ordinary output\n')
  expect(await t.call({ tag: 'test', discard: true })).toContain('discarded test')
  expect(git(lead, 'rev-parse', ref)).toBe(head)
  const registry = await registryForDir(lead)
  expect(collectRecoveryRefs(registry.commonDir, Date.now() + 8 * 86400_000, true)).not.toContain(ref)
})
