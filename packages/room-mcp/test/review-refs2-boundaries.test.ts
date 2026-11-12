import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { realRepo, setupLead } from './workers-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import * as leases from '../src/leases.js'
import { collectRecoveryRefs, deletePreservedWorkerBranch, preserveWorkerBranch, RECOVERY_REF_AGE_MS } from '../src/worker-refs.js'
import type { Session } from '../src/session.js'
import { removePreviewCache, runInMergedTree, waitForPreviewSweepForTests } from '../src/tools/files.js'

it.each(['present', 'inside-root', 'through-symlink'] as const)('review refs2: preserves a user registration %s when only its gitfile is missing', async mode => {
  const { repo, git, head } = realRepo()
  const common = fs.realpathSync(path.join(repo, '.git')), preview = path.join(common, 'room-preview')
  fs.mkdirSync(preview)
  const dir = mode !== 'through-symlink' ? path.join(preview, 'my-personal-worktree') : path.join(repo, 'personal')
  git('worktree', 'add', '--detach', '-q', dir, head)
  git('-C', dir, 'commit', '--allow-empty', '-qm', 'only in user detached HEAD')
  const tip = git('-C', dir, 'rev-parse', 'HEAD')
  const admin = git('-C', dir, 'rev-parse', '--absolute-git-dir')
  if (mode === 'through-symlink') {
    fs.symlinkSync(dir, path.join(preview, 'user-link'))
    fs.writeFileSync(path.join(admin, 'gitdir'), path.join(preview, 'user-link', '.git') + '\n')
  }
  if (mode !== 'present') fs.unlinkSync(path.join(dir, '.git'))
  const oldCap = process.env.ROOM_PREVIEW_CACHE_GB
  try {
    for (const command of ['echo "1 passed"', 'exit 1']) {
      process.env.ROOM_PREVIEW_CACHE_GB = '0.0000001'
      await runInMergedTree({ dir: repo } as Session, head, new Map(), command)
      await waitForPreviewSweepForTests()
      expect(fs.existsSync(admin)).toBe(true)
    }
  } finally {
    if (oldCap === undefined) delete process.env.ROOM_PREVIEW_CACHE_GB
    else process.env.ROOM_PREVIEW_CACHE_GB = oldCap
  }
  await removePreviewCache(repo)
  await waitForPreviewSweepForTests()
  const kept = fs.existsSync(admin)
  git('reflog', 'expire', '--expire=now', '--all')
  git('gc', '--prune=now')
  let reachable = true
  try { git('cat-file', '-e', tip) } catch { reachable = false }
  expect({ kept, reachable }).toEqual({ kept: true, reachable: true })
})

it('review refs2: obsolete receipts cannot expire a recreated annotated pin', () => {
  const { repo, git, head } = realRepo(), common = path.join(repo, '.git')
  const worker = { id: 'w_refs2', tag: 'refs2', branch: 'room/refs2' }
  const tip = git('commit-tree', head + '^{tree}', '-p', head, '-m', 'worker output')
  git('update-ref', 'refs/heads/' + worker.branch, tip)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  const pin = preserveWorkerBranch(common, worker).recoveryRef!, oid = git('rev-parse', pin)
  const file = path.join(common, 'room/registry/ref-writes', createHash('sha256').update(pin).digest('hex') + '.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ref: pin, oid: tip, owner: worker.id, createdAt: Date.now() - RECOVERY_REF_AGE_MS - 1000 }))
  git('update-ref', '--no-deref', '-d', pin, oid)
  const write = vi.spyOn(leases, 'writeAtomic')
  const recreated = preserveWorkerBranch(common, worker)
  expect(recreated.reason).toBeUndefined()
  expect(write).not.toHaveBeenCalled() // No side receipt, including on recreation.
  expect(git('rev-parse', pin)).not.toBe(oid) // Even within the same clock second.
  clock.mockRestore(); write.mockRestore()
  expect(deletePreservedWorkerBranch(common, worker, recreated)).toBeUndefined()
  const removed = collectRecoveryRefs(common)
  git('reflog', 'expire', '--expire=now', '--all'); git('gc', '--prune=now')
  expect(removed).toEqual([])
  expect(git('cat-file', '-t', tip)).toBe('commit')
})

it.each([['collect', 'carry-untracked'], ['discard', 'carry-untracked'], ['collect', 'collect-base'], ['discard', 'collect-base']] as const)('review refs2: %s reports every legacy %s pin', async (action, kind) => {
  const actual = await vi.importActual<typeof import('../src/worker-git.js')>('../src/worker-git.js')
  const loaded = await import('../src/worker-git.js')
  if (vi.isMockFunction(loaded.cleanupWorker)) loaded.cleanupWorker.mockImplementation(actual.cleanupWorker)
  const { repo, git, head } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  expect(await t.leadTools.call('room_spawn', { tag: 'old-refs2', task: 'review' })).toContain('spawned old-refs2')
  const record = (await registry.reserved('old-refs2'))!
  fs.unlinkSync(path.join(record.prep.witness!.adminDir, 'room-preparation.json'))
  await mutateWorkerFixture(registry, record.id, old => ({ ...old, prep: { step: 'prepared', created: true, branchCreated: true }, seq: old.seq + 1 }))
  // Old versions wrote this private pin without an authorized-write receipt.
  const untrackedTip = kind === 'carry-untracked' ? git('write-tree') : git('commit-tree', head + '^{tree}', '-m', 'legacy collection baseline')
  git('update-ref', kind === 'carry-untracked' ? 'refs/room/carry-untracked/' + record.tag : `refs/room/collect-base/${record.tag}/${record.id}`, untrackedTip)
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
  const reply = await t.leadTools.call('room_collect', { tag: record.tag, ...(action === 'discard' ? { discard: true } : {}) })
  expect(reply).not.toContain('error:')
  const pins = git('for-each-ref', '--format=%(refname)', 'refs/room/recovery/').split('\n').filter(Boolean)
  expect(pins).toHaveLength(2)
  git('reflog', 'expire', '--expire=now', '--all'); git('gc', '--prune=now')
  expect(git('cat-file', '-t', untrackedTip)).toBe(kind === 'carry-untracked' ? 'tree' : 'commit')
  for (const pin of pins) {
    expect(reply.split(pin), reply).toHaveLength(2)
    expect(git('cat-file', '-t', pin)).toBe('tag')
  }
})
