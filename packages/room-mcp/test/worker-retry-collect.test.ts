import { realRepo, setupLead } from './workers-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as workerGit from '../src/worker-git.js'
import { localWorkerBaseline, registryForDir } from '../src/worker-registry.js'
import { workerByTag } from './registry-fixture.js'

// Keep synthetic host processes, but exercise actual collection/discard filesystem work.
beforeEach(async () => {
  const actual = await vi.importActual<typeof workerGit>('../src/worker-git.js')
  vi.mocked(workerGit.cleanupWorker).mockImplementation(actual.cleanupWorker)
  vi.mocked(workerGit.ignoredWorkerArtifacts).mockImplementation(actual.ignoredWorkerArtifacts)
  vi.mocked(workerGit.saveDiscardPatch).mockImplementation(actual.saveDiscardPatch)
})

async function failedCarry() {
  const { repo, git, head } = realRepo()
  const put = (root: string, file: string, text: string) => fs.writeFileSync(path.join(root, file), text)
  put(repo, 'modified.txt', 'lead carried work\n')
  put(repo, 'notes.txt', 'carried untracked\n')
  const t = setupLead(repo, head)
  const call = (name: string, args: Record<string, unknown>) => t.leadTools.call(name, args)
  expect(await call('room_spawn', { tag: 'original', host: 'codex', task: 'edit' })).toContain('spawned original')
  const registry = await registryForDir(repo)
  const owner = registry.reserved('original')!
  fs.appendFileSync(owner.logFile!, JSON.stringify({ type: 'turn.failed', error: { message: 'Selected model is at capacity. Please try a different model.' } }) + '\n')
  t.exits[0](1)
  await vi.waitFor(() => expect(registry.status(owner.id)?.status).toBe('failed'))
  const failure = await call('room_collect', { tag: 'original' })
  expect(failure).toContain('skipped original: failed')
  expect(failure).toContain('respawn it with dir= its worktree to retry and keep its edits')
  expect(await call('room_spawn', { tag: 'retry', host: 'codex', task: 'retry', dir: owner.dir })).toContain('spawned retry')
  const retry = registry.reserved('retry')!
  expect(await call('room_collect', { tag: 'retry' })).toContain('skipped retry: running')
  put(owner.dir, 'modified.txt', 'retry tracked result\n')
  put(owner.dir, 'notes.txt', 'retry untracked result\n')
  put(owner.dir, 'new.txt', 'new output\n')
  t.exits[1](0)
  await vi.waitFor(() => expect(registry.status(retry.id)?.status).toBe('done'))
  return { ...t, repo, git, put, registry, owner, retry, call }
}

describe('dir= retry of a failed carried worker', () => {
  it('inherits the baseline for preview and collects the retry delta without changing the failed owner', async () => {
    const t = await failedCarry()
    try {
      expect(t.retry).toMatchObject({ sharedWith: t.owner.id, base: t.owner.base, carriedBase: t.owner.carriedBase, carriedUntracked: t.owner.carriedUntracked })
      expect(localWorkerBaseline(t.repo, t.retry.name)?.base).toBe(t.owner.base)
      expect(t.git('rev-parse', `refs/room/carry/${t.retry.tag}`)).toBe(t.owner.carriedBase)
      expect(t.git('rev-parse', `refs/room/carry-untracked/${t.retry.tag}`)).toBe(t.git('rev-parse', `refs/room/carry-untracked/${t.owner.tag}`))
      const preview = await t.call('room_preview_merge', { people: [t.retry.name] })
      expect(preview).toContain('modified.txt')
      expect(preview).not.toContain('CONFLICT')
      expect(preview).not.toContain('PARTIAL')
      const result = await t.call('room_collect', { tag: 'retry' })
      expect(result).toContain('Changes from retry:')
      expect(result).toContain('detached retry; the worktree belongs to original')
      for (const file of ['modified.txt', 'notes.txt', 'new.txt']) expect(fs.readFileSync(path.join(t.repo, file))).toEqual(fs.readFileSync(path.join(t.owner.dir, file)))
      expect(t.git('diff', '--cached', '--name-only')).toBe('')
      expect(workerByTag(t.repo, 'retry')).toBeUndefined()
      expect(t.git('for-each-ref', '--format=%(refname)', 'refs/room/carry/retry', 'refs/room/carry-untracked/retry', 'refs/room/collect-head/retry', 'refs/room/collect-base/retry')).toBe('')
      expect(t.registry.status(t.owner.id)?.status).toBe('failed')
      expect(fs.existsSync(t.owner.dir)).toBe(true)
      expect(await t.call('room_collect', { tag: 'original', discard: true })).toContain('discarded original')
      expect(fs.existsSync(t.owner.dir)).toBe(false)
    } finally { await t.leadTools.shutdown() }
  })

  it('writes nothing on a real lead conflict since carry', async () => {
    const t = await failedCarry()
    try {
      t.put(t.repo, 'modified.txt', 'lead changed after carry\n')
      const result = await t.call('room_collect', { tag: 'retry' })
      expect(result).toContain('modified.txt')
      expect(result).toContain('conflict')
      expect(fs.readFileSync(path.join(t.repo, 'modified.txt'), 'utf8')).toBe('lead changed after carry\n')
      expect(fs.readFileSync(path.join(t.repo, 'notes.txt'), 'utf8')).toBe('carried untracked\n')
      expect(fs.existsSync(path.join(t.repo, 'new.txt'))).toBe(false)
      expect(workerByTag(t.repo, 'retry')).toBeDefined()
    } finally { await t.leadTools.shutdown() }
  })

  it('discards the stopped pair through the owner, saving recovery and leaving lead carry untouched', async () => {
    const t = await failedCarry()
    try {
      const result = await t.call('room_collect', { tag: 'original', discard: true })
      expect(result).toContain('detached retry')
      expect(result).toContain('discarded original')
      expect(result).toContain('recovery patch:')
      expect(fs.existsSync(t.owner.dir)).toBe(false)
      expect(workerByTag(t.repo, 'original')).toBeUndefined()
      expect(workerByTag(t.repo, 'retry')).toBeUndefined()
      expect(t.git('for-each-ref', '--format=%(refname)', 'refs/room/carry', 'refs/room/carry-untracked', 'refs/room/collect-head', 'refs/room/collect-base')).toBe('')
      expect(fs.readFileSync(path.join(t.repo, 'modified.txt'), 'utf8')).toBe('lead carried work\n')
    } finally { await t.leadTools.shutdown() }
  })

  it('inherits a kept owner snapshot and preserves incremental keep collection for the retry', async () => {
    const { repo, git, head } = realRepo()
    const t = setupLead(repo, head)
    const call = (name: string, args: Record<string, unknown>) => t.leadTools.call(name, args)
    try {
      expect(await call('room_spawn', { tag: 'original', task: 'edit' })).toContain('spawned original')
      const registry = await registryForDir(repo)
      const owner = registry.reserved('original')!
      fs.writeFileSync(path.join(owner.dir, 'modified.txt'), 'delivered round one\n')
      t.exits[0](0)
      await vi.waitFor(() => expect(registry.status(owner.id)?.status).toBe('done'))
      expect(await call('room_collect', { tag: 'original', keep: true })).toContain('kept original: finished and resumable')
      const keptOwner = registry.read(owner.id)!
      expect(await call('room_spawn', { tag: 'retry', task: 'continue', dir: owner.dir })).toContain('spawned retry')
      const retry = registry.reserved('retry')!
      expect(retry).toMatchObject({ base: keptOwner.base, collectedKeep: true, keptPublication: keptOwner.keptPublication })
      for (const ref of [workerGit.collectHeadRef, workerGit.collectBaseRef]) expect(git('rev-parse', ref(retry.tag, retry.id))).toBe(git('rev-parse', ref(owner.tag, owner.id)))
      fs.writeFileSync(path.join(owner.dir, 'modified.txt'), 'retry round two\n')
      t.exits[1](0)
      await vi.waitFor(() => expect(registry.status(retry.id)?.status).toBe('done'))
      const preview = await call('room_preview_merge', { people: [retry.name] })
      expect(preview).not.toContain('provenance could not be verified')
      expect(preview).not.toContain('PARTIAL')
      expect(await call('room_collect', { tag: 'retry', keep: true })).toContain('kept retry: finished and resumable')
      fs.writeFileSync(path.join(repo, 'modified.txt'), 'lead revision after keep\n')
      fs.writeFileSync(path.join(owner.dir, 'new.txt'), 'retry round three\n')
      expect(await call('room_collect', { tag: 'retry' })).toContain('detached retry')
      expect(fs.readFileSync(path.join(repo, 'modified.txt'), 'utf8')).toBe('lead revision after keep\n')
      expect(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8')).toBe('retry round three\n')
      expect(registry.read(owner.id)?.base).toBe(keptOwner.base)
      expect(fs.existsSync(owner.dir)).toBe(true)
    } finally { await t.leadTools.shutdown() }
  })

  it('releases inherited pins when a retry preparation is abandoned, preserving its owner', async () => {
    const t = await failedCarry()
    const id = t.registry.newId()
    try {
      await t.registry.writeIntent({ ...t.retry, id, tag: 'aborted', name: 'rohanz+aborted', phase: 'intent',
        runs: [{ ...t.retry.runs[0], launch: undefined }], seq: 1 })
      expect(t.git('rev-parse', 'refs/room/carry/aborted')).toBe(t.owner.carriedBase)
      await t.registry.abandonPreparation(id)
      expect(t.registry.read(id)?.phase).toBe('abandoned')
      expect(t.git('for-each-ref', '--format=%(refname)', 'refs/room/carry/aborted', 'refs/room/carry-untracked/aborted')).toBe('')
      expect(t.git('rev-parse', 'refs/room/carry/original')).toBe(t.owner.carriedBase)
      expect(fs.existsSync(t.owner.dir)).toBe(true)
    } finally { await t.registry.finishOperation(id); await t.leadTools.shutdown() }
  })
})
