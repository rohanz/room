import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { docs, setPersistence, setupWSConnection } from '@y/websocket-server/utils'
import { RoomDoc } from '@room/shared'
import { SETTLE_MS, encodeFrame, serializedStore, startHub, type Hub, type IncarnationStore, type Reply } from '@room/hub-core'
import { contractSuite, fakeClock, holder, socketClient, waitFor, type ContractClient, type FakeClock, type MakeEnv } from '../../hub-core/test/contract.js'
import { ServerHubs, bindHub, incarnationFile, type PersistenceProvider } from '../src/hub.js'
import { DocumentIdentityGuard, bindDocumentIdentity, capDocSize, makeReadOnly, type DocumentIdentityMode } from '../src/readonly.js'
import { docNameOf, roomNameOf } from '../src/names.js'
import { devServers } from './dev-server.js'

const ROOM = 'git/example.com/o/r/main'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'room-server-hub-'))

/** The stock y-websocket server with the hub wired as index.ts wires it, over a persistence that survives restarts. */
async function hubServer(clock: FakeClock, opts: { full?: () => boolean; identity?: { mode: DocumentIdentityMode; violations: string[] } } = {}) {
  const stored = new Map<string, Uint8Array>()
  const provider: PersistenceProvider = {
    async getYDoc(name) { const doc = new Y.Doc(); const s = stored.get(name); if (s) Y.applyUpdate(doc, s); return doc },
    async storeUpdate(name, update) { const s = stored.get(name); stored.set(name, s ? Y.mergeUpdates([s, update]) : update) },
  }
  const dir = tmp()
  const hubs = new ServerHubs({ store: incarnationFile(dir, 0), log: () => {}, full: () => opts.full?.() ?? false, mono: clock.mono, wall: clock.wall })
  setPersistence(hubs.persistence(provider))
  const wss = new WebSocketServer({ noServer: true })
  const guards = new Map<string, DocumentIdentityGuard>()
  wss.on('connection', (conn, req) => {
    const docName = docNameOf(req.url ?? '/')
    setupWSConnection(conn, req, { gc: true, docName })
    hubs.ensure(docName, docs.get(docName)!)
  })
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    const url = new URL(req.url ?? '/', 'http://x')
    const room = roomNameOf(url.pathname)
    const view = url.searchParams.has('view')
    const login = url.searchParams.get('login') ?? undefined
    bindHub(ws, () => hubs.current(room), view ? { readOnly: true } : { login, readOnly: false })
    if (view) makeReadOnly(ws, () => {})
    if (login && opts.identity) {
      const { mode, violations } = opts.identity
      if (!guards.has(room)) guards.set(room, new DocumentIdentityGuard(() => docs.get(room)))
      bindDocumentIdentity(ws, login, guards.get(room)!, (l, reason) => violations.push(`${l}: ${reason}`), mode)
    }
    wss.emit('connection', ws, req)
  }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    hubs, stored, dir,
    url: (room = ROOM, query = '') => `ws://127.0.0.1:${port}/${encodeURIComponent(room)}${query ? `?${query}` : ''}`,
    /** Connect, and wait until the room's hub serves. */
    async open(room = ROOM, query = ''): Promise<ContractClient & { ws: import('ws').WebSocket }> {
      const c = await socketClient(this.url(room, query))
      await waitFor(() => hubs.current(room))
      return c
    },
    async close() {
      for (const c of wss.clients) c.terminate()
      await new Promise<void>(r => { wss.close(); server.close(() => r()) })
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

const serverEnv: MakeEnv = async clock => {
  const s = await hubServer(clock)
  // The stock server destroys a doc when its last connection leaves: an anchor keeps the room loaded.
  let anchor = await s.open()
  const rooms = new WeakMap<Y.Doc, RoomDoc>()
  const doc = () => { const d = docs.get(ROOM)!; if (!rooms.has(d)) rooms.set(d, new RoomDoc(d)); return rooms.get(d)! }
  return {
    clock,
    doc,
    incarnation: () => s.hubs.current(ROOM)!.incarnation,
    connect: () => s.open(),
    async tick() { s.hubs.current(ROOM)!.tick() },
    async restart(state) {
      await anchor.close()
      for (const conn of [...(docs.get(ROOM)?.conns.keys() ?? [])] as { close(): void }[]) conn.close()
      await waitFor(() => !docs.has(ROOM))
      if (state) s.stored.set(ROOM, state)
      anchor = await s.open()
    },
    async close() { await anchor.close(); await s.close() },
  }
}

contractSuite('server', serverEnv)

async function greeted<C extends ContractClient>(c: C): Promise<C> { expect(await c.hello()).toMatchObject({ ok: true }); return c }

describe('server hub wiring', () => {
  it('a login holds only its own names; a view key is read-only; posts stop when the room is full', async () => {
    const clock = fakeClock()
    let full = false
    const s = await hubServer(clock, { full: () => full })
    try {
      const ada = await greeted(await s.open(ROOM, 'login=ada'))
      clock.advance(SETTLE_MS)
      expect(await ada.send({ op: 'acquire', name: 'bob', holder: holder('s1') })).toMatchObject({ ok: false, reason: 'not-yours' })
      const w = await ada.send({ op: 'acquire', name: 'ada+w', holder: holder('s1') }) as { ok: boolean; epoch: number }
      expect(w).toMatchObject({ ok: true })
      const viewer = await s.open(ROOM, 'view=1')
      expect(await viewer.hello()).toMatchObject({ ok: false, reason: 'read-only' })
      full = true
      expect(await ada.send({ op: 'post', lease: { name: 'ada+w', epoch: w.epoch }, msg: { id: 'm1', type: 'note', from: 'ada', text: 'x' } })).toMatchObject({ ok: false, reason: 'room-full' })
      // A full room takes no new names; a lease already held can still be renewed and released.
      expect(await ada.send({ op: 'acquire', name: 'ada', holder: holder('s1') })).toMatchObject({ ok: false, reason: 'room-full' })
      expect(await ada.send({ op: 'renew', name: 'ada+w', epoch: w.epoch })).toMatchObject({ ok: true })
      expect(await ada.send({ op: 'release', name: 'ada+w', epoch: w.epoch })).toMatchObject({ ok: true })
      await ada.close(); await viewer.close()
    } finally { await s.close() }
  })

  it('two rooms loading at once take distinct incarnations', async () => {
    const clock = fakeClock()
    const s = await hubServer(clock)
    try {
      const [a, b] = await Promise.all([s.open('git/example.com/o/r/one'), s.open('git/example.com/o/r/two')])
      const [ia, ib] = [s.hubs.current('git/example.com/o/r/one')!.incarnation, s.hubs.current('git/example.com/o/r/two')!.incarnation]
      expect(ia).not.toBe(ib)
      expect(JSON.parse(fs.readFileSync(path.join(s.dir, 'hub', 'incarnation.json'), 'utf8')).max).toBe(Math.max(ia, ib))
      await a.close(); await b.close()
    } finally { await s.close() }
  })

  it('bindHub consumes type-7 frames; the size cap never meters them', () => {
    const conn = Object.assign(new EventEmitter(), { sent: [] as Uint8Array[], send(buf: Uint8Array) { this.sent.push(buf) } })
    const seen: unknown[] = []
    conn.on('message', m => seen.push(m))
    let metered = 0
    bindHub(conn, () => undefined, { readOnly: false })
    capDocSize(conn, () => { metered++; return 0 }, 1, () => {})
    conn.emit('message', encodeFrame({ v: 1, id: 'r1', op: 'hello', proto: 1, schema: 2, client: 't', sessionId: 's' }))
    expect(seen).toEqual([])
    expect(metered).toBe(0)
    expect(conn.sent).toHaveLength(1)
    const sync = encoding.createEncoder()
    encoding.writeVarUint(sync, 0)
    syncProtocol.writeUpdate(sync, Y.encodeStateAsUpdate(new Y.Doc()))
    conn.emit('message', encoding.toUint8Array(sync))
    expect(seen).toHaveLength(1)
    expect(metered).toBe(1)
  })

  for (const mode of ['observe', 'enforce'] as const) {
    it(`hub writes are never attributed to the connection that caused them (identity guard: ${mode})`, async () => {
      const clock = fakeClock()
      const violations: string[] = []
      const s = await hubServer(clock, { identity: { mode, violations } })
      try {
        const ada = await greeted(await s.open(ROOM, 'login=ada'))
        const bob = await greeted(await s.open(ROOM, 'login=bob'))
        /** A member's own write, sent as a sync update on its connection; resolves once the room applied it. */
        const write = async (c: typeof ada, key: string, value: object) => {
          const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(docs.get(ROOM)!)); const before = Y.encodeStateVector(d)
          d.getMap('scopes').set(key, value)
          const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(d, before))
          c.ws.send(encoding.toUint8Array(enc))
          await waitFor(() => JSON.stringify(docs.get(ROOM)!.getMap('scopes').get(key)) === JSON.stringify(value))
        }
        await write(ada, 'ada', { by: 'ada', n: 1 })
        clock.advance(SETTLE_MS)
        // Writes foreign to ada's login, made by the hub while it answers ada's frames: bob's holder record,
        // and a message from bob (the hub only observes `from`).
        expect(await bob.send({ op: 'acquire', name: 'bob', holder: holder('s2') })).toMatchObject({ ok: true })
        const own = await ada.send({ op: 'acquire', name: 'ada', holder: holder('s1') }) as { ok: boolean; epoch: number }
        expect(own).toMatchObject({ ok: true })
        expect(await ada.send({ op: 'post', lease: { name: 'ada', epoch: own.epoch }, msg: { id: 'm1', type: 'note', from: 'bob', text: 'x' } })).toMatchObject({ ok: true })
        expect(docs.get(ROOM)!.getMap('participants').get('bob\u0000holder')).toMatchObject({ sessionId: 's2' })
        await write(ada, 'ada', { by: 'ada', n: 2 })
        await write(bob, 'bob', { by: 'bob', n: 1 })
        expect(violations).toEqual([])
        await ada.close(); await bob.close()
      } finally { await s.close() }
    })
  }

  it('without YPERSISTENCE a fresh process over the same port never repeats a seq', async () => {
    const port = 50_000 + Math.floor(Math.random() * 10_000)
    const dir = path.join(os.tmpdir(), `room-server-hub-${port}`)
    const clock = fakeClock(1_000_000)
    const hello = { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 't', sessionId: 's' }
    const start = (store: IncarnationStore) => startHub({ doc: new RoomDoc(), mono: clock.mono, wall: clock.wall, log: () => {}, store })
    const post = (hub: Hub, id: string) => {
      hub.handle(hub, hello, { local: true })
      clock.advance(SETTLE_MS)
      const { epoch } = hub.handle(hub, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('s') }, { local: true }) as { epoch: number }
      return (hub.handle(hub, { v: 1, id, op: 'post', lease: { name: 'ada', epoch }, msg: { id, type: 'note', from: 'ada', text: id } }, { local: true }) as { seq: number }).seq
    }
    try {
      // Rooms A, B and C load together, so C's incarnation runs ahead of the wall clock; C posts.
      const first = incarnationFile(undefined, port)
      const [, , c] = [await start(first), await start(first), await start(first)]
      const before = post(c, 'm1')
      // Two seconds later a new process (a fresh store over the same file) loads C first, before any replica syncs.
      clock.advance(2_000)
      const again = await start(incarnationFile(undefined, port))
      expect(post(again, 'm2')).toBeGreaterThan(before)
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'incarnation.json'), 'utf8')).max).toBe(again.incarnation)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  describe('the incarnation file is durable', () => {
    afterEach(() => { vi.restoreAllMocks() })
    /** Record directory creation, directory fsyncs and renames; `fail(dir)` makes that directory's fsync fail. */
    function watchFs(fail: (dir: string) => NodeJS.ErrnoException | undefined = () => undefined): string[] {
      const events: string[] = []
      const { open, mkdir, rename } = fsp
      vi.spyOn(fsp, 'mkdir').mockImplementation((async (p: string, o: unknown) => { const r = await mkdir(p, o as never); events.push(`mkdir ${p}`); return r }) as never)
      vi.spyOn(fsp, 'rename').mockImplementation((async (a: string, b: string) => { await rename(a, b); events.push(`rename ${b}`) }) as never)
      vi.spyOn(fsp, 'open').mockImplementation((async (p: string, flags: string, mode?: number) => {
        const handle = await open(p, flags, mode)
        if (flags !== 'r') return handle
        return Object.assign(Object.create(handle), {
          sync: async () => { const e = fail(p); if (e) throw e; await handle.sync(); events.push(`sync ${p}`) },
          close: () => handle.close(),
        })
      }) as never)
      return events
    }
    const errno = (code: string) => Object.assign(new Error(code), { code })

    it('fsyncs a new directory into its parent before the record is renamed into it', async () => {
      const volume = path.join(tmp(), 'volume')
      const events = watchFs()
      await incarnationFile(volume, 0).advance(7)
      const hub = path.join(volume, 'hub')
      const at = (e: string) => { const i = events.indexOf(e); expect(i, e).toBeGreaterThanOrEqual(0); return i }
      expect(at(`mkdir ${volume}`)).toBeLessThan(at(`sync ${path.dirname(volume)}`))
      expect(at(`mkdir ${hub}`)).toBeLessThan(at(`sync ${volume}`))
      expect(at(`sync ${volume}`)).toBeLessThan(at(`rename ${path.join(hub, 'incarnation.json')}`))
      expect(at(`rename ${path.join(hub, 'incarnation.json')}`)).toBeLessThan(events.lastIndexOf(`sync ${hub}`))
    })

    it('fails on a real directory fsync error, and ignores only an unsupported one', async () => {
      const volume = tmp()
      const hub = path.join(volume, 'hub')
      watchFs(dir => dir === hub ? errno('EIO') : undefined)
      await expect(incarnationFile(volume, 0).advance(7)).rejects.toMatchObject({ code: 'EIO' })
      vi.restoreAllMocks()
      watchFs(dir => dir === hub ? errno('ENOTSUP') : undefined)
      // The failed write's record may have landed; its incarnation is never served, and never reused.
      await expect(incarnationFile(volume, 0).advance(7)).resolves.toBe(8)
    })
  })

  it('the serialized store takes one incarnation at a time', async () => {
    let max: number | undefined
    const store = serializedStore({ read: async () => max, write: async v => { await new Promise(r => setTimeout(r, 5)); max = v } })
    const values = await Promise.all([store.advance(10), store.advance(10), store.advance(10)])
    expect(new Set(values).size).toBe(3)
  })
})

describe('the server process', () => {
  const servers = devServers()
  let proc: ChildProcess | undefined
  afterAll(async () => { await servers.stopAll() })
  const freePort = () => new Promise<number>((resolve, reject) => {
    const srv = net.createServer(); srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)) })
  })
  async function start(port: number, dir: string): Promise<ChildProcess> {
    const p = servers.start({
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), YPERSISTENCE: dir, ROOM_SERVER: '', GITHUB_CLIENT_ID: '', ROOM_TOKEN: '', OIDC_ISSUER: '', DATABASE_URL: '', NODE_ENV: 'test' },
      stdio: 'ignore',
    })
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch { return false } }, 20_000)
    return p
  }
  async function hello(port: number, query = ''): Promise<Reply> {
    const c = await socketClient(`ws://127.0.0.1:${port}/${encodeURIComponent('local/hub/main')}?schema=2${query}`)
    try { return await waitFor(async () => { const r = await c.hello(); return (r.ok || r.reason !== 'starting') && r }, 5000) }
    finally { await c.close() }
  }

  it('answers hub frames after the room loads, read-only for view keys, and takes a higher incarnation after a kill', async () => {
    const port = await freePort()
    const dir = tmp()
    proc = await start(port, dir)
    const opened = await fetch(`http://127.0.0.1:${port}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: 'local/hub/main', schema: 2 }) })
    expect(opened.status).toBe(201)
    const first = await hello(port)
    expect(first).toMatchObject({ ok: true, proto: 1, authority: true })
    const json = (route: string, body: unknown) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
    const { view } = await json('/view-token', { room: 'local/hub/main', schema: 2 }) as { view: string }
    // A browser trades its view key for a one-use ticket; the key itself is refused in a websocket URL.
    const { ticket } = await json('/ws-ticket', { room: 'local/hub/main', schema: 2, view }) as { ticket: string }
    expect(await hello(port, `&ticket=${ticket}`)).toMatchObject({ ok: false, reason: 'read-only' })
    await servers.stop(proc, 'SIGKILL')
    proc = await start(port, dir)
    const second = await hello(port)
    expect(second.incarnation as number).toBeGreaterThan(first.incarnation as number)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'hub', 'incarnation.json'), 'utf8')).max).toBe(second.incarnation)
    await servers.stop(proc, 'SIGKILL')
  }, 60_000)
})
