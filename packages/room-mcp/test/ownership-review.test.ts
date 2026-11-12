/** Independent review of c7c2620c. Ordinary failing tests intentionally identify open regressions. */
import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import * as baseline from '@room/roomd/baseline'
import * as workerGit from '../src/worker-git.js'
import { collectRecoveryRefs, preserveWorkerBranch, deletePreservedWorkerBranch, deleteWorkerRef, writeWorkerRef } from '../src/worker-refs.js'
import { retainWorkerItem, retainedWorkerLines } from '../src/worker-retained.js'
import { collectLocalState } from '../src/local-state-gc.js'
import { linkWorkspaceDeps } from '../src/worker-deps.js'
import { verifyPreparation } from '../src/worker-preparation.js'
import { writeWorkerArtifacts } from '../src/worker-artifacts.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { workspaceRepo } from './fixtures/workspace-repo.js'
import { realRepo, scratchRepos, setupLead } from './workers-fixture.js'

function branchFixture() {
  const f = realRepo(), common = path.join(f.repo, '.git')
  const worker = { id: 'w_review', tag: 'review', branch: 'room/review' }
  const tip = f.git('commit-tree', `${f.head}^{tree}`, '-p', f.head, '-m', 'unique operation tip')
  f.git('update-ref', `refs/heads/${worker.branch}`, tip)
  return { ...f, common, worker, tip, pin: `refs/room/recovery/${worker.tag}/${tip}` }
}

function deletesRef(args: Parameters<typeof baseline.boundedGitSync>, ref: string): boolean {
  if (!args[1].includes('update-ref')) return false
  if (args[1].includes('-d')) return args[1].includes(ref)
  if (!args[1].includes('--stdin')) return false
  const input = args[2]?.stdinFile ? fs.readFileSync(args[2].stdinFile) : args[2]?.input
  return input?.toString().split('\n').some(line => line.startsWith(`delete ${ref} `)) ?? false
}

it('review: a recovery pin changed after verification cannot authorize erasing its last branch', () => {
  const { common, git, head, worker, tip, pin } = branchFixture()
  const receipt = preserveWorkerBranch(common, worker)
  expect(receipt).toEqual({ tip, recoveryRef: pin })
  const run = baseline.boundedGitSync
  let replaced = false
  const spy = vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
    if (!replaced && deletesRef(args, `refs/heads/${worker.branch}`)) {
      git('update-ref', pin, head, git('rev-parse', pin))
      replaced = true
    }
    return run(...args)
  })
  try { deletePreservedWorkerBranch(common, worker, receipt) } finally { spy.mockRestore() }
  expect(replaced).toBe(true)
  // Ordinary GC after log expiry exposes actual loss, not just a changed diagnostic.
  git('reflog', 'expire', '--expire=now', '--all')
  git('gc', '--prune=now')
  expect(() => git('cat-file', '-e', `${tip}^{commit}`)).not.toThrow()
})

it('review: an existing dangling symbolic recovery name is a conflict, not an absent name', () => {
  const { common, git, worker, pin } = branchFixture()
  git('symbolic-ref', pin, 'refs/heads/not-created')
  const receipt = preserveWorkerBranch(common, worker)
  expect(receipt.reason).toBeDefined()
  expect(git('symbolic-ref', pin)).toBe('refs/heads/not-created')
})

it('review: a recovery write that returns after its value changed retains the branch', () => {
  const { common, git, worker, head, tip, pin } = branchFixture()
  const run = baseline.boundedGitSync
  let changed = false
  const spy = vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
    const result = run(...args)
    if (!changed && args[1].includes('update-ref') && args[1].includes(pin)) {
      git('update-ref', pin, head, git('rev-parse', pin))
      changed = true
    }
    return result
  })
  try {
    const receipt = preserveWorkerBranch(common, worker)
    expect(deletePreservedWorkerBranch(common, worker, receipt)).toContain('kept branch')
    expect(git('rev-parse', worker.branch)).toBe(tip)
    expect(changed).toBe(true)
  } finally { spy.mockRestore() }
})

it.each(['direct-conflict', 'symbolic-conflict', 'packed-same'] as const)('review: recovery name %s has conservative exact-name handling', mode => {
  const { common, git, worker, head, tip, pin } = branchFixture()
  if (mode === 'symbolic-conflict') git('symbolic-ref', pin, 'refs/heads/main')
  else git('update-ref', pin, mode === 'packed-same' ? tip : head)
  if (mode === 'packed-same') git('pack-refs', '--all')
  const receipt = preserveWorkerBranch(common, worker)
  if (mode === 'packed-same') {
    expect(deletePreservedWorkerBranch(common, worker, receipt)).toBeUndefined()
    expect(git('rev-parse', `${pin}^{commit}`)).toBe(tip)
    expect(git('branch', '--list', worker.branch)).toBe('')
  } else {
    expect(receipt.reason).toContain('already occupied')
    expect(git('rev-parse', `${pin}^{commit}`)).toBe(head)
    expect(git('rev-parse', worker.branch)).toBe(tip)
  }
})

it('review: GC at the branch-deletion boundary preserves a stable recovery pin', () => {
  const { common, git, worker, tip } = branchFixture()
  const receipt = preserveWorkerBranch(common, worker), run = baseline.boundedGitSync
  let collected = false
  const spy = vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
    if (!collected && deletesRef(args, `refs/heads/${worker.branch}`)) {
      git('reflog', 'expire', '--expire=now', '--all')
      git('gc', '--prune=now')
      collected = true
    }
    return run(...args)
  })
  try { expect(deletePreservedWorkerBranch(common, worker, receipt)).toBeUndefined() } finally { spy.mockRestore() }
  expect(collected).toBe(true)
  git('gc', '--prune=now')
  expect(() => git('cat-file', '-e', `${tip}^{commit}`)).not.toThrow()
})

it('review: a borrower does not overwrite an existing target pin when its source is present', () => {
  const { common, git, head, tip } = branchFixture()
  git('update-ref', 'refs/room/carry/owner', head)
  git('update-ref', 'refs/room/carry/retry', tip)
  workerGit.inheritWorkerRefs(common, { tag: 'owner', id: 'w_owner' }, { tag: 'retry', id: 'w_retry' })
  expect(git('rev-parse', 'refs/room/carry/retry')).toBe(tip)
})

it('review: the operation pin preserves the current tip, not abandoned worktree-only reflog history', () => {
  const { repo, head, git } = realRepo(), common = path.join(repo, '.git')
  const dir = path.join(repo, 'history'), worker = { id: 'w_history', tag: 'history', branch: 'room/history' }
  git('worktree', 'add', '-q', '-b', worker.branch, dir)
  git('-C', dir, 'commit', '--allow-empty', '-qm', 'later abandoned')
  const abandoned = git('-C', dir, 'rev-parse', 'HEAD')
  git('-C', dir, 'reset', '--hard', head)
  git('reflog', 'expire', '--expire=now', `refs/heads/${worker.branch}`)
  git('gc', '--prune=now')
  expect(() => git('cat-file', '-e', `${abandoned}^{commit}`)).not.toThrow()
  const receipt = preserveWorkerBranch(common, worker)
  git('worktree', 'remove', dir)
  expect(deletePreservedWorkerBranch(common, worker, receipt)).toBeUndefined()
  git('gc', '--prune=now')
  expect(() => git('cat-file', '-e', `${abandoned}^{commit}`)).toThrow()
  expect(receipt.recoveryRef).toBe(`refs/room/recovery/${worker.tag}/${head}`)
  expect(git('rev-parse', `${receipt.recoveryRef!}^{commit}`)).toBe(head)
  expect(collectRecoveryRefs(common)).toEqual([])
  expect(() => git('cat-file', '-e', head)).not.toThrow()
})

it.each(['replaced-child', 'new-child'] as const)('review: dependency rollback preserves %s inside an unchanged parent', async mode => {
  const { repo, worktree } = workspaceRepo(), worker = worktree()
  scratchRepos.push(repo)
  const modules = path.join(worker, 'node_modules'), first = path.join(modules, '@fx/a')
  const precious = mode === 'replaced-child' ? path.join(first, 'precious.txt') : path.join(modules, '.bin/precious.txt')
  const link = fs.symlinkSync
  let installed = false
  const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation((...args: Parameters<typeof fs.symlinkSync>) => {
    if (String(args[1]) === path.join(modules, '@fx/b')) {
      if (mode === 'replaced-child') { fs.unlinkSync(first); fs.mkdirSync(first) }
      fs.writeFileSync(precious, 'foreign dependency contents')
      installed = true
      throw new Error('injected later link failure')
    }
    return link(...args)
  })
  let result: Awaited<ReturnType<typeof linkWorkspaceDeps>>
  try { result = await linkWorkspaceDeps(repo, worker) } finally { spy.mockRestore() }
  expect(installed).toBe(true)
  expect(result.linked).toBe(false)
  expect(fs.existsSync(precious), result.reason).toBe(true)
  expect(fs.readFileSync(precious, 'utf8')).toBe('foreign dependency contents')
})

it('review: resolved retained-item diagnostics are eventually reclaimed by local GC', () => {
  const { repo } = realRepo(), common = path.join(repo, '.git'), count = 80
  for (let i = 0; i < count; i++) {
    const target = path.join(repo, `retained-${i}`)
    fs.mkdirSync(target)
    retainWorkerItem(common, { kind: 'directory', path: target, reason: 'review fixture' })
    fs.rmdirSync(target)
  }
  expect(retainedWorkerLines(common)).toEqual([])
  collectLocalState(common, { now: () => Date.now() + 90 * 24 * 60 * 60 * 1000 })
  expect(fs.readdirSync(path.join(common, 'room/registry/retained'))).toHaveLength(0)
})

// Pre-existing v0.17.47 limitation: worker-git.ts:605 removes tag sidecars
// without a file receipt. Deferred explicitly; see reference.md.
it.fails('review: an unowned replacement log is not erased merely by its worker tag', () => {
  const { repo } = realRepo(), target = path.join(repo, '.room/workers/log-owner.log')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, 'foreign replacement log bytes')
  workerGit.cleanupWorkerLogs(repo, { id: 'w_log', tag: 'log-owner', dir: path.join(repo, '.room/workers/log-owner'), outside: false })
  expect(fs.existsSync(target)).toBe(true)
})

// Pre-existing v0.17.47 limitation: worker-artifacts.ts:36 removes the old
// path before its exclusive write. Deferred explicitly; see reference.md.
it.fails('review: artifact regeneration does not overwrite a foreign replacement file', () => {
  const { repo } = realRepo(), target = path.join(repo, '.room/workers/artifact.env.sh')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, 'foreign artifact replacement')
  writeWorkerArtifacts(repo, { artifacts: [{ id: 'env', path: target, content: 'new Room content', mode: 0o600 }], artifactEnv: [], envPatch: {} })
  expect(fs.readFileSync(target, 'utf8')).toBe('foreign artifact replacement')
})

// Accepted existing limitation: v0.17.47 also recursively refreshes a matching
// scratch root. Root identity does not prove later-child ownership; see reference.md.
it.fails('review: repeated scratch saving preserves foreign children of its unchanged owned root', () => {
  const { repo } = realRepo(), source = path.join(repo, 'scratch-source'), target = path.join(repo, '.room/scratch/repeat')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'output.log'), 'Room output')
  const request = [{ tag: 'repeat', root: fs.realpathSync(source), paths: ['output.log'] }]
  expect(workerGit.saveWorkerScratch(repo, request).saved.get('repeat')).toEqual(['output.log'])
  fs.writeFileSync(path.join(target, 'precious.txt'), 'foreign child after first save')
  workerGit.saveWorkerScratch(repo, request)
  expect(fs.existsSync(path.join(target, 'precious.txt'))).toBe(true)
})

it('review: a resolved retained path is not reported against a later healthy generation', () => {
  const { repo } = realRepo(), common = path.join(repo, '.git'), target = path.join(repo, 'reused-path')
  fs.mkdirSync(target)
  retainWorkerItem(common, { kind: 'directory', path: target, id: 'w_old', reason: 'old generation mismatched' })
  fs.rmdirSync(target)
  expect(retainedWorkerLines(common)).toEqual([])
  collectLocalState(common, { now: () => Date.now() + 90 * 24 * 60 * 60 * 1000 })
  fs.mkdirSync(target)
  expect(retainedWorkerLines(common)).toEqual([])
})

it('review: new witness survives a normal Git move and repair with the same root and admin', async () => {
  const { repo, git } = realRepo(), prepared = await workerGit.prepareWorktree(repo, 'move-healthy', 'lead', { carry: false })
  const moved = path.join(repo, 'moved')
  git('worktree', 'move', prepared.dir, moved)
  expect(() => verifyPreparation(moved, prepared.witness!)).not.toThrow()
  fs.renameSync(moved, moved + '-again')
  git('worktree', 'repair', moved + '-again')
  expect(() => verifyPreparation(moved + '-again', prepared.witness!)).not.toThrow()
})

it('review: case-equivalent spelling does not invalidate a healthy witness', async context => {
  const { repo } = realRepo(), prepared = await workerGit.prepareWorktree(repo, 'mixed', 'lead', { carry: false })
  const alias = path.join(repo, '.ROOM/WORKERS/MIXED')
  if (!fs.existsSync(alias)) context.skip('requires case-insensitive filesystem')
  expect(() => verifyPreparation(alias, prepared.witness!)).not.toThrow()
})

it.each(['pin-only', 'receipt', 'checkout-removed', 'branch-deleted'] as const)('review: durable discard receipt survives restart at %s', async stage => {
  await realCleanup()
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  await t.leadTools.call('room_spawn', { tag: 'restart', task: 'review' })
  const record = (await registry.reserved('restart'))!
  git('-C', record.dir, 'commit', '--allow-empty', '-qm', 'operation commit')
  const tip = git('-C', record.dir, 'rev-parse', 'HEAD')
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
  await registry.beginOperation(record.id, 'discard')
  // The operation captures its tip without mutating refs during preflight.
  // This checkpoint explicitly represents the subsequent successful pin write.
  if (stage === 'pin-only') preserveWorkerBranch(path.join(repo, '.git'), record, { tip })
  if (stage !== 'pin-only') {
    await registry.beginDiscard(record.id, true, [])
    await registry.markDiscardStep(record.id, 'children')
    await registry.markDiscardStep(record.id, 'stop')
    await registry.markDiscardStep(record.id, 'patch') // no patch needed for committed, unchanged files
  }
  if (stage === 'checkout-removed' || stage === 'branch-deleted') git('worktree', 'remove', record.dir)
  if (stage === 'branch-deleted') git('update-ref', '--no-deref', '-d', `refs/heads/${record.branch}`, tip)
  // Disk-only restart fixture: a definitively dead operation holder, no live test process killed.
  const opFile = path.join(registry.root, 'workers', record.id + '.op')
  const op = JSON.parse(fs.readFileSync(opFile, 'utf8'))
  op.holder = { pid: 987654321, startTime: 'fixture:dead', executable: 'node', sessionId: 'dead', nonce: 'dead' }
  fs.writeFileSync(opFile, JSON.stringify(op))
  await closeRegistryForDir(repo)
  if (stage === 'receipt') git('update-ref', `refs/heads/${record.branch}`, head)
  let timer: ReturnType<typeof setTimeout> | undefined
  const reopening = registryForDir(repo)
  const reopened = await Promise.race([
    reopening,
    new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 5000) }),
  ])
  if (timer) clearTimeout(timer)
  if (!reopened) {
    // Remove the pending cache entry so the fixture's awaited close cannot also
    // deadlock. The unresolved promise has no timer/process and grants no cleanup.
    void closeRegistryForDir(repo)
  }
  expect(reopened, 'registry startup must not await itself while replaying discard').toBeDefined()
  expect(git('rev-parse', `refs/room/recovery/${record.tag}/${tip}^{commit}`)).toBe(tip)
  expect(() => git('cat-file', '-e', `${tip}^{commit}`)).not.toThrow()
  if (stage === 'receipt') {
    expect((await reopened!.read(record.id))?.branchCleanup?.tip).toBe(tip)
    expect(git('rev-parse', record.branch)).toBe(head)
  }
})

async function realCleanup() {
  const actual = await vi.importActual<typeof workerGit>('../src/worker-git.js')
  const loaded = await import('../src/worker-git.js')
  if (vi.isMockFunction(loaded.cleanupWorker)) loaded.cleanupWorker.mockImplementation(actual.cleanupWorker)
  if (vi.isMockFunction(loaded.ignoredWorkerArtifacts)) loaded.ignoredWorkerArtifacts.mockImplementation(actual.ignoredWorkerArtifacts)
  if (vi.isMockFunction(loaded.saveDiscardPatch)) loaded.saveDiscardPatch.mockImplementation(actual.saveDiscardPatch)
}

it('review: a different tip installed before operation admission is preserved before its branch is removed', async () => {
  await realCleanup()
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  await t.leadTools.call('room_spawn', { tag: 'before-read', task: 'review' })
  const record = (await registry.reserved('before-read'))!
  const installed = git('commit-tree', `${head}^{tree}`, '-p', head, '-m', 'different actor before admission')
  git('update-ref', '--no-deref', '-d', `refs/heads/${record.branch}`, head)
  git('update-ref', `refs/heads/${record.branch}`, installed)
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
  const reply = await t.leadTools.call('room_collect', { tag: record.tag, discard: true })
  expect(fs.existsSync(record.dir), reply).toBe(false)
  expect(git('branch', '--list', record.branch), reply).toBe('')
  expect(git('rev-parse', `refs/room/recovery/${record.tag}/${installed}^{commit}`)).toBe(installed)
  git('reflog', 'expire', '--expire=now', '--all')
  git('gc', '--prune=now')
  expect(() => git('cat-file', '-e', `${installed}^{commit}`)).not.toThrow()
})

it.each(['collect', 'discard'] as const)('review: a v0.17.47-shaped markerless worker remains usable for %s', async action => {
  await realCleanup()
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  expect(await t.leadTools.call('room_spawn', { tag: 'old-worker', task: 'review' })).toContain('spawned old-worker')
  const record = (await registry.reserved('old-worker'))!
  fs.unlinkSync(path.join(record.prep.witness!.adminDir, 'room-preparation.json'))
  await mutateWorkerFixture(registry, record.id, old => ({ ...old, prep: { step: 'prepared', created: true, branchCreated: true }, seq: old.seq + 1 }))
  fs.writeFileSync(path.join(record.dir, 'modified.txt'), 'legacy committed output')
  git('-C', record.dir, 'commit', '-qam', 'legacy output')
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
  const reply = await t.leadTools.call('room_collect', { tag: record.tag, ...(action === 'discard' ? { discard: true } : {}) })
  expect(fs.existsSync(record.dir), reply).toBe(false)
  expect(git('branch', '--list', record.branch), reply).toBe('')
  expect(reply).not.toContain('left in place because Room cannot confirm')
  expect(await t.leadTools.call('room_spawn', { tag: record.tag, task: 'again' })).toContain('spawned ' + record.tag)
})

it('review: retained-item reporting remains after the worker record and session disappear', async () => {
  const { repo } = realRepo(), common = path.join(repo, '.git'), registry = await registryForDir(repo)
  const target = path.join(repo, 'foreign-retained')
  fs.mkdirSync(target)
  retainWorkerItem(common, { kind: 'directory', path: target, id: 'w_no_record', reason: 'must survive retirement' })
  expect(await registry.read('w_no_record')).toBeUndefined()
  await closeRegistryForDir(repo)
  expect(retainedWorkerLines(common).join('\n')).toContain(target)
})

it('review: authorized ref receipts do not accumulate after their refs are deleted', () => {
  const { common, head } = branchFixture()
  for (let i = 0; i < 80; i++) {
    const ref = `refs/room/collect-head/review/w_${i}`
    writeWorkerRef(common, ref, head, `w_${i}`)
    deleteWorkerRef(common, ref, `w_${i}`)
  }
  collectLocalState(common, { now: () => Date.now() + 90 * 24 * 60 * 60 * 1000 })
  expect(fs.readdirSync(path.join(common, 'room/registry/ref-writes'))).toHaveLength(0)
})
