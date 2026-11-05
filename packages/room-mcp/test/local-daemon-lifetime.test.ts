import { relayHealth } from '@room/relay'
import { recordTestDaemon, stopTestDaemon } from './daemon-fixture.js'
import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { RoomDoc } from '@room/shared'
import { memoryFile } from '../../relay/src/memory.js'
import { detachCheckout, joinSession, leaveSession, type Session } from '../src/session.js'
import { AutoJoin } from '../src/auto-join.js'
import { PresenceEnd, IDLE_LEASE_MS } from '../src/presence-end.js'
import { rejoinOptions } from '../src/tools/join.js'
import { createTools } from '../src/tools.js'
import { disposePreviewFixture } from './fixtures/preview-disposal.js'

// Model unavailable startup/storage without replacing the session/provider recovery path.
const recoveryBlocked = vi.hoisted(() => new Set<string>())
vi.mock('@room/relay', async importOriginal => {
  const relay = await importOriginal<typeof import('@room/relay')>()
  return { ...relay, ensureLocalDaemon: (...args: Parameters<typeof relay.ensureLocalDaemon>) => {
    if (recoveryBlocked.has(args[0])) return Promise.reject(new Error('test: daemon storage unavailable'))
    return relay.ensureLocalDaemon(...args)
  } }
})

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => { recoveryBlocked.clear(); for (const stop of cleanup.splice(0).reverse()) await stop() })
function repo(parent = os.tmpdir()) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'room-daemon-client-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'Ada')
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\n'); git('add', '.'); git('commit', '-qm', 'init')
  return dir
}
const pidOf = (s: Session) => (s.local as typeof s.local & { pid: number }).pid
function track(s: Session) {
  cleanup.push(() => leaveSession(s, { preserveReplica: false }))
  cleanup.unshift(() => stopTestDaemon(path.join(s.dir, '.git')))
  return s
}

it('a daemon outlives its separate launching MCP process and the surviving worker remains connected', async () => {
  const dir = repo()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !key.startsWith('ROOM_') && value !== undefined)) as Record<string, string>
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', import.meta.resolve('tsx'), path.join(root, 'packages/room-mcp/src/index.ts')], cwd: dir, env: { ...env, ROOM_DIR: dir }, stderr: 'pipe' })
  const client = new Client({ name: 'launcher', version: '1' })
  await client.connect(transport)
  cleanup.push(() => client.close())
  await client.callTool({ name: 'room_state', arguments: {} }, undefined, { timeout: 60_000 })
  recordTestDaemon(path.join(dir, '.git')) // This fixture's MCP child just started the daemon.
  const survivor = track(await joinSession({ dir, name: 'Ada', tag: 'worker' }))
  const pid = pidOf(survivor)
  const authority = fs.readFileSync(path.join(dir, '.git', 'room', 'hub', 'authority.lock'), 'utf8')
  expect(pid).not.toBe(process.pid)
  expect(pid).not.toBe(transport.pid)
  await client.close()
  expect(survivor.provider.wsconnected).toBe(true)
  expect(pidOf(survivor)).toBe(pid)
  expect(fs.readFileSync(path.join(dir, '.git', 'room', 'hub', 'authority.lock'), 'utf8')).toBe(authority)
  expect((await survivor.post(survivor.me, { type: 'note', text: 'launcher has exited' })).ok).toBe(true)
}, 90_000)

it('preview fixture disposal waits for every clone daemon to exit before removing its root', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-daemon-dispose-')))
  cleanup.unshift(() => disposePreviewFixture(root))
  const a = track(await joinSession({ dir: repo(root), name: 'Ada' }))
  const b = track(await joinSession({ dir: repo(root), name: 'Bo' }))
  const endpoints = [a, b].map(s => ({ port: s.local!.port, key: s.local!.key }))
  await leaveSession(a)
  await leaveSession(b)
  await disposePreviewFixture(root, { registries: [a.dir, b.dir] })
  expect(fs.existsSync(root)).toBe(false)
  for (const endpoint of endpoints) expect(await relayHealth(endpoint.port, endpoint.key)).toBeUndefined()
}, 60_000)

it.each([false, true])('daemon crash resyncs an acknowledged unsaved post through the same session (fallback port=%s)', async fallback => {
  const dir = repo()
  const logs: string[] = []
  const survivor = track(await joinSession({ dir, name: 'Ada', tag: 'survivor', log: line => logs.push(line) }))
  const doc = survivor.room.doc, provider = survivor.provider
  const file = memoryFile(path.join(dir, '.git'), survivor.roomName)
  await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true), { timeout: 15_000 })
  const id = `m_surviving_${fallback}`
  const posted = await survivor.post(survivor.me, { type: 'note', text: 'acknowledged but absent from disk' }, { id })
  expect(posted.ok).toBe(true)
  await vi.waitFor(() => expect(survivor.room.message(id)).toBeDefined())
  const oldPort = survivor.local!.port, oldPid = pidOf(survivor)
  expect((await relayHealth(oldPort, survivor.local!.key))?.pid).toBe(oldPid)
  process.kill(oldPid, 'SIGKILL')
  const disk = new Y.Doc()
  if (fs.existsSync(file)) Y.applyUpdate(disk, fs.readFileSync(file))
  expect(new RoomDoc(disk).message(id)).toBeUndefined() // establish the sole surviving replica premise
  disk.destroy()
  let occupied: http.Server | undefined
  if (fallback) {
    occupied = http.createServer((_req, res) => res.end('foreign listener'))
    await vi.waitFor(() => new Promise<void>((resolve, reject) => { occupied!.once('error', reject); occupied!.listen(oldPort, '127.0.0.1', resolve) }), { timeout: 5000, interval: 20 })
    cleanup.push(() => new Promise<void>(resolve => occupied!.close(() => resolve())))
  }
  await vi.waitFor(() => {
    expect(pidOf(survivor)).not.toBe(oldPid)
    expect(survivor.provider.wsconnected && survivor.provider.synced).toBe(true)
  }, { timeout: 40_000, interval: 50 }).catch(error => {
    const record = JSON.parse(fs.readFileSync(path.join(dir, '.git', 'room', 'relay.json'), 'utf8')) as { pid: number; port: number }
    throw new Error(`${String(error)}; recovery logs: ${logs.slice(-8).join(' | ')}; closed=${JSON.stringify(survivor.closed)}; connected=${survivor.provider.wsconnected}; discovery pid=${record.pid} port=${record.port}`, { cause: error })
  })
  track(survivor)
  expect(survivor.room.doc).toBe(doc)
  expect(survivor.provider).toBe(provider)
  expect(doc.isDestroyed).toBe(false)
  if (fallback) expect(survivor.local!.port).not.toBe(oldPort)
  else expect(survivor.local!.port).toBe(oldPort)
  const observer = track(await joinSession({ dir, name: 'Observer' }))
  await vi.waitFor(() => expect(observer.room.message(id)).toBeDefined(), { timeout: 10_000 })
  await vi.waitFor(async () => expect((await survivor.post(survivor.me, { type: 'note', text: 'acknowledged but absent from disk' }, { id })).ok).toBe(true), { timeout: 10_000 })
  expect(observer.room.messages().filter(message => message.id === id)).toHaveLength(1)
  await leaveSession(survivor, { preserveReplica: false })
  expect(doc.isDestroyed).toBe(true)
}, 90_000)

it('host identity replacement preserves the exact replica through roomd shutdown and initialization', async () => {
  const dir = repo()
  const old = track(await joinSession({ dir, name: 'Ada', sessionId: 'before-clear' }))
  const reuse = detachCheckout(old)
  const doc = old.room.doc
  doc.getMap('rebind-test').set('retained-for-rebind', true)
  await leaveSession(old)
  expect(doc.isDestroyed).toBe(false)
  const rebound = track(await joinSession({ dir, name: 'Ada', sessionId: 'after-clear', reuse }))
  expect(rebound.room.doc).toBe(doc)
  expect(rebound.room.doc.getMap('rebind-test').has('retained-for-rebind')).toBe(true)
  await leaveSession(rebound, { preserveReplica: false })
  expect(doc.isDestroyed).toBe(true)
}, 60_000)

it('daemon death, exhausted recovery and idle drop retain an acknowledged unsaved post for automatic rejoin; room_leave disposes', async () => {
  const dir = repo(), common = path.join(dir, '.git')
  const logs: string[] = []
  const old = track(await joinSession({ dir, name: 'Ada', log: line => logs.push(line) }))
  const doc = old.room.doc, file = memoryFile(common, old.roomName)
  await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true), { timeout: 15_000 })
  const id = 'm_surviving_idle_drop'
  expect((await old.post(old.me, { type: 'note', text: 'acknowledged before idle expiry' }, { id })).ok).toBe(true)
  await vi.waitFor(() => expect(old.room.message(id)).toBeDefined())
  recoveryBlocked.add(common)
  process.kill(pidOf(old), 'SIGKILL')
  const disk = new Y.Doc()
  Y.applyUpdate(disk, fs.readFileSync(file))
  expect(new RoomDoc(disk).message(id)).toBeUndefined()
  disk.destroy()
  await vi.waitFor(() => expect(logs.some(line => line.includes('recovery paused; replica retained'))).toBe(true), { timeout: 30_000 })

  let session: Session | null = old
  const tools = createTools({ getSession: () => session, setSession: s => { session = s }, cwd: dir, log: line => logs.push(line) })
  cleanup.push(() => tools.shutdown())
  const auto = new AutoJoin({
    local: true, joined: () => !!session, log: () => {}, report: () => {},
    attempt: target => joinSession({ ...rejoinOptions(target!), reuse: detachCheckout(target!) }),
    adopt: async s => { session = track(s) },
    discard: async (s, reason) => { await leaveSession(s, { preserveReplica: reason !== 'leave' }) },
  })
  auto.remember(old)
  tools.setAutoJoin(auto)
  let now = 0
  const presence = new PresenceEnd({
    hostKind: 'shared-app-server', episodeId: 'test', tickMs: 0, mono: () => now,
    hostAlive: () => true, holds: () => false, leadsWorkers: () => false, waiting: () => false,
    hostEnded: () => {}, releaseHeld: async () => {},
    leave: async () => { for (const s of tools.joinedSessions().reverse()) await tools.drop(s, 'idle lease') },
  })
  now = IDLE_LEASE_MS
  await presence.tick()
  expect(presence.hasLeft).toBe(true)
  expect(session).toBeNull()
  expect(doc.isDestroyed).toBe(false)
  expect(old.room.message(id)).toBeDefined()

  recoveryBlocked.delete(common)
  presence.activity()
  await auto.ensure()
  expect(session).not.toBeNull()
  expect(session!.room.doc).toBe(doc)
  const observer = track(await joinSession({ dir, name: 'Observer' }))
  await vi.waitFor(() => expect(observer.room.message(id)).toBeDefined(), { timeout: 10_000 })
  expect(observer.room.messages().filter(message => message.id === id)).toHaveLength(1)
  expect(await tools.call('room_leave', {})).toContain('left local/')
  expect(doc.isDestroyed).toBe(true)
  await auto.ensure()
  expect(session).toBeNull()
}, 90_000)
