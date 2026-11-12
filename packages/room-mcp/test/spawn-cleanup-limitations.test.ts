import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { realRepo, setupLead } from './workers-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import type { WorkerRecord } from '../src/worker-status.js'
import * as workerGit from '../src/worker-git.js'
import * as baseline from '@room/roomd/baseline'

async function realCleanup() {
  const actual = await vi.importActual<typeof workerGit>('../src/worker-git.js')
  vi.mocked(workerGit.cleanupWorker).mockImplementation(actual.cleanupWorker)
  vi.mocked(workerGit.ignoredWorkerArtifacts).mockImplementation(actual.ignoredWorkerArtifacts)
  vi.mocked(workerGit.saveDiscardPatch).mockImplementation(actual.saveDiscardPatch)
}

// Existing v0.17.47 limitation: preparation completion grants authority by record/path
// without preventing another actor from replacing the checkout before promotion.
it('does not promote a markerless replacement to established ownership at prepare-finish', async () => {
  await realCleanup()
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  const command = registry.command.bind(registry), dir = path.join(repo, '.room/workers/promote')
  let replaced = false
  vi.spyOn(registry, 'command').mockImplementation(async (...args) => {
    if (args[1].type === 'prepare-finish') {
      replaced = true
      git('worktree', 'remove', '--force', dir)
      git('branch', '-D', 'room/promote')
      git('worktree', 'add', '-q', '-b', 'room/promote', dir)
      fs.writeFileSync(path.join(dir, 'precious.txt'), 'foreign replacement before promotion')
    }
    return command(...args)
  })
  const spawn = await t.leadTools.call('room_spawn', { tag: 'promote', task: 'x' })
  expect(replaced).toBe(true)
  // Exercise the resulting cleanup authority too, rather than stopping at the launch assertion.
  let discard = ''
  if (t.specs.length) {
    const record = (await registry.reserved('promote'))!
    t.exits[0](0)
    await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
    discard = await t.leadTools.call('room_collect', { tag: 'promote', discard: true, force: true })
  }
  expect(fs.existsSync(path.join(dir, 'precious.txt')), `${spawn}; ${discard}`).toBe(true)
  expect(t.specs, spawn).toHaveLength(0)
})

// Existing v0.17.47 limitation: trusted/discard accepts unfinished records after their
// operation lease is released or recovered, including a matching foreign checkout.
it.each(['intent', 'preparing'] as const)('discard never turns a markerless %s record into cleanup authority', async phase => {
  await realCleanup()
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  const dir = path.join(repo, '.room/workers/pending'), id = registry.newId()
  const record: WorkerRecord = {
    v: 1, id, tag: 'pending', name: 'rohanz+pending', mode: 'here', room: 'local/x',
    lead: { participant: 'rohanz', room: 'local/x', instance: registry.instance }, host: 'claude',
    budget: { threads: 1, memGb: 1, nice: 10 }, share: 'full', task: 'x',
    dir, outside: false, branch: 'room/pending', prep: { step: 'plan', created: false, branchCreated: false },
    capabilities: { resume: true, signal: true, collect: 'delta' }, phase,
    runs: [{ n: 1, mode: 'fresh', intentAt: Date.now(), nonce: 'pending', busFrontier: 0,
      promptMsgIds: [], launcher: registry.instance, logStart: 0 }], createdAt: Date.now(), seq: 1,
  }
  await registry.writeIntent(record)
  await registry.finishOperation(id)
  git('worktree', 'add', '-q', '-b', record.branch, dir)
  fs.writeFileSync(path.join(dir, 'precious.txt'), 'foreign checkout after intent')
  const reply = await t.leadTools.call('room_collect', { tag: 'pending', discard: true, force: true })
  expect(fs.existsSync(path.join(dir, 'precious.txt')), reply).toBe(true)
  expect(git('branch', '--list', record.branch), reply).not.toBe('')
})

// Existing v0.17.47 limitation: cleanup removes by pathname, so an external replacement
// immediately before Git's remove is affected; the new witness narrows but cannot close it.
it.fails('does not remove a foreign replacement between witness verification and Git removal', async () => {
  const { repo, git } = realRepo(), prepared = await workerGit.prepareWorktree(repo, 'remove-race', 'lead', { carry: false })
  const run = baseline.boundedGitSync
  let replaced = false
  vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
    if (!replaced && args[1].includes('worktree') && args[1].includes('remove')) {
      replaced = true
      git('worktree', 'remove', '--force', prepared.dir)
      git('worktree', 'add', '-q', '-b', 'user-replacement', prepared.dir)
      fs.writeFileSync(path.join(prepared.dir, 'precious.txt'), 'foreign during remove')
    }
    return run(...args)
  })
  await workerGit.cleanupPreparedWorktree(repo, prepared).catch(() => {})
  expect(replaced).toBe(true)
  expect(fs.existsSync(path.join(prepared.dir, 'precious.txt'))).toBe(true)
})

// Existing v0.17.47 limitation: branch deletion is not conditional on the previous tip;
// another actor can recreate the now-free branch between checkout removal and branch -D.
it('does not delete a foreign replacement branch after removing the witnessed checkout', async () => {
  const { repo, git } = realRepo(), prepared = await workerGit.prepareWorktree(repo, 'branch-race', 'lead', { carry: false })
  git('commit', '--allow-empty', '-qm', 'new foreign tip')
  const foreignTip = git('rev-parse', 'HEAD'), run = baseline.boundedGitSync
  let replaced = false
  vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
    const result = run(...args)
    if (!replaced && args[1].includes('worktree') && args[1].includes('remove')) {
      replaced = true
      git('branch', '-D', prepared.branch)
      git('branch', prepared.branch, foreignTip)
    }
    return result
  })
  await workerGit.cleanupPreparedWorktree(repo, prepared)
  expect(replaced).toBe(true)
  expect(git('branch', '--list', prepared.branch)).not.toBe('')
  expect(git('rev-parse', prepared.branch)).toBe(foreignTip)
})

// Acceptance regression from removing preparation's unconditional prune: a missing,
// detached registration has no checkout or room/tag branch to take ownership of.
it('refuses a foreign detached stale registration without deleting its admin entry', async () => {
  const { repo, head, git } = realRepo(), dir = path.join(repo, '.room/workers/stale')
  git('worktree', 'add', '-q', '--detach', dir)
  fs.rmSync(dir, { recursive: true })
  const t = setupLead(repo, head)
  const before = git('worktree', 'list', '--porcelain', '-z')
  expect(await t.leadTools.call('room_spawn', { tag: 'stale', task: 'x' })).toContain('error:')
  expect(git('worktree', 'list', '--porcelain', '-z')).toBe(before)
})
