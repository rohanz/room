/** Independent review of 4d1ff6cc. Run on that pinned tree; this review branch is not rebased. */
import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import * as baseline from '@room/roomd/baseline'
import * as workerGit from '../src/worker-git.js'
import { preserveWorkerBranch, deletePreservedWorkerBranch, writeWorkerRef } from '../src/worker-refs.js'
import { linkWorkspaceDeps } from '../src/worker-deps.js'
import { registryForDir } from '../src/worker-registry.js'
import { retainedWorkerLines } from '../src/worker-retained.js'
import { workspaceRepo } from './fixtures/workspace-repo.js'
import { realRepo, scratchRepos, setupLead } from './workers-fixture.js'

function branchFixture() {
  const f = realRepo(), common = path.join(f.repo, '.git')
  const worker = { id: 'w_r2', tag: 'r2', branch: 'room/r2' }
  const tip = f.git('commit-tree', `${f.head}^{tree}`, '-p', f.head, '-m', 'operation tip')
  f.git('update-ref', `refs/heads/${worker.branch}`, tip)
  return { ...f, common, worker, tip, pin: `refs/room/recovery/r2/${tip}` }
}

it.each(['other', 'missing', 'dangling', 'symbolic-same', 'symbolic-other'] as const)(
  'r2: atomic branch deletion preserves content when the pin becomes %s', mode => {
    const { common, git, head, worker, tip, pin } = branchFixture()
    const receipt = preserveWorkerBranch(common, worker)
    const target = 'refs/heads/user-target', targetValue = mode === 'symbolic-same' ? tip : head
    git('update-ref', target, targetValue)
    const run = baseline.boundedGitSync
    let injected = false
    const spy = vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
      if (!injected && args[1].includes('update-ref') && args[2]?.input?.toString().includes(`delete refs/heads/${worker.branch} `)) {
        injected = true
        if (mode === 'other') git('update-ref', pin, head)
        else if (mode === 'missing') git('update-ref', '-d', pin)
        else git('symbolic-ref', pin, mode === 'dangling' ? 'refs/heads/not-present' : target)
      }
      return run(...args)
    })
    let result: string | undefined
    try { result = deletePreservedWorkerBranch(common, worker, receipt) } finally { spy.mockRestore() }
    expect(injected).toBe(true)
    expect(git('rev-parse', target)).toBe(targetValue)
    if (mode === 'symbolic-same') {
      expect(result).toBeUndefined()
      expect(git('branch', '--list', worker.branch)).toBe('')
      expect(git('rev-parse', pin)).toBe(tip)
      expect(() => git('symbolic-ref', '-q', pin)).toThrow()
    } else {
      expect(result).toContain('kept branch')
      expect(git('rev-parse', worker.branch)).toBe(tip)
    }
    git('reflog', 'expire', '--expire=now', '--all')
    git('gc', '--prune=now')
    expect(() => git('cat-file', '-e', `${tip}^{commit}`)).not.toThrow()
  },
)

// Lead ruling m_mwcljb9et35lkq: replacing a dangling name inside refs/room loses
// no object/user ref and is allowed. Keep this as characterization, not a failure.
it('r2: inheritance over a dangling Room-private name never creates the name\'s target', () => {
  const { common, git, head } = branchFixture()
  git('update-ref', 'refs/room/carry/source', head)
  git('symbolic-ref', 'refs/room/carry/borrower', 'refs/heads/not-present')
  workerGit.inheritWorkerRefs(common, { id: 'w_source', tag: 'source' }, { id: 'w_borrower', tag: 'borrower' })
  // What Git does with a create over a dangling symbolic name depends on its version: 2.45 on macOS replaces
  // the name with the commit, the version on GitHub's Linux runner leaves it dangling. Either is acceptable.
  // The guarantees are that the user's branch namespace is not written and the source keeps its commit.
  expect(git('branch', '--list', 'not-present')).toBe('')
  expect(git('rev-parse', 'refs/room/carry/source')).toBe(head)
  let borrower: string
  try { borrower = git('rev-parse', '--verify', '-q', 'refs/room/carry/borrower') } catch { borrower = 'dangling' }
  expect([head, 'dangling']).toContain(borrower)
  if (borrower === 'dangling') expect(git('symbolic-ref', 'refs/room/carry/borrower')).toBe('refs/heads/not-present')
})

it('r2: branch writes with their nonzero expectation retain a dangling replacement', () => {
  const { common, git, head } = branchFixture(), ref = 'refs/heads/room/dangling'
  git('symbolic-ref', ref, 'refs/heads/not-present')
  expect(() => writeWorkerRef(common, ref, head, 'w_branch', head)).toThrow()
  expect(git('symbolic-ref', ref)).toBe('refs/heads/not-present')
  expect(git('branch', '--list', 'not-present')).toBe('')
})

it.each(['local-replacement', 'foreign-parent'] as const)('r2: dependency receipt observation after %s', async mode => {
  const { repo, worktree } = workspaceRepo(), worker = worktree()
  scratchRepos.push(repo)
  const name = 'shim.cmd', source = path.join(repo, 'node_modules/.bin', name)
  const target = path.join(worker, 'node_modules/.bin', name)
  fs.writeFileSync(source, 'Room dependency shim')
  const outside = path.join(repo, 'user-bin'), precious = path.join(outside, name)
  fs.mkdirSync(outside)
  fs.writeFileSync(precious, 'pre-existing user bytes outside worker')
  const copy = fs.copyFileSync, link = fs.symlinkSync
  let replaced = false, failed = false
  const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation((...args: Parameters<typeof fs.copyFileSync>) => {
    copy(...args)
    if (String(args[1]) === target) {
      if (mode === 'local-replacement') {
        fs.unlinkSync(target)
        fs.writeFileSync(target, 'foreign bytes before identity observation')
      } else {
        const bin = path.dirname(target)
        fs.renameSync(bin, bin + '-original')
        fs.symlinkSync(outside, bin, process.platform === 'win32' ? 'junction' : 'dir')
      }
      replaced = true
    }
  })
  const linkSpy = vi.spyOn(fs, 'symlinkSync').mockImplementation((...args: Parameters<typeof fs.symlinkSync>) => {
    if (String(args[1]) === path.join(worker, 'node_modules/@fx/b')) {
      failed = true
      throw new Error('later dependency failure')
    }
    return link(...args)
  })
  try {
    const result = await linkWorkspaceDeps(repo, worker)
    expect(replaced).toBe(true)
    expect(failed).toBe(true)
    expect(result.linked).toBe(false)
    if (mode === 'local-replacement') {
      // Lead correction: retaining this output is preferable to unlinking a
      // path through a replaceable parent. Real discard/tag reuse is covered
      // separately in worker-deps-rollback.test.ts.
      expect(fs.existsSync(target), result.reason).toBe(true)
      expect(result.reason).toContain(path.dirname(target))
    }
    expect(fs.existsSync(precious), result.reason).toBe(true)
    expect(fs.readFileSync(precious, 'utf8')).toBe('pre-existing user bytes outside worker')
  } finally { copySpy.mockRestore(); linkSpy.mockRestore() }
})

async function realCleanup() {
  const actual = await vi.importActual<typeof workerGit>('../src/worker-git.js')
  const loaded = await import('../src/worker-git.js')
  if (vi.isMockFunction(loaded.cleanupWorker)) loaded.cleanupWorker.mockImplementation(actual.cleanupWorker)
  if (vi.isMockFunction(loaded.ignoredWorkerArtifacts)) loaded.ignoredWorkerArtifacts.mockImplementation(actual.ignoredWorkerArtifacts)
  if (vi.isMockFunction(loaded.saveDiscardPatch)) loaded.saveDiscardPatch.mockImplementation(actual.saveDiscardPatch)
}

it.each(['collect', 'discard', 'keep-collect'] as const)('r2: normal committed %s removes the branch and permits reuse without retained reports', async action => {
  await realCleanup()
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  const tag = 'normal-r2'
  expect(await t.leadTools.call('room_spawn', { tag, task: 'review' })).toContain('spawned ' + tag)
  const record = (await registry.reserved(tag))!
  fs.writeFileSync(path.join(record.dir, 'modified.txt'), 'r2 committed output')
  git('-C', record.dir, 'commit', '-qam', 'worker output')
  const tip = git('-C', record.dir, 'rev-parse', 'HEAD')
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
  if (action === 'keep-collect') {
    const kept = await t.leadTools.call('room_collect', { tag, keep: true })
    expect(kept).not.toContain('error:')
    expect(kept).not.toContain('left in place because Room cannot confirm')
    expect(fs.existsSync(record.dir)).toBe(true)
    expect((await registry.read(record.id))?.branchCleanup).toBeUndefined()
    expect(git('for-each-ref', '--format=%(refname)', `refs/room/recovery/${tag}/`)).toBe('')
  }
  const reply = await t.leadTools.call('room_collect', { tag, ...(action === 'discard' ? { discard: true } : {}) })
  expect(fs.existsSync(record.dir), reply).toBe(false)
  expect(git('branch', '--list', record.branch), reply).toBe('')
  expect(git('rev-parse', `refs/room/recovery/${tag}/${tip}`)).toBe(tip)
  expect(retainedWorkerLines(registry.commonDir), reply).toEqual([])
  expect(await t.leadTools.call('room_spawn', { tag, task: 'reuse' })).toContain('spawned ' + tag)
})
