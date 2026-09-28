import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { docs, setPersistence, setupWSConnection } from '@y/websocket-server/utils'
import { RoomDoc } from '@room/shared'
import { SETTLE_MS, encodeFrame, serializedStore, type Reply } from '@room/hub-core'
import { contractSuite, fakeClock, holder, socketClient, waitFor, type ContractClient, type FakeClock, type MakeEnv } from '../../hub-core/test/contract.js'
import { ServerHubs, bindHub, incarnationFile, type PersistenceProvider } from '../src/hub.js'
import { DocumentIdentityGuard, capDocSize, makeReadOnly } from '../src/readonly.js'
import { docNameOf, roomNameOf } from '../src/names.js'

const ROOM = 'git/example.com/o/r/main'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'room-server-hub-'))

/** The stock y-websocket server with the hub wired as index.ts wires it, over a persistence that survives restarts. */
async function hubServer(clock: FakeClock, opts: { full?: () => boolean } = {}) {
  const stored = new Map<string, Uint8Array>()
  const provider: PersistenceProvider = {
    async getYDoc(name) { const doc = new Y.Doc(); const s = stored.get(name); if (s) Y.applyUpdate(doc, s); return doc },
    async storeUpdate(name, update) { const s = stored.get(name); stored.set(name, s ? Y.mergeUpdates([s, update]) : update) },
  }
  const dir = tmp()
  const hubs = new ServerHubs({ store: incarnationFile(dir), log: () => {}, full: () => opts.full?.() ?? false, mono: clock.mono, wall: clock.wall })
  setPersistence(hubs.persistence(provider))
  const wss = new WebSocketServer({ noServer: true })
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
    bindHub(ws, () => hubs.current(room), view ? { readOnly: true } : { login: url.searchParams.get('login') ?? undefined, readOnly: false })
    if (view) makeReadOnly(ws, () => {})
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

async function greeted(c: ContractClient): Promise<ContractClient> { expect(await c.hello()).toMatchObject({ ok: true }); return c }

describe('server hub wiring', () => {
  it('a login holds only its own names; a view key is read-only; posts stop when the room is full', async () => {
    const clock = fakeClock()
    let full = false
    const s = await hubServer(clock, { full: () => full })
    try {
      const ada = await greeted(await s.open(ROOM, 'login=ada'))
      clock.advance(SETTLE_MS)
      expect(await ada.send({ op: 'acquire', name: 'bob', holder: holder('s1') })).toMatchObject({ ok: false, reason: 'not-yours' })
      expect(await ada.send({ op: 'acquire', name: 'ada+w', holder: holder('s1') })).toMatchObject({ ok: true })
      const viewer = await s.open(ROOM, 'view=1')
      expect(await viewer.hello()).toMatchObject({ ok: false, reason: 'read-only' })
      full = true
      expect(await ada.send({ op: 'post', msg: { id: 'm1', type: 'note', from: 'ada', text: 'x' } })).toMatchObject({ ok: false, reason: 'room-full' })
      expect(await ada.send({ op: 'acquire', name: 'ada', holder: holder('s1') })).toMatchObject({ ok: true })
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

  it('hub writes raise no identity objection, in observe or enforce mode', async () => {
    const clock = fakeClock()
    const s = await hubServer(clock)
    try {
      const c = await greeted(await s.open(ROOM, 'login=ada'))
      const guard = new DocumentIdentityGuard(() => docs.get(ROOM))
      // A member write first, so the guard's shadow follows the real doc from here on.
      const member = (change: (doc: Y.Doc) => void) => {
        const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(docs.get(ROOM)!)); const before = Y.encodeStateVector(d)
        change(d)
        const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(d, before))
        return encoding.toUint8Array(enc)
      }
      expect(guard.accept(member(d => d.getMap('scopes').set('ada', { by: 'ada' })), 'ada')).toEqual({ ok: true })
      clock.advance(SETTLE_MS)
      expect(await c.send({ op: 'acquire', name: 'ada', holder: holder('s1') })).toMatchObject({ ok: true })
      expect(await c.send({ op: 'post', msg: { id: 'm1', type: 'note', from: 'ada', to: 'bob', text: 'x' } })).toMatchObject({ ok: true })
      expect(guard.accept(member(d => d.getMap('scopes').set('ada', { by: 'ada', again: true })), 'ada')).toEqual({ ok: true })
      await c.close()
    } finally { await s.close() }
  })

  it('the serialized store takes one incarnation at a time', async () => {
    let max: number | undefined
    const store = serializedStore({ read: async () => max, write: async v => { await new Promise(r => setTimeout(r, 5)); max = v } })
    const values = await Promise.all([store.advance(10), store.advance(10), store.advance(10)])
    expect(new Set(values).size).toBe(3)
  })
})

describe('the server process', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  let proc: ChildProcess | undefined
  afterAll(() => { proc?.kill('SIGKILL') })
  const freePort = () => new Promise<number>((resolve, reject) => {
    const srv = net.createServer(); srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)) })
  })
  async function start(port: number, dir: string): Promise<ChildProcess> {
    const p = spawn(process.execPath, [path.resolve(here, '../../../node_modules/tsx/dist/cli.mjs'), path.resolve(here, '../src/index.ts')], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), YPERSISTENCE: dir, ROOM_SERVER: '', GITHUB_CLIENT_ID: '', ROOM_TOKEN: '', OIDC_ISSUER: '', DATABASE_URL: '', NODE_ENV: 'test' },
      stdio: 'ignore',
    })
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch { return false } }, 20_000)
    return p
  }
  async function hello(port: number, query = ''): Promise<Reply> {
    const c = await socketClient(`ws://127.0.0.1:${port}/${encodeURIComponent('local/hub/main')}${query}`)
    try { return await waitFor(async () => { const r = await c.hello(); return (r.ok || r.reason !== 'starting') && r }, 5000) }
    finally { await c.close() }
  }

  it('answers hub frames after the room loads, read-only for view keys, and takes a higher incarnation after a kill', async () => {
    const port = await freePort()
    const dir = tmp()
    proc = await start(port, dir)
    const opened = await fetch(`http://127.0.0.1:${port}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: 'local/hub/main' }) })
    expect(opened.status).toBe(201)
    const first = await hello(port)
    expect(first).toMatchObject({ ok: true, proto: 1, authority: true })
    const { view } = await (await fetch(`http://127.0.0.1:${port}/view-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: 'local/hub/main' }) })).json() as { view: string }
    expect(await hello(port, `?view=${view}`)).toMatchObject({ ok: false, reason: 'read-only' })
    proc.kill('SIGKILL')
    await new Promise(r => proc!.once('exit', r))
    proc = await start(port, dir)
    const second = await hello(port)
    expect(second.incarnation as number).toBeGreaterThan(first.incarnation as number)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'hub', 'incarnation.json'), 'utf8')).max).toBe(second.incarnation)
    proc.kill('SIGKILL')
  }, 60_000)
})
