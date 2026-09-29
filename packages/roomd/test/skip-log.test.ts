import { it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Awareness } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { defaultIgnoredPath, startRoomd, type RoomdOptions } from '../src/index.js'

vi.setConfig({ testTimeout: 30_000 })
beforeAll(() => { vi.stubEnv('CHOKIDAR_USEPOLLING', '1') })
afterAll(() => { vi.unstubAllEnvs() })

function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-log-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
  git('add', '.'); git('commit', '-qm', 'base')
  return dir
}
const start = (dir: string, log: (line: string) => void, extra: Partial<RoomdOptions> = {}) => startRoomd({ dir, name: 'Test', room: 'ws://memory/skip-log', debounceMs: 20, log, ...extra, providerFactory: (_server, _room, doc) => {
  const awareness = new Awareness(doc)
  return { synced: true, awareness, on() {}, off() {}, destroy() { awareness.destroy() } } as unknown as WebsocketProvider
} })

it.each(['__pycache__/app.pyc', 'app.pyo', '.coverage', 'sample.egg-info/PKG-INFO'])('default-ignores generated %s', relpath => {
  expect(defaultIgnoredPath(relpath)).toBe(true)
})
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)) }
}

it('logs ignored-file skips as one count per scan, not one line per file', async () => {
  const dir = repo({ '.gitignore': 'logs/\n', 'app.py': 'x = 1\n' })
  const logs: string[] = []
  const daemon = await start(dir, line => logs.push(line), { skipLogMs: 300 })
  try {
    fs.mkdirSync(path.join(dir, 'logs'))
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, 'logs', `run-${i}.log`), `line ${i}\n`)
    await until(() => daemon.skipped().ignore.filter(p => p.startsWith('logs/')).length === 30)
    await until(() => logs.filter(line => line.startsWith('skipped ')).reduce((n, line) => n + Number(line.match(/^skipped (\d+)/)![1]), 0) === 30)
    expect(logs.filter(line => line.startsWith('skip '))).toEqual([])
    const counts = logs.filter(line => line.startsWith('skipped '))
    expect(counts.length).toBeLessThanOrEqual(2)
    expect(counts.reduce((n, line) => n + Number(line.match(/^skipped (\d+)/)![1]), 0)).toBe(30)
    expect(counts[0]).toMatch(/^skipped \d+ file\(s\) \(\d+ \.gitignore\), e\.g\. logs\/run-\d+\.log$/)
  } finally { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})

it('does not watch ignored build output such as test-results/, but still watches build dirs holding tracked files', async () => {
  const dir = repo({ '.gitignore': 'test-results/\n', 'app.py': 'x = 1\n', 'out/tracked.js': 'a\n' })
  fs.mkdirSync(path.join(dir, 'test-results', 'trace'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'test-results', 'trace', 'old.jpeg'), 'x')
  const logs: string[] = []
  const daemon = await start(dir, line => logs.push(line))
  try {
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, 'test-results', 'trace', `page-${i}.jpeg`), `frame ${i}`)
    fs.writeFileSync(path.join(dir, 'out', 'tracked.js'), 'b\n')
    fs.writeFileSync(path.join(dir, 'app.py'), 'x = 2\n')
    await until(() => daemon.roomDoc.text('app.py', 'Test') === 'x = 2\n' && daemon.roomDoc.text('out/tracked.js', 'Test') === 'b\n')
    await daemon.settle()
    expect(daemon.skipped().ignore.filter(p => p.startsWith('test-results'))).toEqual([])
    expect(logs.filter(line => line.includes('test-results'))).toEqual([])
  } finally { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})

it.each(['full', 'declared'] as const)('shares a tracked lockfile but skips an untracked one at %s sharing', async share => {
  const dir = repo({ 'uv.lock': 'tracked base\n', 'app.py': 'x = 1\n' })
  const logs: string[] = []
  fs.writeFileSync(path.join(dir, 'uv.lock'), 'tracked change\n')
  fs.mkdirSync(path.join(dir, 'nested'))
  fs.writeFileSync(path.join(dir, 'nested', 'uv.lock'), 'generated\n')
  const daemon = await start(dir, line => logs.push(line), { share, scopePaths: share === 'declared' ? ['uv.lock', 'nested/uv.lock'] : undefined, skipLogMs: 20 })
  try {
    expect(daemon.roomDoc.overlayText('Test', 'uv.lock')?.toString()).toBe('tracked change\n')
    expect(daemon.roomDoc.overlayText('Test', 'nested/uv.lock')).toBeUndefined()
    expect(daemon.skipped().ignore).toContain('nested/uv.lock')
    fs.writeFileSync(path.join(dir, 'poetry.lock'), 'generated after join\n')
    await until(() => daemon.skipped().ignore.includes('poetry.lock'))
    await until(() => logs.some(line => line.includes('untracked lockfile')))
  } finally { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})

it.each(['full', 'declared'] as const)('shares an untracked lockfile after git add at %s sharing', async share => {
  const dir = repo({ 'app.py': 'x = 1\n' })
  const lockfile = path.join(dir, 'uv.lock')
  fs.writeFileSync(lockfile, 'generated\n')
  const daemon = await start(dir, () => {}, { share, scopePaths: share === 'declared' ? ['uv.lock'] : undefined, trackedRefreshMs: 50, basePollMs: 0, reconcileIntervalMs: 0 })
  try {
    expect(daemon.roomDoc.overlayText('Test', 'uv.lock')).toBeUndefined()
    expect(daemon.skipped().ignore).toContain('uv.lock')
    execFileSync('git', ['add', '--', 'uv.lock'], { cwd: dir })
    await until(() => daemon.roomDoc.overlayText('Test', 'uv.lock')?.toString() === 'generated\n')
    expect(daemon.skipped().ignore).not.toContain('uv.lock')
  } finally { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})

it('keeps a tracked lockfile deletion published before and after the tracked refresh', async () => {
  const dir = repo({ 'uv.lock': 'tracked base\n', 'app.py': 'x = 1\n' })
  const daemon = await start(dir, () => {}, { trackedRefreshMs: 60_000, basePollMs: 0, reconcileIntervalMs: 0 })
  try {
    execFileSync('git', ['rm', '-q', '--', 'uv.lock'], { cwd: dir })
    await (daemon as unknown as { onDiskChange(path: string, isNew: boolean): Promise<void> }).onDiskChange('uv.lock', false)
    expect(daemon.roomDoc.deletedFor('Test').has('uv.lock')).toBe(true)
    await (daemon as unknown as { refreshTracked(): Promise<void> }).refreshTracked()
    await (daemon as unknown as { onDiskChange(path: string, isNew: boolean): Promise<void> }).onDiskChange('uv.lock', false)
    expect(daemon.roomDoc.deletedFor('Test').has('uv.lock')).toBe(true)
  } finally { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})

it.each(['rm --cached', 'restore --staged'] as const)('withdraws a newly added lockfile after git %s', async command => {
  const dir = repo({ 'app.py': 'x = 1\n' })
  fs.writeFileSync(path.join(dir, 'uv.lock'), 'generated\n')
  const daemon = await start(dir, () => {}, { trackedRefreshMs: 60_000, basePollMs: 0, reconcileIntervalMs: 0 })
  try {
    execFileSync('git', ['add', '--', 'uv.lock'], { cwd: dir })
    await (daemon as unknown as { refreshTracked(): Promise<void> }).refreshTracked()
    await until(() => daemon.roomDoc.overlayText('Test', 'uv.lock')?.toString() === 'generated\n')
    execFileSync('git', [...command.split(' '), '--', 'uv.lock'], { cwd: dir })
    await (daemon as unknown as { refreshTracked(): Promise<void> }).refreshTracked()
    await until(() => daemon.roomDoc.overlayText('Test', 'uv.lock') === undefined)
    expect(daemon.skipped().ignore).toContain('uv.lock')
  } finally { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})
