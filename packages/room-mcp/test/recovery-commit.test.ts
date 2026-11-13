import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { base, git, lead, put, root, setup, worker } from './collect-fixture.js'
import { saveDiscardRecovery } from '../src/worker-git.js'
import { registryForDir } from '../src/worker-registry.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'

it('captures working bytes and HEAD ancestry without modifying the real index or registering a verification checkout', async () => {
  const t = setup('failed')
  put(worker, 'file.txt', 'staged\n')
  git(worker, 'add', 'file.txt')
  put(worker, 'file.txt', 'unstaged final\n')
  put(worker, 'new.bin', '\0binary output')
  put(worker, 'artifact.bin', 'ignored private output')
  fs.symlinkSync('file.txt', path.join(worker, 'link'))
  const index = git(worker, 'rev-parse', '--path-format=absolute', '--git-path', 'index')
  const before = fs.readFileSync(index), beforeStat = fs.statSync(index)
  const registrations = git(lead, 'worktree', 'list', '--porcelain')
  const recovery = await saveDiscardRecovery(lead, t.w)
  expect(recovery.unchanged).toBe(false)
  expect(fs.readFileSync(index)).toEqual(before)
  expect(fs.statSync(index).mtimeMs).toBe(beforeStat.mtimeMs)
  expect(git(worker, 'diff', '--cached', '--', 'file.txt')).toContain('+staged')
  expect(git(lead, 'worktree', 'list', '--porcelain')).toBe(registrations)
  expect(git(lead, 'rev-parse', `${recovery.recoveryRef}^`)).toBe(base)
  const recovered = path.join(root, 'snapshot')
  git(lead, 'worktree', 'add', '--detach', recovered, recovery.recoveryRef)
  expect(fs.readFileSync(path.join(recovered, 'file.txt'), 'utf8')).toBe('unstaged final\n')
  expect(fs.readFileSync(path.join(recovered, 'new.bin'))).toEqual(Buffer.from('\0binary output'))
  expect(fs.readlinkSync(path.join(recovered, 'link'))).toBe('file.txt')
  expect(fs.existsSync(path.join(recovered, 'artifact.bin'))).toBe(false)
})

it('uses the existing HEAD for an unchanged tree and says so in its reply', async () => {
  const t = setup('failed')
  const reply = await t.call({ tag: 'test', discard: true })
  const record = (await (await registryForDir(lead)).read('w_test'))!
  expect(record.discard!.recoveryRef).toBe(`refs/room/recovery/test/${base}`)
  expect(record.discard!.unchanged).toBe(true)
  expect(record.discard!.patch).toBeUndefined()
  expect(record.discard!.baseRef).toBeUndefined()
  expect(record.discard!.steps).not.toHaveProperty('patch')
  expect(record.discard!.steps).not.toHaveProperty('recovery')
  expect(reply).toContain('worktree matches HEAD')
  expect(reply).not.toContain('branch recovery ref:')
  expect(fs.existsSync(path.join(lead, '.git/room/registry/patches'))).toBe(false)
})

it.each([true, false])('finishes a legacy journal after its checkout was removed (patch=%s)', async hasPatch => {
  const t = setup('failed')
  await t.sync()
  const registry = await registryForDir(lead)
  await registry.beginDiscard('w_test', [])
  const record = (await registry.read('w_test'))!
  const ref = record.branchCleanup!.recoveryRef!
  const patch = path.join(registry.root, 'patches/w_test.patch')
  if (hasPatch) {
    put(worker, 'file.txt', 'old format recovery\n')
    put(path.dirname(patch), path.basename(patch), git(worker, 'diff', 'HEAD') + '\n')
  }
  await mutateWorkerFixture(registry, record.id, old => ({ ...old, discard: { children: [],
    steps: { children: true, stop: true, patch: true, cleanup: true }, baseRef: ref,
    ...(hasPatch ? { patch: { path: patch, sha256: createHash('sha256').update(fs.readFileSync(patch)).digest('hex') } } : {}) }, seq: old.seq + 1 }))
  git(lead, 'worktree', 'remove', '--force', worker)
  await registry.replayDiscard(record.id)
  const finished = (await registry.read(record.id))!
  expect(finished.phase).toBe('retiring')
  expect(finished.archive!.summary).toContain(ref)
  if (hasPatch) {
    expect(finished.archive!.summary).toContain(patch)
    const recovered = path.join(root, 'legacy')
    git(lead, 'worktree', 'add', '--detach', recovered, ref)
    git(recovered, 'apply', patch)
    expect(fs.readFileSync(path.join(recovered, 'file.txt'), 'utf8')).toBe('old format recovery\n')
  }
})

it('keeps legacy patch files until their original seven-day mtime expiry', async () => {
  const t = setup('failed')
  await t.sync()
  const registry = await registryForDir(lead)
  const patch = path.join(registry.root, 'patches/w_old.patch')
  put(path.dirname(patch), path.basename(patch), 'legacy bytes')
  const recent = new Date(Date.now() - 6 * 86400_000)
  fs.utimesSync(patch, recent, recent)
  const mtime = fs.statSync(patch).mtimeMs
  await registry.reconcile()
  expect(fs.readFileSync(patch, 'utf8')).toBe('legacy bytes')
  expect(fs.statSync(patch).mtimeMs).toBe(mtime)
  const expired = new Date(Date.now() - 8 * 86400_000)
  fs.utimesSync(patch, expired, expired)
  await registry.reconcile()
  expect(fs.existsSync(patch)).toBe(false)
})
