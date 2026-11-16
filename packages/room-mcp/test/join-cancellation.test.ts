import { EventEmitter, getEventListeners } from 'node:events'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { joinSession, leaveSession, startAutoTaggedRoomd, type NamedRoomd } from '../src/session.js'
import { withToolSignal } from '../src/registry.js'

const held = vi.hoisted(() => ({ names: 0, publishers: 0, hubs: 0, gate: undefined as undefined | (() => Promise<void>), validate: undefined as undefined | (() => Promise<void>) }))
vi.mock('@room/roomd', async original => {
  const actual = await original<typeof import('@room/roomd')>()
  return { ...actual, startRoomd: async (options: Parameters<typeof actual.startRoomd>[0]) => {
    const daemon = await actual.startRoomd(options)
    if (held.validate) daemon.validateMigratedClaims = held.validate
    return daemon
  } }
})
vi.mock('../src/names.js', async original => ({
  ...await original<typeof import('../src/names.js')>(),
  processToken: () => ({ pid: process.pid, startTime: 'test', executable: 'node', sessionId: 'test', nonce: 'test' }),
  chooseName: async () => { held.names++; await held.gate?.(); return { name: 'Ada', file: '/unused', epoch: 1 } },
  ParticipantLease: class {
    epoch = 1; state = 'held'
    fence() { return '1' }
    async end() { if (this.state !== 'ended') { this.state = 'ended'; held.names-- } }
    held() { return true }
    paused() {}
  },
}))
vi.mock('../src/hub-client.js', async original => ({
  ...await original<typeof import('../src/hub-client.js')>(),
  HubClient: class {
    constructor() { held.hubs++ }
    async hello() {}
    attach() {}
    close() { held.hubs-- }
  },
}))
vi.mock('../src/publisher-lease.js', () => ({
  publisherLease: () => ({}),
  attachPublisher: async () => { held.publishers++; return { detach: async () => { held.publishers-- }, activity: async () => {} } },
}))
vi.mock('../src/post.js', async original => ({ ...await original<typeof import('../src/post.js')>(), greet: () => {} }))

let dir: string, named: NamedRoomd | undefined, session: Awaited<ReturnType<typeof joinSession>> | undefined
afterEach(async () => {
  await named?.daemon.stop(); named = undefined
  if (session) await leaveSession(session); session = undefined
  held.gate = undefined; held.validate = undefined
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  fs.rmSync(dir, { recursive: true, force: true })
})
function repo() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'join-cancel-'))
  const sh = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  sh('init', '-q', '-b', 'main'); sh('config', 'user.name', 'Ada'); sh('config', 'user.email', 'a@a')
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\n'); sh('add', '.'); sh('commit', '-qm', 'init')
  fs.writeFileSync(path.join(dir, 'app.py'), 'private text\n')
}

it('a cancelled join makes no first HTTP contact after its Git probe', async () => {
  repo()
  const abort = new AbortController()
  const fetch = vi.fn(async () => { throw new Error('unexpected contact') }); vi.stubGlobal('fetch', fetch)
  const repository = await import('../src/repository.js'), original = repository.joinableRoot
  vi.spyOn(repository, 'joinableRoot').mockImplementationOnce(async dir => { const root = await original(dir); abort.abort(); return root })
  const error = await withToolSignal(abort.signal, () => joinSession({ dir, server: 'ws://team.example', room: 'chosen' })).then(value => { session = value; return undefined }, error => error)
  expect(error).toMatchObject({ name: 'AbortError' })
  expect(fetch).not.toHaveBeenCalled()
})

it('a cancelled connected probe releases its name and hub before publication starts', async () => {
  repo()
  const abort = new AbortController(), doc = new Y.Doc(), awareness = new Awareness(doc)
  const provider = Object.assign(new EventEmitter(), { synced: true, awareness, destroy: vi.fn() })
  const connect = vi.fn(() => provider as unknown as WebsocketProvider)
  held.gate = async () => { abort.abort() }
  try {
    const error = await withToolSignal(abort.signal, () => startAutoTaggedRoomd({ dir, name: 'Ada', room: 'ws://memory/local/test', requested: 'full', replica: doc, providerFactory: connect,
      basePollMs: 0, reconcileIntervalMs: 0, log: () => {} })).then(value => { named = value; return undefined }, error => error)
    expect(error).toMatchObject({ name: 'AbortError' })
    expect(held).toMatchObject({ names: 0, publishers: 0, hubs: 0 })
    expect(connect).toHaveBeenCalledOnce()
    expect(provider.destroy).toHaveBeenCalledOnce()
    const { RoomDoc } = await import('@room/shared')
    expect(new RoomDoc(doc).allScopes()).toEqual([])
    expect(new RoomDoc(doc).openClaims()).toEqual([])
  } finally { await named?.daemon.stop(); named = undefined; awareness.destroy(); doc.destroy() }
})

it('abort after the daemon starts stops publication while join validation is pending', async () => {
  repo()
  const abort = new AbortController(), doc = new Y.Doc()
  let release!: () => void, enter!: () => void
  const heldValidation = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  held.validate = async () => { enter(); await heldValidation }
  const providers: Array<WebsocketProvider> = []
  const connect = () => {
    const provider = Object.assign(new EventEmitter(), { synced: true, awareness: new Awareness(doc), destroy: vi.fn() }) as unknown as WebsocketProvider
    providers.push(provider); return provider
  }
  const pending = withToolSignal(abort.signal, () => startAutoTaggedRoomd({ dir, name: 'Ada', room: 'ws://memory/local/test', requested: 'full', replica: doc, providerFactory: connect,
    basePollMs: 0, reconcileIntervalMs: 0, log: () => {} })).then(value => { named = value; return undefined }, error => error)
  try {
    await entered
    abort.abort()
    release()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(held).toMatchObject({ names: 0, publishers: 0, hubs: 0 })
    expect(providers).toHaveLength(2)
    for (const provider of providers) expect(provider.destroy).toHaveBeenCalledOnce()
    expect(getEventListeners(abort.signal, 'abort')).toEqual([])
  } finally { release(); await pending; for (const provider of providers) provider.awareness.destroy(); doc.destroy() }
})
