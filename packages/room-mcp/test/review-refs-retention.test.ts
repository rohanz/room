import path from 'node:path'
import { expect, it, vi } from 'vitest'
import * as baseline from '@room/roomd/baseline'
import { realRepo } from './workers-fixture.js'
import { collectLocalState } from '../src/local-state-gc.js'
import { collectRecoveryRefs, deletePreservedWorkerBranch, preserveWorkerBranch, recoveryRefDescription, RECOVERY_REF_AGE_MS } from '../src/worker-refs.js'

function fixture() {
  const f = realRepo(), common = path.join(f.repo, '.git'), worker = { id: 'w_review', tag: 'review', branch: 'room/review' }
  const tip = f.git('commit-tree', f.head + '^{tree}', '-p', f.head, '-m', 'unique worker commit')
  const branch = 'refs/heads/' + worker.branch, pin = 'refs/room/recovery/' + worker.tag + '/' + tip
  f.git('update-ref', branch, tip)
  return { ...f, common, worker, tip, branch, pin }
}
// Inject at the real transaction boundary; Git still performs every comparison.
function beforeTransaction(change: () => void) {
  const run = baseline.boundedGitSync
  let changed = false
  vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
    if (!changed && args[1].includes('--stdin')) { changed = true; change() }
    return run(...args)
  })
}
it.each(['delete', 'reset', 'symbolic'] as const)('changing another branch to %s cannot strand the pinned worker tip', action => {
  const { git, common, worker, tip, branch, head, pin } = fixture()
  git('branch', 'protector', tip)
  const receipt = preserveWorkerBranch(common, worker)
  beforeTransaction(() => action === 'symbolic' ? git('symbolic-ref', 'refs/heads/protector', branch) : action === 'delete' ? git('branch', '-D', 'protector') : git('update-ref', 'refs/heads/protector', head, tip))
  expect(deletePreservedWorkerBranch(common, worker, receipt)).toBeUndefined()
  expect(git('for-each-ref', '--format=%(refname)', branch)).toBe('')
  git('symbolic-ref', 'refs/heads/protector', pin)
  expect(collectRecoveryRefs(common)).toEqual([])
  expect(git('rev-parse', `${pin}^{commit}`)).toBe(tip)
})
it('expiry can delete a same-OID symbolic replacement but preserves its target (Git 2.45 limit)', () => {
  const { git, common, worker, tip, pin } = fixture()
  const receipt = preserveWorkerBranch(common, worker), oid = git('rev-parse', pin)
  deletePreservedWorkerBranch(common, worker, receipt)
  git('update-ref', 'refs/room/saved', oid)
  beforeTransaction(() => git('symbolic-ref', pin, 'refs/room/saved'))
  expect(collectRecoveryRefs(common, Date.now() + RECOVERY_REF_AGE_MS)).toEqual([pin])
  expect(git('for-each-ref', '--format=%(refname)', pin)).toBe('')
  expect(git('rev-parse', 'refs/room/saved^{commit}')).toBe(tip)
})
it('peels for branch/log, survives GC, and expires exactly a week after tag creation even when packed', () => {
  const { common, worker, pin, git, tip } = fixture(), createdAt = Math.floor(Date.now() / 1000) * 1000
  const clock = vi.spyOn(Date, 'now').mockReturnValue(createdAt)
  const receipt = preserveWorkerBranch(common, worker), oid = git('rev-parse', pin)
  preserveWorkerBranch(common, worker, receipt)
  expect(git('rev-parse', pin)).toBe(oid)
  expect(git('cat-file', '-t', oid)).toBe('tag')
  git('branch', 'recovered', pin)
  expect(git('rev-parse', 'recovered')).toBe(tip)
  expect(git('log', '-1', '--format=%H', pin)).toBe(tip)
  git('branch', '-D', 'recovered')
  expect(deletePreservedWorkerBranch(common, worker, receipt)).toBeUndefined()
  git('pack-refs', '--all'); git('reflog', 'expire', '--expire=now', '--all'); git('gc', '--prune=now')
  expect(git('cat-file', '-t', tip)).toBe('commit')
  clock.mockRestore()
  expect(collectLocalState(common, { now: () => createdAt + RECOVERY_REF_AGE_MS - 1 }).removed).not.toContain(pin)
  expect(collectLocalState(common, { now: () => createdAt + RECOVERY_REF_AGE_MS, dryRun: true }).removed).toContain(pin)
  expect(git('rev-parse', pin)).toBe(oid)
  expect(collectLocalState(common, { now: () => createdAt + RECOVERY_REF_AGE_MS }).removed).toEqual([pin])
})
it.each(['legacy', 'foreign-tag', 'future', 'moved-pin', 'symbolic', 'during-delete', 'unreadable'] as const)('retains %s pins', mode => {
  const { git, common, worker, tip, head, pin } = fixture()
  if (mode === 'future') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * RECOVERY_REF_AGE_MS)
  const receipt = preserveWorkerBranch(common, worker), oid = git('rev-parse', pin)
  deletePreservedWorkerBranch(common, worker, receipt)
  vi.restoreAllMocks()
  if (mode === 'legacy' || mode === 'moved-pin') git('update-ref', pin, mode === 'legacy' ? tip : head, oid)
  else if (mode === 'foreign-tag') { git('tag', '-a', 'personal', tip, '-m', 'personal'); git('update-ref', pin, git('rev-parse', 'personal'), oid) }
  else if (mode === 'symbolic') git('symbolic-ref', pin, 'refs/heads/main')
  else if (mode === 'during-delete') beforeTransaction(() => git('update-ref', pin, head, oid))
  else if (mode === 'unreadable') {
    const run = baseline.boundedGitSync
    vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => { if (args[1].includes('cat-file')) throw new Error('unreadable object'); return run(...args) })
  }
  expect(collectRecoveryRefs(common, Date.now() + 2 * RECOVERY_REF_AGE_MS)).toEqual([])
  expect(git('rev-parse', `${pin}^{commit}`)).toBe(['moved-pin', 'symbolic', 'during-delete'].includes(mode) ? head : tip)
  if (mode === 'legacy') expect(recoveryRefDescription(common, pin)).toContain('creation time unrecorded')
})
it('dates every pin with one Git call when none is old enough to go, and still expires an old one', () => {
  const { git, common, worker, tip, pin } = fixture()
  preserveWorkerBranch(common, worker)
  // More pins of the same shape, plus two things that are never pins: a plain ref and a foreign annotated tag.
  const pinOid = git('rev-parse', pin)
  for (let i = 0; i < 20; i++) git('update-ref', `refs/room/recovery/extra${i}/${tip}`, pinOid)
  git('update-ref', `refs/room/recovery/plain/${tip}`, tip)
  git('tag', '-a', '-m', 'not a Room pin', 'foreign', tip)
  git('update-ref', `refs/room/recovery/foreign/${tip}`, git('rev-parse', 'refs/tags/foreign'))
  const calls = vi.spyOn(baseline, 'boundedGitSync')
  try {
    expect(collectRecoveryRefs(common)).toEqual([])
    expect(calls).toHaveBeenCalledTimes(1)
  } finally { calls.mockRestore() }
  const removed = collectRecoveryRefs(common, Date.now() + RECOVERY_REF_AGE_MS)
  expect(removed).toHaveLength(21)
  expect(removed).toContain(pin)
  // What is not a Room pin is never expired, however old.
  expect(git('rev-parse', `refs/room/recovery/plain/${tip}`)).toBe(tip)
  expect(git('rev-parse', `refs/room/recovery/foreign/${tip}^{commit}`)).toBe(tip)
})
