import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { base, git, lead, put, root, setup, worker } from './collect-fixture.js'
import { saveDiscardRecovery } from '../src/worker-git.js'
import { FileWorkerStore } from '../src/worker-file-store.js'
import { rootIdentity, witnessPreparation } from '../src/worker-preparation.js'

it('includes an ignored file already staged in the worker index, without including ordinary ignored files', async () => {
  const t = setup('failed')
  put(worker, 'staged.bin', 'staged tracked work\n')
  git(worker, 'add', 'staged.bin')
  put(worker, '.gitignore', 'staged.bin\nsecret.bin\n.room/\n')
  put(worker, 'secret.bin', 'ignored output')
  const { recoveryRef } = await saveDiscardRecovery(lead, t.w)
  expect(git(lead, 'show', `${recoveryRef}:staged.bin`)).toBe('staged tracked work')
  expect(() => git(lead, 'show', `${recoveryRef}:secret.bin`)).toThrow()
})

it('does not force-add ignored children when a carried file became a directory', async () => {
  const t = setup('failed')
  put(worker, 'notes.txt', 'carried\n')
  const sha = git(worker, 'hash-object', '-w', 'notes.txt')
  fs.unlinkSync(path.join(worker, 'notes.txt'))
  put(worker, 'notes.txt/ordinary.txt', 'ordinary work\n')
  put(worker, 'notes.txt/secret.bin', 'ignored output')
  put(worker, '.gitignore', '*.bin\n.room/\n')
  const { recoveryRef } = await saveDiscardRecovery(lead, { ...t.w, carriedUntracked: [{ path: 'notes.txt', sha, mode: 0o644 }] })
  expect(git(lead, 'show', `${recoveryRef}:notes.txt/ordinary.txt`)).toBe('ordinary work')
  expect(() => git(lead, 'show', `${recoveryRef}:notes.txt/secret.bin`)).toThrow()
})

it('retains a detached checkout whose HEAD changes after snapshot capture', async () => {
  const t = setup('failed')
  witnessPreparation(worker, 'room/test', { id: 'fixture', nonce: 'fixture' }, rootIdentity(worker), base)
  await t.sync()
  git(worker, 'checkout', '--detach', base)
  const original = FileWorkerStore.prototype.recordDiscardRecovery
  let laterHead = ''
  const fault = vi.spyOn(FileWorkerStore.prototype, 'recordDiscardRecovery').mockImplementation(async function (this: FileWorkerStore, id, facts) {
    await original.call(this, id, facts)
    if (facts.recoveryRef) {
      put(worker, 'later.txt', 'new detached work\n')
      git(worker, 'add', 'later.txt')
      git(worker, 'commit', '-qm', 'later detached commit')
      laterHead = git(worker, 'rev-parse', 'HEAD')
    }
  })
  let reply: string
  try { reply = await t.call({ tag: 'test', discard: true }) }
  finally { fault.mockRestore() }
  expect(reply).toContain('checkout HEAD changed after discard snapshot')
  expect(fs.existsSync(worker)).toBe(true)
  expect(git(worker, 'rev-parse', 'HEAD')).toBe(laterHead)
  expect(fs.readFileSync(path.join(worker, 'later.txt'), 'utf8')).toBe('new detached work\n')
  expect(git(lead, 'worktree', 'list', '--porcelain')).not.toContain(path.join(root, 'verify'))
})
