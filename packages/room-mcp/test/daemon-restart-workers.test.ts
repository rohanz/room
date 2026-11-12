import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRelayInfo, relayHealth } from '@room/relay'
import { joinSession, leaveSession, type Session } from '../src/session.js'
import { createTools } from '../src/tools.js'
import { registryForDir } from '../src/worker-registry.js'
import { requireWorkerInventory } from '../src/worker-store.js'
import { prepareWorktree } from '../src/worker-git.js'
import { disposePreviewFixture } from './fixtures/preview-disposal.js'
import { finishFixtureProcess, fixtureProbe, spawnFixtureProcess } from './fixtures/process-liveness.js'

// Only the worker host is synthetic; daemon launch, idle exit, sessions and registry are real.
vi.mock('../src/hosts/codex-install.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/hosts/codex-install.js')>()
  const { CURRENT_COMPAT } = await import('@room/hub-core')
  return { ...real, installedCodexRoomContract: () => ({ release: 'test-install', compat: CURRENT_COMPAT, workerRecordSchema: 1 }) }
})
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

it.each([
  { kind: 'failed-preparation', occupiedPort: false },
  { kind: 'failed-preparation', occupiedPort: true },
  { kind: 'unconfirmed-launch', occupiedPort: false },
  { kind: 'unconfirmed-launch', occupiedPort: true },
] as const)('joins and spawns after daemon idle exit with a $kind record lacking child identity (occupied port: $occupiedPort)', async ({ kind, occupiedPort }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-daemon-worker-restart-')))
  cleanups.push(() => disposePreviewFixture(dir, { registries: [dir] }))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Ada'); git('config', 'user.email', 'a@example.invalid')
  git('commit', '-qm', 'init', '--allow-empty')
  const common = path.join(dir, '.git'), room = 'local/restart-workers'
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../../relay/test/daemon-child.ts', import.meta.url)), common, room, '300000', 'fake'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited
    }
  })
  let startup = '', ready = false
  child.stderr!.on('data', chunk => { startup += String(chunk) })
  child.on('message', message => { if ((message as { ready?: unknown }).ready) ready = true })
  await vi.waitFor(() => { if (child.exitCode !== null) throw new Error(startup); expect(ready).toBe(true) }, { timeout: 10_000 })
  const drain = path.join(common, 'room/daemon-cutover.json')
  if (kind === 'unconfirmed-launch') fs.writeFileSync(drain, JSON.stringify({ v: 1, at: 1 }), { mode: 0o600 })
  let session: Session | null = await joinSession({ dir, server: 'local', room, name: 'Ada' })
  const registry = await registryForDir(dir)
  let failPreparation = true, launches = 0
  const callbacks: ((code: number | null) => void)[] = []
  const tools = createTools({ cwd: dir, getSession: () => session, setSession: s => { session = s }, maxWorkers: kind === 'failed-preparation' ? 1 : 2,
    probe: fixtureProbe, listCwdProcesses: () => [],
    worktree: (repo, tag) => {
      if (failPreparation) throw new Error('preparation failed before host launch')
      return prepareWorktree(repo, tag, 'Ada')
    },
    spawner: () => {
      launches++
      const pid = 2147482000; spawnFixtureProcess(pid)
      return { pid, started: Promise.resolve(), onExit: callback => { callbacks.push(callback) }, kill: () => {
        finishFixtureProcess(pid); for (const callback of callbacks.splice(0)) callback(0); return true
      } }
    },
  })
  cleanups.push(async () => { await tools.shutdown(); if (session) await leaveSession(session) })
  expect(await tools.call('room_spawn', { host: 'codex', tag: 'old', task: 'never launched' })).toContain('preparation failed before host launch')
  expect(launches).toBe(0)
  const failed = requireWorkerInventory(await registry.list()).find(record => record.tag === 'old')!
  expect(failed.phase).toBe('abandoned')
  expect(failed.runs.at(-1)?.launch).toBeUndefined()
  // Unconfirmed retained launches still consume capacity, but do not block daemon ownership or available slots.
  if (kind === 'unconfirmed-launch') await registry.command(failed.id, { type: 'launch', run: 1,
    phase: 'active', launch: { outcome: 'ambiguous', at: Date.now() } })
  const first = readRelayInfo(common)!
  await leaveSession(session); session = null
  await vi.waitFor(async () => expect((await relayHealth(first.port, first.key))?.writers).toBe(0))
  child.send({ command: 'clock', now: 300000 })
  await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 10_000 })
  expect(readRelayInfo(common)?.pid).toBe(child.pid)
  // Exercise both same-port hand-over and the supported fallback around an unrelated listener.
  if (occupiedPort) {
    const occupant = http.createServer((_req, res) => { res.writeHead(404); res.end() })
    await new Promise<void>((resolve, reject) => { occupant.once('error', reject); occupant.listen(first.port, '127.0.0.1', resolve) })
    cleanups.push(() => new Promise<void>((resolve, reject) => occupant.close(error => error ? reject(error) : resolve())))
  }
  // Existing drain files are inert; restarting needs no operator attestation. Fresh clones need no drain file.
  const beforeDrain = fs.existsSync(drain) ? fs.readFileSync(drain, 'utf8') : undefined
  session = await joinSession({ dir, server: 'local', room, name: 'Ada' })
  expect(session.provider.synced).toBe(true)
  expect(readRelayInfo(common)?.pid).not.toBe(child.pid)
  if (occupiedPort) expect(readRelayInfo(common)?.port).not.toBe(first.port)
  else expect(readRelayInfo(common)?.port).toBe(first.port)
  expect(fs.existsSync(drain) ? fs.readFileSync(drain, 'utf8') : undefined).toBe(beforeDrain)
  expect(await tools.call('room_state', { check: true })).not.toContain('cutover')
  failPreparation = false
  expect(await tools.call('room_spawn', { host: 'codex', tag: 'new', task: 'new task', carry: false })).toContain('spawned new:')
  expect(launches).toBe(1)
}, 45_000)
