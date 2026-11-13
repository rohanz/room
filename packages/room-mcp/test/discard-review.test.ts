import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { git, lead, put, setup, worker, root } from './collect-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { FileWorkerStore } from '../src/worker-file-store.js'
import { collectRecoveryRefs, preserveWorkerBranch } from '../src/worker-refs.js'
import { saveDiscardPatch } from '../src/worker-git.js'

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
  const patch = r.discard!.patch!.path
  const ref = r.discard!.baseRef!
  const recovered = path.join(root, 'recover')
  git(lead, 'worktree', 'add', '--detach', recovered, ref)
  git(recovered, 'apply', patch)
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

it.each([false, true])('review: discard after keep retains the recovery patch base independently of the lead working tree (force=%s)', async force => {
  const t = setup()
  const delivered = Array.from({ length: 30 }, (_, i) => `delivered line ${i + 1}`).join('\n') + '\n'
  put(worker, 'file.txt', delivered)
  expect(await t.call({ tag: 'test', keep: true })).toContain('kept test')
  const registry = await registryForDir(lead)
  const keptBase = (await registry.reserved('test'))!.base!
  put(lead, 'file.txt', 'lead moved on\n')
  put(worker, 'file.txt', delivered.replace('delivered line 25', 'later worker output'))
  put(worker, 'ordinary.txt', 'new work after keep\n')
  put(worker, 'artifact.bin', 'ignored output')
  const reply = await t.call({ tag: 'test', discard: true, force })
  expect(reply).toContain('discarded test')
  expect(fs.existsSync(worker)).toBe(false)
  const discarded = (await registry.read('w_test'))!
  const patch = discarded.discard!.patch!.path
  expect(fs.readFileSync(patch, 'utf8')).toContain('-delivered line 25')
  expect(fs.readFileSync(patch, 'utf8')).not.toContain('delivered line 1\n')
  const ref = discarded.discard!.baseRef!
  expect(reply).toContain(`recovery patch base ref: ${ref} (kept for seven days)`)
  const recovered = path.join(root, 'recover-kept')
  git(lead, 'worktree', 'add', '--detach', recovered, ref)
  expect(() => git(recovered, 'apply', '--check', patch)).not.toThrow()
  git(recovered, 'apply', patch)
  expect(fs.readFileSync(path.join(recovered, 'file.txt'), 'utf8')).toBe(delivered.replace('delivered line 25', 'later worker output'))
  expect(fs.readFileSync(path.join(recovered, 'ordinary.txt'), 'utf8')).toBe('new work after keep\n')
  // An old kept snapshot must remain reachable for the promised recovery period.
  // Ordinary Git GC may prune old, newly unreachable objects immediately.
  expect(git(lead, 'for-each-ref', '--format=%(refname)', '--contains', keptBase)).not.toBe('')
  git(lead, 'reflog', 'expire', '--expire=now', '--all')
  git(lead, 'gc', '--prune=now', '--quiet')
  expect(git(lead, 'rev-parse', `${ref}^{commit}`)).toBe(keptBase)
})

it('retains an unchanged kept tree when discard needs no patch', async () => {
  const t = setup()
  put(worker, 'file.txt', 'delivered without later changes\n')
  await t.call({ tag: 'test', keep: true })
  put(lead, 'file.txt', 'lead moved on\n')
  const reply = await t.call({ tag: 'test', discard: true })
  const record = (await (await registryForDir(lead)).read('w_test'))!
  expect(record.discard!.patch).toBeUndefined()
  expect(reply).toContain(`recovery patch base ref: ${record.discard!.baseRef}`)
  expect(git(lead, 'show', `${record.discard!.baseRef}:file.txt`)).toBe('delivered without later changes')
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
  // Old journals have a validated patch, but no recorded recovery base ref.
  const patch = await saveDiscardPatch(lead, { ...t.w, carriedUntracked: [{ path: 'notes.txt', sha, mode: 0o644 }] }, bytes => registry.recordDiscardPatch('w_test', bytes))
  await registry.markDiscardStep('w_test', 'patch')
  expect(fs.readFileSync(patch!, 'utf8')).not.toContain('notes.txt')
  expect(fs.existsSync(path.join(lead, 'notes.txt'))).toBe(false)
  await registry.replayDiscard('w_test')
  const record = (await registry.read('w_test'))!
  const recovered = path.join(root, 'recovered-carried')
  git(lead, 'worktree', 'add', '--detach', recovered, record.discard!.baseRef!)
  git(recovered, 'apply', patch!)
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

it('gives a reused patch-base pin a full new recovery lifetime', async () => {
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
