import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { beginPreviewAttempt, collectedTreeEvidence, fingerprintTree, validateFingerprint } from '../src/preview-evidence.js'
import { cleanupWorkerLogs } from '../src/worker-git.js'
import { FileWorkerStore } from '../src/worker-file-store.js'
import { writeWorkerArtifacts } from '../src/worker-artifacts.js'
import { runInMergedTree } from '../src/tools/files.js'
import { setPreviewLockUnavailableForTests } from '../src/preview-cache.js'
import type { Session } from '../src/session.js'
import { setPending, setCredential, removeCredential } from '../src/credentials.js'
import { defaultSpawner } from '../src/worker-process.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  setPreviewLockUnavailableForTests()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

it('does not report a passing preview when cancelled in the post-command final observation await', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-review-preview-abort-')))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(root, 'file.txt'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  setPreviewLockUnavailableForTests(true)
  const controller = new AbortController(), original = fs.lstatSync
  let observations = 0
  vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    const stat = original(...args)
    if (String(args[0]).includes('room-merge-') && String(args[0]).endsWith('/file.txt') && ++observations === 2)
      queueMicrotask(() => controller.abort(new Error('cancelled during final observation')))
    return stat
  }) as typeof fs.lstatSync)
  const result = await runInMergedTree({ dir: root } as Session, git('rev-parse', 'HEAD'), new Map(), 'echo "1 passed"', { signal: controller.signal })
  expect(controller.signal.aborted).toBe(true)
  const evidence = await collectedTreeEvidence(root)
  expect({ passed: result.passed, certified: evidence.includes('tree that passed') }, `${result.text}\n${evidence}`).toEqual({ passed: false, certified: false })
}, 30_000)

it('rejects cancellation delivered in the final observation await', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-review-abort-')))
  roots.push(root)
  fs.writeFileSync(path.join(root, 'file.txt'), 'base\n')
  const tree = await fingerprintTree(root, ['file.txt'])
  const controller = new AbortController()
  const original = fs.lstatSync
  vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    const stat = original(...args)
    if (String(args[0]) === path.join(root, 'file.txt')) queueMicrotask(() => controller.abort(new Error('cancelled during final observation')))
    return stat
  }) as typeof fs.lstatSync)
  await expect((async () => {
    const final = await validateFingerprint(tree, async () => ['file.txt'], controller.signal)
    final()
  })()).rejects.toThrow('cancelled during final observation')
})

it.each(['cleanup', 'artifact', 'login-pending', 'login-save', 'login-remove', 'spawn-log'] as const)('keeps the same-process %s writer after the synchronous gate decision, then detects its changed tree', async writer => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-review-gate-')))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  fs.mkdirSync(path.join(root, '.room', 'workers'), { recursive: true })
  const log = path.join(root, '.room', 'workers', 'old.log')
  fs.writeFileSync(log, '{"wss://review.invalid":{"session":"test-only","login":"fixture","at":0}}\n')
  // No .gitignore is required by Room. Even an ignored log can be explicitly tracked.
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(root, `z${i.toString().padStart(3, '0')}.txt`), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const paths = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean).sort()
  const tree = await fingerprintTree(root, paths)
  const finish = await beginPreviewAttempt(root, 'true')
  await finish(tree, { complete: true, exitCode: 0, passed: true }, git('rev-parse', 'HEAD'))
  const original = fs.lstatSync
  let scheduled = false, cleaned = false
  let childEnded: Promise<void> | undefined
  vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    const stat = original(...args)
    if (!scheduled && String(args[0]) === log) {
      scheduled = true
      setImmediate(() => {
        if (writer === 'cleanup') cleaned = cleanupWorkerLogs(root, { id: 'old-worker', tag: 'old', outside: false, dir: path.join(root, '.room', 'workers', 'old') })
        else if (writer === 'artifact') cleaned = writeWorkerArtifacts(root, { artifacts: [{ id: 'shell-env', path: log, content: 'replacement\n', mode: 0o600 }], artifactEnv: [], envPatch: {} }).outcomes[0]!.written
        else if (writer === 'login-pending') { setPending(log, 'wss://review.invalid', { provider: 'github', device: 'fixture-only', expires_in: 100, interval: 1, startedAt: 0 }); cleaned = true }
        else if (writer === 'login-save') { setCredential(log, 'wss://review.invalid', { session: 'new-test-only', login: 'fixture', at: 1 }); cleaned = true }
        else if (writer === 'login-remove') cleaned = removeCredential(log, 'wss://review.invalid')
        else {
          const child = defaultSpawner({ cmd: process.execPath, args: ['-e', ''], cwd: root, env: {}, logFile: path.join(root, '.room', 'workers', 'new.log') })
          childEnded = new Promise(resolve => { child.onExit(() => resolve()); child.onError?.(() => resolve()) })
          void child.started.catch(() => {})
          cleaned = fs.existsSync(path.join(root, '.room', 'workers', 'new.log'))
        }
      })
    }
    return stat
  }) as typeof fs.lstatSync)
  const registry = await FileWorkerStore.open(path.join(root, '.git'), { watch: false })
  let result: string, afterWrite: string
  try {
    result = await registry.withCollectLease(root, async () => {
      const decision = await collectedTreeEvidence(root)
      // Check before lease release, which can itself wait on a guard. Each real
      // writer is queued from an already-checked file; the synchronous final
      // listing/metadata/report must finish before its setImmediate callback.
      expect(scheduled).toBe(true)
      expect(cleaned).toBe(false)
      return decision
    })
    expect(result).toContain('collected tree is identical to the tree that passed')
    await new Promise<void>(resolve => setImmediate(resolve))
    await childEnded
    // Once cleanup/artifact/credentials/log creation runs, a fresh comparison
    // must observe its removal/replacement/new included path and refuse reuse.
    afterWrite = await registry.withCollectLease(root, () => collectedTreeEvidence(root))
  } finally { registry.close(); await childEnded }
  expect(cleaned).toBe(true)
  if (writer === 'cleanup') expect(fs.existsSync(log)).toBe(false)
  else if (writer === 'artifact') expect(fs.readFileSync(log, 'utf8')).toBe('replacement\n')
  expect(afterWrite).not.toContain('collected tree is identical to the tree that passed')
})
