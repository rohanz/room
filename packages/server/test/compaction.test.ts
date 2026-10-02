/** Compaction at server start (docs/superpowers/specs/2026-10-02-doc-history.md §5): a room's first load in a
 *  process rebuilds it from its values under a new generation, and the gate refuses replicas of an earlier one.
 *  The child-server tests listen on loopback. */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { LeveldbPersistence } from 'y-leveldb'
import { COMPACTED_UPDATE_REASON, GENERATION_PARAM, RoomDoc, STALE_REPLICA_CODE, docGeneration, historyOf, replicaGeneration } from '@room/shared'
import { SETTLE_MS, encodeFrame, decodeFrame, serializedStore, MSG_HUB, type Reply } from '@room/hub-core'
import { ServerHubs, type PersistenceProvider } from '../src/hub.js'
import { devServers } from './dev-server.js'

const ROOM = 'github.com/ada/r'
const holder = (sessionId: string) => ({ sessionId, pid: 1, startTime: 't', executable: 'node' })

function memoryStore(opts: { failReplace?: boolean } = {}) {
  const stored = new Map<string, Uint8Array>()
  let replaces = 0
  const provider: PersistenceProvider = {
    async getYDoc(name) { const doc = new Y.Doc(); const s = stored.get(name); if (s) Y.applyUpdate(doc, s); return doc },
    async storeUpdate(name, update) { const s = stored.get(name); stored.set(name, s ? Y.mergeUpdates([s, update]) : update) },
    async replace(name, snapshot) { replaces++; if (opts.failReplace) throw new Error('disk full'); stored.set(name, snapshot) },
  }
  return { stored, provider, replaces: () => replaces }
}

/** One server process: a fresh ServerHubs over the same store, as a restart has. */
/** The durable incarnation record every process of these tests shares, as one volume does. */
let incarnationMax: number | undefined
const incarnations = serializedStore({ read: async () => incarnationMax, write: async v => { incarnationMax = v } })
function process_(provider: PersistenceProvider, minDeleted: number, dir: string, clock: { mono: number; wall: number }) {
  const lines: string[] = []
  const hubs = new ServerHubs({ store: incarnations, leaseFile: () => leaseFile(dir), log: line => lines.push(line), full: () => false,
    mono: () => clock.mono, wall: () => clock.wall, compaction: { minDeleted, generation: () => `g${Math.random().toString(16).slice(2)}` } })
  return { hubs, lines, persistence: hubs.persistence(provider) }
}
const leases = new Map<string, unknown[]>()
const leaseFile = (dir: string) => ({ store: { read: async () => (leases.get(dir) ?? []) as never, write: async (rows: unknown[]) => { leases.set(dir, rows) } }, remove: async () => { leases.delete(dir) } })

async function load(p: ReturnType<typeof process_>, name = ROOM): Promise<Y.Doc> {
  const doc = new Y.Doc()
  await p.persistence.bindState(name, doc)
  return doc
}

/** A churned room: overwrites and deletions leave tombstones. */
function churn(doc: Y.Doc, rounds: number): void {
  const room = new RoomDoc(doc)
  for (let i = 0; i < rounds; i++) doc.transact(() => {
    room.metaMap.set('hubSeq', i)
    room.archive.set(`m${i}`, ['note', 'ada', i, []] as never)
    if (i >= 20) room.archive.delete(`m${i - 20}`)
  })
}

describe('compaction at load', () => {
  it('compacts a room over the threshold at its first load, once per process, and stores the copy', async () => {
    const { stored, provider, replaces } = memoryStore()
    const seed = new Y.Doc(); churn(seed, 300); seed.getMap('claims').set('c1', { id: 'c1', by: 'ada' })
    stored.set(ROOM, Y.encodeStateAsUpdate(seed))
    const before = historyOf(seed)
    const clock = { mono: 1e6, wall: Date.UTC(2026, 9, 2) }
    const first = process_(provider, 100, 'a', clock)
    const doc = await load(first)
    const generation = docGeneration(doc)
    expect(generation).toMatch(/^g/)
    expect(historyOf(doc).deleted).toBe(0)
    expect(historyOf(doc).structs).toBeLessThan(before.structs / 4)
    expect(new RoomDoc(doc).archive.toJSON()).toEqual(new RoomDoc(seed).archive.toJSON())
    expect(doc.getMap('claims').get('c1')).toEqual({ id: 'c1', by: 'ada' })
    expect(replaces()).toBeGreaterThanOrEqual(1)
    expect(docGeneration(await provider.getYDoc(ROOM))).toBe(generation) // the stored document is the copy
    expect(first.lines.join('\n')).toMatch(/compacted at load: \d+ structs \(\d+ deleted\) -> \d+ structs/)
    // A later load in the same process (the room unloaded and came back) is not compacted again.
    churn(doc, 300)
    await first.hubs.flush(doc); await first.hubs.flushName(ROOM); doc.destroy()
    const again = await load(first)
    expect(docGeneration(again)).toBe(generation)
    expect(historyOf(again).deleted).toBeGreaterThan(100)
    again.destroy(); await first.hubs.flushName(ROOM)
    // The next process compacts it again, under a new generation.
    const next = await load(process_(provider, 100, 'a', clock))
    expect(docGeneration(next)).toMatch(/^g/)
    expect(docGeneration(next)).not.toBe(generation)
    expect(historyOf(next).deleted).toBe(0)
  })

  it('leaves a room under the threshold as it is, with no generation', async () => {
    const { stored, provider } = memoryStore()
    const seed = new Y.Doc(); churn(seed, 30)
    stored.set(ROOM, Y.encodeStateAsUpdate(seed))
    const doc = await load(process_(provider, 10_000, 'b', { mono: 1e6, wall: 1 }))
    expect(docGeneration(doc)).toBeUndefined()
    expect(historyOf(doc)).toEqual(historyOf(seed))
    expect(docGeneration(await provider.getYDoc(ROOM))).toBeUndefined()
  })

  it('a failed write keeps the stored document and its generation; the next process compacts', async () => {
    const failing = memoryStore({ failReplace: true })
    const seed = new Y.Doc(); churn(seed, 300)
    const original = Y.encodeStateAsUpdate(seed)
    failing.stored.set(ROOM, original)
    const p = process_(failing.provider, 100, 'c', { mono: 1e6, wall: 1 })
    const doc = await load(p)
    expect(docGeneration(doc)).toBeUndefined()
    expect(historyOf(doc)).toEqual(historyOf(seed))
    expect(failing.stored.get(ROOM)).toBe(original)
    expect(p.lines.join('\n')).toMatch(/not compacted: disk full/)
    const ok = memoryStore(); ok.stored.set(ROOM, original)
    expect(docGeneration(await load(process_(ok.provider, 100, 'c', { mono: 1e6, wall: 1 })))).toMatch(/^g/)
  })

  it('keeps history bounded across repeated restarts under the soak mix (harness), and grows without it', async () => {
    const run = async (minDeleted: number) => {
      const { provider } = memoryStore()
      const clock = { mono: 1e6, wall: Date.UTC(2026, 9, 2) }
      const loads: { structs: number; deleted: number }[] = []
      let seqs: number[] = []
      for (let restart = 0; restart < 6; restart++) {
        const p = process_(provider, minDeleted, `h${minDeleted}`, clock)
        const doc = await load(p)
        loads.push(historyOf(doc))
        p.hubs.ensure(ROOM, doc)
        let hub = p.hubs.current(ROOM)
        for (let i = 0; i < 200 && !hub; i++) { await new Promise(r => setTimeout(r, 5)); hub = p.hubs.current(ROOM) }
        if (!hub) throw new Error(`hub did not start: ${p.lines.join('; ')}`)
        clock.mono += SETTLE_MS; clock.wall += SETTLE_MS
        const posted = soakMix(hub, new RoomDoc(doc), clock, 1000, restart)
        expect(posted.length).toBeGreaterThan(900)
        seqs = seqs.concat(posted)
        await p.hubs.flush(doc)
        p.hubs.stop(ROOM)
        await p.hubs.flushName(ROOM)
        doc.destroy()
      }
      return { loads, seqs }
    }
    const compacted = await run(2_000)
    const growing = await run(Infinity)
    // Every load is either compacted or under the threshold: tombstones never pile up across restarts.
    expect(Math.max(...compacted.loads.map(l => l.deleted))).toBeLessThan(2_000)
    expect(compacted.loads.filter(l => l.deleted === 0).length).toBeGreaterThanOrEqual(4)
    expect(growing.loads.at(-1)!.deleted).toBeGreaterThan(5 * 2_000)
    expect(compacted.loads.at(-1)!.structs).toBeLessThan(growing.loads.at(-1)!.structs / 2)
    // Counters: seq strictly rises across every compacting restart, never reused.
    for (let i = 1; i < compacted.seqs.length; i++) expect(compacted.seqs[i]).toBeGreaterThan(compacted.seqs[i - 1]!)
  }, 120_000)
})

/** The harness's mix (scripts/doc-history.mts), against one hub: posts, receipts, answers, claims, renewals, ticks. */
function soakMix(hub: NonNullable<ReturnType<ServerHubs['current']>>, room: RoomDoc, clock: { mono: number; wall: number }, posts: number, salt: number): number[] {
  const people = ['a', 'b', 'c', 'd']
  const conns = new Map<string, { conn: object; epoch: number }>()
  for (const p of people) {
    const conn = {}
    hub.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 't', sessionId: p }, { local: true })
    const r = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: p, holder: holder(p) }, { local: true }) as { epoch: number }
    conns.set(p, { conn, epoch: r.epoch })
  }
  const seqs: number[] = []
  const open: string[] = []
  let seed = 7 + salt
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n }
  for (let n = 1; n <= posts; n++) {
    const from = people[rand(people.length)]!, c = conns.get(from)!
    const to = people[(people.indexOf(from) + 1) % people.length]!
    const id = `q-${salt}-${n}`
    const r = hub.handle(c.conn, { v: 1, id: 'p', op: 'post', lease: { name: from, epoch: c.epoch }, msg: { id, type: 'question', to, from, fromKind: 'agent', text: `question ${n}` } }, { local: true }) as Reply & { seq?: number }
    if (r.ok && r.seq) seqs.push(r.seq)
    room.markSeen(to, [id], { s: to, via: 'reply' }, 'member')
    if (n % 250 === 0) for (const p of people) room.doc.transact(() => room.pruneSeen(p, () => true), 'member')
    if (rand(6) === 0) open.push(room.addClaim({ path: `f${rand(20)}.py`, from: 1, to: 9, by: from, byKind: 'agent' } as never).id)
    if (open.length > 6) room.removeClaim(open.shift()!)
    clock.mono += 5_000; clock.wall += 5_000
    for (const [name, x] of conns) hub.handle(x.conn, { v: 1, id: 'r', op: 'renew', name, epoch: x.epoch }, { local: true })
    hub.tick()
  }
  return seqs
}

// ---- a real server: restarts over LevelDB, the gate, leases and counters ------------------------------------

const servers = devServers()
const dirs: string[] = []
afterAll(async () => { try { await servers.stopAll() } finally { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }) } })

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)) })
  })
}

function teamServer(dir: string, port: number, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ROOM_')) env[k] = v
  const lines: string[] = []
  const child = servers.start({ env: { ...env, HOST: '127.0.0.1', PORT: String(port), GITHUB_CLIENT_ID: 'fake', NODE_ENV: 'test', YPERSISTENCE: dir, ROOM_COMPACT_MIN_DELETED: '150', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.on('data', (b: Buffer) => lines.push(...b.toString().split('\n').filter(Boolean)))
  child.stderr!.on('data', (b: Buffer) => lines.push(...b.toString().split('\n').filter(Boolean)))
  return { child, lines, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` }
}
async function healthy(http: string): Promise<void> {
  for (let i = 0; i < 300; i++) { try { if ((await fetch(`${http}/health`)).ok) return } catch { /* starting */ } await new Promise(r => setTimeout(r, 100)) }
  throw new Error('server did not start')
}
const postJson = (http: string, p: string, body: unknown) => fetch(`${http}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function login(http: string, who: string): Promise<string> {
  const { device } = await (await postJson(http, '/auth/device', {})).json() as { device: string }
  return ((await (await postJson(http, '/auth/poll', { device, fakeLogin: who })).json()) as { session: string }).session
}

interface SyncClient { ws: WebSocket; synced: Promise<void>; closed: Promise<{ code: number; reason: string }>; hub(body: Record<string, unknown>): Promise<Reply & Record<string, unknown>> }
/** A y-websocket client stating `gen` (undefined: an rc client), syncing `doc` and carrying hub frames. */
function syncClient(url: string, doc: Y.Doc, opts: { gen?: string | null; session?: string; ticket?: string } = {}): SyncClient {
  const query = new URLSearchParams({ schema: '2' })
  const gen = opts.gen === undefined ? replicaGeneration(doc) : opts.gen
  if (gen !== null) query.set(GENERATION_PARAM, gen)
  if (opts.ticket) query.set('ticket', opts.ticket)
  const ws = new WebSocket(`${url}/${encodeURIComponent(ROOM)}?${query}`, { headers: opts.session ? { authorization: `Bearer ${opts.session}` } : {} })
  ws.binaryType = 'arraybuffer'
  ws.on('error', () => {}) // a refused or killed connection still closes
  let markSynced!: () => void
  const synced = new Promise<void>(resolve => { markSynced = resolve })
  const closed = new Promise<{ code: number; reason: string }>(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  const pending = new Map<string, (r: Reply & Record<string, unknown>) => void>()
  const send = (update: Uint8Array, origin: unknown) => {
    if (origin === 'server' || ws.readyState !== ws.OPEN) return
    const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeUpdate(e, update); ws.send(encoding.toUint8Array(e))
  }
  doc.on('update', send)
  ws.once('close', () => doc.off('update', send))
  ws.on('open', () => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeSyncStep1(e, doc); ws.send(encoding.toUint8Array(e)) })
  ws.on('message', (data: ArrayBuffer) => {
    const buf = new Uint8Array(data)
    if (buf[0] === MSG_HUB) { const frame = decodeFrame(buf) as Reply & Record<string, unknown>; if (!('push' in frame)) pending.get(frame.re)?.(frame); return }
    const d = decoding.createDecoder(buf)
    if (decoding.readVarUint(d) !== 0) return
    const e = encoding.createEncoder(); encoding.writeVarUint(e, 0)
    const type = syncProtocol.readSyncMessage(d, e, doc, 'server')
    if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e))
    if (type === syncProtocol.messageYjsSyncStep2) markSynced()
  })
  let n = 0
  return { ws, synced, closed, hub: body => new Promise(resolve => { const id = `r${++n}`; pending.set(id, resolve); ws.send(encodeFrame({ v: 1, id, ...body } as never)) }) }
}
/** Hello, retried while the room's hub is starting. */
async function hello(c: SyncClient, sessionId: string): Promise<Reply & Record<string, unknown>> {
  for (let i = 0; ; i++) {
    const reply = await within(c.hub({ op: 'hello', proto: 1, schema: 2, client: 'test', sessionId }))
    if (reply.ok || i > 100) return reply
    await new Promise(r => setTimeout(r, 100))
  }
}
const within = <T>(p: Promise<T>, ms = 10_000) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))])

describe('a compacting restart on a real server', () => {
  it('refuses a stale replica (4409) and merges nothing of it; a fresh replica rejoins with no duplicates; rc and view clients are gated', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-compaction-')); dirs.push(dir)
    const port = await freePort()
    let s = teamServer(dir, port)
    await healthy(s.http)
    const session = await login(s.http, 'ada')
    expect((await postJson(s.http, '/rooms', { room: ROOM, session, schema: 2 })).ok).toBe(true)

    // Before any compaction an rc client (no gen) is served, as today.
    const rc = syncClient(s.ws, new Y.Doc(), { gen: null, session })
    await within(rc.synced); rc.ws.close()

    const a = new Y.Doc()
    const live = syncClient(s.ws, a, { session })
    await within(live.synced)
    expect(replicaGeneration(a)).toBe('0')
    churn(a, 200)
    a.getMap('claims').set('c1', { id: 'c1', by: 'ada' })
    a.getArray('list').push(['one', 'two'])
    expect(await hello(live, 's-ada')).toMatchObject({ ok: true })
    let acquired = await live.hub({ op: 'acquire', name: 'ada', holder: holder('s-ada') })
    for (let i = 0; i < 100 && !acquired.ok; i++) { await new Promise(r => setTimeout(r, 100)); acquired = await live.hub({ op: 'acquire', name: 'ada', holder: holder('s-ada') }) }
    expect(acquired).toMatchObject({ ok: true })
    const epoch = acquired.epoch as number
    const first = await live.hub({ op: 'post', lease: { name: 'ada', epoch }, msg: { id: 'm1', type: 'note', from: 'ada', text: 'before' } }) as Reply & { seq: number }
    expect(first).toMatchObject({ ok: true })
    await new Promise(r => setTimeout(r, 300)) // the doc's writes reach LevelDB

    await servers.stop(s.child)
    await within(live.closed)
    a.getMap('claims').set('offline', { id: 'offline', by: 'ada' }) // written while the server was down
    s = teamServer(dir, port)
    await healthy(s.http)

    // The old replica states 0; the room is compacted now. It is refused before any sync, and stays out.
    const stale = syncClient(s.ws, a, { session })
    expect(await within(stale.closed)).toEqual({ code: STALE_REPLICA_CODE, reason: expect.stringMatching(/compacted/) })
    expect(s.lines.join('\n')).toMatch(/compacted at load/)

    const b = new Y.Doc()
    const fresh = syncClient(s.ws, b, { session })
    await within(fresh.synced)
    const generation = docGeneration(b)
    expect(generation).toMatch(/^[0-9a-f]{32}$/)
    expect(replicaGeneration(b)).toBe(generation)
    expect(historyOf(b).deleted).toBe(0)
    expect(b.getMap('claims').has('c1')).toBe(true)
    expect(b.getMap('claims').has('offline')).toBe(false)
    expect(b.getArray('list').toArray()).toEqual(['one', 'two']) // no duplicated values
    expect(new RoomDoc(b).archive.toJSON()).toEqual(new RoomDoc(a).archive.toJSON())

    // Leases survive (same epoch, renewed by the same session) and counters are never reused.
    expect(await hello(fresh, 's-ada')).toMatchObject({ ok: true })
    let renew: Reply & Record<string, unknown> = { v: 1, re: '', ok: false } as never
    for (let i = 0; i < 100 && !renew.ok; i++) { renew = await fresh.hub({ op: 'renew', name: 'ada', epoch }); if (!renew.ok) await new Promise(r => setTimeout(r, 100)) }
    expect(renew).toMatchObject({ ok: true })
    const second = await fresh.hub({ op: 'post', lease: { name: 'ada', epoch }, msg: { id: 'm2', type: 'note', from: 'ada', text: 'after' } }) as Reply & { seq: number }
    expect(second).toMatchObject({ ok: true })
    expect(second.seq).toBeGreaterThan(first.seq)
    expect(await fresh.hub({ op: 'post', lease: { name: 'ada', epoch }, msg: { id: 'm1', type: 'note', from: 'ada', text: 'before' } })).toMatchObject({ ok: true, seq: first.seq })

    // rc clients state no generation: closed with 4403, which every rc client treats as final.
    const old = syncClient(s.ws, new Y.Doc(), { gen: null, session })
    expect(await within(old.closed)).toEqual({ code: 4403, reason: COMPACTED_UPDATE_REASON })

    // A read-only view passes the same gate.
    const { view } = await (await postJson(s.http, '/view-token', { room: ROOM, session, schema: 2 })).json() as { view: string }
    const ticket = async () => ((await (await postJson(s.http, '/ws-ticket', { room: ROOM, schema: 2, view })).json()) as { ticket: string }).ticket
    const staleView = syncClient(s.ws, a, { ticket: await ticket() })
    expect((await within(staleView.closed)).code).toBe(STALE_REPLICA_CODE)
    const viewer = syncClient(s.ws, new Y.Doc(), { ticket: await ticket() })
    await within(viewer.synced)
    viewer.ws.close(); fresh.ws.close()

    // The next restart has nothing worth compacting: the generation stays, and a current replica reconnects.
    await servers.stop(s.child)
    s = teamServer(dir, port)
    await healthy(s.http)
    const back = syncClient(s.ws, b, { session })
    await within(back.synced)
    expect(docGeneration(b)).toBe(generation)
    back.ws.close()
    await servers.stop(s.child)
  }, 90_000)

  it('a crash during compaction keeps the old document, and the next start compacts it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-compaction-crash-')); dirs.push(dir)
    const db = new LeveldbPersistence(dir)
    const seed = new Y.Doc(); seed.getMap('meta').set('schemaVersion', 2); churn(seed, 200)
    await db.storeUpdate(ROOM, Y.encodeStateAsUpdate(seed))
    await db.destroy()
    const migratedAt = Date.now()
    fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({ [ROOM]: { at: migratedAt, lastSeen: migratedAt, branches: [], mode: 'repo', migratedAt } }))
    const port = await freePort()
    let s = teamServer(dir, port, { ROOM_TEST_COMPACT_DELAY_MS: '30000' })
    await healthy(s.http)
    const session = await login(s.http, 'ada')
    const client = syncClient(s.ws, new Y.Doc(), { session })
    for (let i = 0; i < 200 && !s.lines.some(l => /compacting/.test(l)); i++) await new Promise(r => setTimeout(r, 50))
    expect(s.lines.join('\n')).toMatch(/compacting/)
    await servers.stop(s.child, 'SIGKILL') // mid-compaction
    await client.closed

    const check = new LeveldbPersistence(dir)
    const kept = await check.getYDoc(ROOM)
    expect(docGeneration(kept)).toBeUndefined()
    expect(new RoomDoc(kept).archive.toJSON()).toEqual(new RoomDoc(seed).archive.toJSON())
    await check.destroy()

    s = teamServer(dir, port)
    await healthy(s.http)
    const again = await login(s.http, 'ada')
    const b = new Y.Doc()
    const fresh = syncClient(s.ws, b, { session: again })
    await within(fresh.synced)
    expect(docGeneration(b)).toMatch(/^[0-9a-f]{32}$/)
    expect(new RoomDoc(b).archive.toJSON()).toEqual(new RoomDoc(seed).archive.toJSON())
    fresh.ws.close()
    await servers.stop(s.child)
  }, 90_000)
})
