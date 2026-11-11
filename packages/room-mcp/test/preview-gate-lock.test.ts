import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const helper = vi.hoisted(() => ({ lose: undefined as undefined | (() => void) }))
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (!['lockf', 'flock'].includes(String(args[0]))) return actual.spawn(...args)
    // Model the lock holder's documented READY/close protocol. All Git/check
    // processes remain real; no OS helper or unowned process is killed.
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null as number | null })
    helper.lose = () => { child.exitCode = 1; child.stdin.end(); child.stdout.end(); child.emit('close', 1) }
    child.stdin.on('finish', () => { if (child.exitCode === null) { child.exitCode = 0; child.emit('close', 0) } })
    setImmediate(() => child.stdout.write('READY'))
    return child
  } }
})
import { runInMergedTree, waitForPreviewSweepForTests, previewCachePath } from '../src/tools/files.js'
import type { Session } from '../src/session.js'
import { collectedTreeEvidence } from '../src/preview-evidence.js'

afterEach(() => vi.restoreAllMocks())

it.skipIf(!['darwin', 'linux'].includes(process.platform))('does not certify after the cache lock helper exits during validation', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-review-lock-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(root, 'file.txt'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  let lost = false
  const original = fs.lstatSync
  vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    const stat = original(...args)
    if (!lost && String(args[0]).includes('room-preview') && String(args[0]).endsWith('/file.txt')) {
      lost = true
      queueMicrotask(() => helper.lose!())
    }
    return stat
  }) as typeof fs.lstatSync)
  try {
    const result = await runInMergedTree({ dir: root } as Session, git('rev-parse', 'HEAD'), new Map(), 'echo "1 passed"')
    expect(lost).toBe(true)
    const evidence = await collectedTreeEvidence(root)
    expect({ passed: result.passed, certified: evidence.includes('tree that passed') }, `${result.text}\n${evidence}`).toEqual({ passed: false, certified: false })
  } finally { vi.restoreAllMocks(); await waitForPreviewSweepForTests(); fs.rmSync(root, { recursive: true, force: true }) }
}, 30_000)

it.skipIf(!['darwin', 'linux'].includes(process.platform))('leaves the cache untouched and does not launch after setup loses its helper', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-review-setup-lock-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(root, 'file.txt'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const marker = path.join(root, 'command-started')
  let lost = false
  try {
    const result = await runInMergedTree({ dir: root } as Session, git('rev-parse', 'HEAD'), new Map([['file.txt', 'merged\n']]), `touch "${marker}"`, {
      observe: { mergedWrite() { lost = true; helper.lose!() } },
    })
    expect(lost).toBe(true)
    expect(result.passed, result.text).toBe(false)
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.readFileSync(path.join(await previewCachePath(root), 'file.txt'), 'utf8')).toBe('merged\n')
    expect(await collectedTreeEvidence(root)).not.toContain('tree that passed')
  } finally { await waitForPreviewSweepForTests(); fs.rmSync(root, { recursive: true, force: true }) }
}, 30_000)
