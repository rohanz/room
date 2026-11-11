import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { createPreviewTreePaths, fingerprintTree, validateFingerprintSync, collectedTreeEvidence, MAX_EQUIVALENCE_FILES, EquivalenceTooLarge, largeTreeReply } from '../src/preview-evidence.js'
import { runInMergedTree } from '../src/tools/files.js'
import { FileWorkerStore } from '../src/worker-file-store.js'
import { disposePreviewFixture } from './fixtures/preview-disposal.js'
import type { Session } from '../src/session.js'
import * as evidence from '../src/preview-evidence.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await disposePreviewFixture(root) }, 120_000)
function fixture(count: number) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-gate-capped-')))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  for (let i = 0; i < count; i++) {
    const dir = path.join(root, 'src', String(Math.floor(i / 100)).padStart(3, '0'))
    if (i % 100 === 0) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${String(i).padStart(5, '0')}.txt`), 'bytes\n')
  }
  git('add', '.'); git('commit', '-qm', 'base')
  return { root, head: git('rev-parse', 'HEAD') }
}

it.each([MAX_EQUIVALENCE_FILES, MAX_EQUIVALENCE_FILES + 1])('runs and grades preview plus collect at the %i-file boundary', async count => {
  const { root, head } = fixture(count)
  const result = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  const folder = path.join(root, '.git', 'room', 'preview-evidence')
  const record = JSON.parse(fs.readFileSync(path.join(folder, fs.readdirSync(folder).find(name => name.endsWith('.json'))!), 'utf8'))
  const registry = await FileWorkerStore.open(path.join(root, '.git'), { watch: false })
  let evidence: string
  try { evidence = await registry.withCollectLease(root, () => collectedTreeEvidence(root)) }
  finally { registry.close() }
  expect(record.complete).toBe(true)
  if (count === MAX_EQUIVALENCE_FILES) {
    expect(record.passed).toBe(true)
    expect(record.tree).not.toBeNull()
    expect(evidence).toContain('collected tree is identical to the tree that passed')
  } else {
    expect(record.passed).toBe(false)
    expect(record.tree).toBeNull()
    expect(record.equivalence).toBe('too-large')
    expect(record.reason).toContain('more than 2,000 files')
    expect(result.text).toContain('equivalence was not established because the tree has more than 2,000 files')
    expect(evidence).toBe(largeTreeReply)
    const failed = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 failed"; exit 7')
    expect(failed.passed).toBe(false)
    expect(failed.text).toContain('tests: FAILED')
    expect(failed.text).toContain('more than 2,000 files')
    // A later smaller destination should describe the unavailable preview, not
    // falsely say the current destination is still above the limit.
    execFileSync('git', ['-C', root, 'rm', '--quiet', 'src/020/02000.txt'])
    const smaller = await collectedTreeEvidence(root)
    expect(smaller).toContain('the most recent preview did not establish equivalence')
    expect(smaller).not.toContain('tree that passed')
    expect(smaller.startsWith('tree too large')).toBe(false)
  }
}, 60_000)

it('refuses an oversized fingerprint before reading any file', async () => {
  const { root, head } = fixture(1)
  const listing = await createPreviewTreePaths(root, head, root)
  try {
    expect(await listing.eligiblePaths()).toHaveLength(1)
    // Public fingerprint callers also fail before reading a file over the cap.
    const read = vi.spyOn(fs.promises, 'lstat')
    await expect(fingerprintTree('/does-not-exist', Array.from({ length: MAX_EQUIVALENCE_FILES + 1 }, (_, i) => `${i}`))).rejects.toBeInstanceOf(EquivalenceTooLarge)
    expect(read).not.toHaveBeenCalled()
  } finally { await listing.dispose() }
})

it.skipIf(process.env.TEST_SCALE !== '1').each([1_000, 2_000])('measures the actual cached-preview final synchronous stretch at %i files', async count => {
  const { root, head } = fixture(count)
  // Measure the actual cached path depth; shallower direct fixtures understate it.
  // Spies are passive: arguments, results and decisions are unchanged.
  const create = evidence.createPreviewTreePaths, validate = evidence.validateFingerprintSync
  let started: number | undefined, longest = 0, gates = 0, fingerprints = 0
  const fingerprint = evidence.fingerprintTree
  vi.spyOn(evidence, 'fingerprintTree').mockImplementation((...args) => { fingerprints++; return fingerprint(...args) })
  vi.spyOn(evidence, 'createPreviewTreePaths').mockImplementation(async (...args) => {
    const real = await create(...args)
    return { ...real, pathsSync() { started = performance.now(); return real.pathsSync() } }
  })
  vi.spyOn(evidence, 'validateFingerprintSync').mockImplementation((...args) => {
    try { return validate(...args) }
    finally { if (started !== undefined) { gates++; longest = Math.max(longest, performance.now() - started); started = undefined } }
  })
  const begin = performance.now()
  const result = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(gates).toBe(2)
  expect(fingerprints).toBe(2)
  expect(longest).toBeLessThan(200)
  process.stdout.write(JSON.stringify({ files: count, finalSynchronousGateMs: longest, gateCalls: gates, fingerprints, previewWallMs: performance.now() - begin, outcome: 'actual cached preview: Git listing plus one metadata pass over both observations' }) + '\n')
}, 120_000)

it('refuses equivalence if the real destination lease disappears during hashing', async () => {
  const { root, head } = fixture(1)
  expect((await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')).passed).toBe(true)
  const registry = await FileWorkerStore.open(path.join(root, '.git'), { watch: false })
  const open = fs.promises.open.bind(fs.promises)
  let lost = false
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    if (!lost && String(args[0]) === path.join(root, 'src', '000', '00000.txt')) {
      const folder = path.join(registry.root, 'collect')
      fs.unlinkSync(path.join(folder, fs.readdirSync(folder).find(name => name.endsWith('.json'))!))
      lost = true
    }
    return open(...args)
  })
  try {
    const result = await registry.withCollectLease(root, () => collectedTreeEvidence(root))
    expect(lost).toBe(true)
    expect(result).toContain('equivalence unavailable: destination collect lease ownership lost; validate it')
    expect(result).not.toContain('tree that passed')
  } finally { registry.close() }
})
