import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { Roomd } from '@room/roomd'
import { WebsocketProvider } from 'y-websocket'
import { joinSession, startAutoTaggedRoomd } from '../src/session.js'
import { withToolSignal } from '../src/registry.js'
import { writeChoice } from '../src/choice.js'
import { sharingFile, PolicyStore } from '../src/policy-store.js'
import { teamHealth } from './fixtures/team-server.js'

const state = vi.hoisted(() => ({
  daemon: undefined as Roomd | undefined,
  detach: undefined as undefined | (() => Promise<void>),
  acquire: undefined as undefined | ((name: string) => Promise<void>),
  validate: undefined as undefined | (() => Promise<void>),
  providers: [] as any[], cancelled: false, outbound: [] as Uint8Array[],
}))
vi.mock('y-websocket', () => ({ WebsocketProvider: class extends EventEmitter {
  synced = true; wsconnected = true; awareness: Awareness; destroyed = false
  constructor(_server: string, _room: string, readonly doc: Y.Doc) {
    super(); this.awareness = new Awareness(doc); state.providers.push(this)
    doc.on('update', this.send)
  }
  send = (bytes: Uint8Array) => { if (!this.destroyed && state.cancelled) state.outbound.push(bytes) }
  destroy() { this.destroyed = true; this.doc.off('update', this.send) }
} }))
vi.mock('@room/roomd', async original => {
  const actual = await original<typeof import('@room/roomd')>()
  return { ...actual, startRoomd: async (options: Parameters<typeof actual.startRoomd>[0]) => {
    const daemon = state.daemon = await actual.startRoomd({ ...options, basePollMs: 0, reconcileIntervalMs: 0 })
    if (state.validate) daemon.validateMigratedClaims = state.validate
    return daemon
  } }
})
vi.mock('../src/names.js', async original => ({
  ...await original<typeof import('../src/names.js')>(),
  processToken: (sessionId: string) => ({ pid: process.pid, startTime: 'test', executable: 'node', sessionId, nonce: 'rev23' }),
}))
vi.mock('../src/hub-client.js', async original => ({
  ...await original<typeof import('../src/hub-client.js')>(),
  HubClient: class {
    epochs = new Map<string, number>()
    async hello() {}
    async acquire(name: string) { await state.acquire?.(name); this.epochs.set(name, 1); return 1 }
    lease(name: string) { return this.epochs.get(name) }
    async release(name: string) { this.epochs.delete(name) }
    attach() {}
    close() {}
  },
}))
// A publisher detach may normally await its serial file lease (including a busy guard).
// Keep that await controllable; real ParticipantLease and daemon publication remain in use.
vi.mock('../src/publisher-lease.js', async original => {
  const actual = await original<typeof import('../src/publisher-lease.js')>()
  return { ...actual, publisherLease: (...args: Parameters<typeof actual.publisherLease>) => {
    const lease = new actual.PublisherLease(...args)
    const detach = lease.detach.bind(lease)
    lease.detach = async key => { await state.detach?.(); await detach(key) }
    return lease
  } }
})
vi.mock('../src/post.js', async original => ({ ...await original<typeof import('../src/post.js')>(), greet: () => {} }))

const dirs: string[] = []
afterEach(async () => {
  state.detach = undefined
  await state.daemon?.stop(); state.daemon = undefined
  for (const p of state.providers.splice(0)) { p.destroy(); p.awareness.destroy(); p.doc.destroy() }
  state.acquire = undefined; state.validate = undefined; state.cancelled = false; state.outbound = []
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rev23-'))); dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Ada'); git('config', 'user.email', 'a@a')
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\n'); git('add', '.'); git('commit', '-qm', 'init')
  fs.writeFileSync(path.join(dir, 'app.py'), 'before cancellation\n')
  return dir
}
function barrier() {
  let release!: () => void, enter!: () => void
  const held = new Promise<void>(r => { release = r }), entered = new Promise<void>(r => { enter = r })
  return { release, entered, wait: async () => { enter(); await held } }
}

it('view-token cancellation fences every outbound file update before asynchronous publisher detach', async () => {
  const dir = repo(), abort = new AbortController(), token = barrier(), detach = barrier()
  let requests = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/health')) return teamHealth()
    if (url.endsWith('/auth/config')) return Response.json({ providers: [], shareMax: 'full' })
    if (url.endsWith('/view-token')) {
      if (++requests === 2) await token.wait()
      return Response.json({ hub: 1, view: 'test' })
    }
    throw new Error(url)
  }))
  const pending = withToolSignal(abort.signal, () => joinSession({ dir, server: 'ws://rev23.example', room: 'local/review', token: 'test', name: 'Ada' })).then(s => s, e => e)
  try {
    await token.entered
    const daemon = state.daemon!
    const receiver = new Y.Doc()
    Y.applyUpdate(receiver, Y.encodeStateAsUpdate(daemon.roomDoc.doc))
    state.detach = detach.wait
    state.cancelled = true; abort.abort()
    fs.writeFileSync(path.join(dir, 'app.py'), 'PRIVATE_AFTER_CANCEL\n')
    await detach.entered
    await daemon.reconcileGitChanges()
    for (const update of state.outbound) Y.applyUpdate(receiver, update)
    const wireText = Buffer.concat(state.outbound.map(u => Buffer.from(u))).toString()
    receiver.destroy()
    expect(wireText).not.toContain('PRIVATE_AFTER_CANCEL')
    expect(state.outbound).toHaveLength(0)
    detach.release(); token.release()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(state.outbound).toHaveLength(0)
  } finally { detach.release(); token.release(); await pending }
})

// Accepted cosmetic residual: the tag must be durable before publication to preserve
// same-worktree identity across overlapping joins and failed setup/retry (rev25).
it.fails('cancelled name acquisition does not change the name of the explicit destination', async () => {
  const dir = repo(), abort = new AbortController(), name = barrier()
  vi.stubEnv('ROOM_HOST', 'claude')
  await writeChoice(dir, 'ws://remembered.example')
  const { HubError } = await import('../src/hub-client.js')
  state.acquire = async candidate => {
    if (candidate === 'Ada') throw new HubError('held', 'another team member holds Ada')
    await name.wait()
  }
  const connect = async (signal?: AbortSignal) => withToolSignal(signal, () => startAutoTaggedRoomd({ dir, name: 'Ada', room: signal ? 'ws://memory/local/team' : 'ws://memory/local/chosen', requested: 'full',
    providerFactory: (_server, _room, doc) => {
      const p = Object.assign(new EventEmitter(), { synced: true, awareness: new Awareness(doc), destroy() {} })
      return p as any
    }, basePollMs: 0, reconcileIntervalMs: 0, log: () => {} }))
  const pending = connect(abort.signal).then(s => s, e => e)
  try {
    await name.entered; state.cancelled = true; abort.abort(); fs.writeFileSync(path.join(dir, 'app.py'), 'PRIVATE_AFTER_CANCEL\n'); name.release()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(state.outbound).toEqual([])
    state.cancelled = false; state.acquire = undefined
    const explicit = await connect()
    try { expect(explicit.me.name).toBe('Ada') }
    finally { await explicit.daemon.stop(); state.daemon = undefined }
  } finally { name.release(); await pending }
})


it('validation cancellation fences every outbound update before asynchronous publisher detach', async () => {
  const dir = repo(), abort = new AbortController(), validation = barrier(), detach = barrier()
  state.validate = validation.wait
  const pending = withToolSignal(abort.signal, () => startAutoTaggedRoomd({ dir, name: 'Ada', room: 'ws://memory/local/validation', requested: 'full',
    providerFactory: (server, room, doc) => new WebsocketProvider(server, room, doc),
    log: () => {} })).then(s => s, e => e)
  try {
    await validation.entered
    state.detach = detach.wait
    state.cancelled = true; abort.abort()
    fs.writeFileSync(path.join(dir, 'app.py'), 'PRIVATE_AFTER_CANCEL\n')
    await detach.entered
    await state.daemon!.reconcileGitChanges()
    expect(Buffer.concat(state.outbound.map(bytes => Buffer.from(bytes))).toString()).not.toContain('PRIVATE_AFTER_CANCEL')
    expect(state.outbound).toEqual([])
    detach.release(); validation.release()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(state.outbound).toEqual([])
  } finally { detach.release(); validation.release(); await pending }
})


it('probe-sync cancellation cannot send an edit made in the abort tick', async () => {
  const dir = repo(), abort = new AbortController(), sync = barrier()
  const pending = withToolSignal(abort.signal, () => startAutoTaggedRoomd({ dir, name: 'Ada', room: 'ws://memory/local/sync', requested: 'full',
    providerFactory: (server, room, doc) => {
      const p = new WebsocketProvider(server, room, doc)
      p.synced = false
      p.on('newListener', event => { if (event === 'sync') void sync.wait() })
      return p
    }, log: () => {} })).then(s => s, e => e)
  try {
    await sync.entered
    state.cancelled = true; abort.abort()
    fs.writeFileSync(path.join(dir, 'app.py'), 'PRIVATE_AFTER_CANCEL\n')
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(state.daemon).toBeUndefined()
    expect(state.outbound).toEqual([])
  } finally { sync.release(); await pending }
})

// Consent audit requested by the lead: these pre-existing sharing-store effects are
// deliberately unchanged here and require an owner decision separately from F1/F2.
it.each(['full', 'declared'] as const)('audits sharing state after a cancelled %s team join, explicit local choice and later team join', async level => {
  const dir = repo(), abort = new AbortController(), token = barrier(), room = 'git/example.org/team/audit'
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.org/team/audit.git'])
  execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
  execFileSync('git', ['-C', dir, 'config', 'branch.main.remote', 'origin'])
  execFileSync('git', ['-C', dir, 'config', 'branch.main.merge', 'refs/heads/main'])
  vi.stubEnv('ROOM_HOST', 'claude')
  const before = await PolicyStore.open({ dir, room, participant: 'Ada', requested: 'declared' })
  await before.declare(['app.py']); await before.declare([])
  const file = await sharingFile(dir, room, 'Ada')
  const initial = JSON.parse(fs.readFileSync(file, 'utf8'))
  expect(initial).toMatchObject({ requested: 'declared', declared: { ending: ['app.py'], retained: [] }, disclosed: { version: 0 } })
  let requests = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/health')) return teamHealth()
    if (url.endsWith('/auth/config')) return Response.json({ providers: [], shareMax: 'full' })
    if (url.endsWith('/view-token')) {
      if (++requests === 2) await token.wait()
      return Response.json({ hub: 1, view: 'test' })
    }
    throw new Error(url)
  }))
  const opts = { dir, server: 'ws://sharing-audit.example', room, token: 'test', name: 'Ada', log: () => {} }
  const pending = withToolSignal(abort.signal, () => joinSession({ ...opts, share: level })).then(s => s, e => e)
  try {
    await token.entered
    abort.abort(); token.release()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    const cancelled = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(cancelled.requested).toBe(level)
    expect(cancelled.disclosed).toEqual(initial.disclosed)
    expect(cancelled.declared).toEqual({ active: [], ending: [], retained: level === 'declared' ? ['app.py'] : [] })
    const local = await startAutoTaggedRoomd({ dir, name: 'Ada', room: 'ws://memory/local/chosen', localKey: 'test', requested: 'full',
      providerFactory: (server, room, doc) => new WebsocketProvider(server, room, doc), log: () => {} })
    await local.daemon.stop(); state.daemon = undefined
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(cancelled)
    const later = await joinSession(opts)
    try {
      expect(later.policyStore.requested).toBe(level)
      expect(later.policyStore.disclosed).toEqual(initial.disclosed)
      expect(later.policyStore.retained).toEqual(level === 'declared' ? ['app.py'] : [])
    } finally { await later.daemon.stop(); state.daemon = undefined }
  } finally { token.release(); await pending }
})


it('an abort after a completed join leaves its live publication unchanged', async () => {
  const dir = repo(), abort = new AbortController()
  const joined = await withToolSignal(abort.signal, () => startAutoTaggedRoomd({ dir, name: 'Ada', room: 'ws://memory/local/completed', localKey: 'test', requested: 'full',
    providerFactory: (server, room, doc) => new WebsocketProvider(server, room, doc), log: () => {} }))
  try {
    state.cancelled = true; abort.abort()
    fs.writeFileSync(path.join(dir, 'app.py'), 'AFTER_COMPLETED_JOIN\n')
    await joined.daemon.reconcileGitChanges()
    expect(Buffer.concat(state.outbound.map(bytes => Buffer.from(bytes))).toString()).toContain('AFTER_COMPLETED_JOIN')
  } finally { await joined.daemon.stop(); state.daemon = undefined }
})
