import { manifestText, manifestPaths } from './manifest-assert.js'
import { policyFromLevel } from '../src/policy.js'
import { it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Awareness } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, type RoomdOptions } from '../src/index.js'

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
const start = (dir: string, log: (line: string) => void, extra: Partial<RoomdOptions> = {}) => startRoomd({ policy: policyFromLevel('full'), dir, name: 'Test', room: 'ws://memory/skip-log', debounceMs: 20, log, ...extra, providerFactory: (_server, _room, doc) => {
  const awareness = new Awareness(doc)
  return { synced: true, awareness, on() {}, off() {}, destroy() { awareness.destroy() } } as unknown as WebsocketProvider
} })
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)) }
}

it('does not digest gitignored untracked files as repository changes', async () => {
  const dir = repo({ '.gitignore': 'logs/\n', 'app.py': 'x = 1\n' })
  const logs: string[] = []
  const daemon = await start(dir, line => logs.push(line), { skipLogMs: 300 })
  try {
    fs.mkdirSync(path.join(dir, 'logs'))
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, 'logs', `run-${i}.log`), `line ${i}\n`)
    await daemon.reconcileGitChanges()
    expect(daemon.roomDoc.manifestHead.get('Test')?.excluded).toEqual([])
    expect(manifestPaths(daemon.roomDoc, 'Test').filter(p => p.startsWith('logs/'))).toEqual([])
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
    await until(() => manifestText(daemon.roomDoc, 'app.py', 'Test') === 'x = 2\n' && manifestText(daemon.roomDoc, 'out/tracked.js', 'Test') === 'b\n')
    await daemon.settle()
    expect(daemon.skipped().ignore.filter(p => p.startsWith('test-results'))).toEqual([])
    expect(logs.filter(line => line.includes('test-results'))).toEqual([])
  } finally { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})
