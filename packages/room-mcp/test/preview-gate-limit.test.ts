import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import * as baseline from '@room/roomd/baseline'
import * as evidence from '../src/preview-evidence.js'
import { runInMergedTree } from '../src/tools/files.js'
import { setPreviewLockUnavailableForTests } from '../src/preview-cache.js'
import type { Session } from '../src/session.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks(); setPreviewLockUnavailableForTests()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture(count = evidence.MAX_EQUIVALENCE_FILES) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-review-cap-')))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(root, `f${String(i).padStart(4, '0')}`), 'bytes\n')
  git('add', '.'); git('commit', '-qm', 'base')
  return { root, git, head: git('rev-parse', 'HEAD') }
}
function record(root: string) {
  const dir = path.join(root, '.git', 'room', 'preview-evidence')
  return JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('latest.json'))!), 'utf8'))
}
async function passingRecord(root: string, head: string) {
  const paths = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  const tree = await evidence.fingerprintTree(root, paths)
  await (await evidence.beginPreviewAttempt(root, 'earlier-small-command'))(tree, { complete: true, passed: true, exitCode: 0 }, head)
}

it('rejects a destination that grows from N to N+1 after eligibility and hashing despite a matching old record', async () => {
  const { root, head } = fixture()
  await passingRecord(root, head)
  const real = baseline.boundedGitSync
  let grew = false
  vi.spyOn(baseline, 'boundedGitSync').mockImplementation((dir, args, options) => {
    if (!grew && args.includes('ls-files')) { grew = true; fs.writeFileSync(path.join(root, 'extra'), 'new\n') }
    return real(dir, args, options)
  })
  expect(await evidence.collectedTreeEvidence(root)).toBe(evidence.largeTreeReply)
  expect(grew).toBe(true)
}, 120_000)

it.each([1, 2])('does not record passing equivalence when preview grows beyond N at final listing %i', async gate => {
  const { root, head } = fixture()
  await passingRecord(root, head)
  setPreviewLockUnavailableForTests(true)
  const real = evidence.createPreviewTreePaths
  let listings = 0
  vi.spyOn(evidence, 'createPreviewTreePaths').mockImplementation(async (...args) => {
    const listing = await real(...args)
    return { ...listing, pathsSync() {
      if (++listings === gate) fs.writeFileSync(path.join(args[2], 'extra'), 'new\n')
      return listing.pathsSync()
    } }
  })
  const result = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
  expect(listings).toBe(gate)
  expect(result.passed, result.text).toBe(true) // This grades the command only.
  expect(result.text).toContain(evidence.largeTreeReason)
  expect(record(root)).toMatchObject({ tree: null, passed: false, equivalence: 'too-large' })
  const smaller = await evidence.collectedTreeEvidence(root)
  expect(smaller).toContain('the most recent preview did not establish equivalence')
  expect(smaller).not.toContain('tree that passed')
}, 120_000)

it('retains too-large status when an oversized preview command shrinks below N', async () => {
  const { root } = fixture(evidence.MAX_EQUIVALENCE_FILES + 1)
  setPreviewLockUnavailableForTests(true)
  // Removing a tracked file still counts as an included missing path, so use a
  // merged untracked path as the 2,001st entry, then remove that during the command.
  execFileSync('git', ['-C', root, 'rm', '-q', 'f2000'])
  execFileSync('git', ['-C', root, 'commit', '-qm', 'small base'])
  const smallHead = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  await passingRecord(root, smallHead)
  const result = await runInMergedTree({ dir: root } as Session, smallHead, new Map([['extra', 'new\n']]), 'rm extra; echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(record(root)).toMatchObject({ tree: null, passed: false, equivalence: 'too-large' })
  expect(await evidence.collectedTreeEvidence(root)).toContain('the most recent preview did not establish equivalence')
}, 120_000)

it('counts distinct paths rather than duplicate unmerged Git stages at N and N+1', async () => {
  const { root, git, head } = fixture()
  await passingRecord(root, head)
  const blob = git('rev-parse', 'HEAD:f0000')
  execFileSync('git', ['-C', root, 'update-index', '--index-info'], { input: `0 ${'0'.repeat(40)}\tf0000\n100644 ${blob} 1\tf0000\n100644 ${blob} 2\tf0000\n100644 ${blob} 3\tf0000\n` })
  expect(execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)).toHaveLength(evidence.MAX_EQUIVALENCE_FILES + 2)
  expect(await evidence.collectedTreeEvidence(root)).toContain('collected tree is identical to the tree that passed')
  fs.writeFileSync(path.join(root, 'extra'), 'new\n')
  expect(await evidence.collectedTreeEvidence(root)).toBe(evidence.largeTreeReply)
}, 120_000)
