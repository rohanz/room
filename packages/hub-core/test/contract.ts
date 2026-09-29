/**
 * The hub contract (docs/superpowers/specs/2026-09-28-hub.md §12, cases 1–6): one set of cases, run in
 * process (`memoryEnv`) and over the relay and server adapters with real sockets. Clocks are fake everywhere.
 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import WebSocket from 'ws'
import { OWED_PER_RECIPIENT, RoomDoc } from '@room/shared'
import {
  LEASE_TTL_MS, MSG_HUB, SETTLE_MS, decodeFrame, encodeFrame, incarnationOf, serializedStore, startHub,
  type Hub, type HubHost, type HolderIn, type Principal, type Push, type Reply,
} from '../src/index.js'

export interface FakeClock { mono(): number; wall(): number; advance(ms: number): void }
export function fakeClock(wall = Date.UTC(2026, 8, 28, 12)): FakeClock {
  let mono = 1_000, offset = wall
  return { mono: () => mono, wall: () => offset, advance(ms) { mono += ms; offset += ms } }
}

type Body = Record<string, unknown> & { op: string }
export interface ContractClient {
  send(body: Body): Promise<Reply>
  hello(): Promise<Reply>
  readonly pushes: Push[]
  close(): Promise<void>
}
interface ContractEnv {
  clock: FakeClock
  /** The hub's document. */
  doc(): RoomDoc
  connect(): Promise<ContractClient>
  /** One hub tick, after in-flight frames have landed. */
  tick(): Promise<void>
  /** Stop the hub and start the next incarnation on the same doc, or on a doc rebuilt from `state` alone. */
  restart(state?: Uint8Array): Promise<void>
  incarnation(): number
  close(): Promise<void>
}
export type MakeEnv = (clock: FakeClock) => Promise<ContractEnv>

/** This test process as the holder: alive to a relay's liveness check, identity unread. */
export const holder = (sessionId: string, extra: Partial<HolderIn> = {}): HolderIn => ({ sessionId, pid: process.pid, startTime: '', executable: '', ...extra })

/** A hub client over a real websocket: replies matched by id, pushes collected. */
export async function socketClient(url: string): Promise<ContractClient & { ws: WebSocket }> {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
  const pending = new Map<string, (r: Reply) => void>()
  const pushes: Push[] = []
  ws.on('message', (data: ArrayBuffer) => {
    const buf = new Uint8Array(data)
    if (buf[0] !== MSG_HUB) return
    const frame = decodeFrame(buf) as Reply | Push
    if ('push' in frame) pushes.push(frame)
    else pending.get(frame.re)?.(frame)
  })
  let n = 0
  const send = (body: Body) => new Promise<Reply>(resolve => {
    const id = `r${++n}`
    pending.set(id, reply => { pending.delete(id); resolve(reply) })
    ws.send(encodeFrame({ v: 1, id, ...body } as never))
  })
  return {
    ws, send, pushes,
    hello: () => send({ op: 'hello', proto: 1, schema: 2, client: 'contract', sessionId: 'c' }),
    close: () => new Promise<void>(resolve => { if (ws.readyState === ws.CLOSED) return resolve(); ws.once('close', () => resolve()); ws.close() }),
  }
}

export async function waitFor<T>(read: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise(r => setTimeout(r, 5))
  }
}

const ok = (r: Reply) => { expect(r).toMatchObject({ ok: true }); return r as Reply & Record<string, unknown> }
const refused = (r: Reply, reason: string) => { expect(r).toMatchObject({ ok: false, reason }); return r as Reply & Record<string, unknown> }
const holderOf = (doc: RoomDoc, name: string) => doc.participants.get(`${name}\u0000holder`) as Record<string, unknown> | undefined

async function ready(make: MakeEnv): Promise<ContractEnv & { a: ContractClient }> {
  const env = await make(fakeClock())
  env.clock.advance(SETTLE_MS)
  const a = await env.connect()
  ok(await a.hello())
  return Object.assign(env, { a })
}

async function greeted(env: ContractEnv): Promise<ContractClient> {
  const c = await env.connect()
  ok(await c.hello())
  return c
}

export function contractSuite(name: string, make: MakeEnv): void {
  describe(`hub contract: ${name}`, () => {
    it('1. acquire, renew, release; held; the same session supersedes; supersedes hands over', async () => {
      const env = await ready(make)
      try {
        const { a } = env
        const hello = ok(await a.hello())
        expect(hello).toMatchObject({ proto: 1, incarnation: env.incarnation(), ttlMs: 45_000, renewMs: 15_000, authority: true })
        const e1 = ok(await a.send({ op: 'acquire', name: 'ada', holder: holder('s1') })).epoch as number
        expect(incarnationOf(e1)).toBe(env.incarnation())
        expect(holderOf(env.doc(), 'ada')).toMatchObject({ sessionId: 's1', epoch: e1, pid: process.pid })
        expect(holderOf(env.doc(), 'ada')).not.toHaveProperty('ended')
        expect(env.doc().metaMap.get('hubEpoch')).toBe(e1)

        const b = await greeted(env)
        const held = refused(await b.send({ op: 'acquire', name: 'ada', holder: holder('s2') }), 'held')
        expect(held.holder).toMatchObject({ sessionId: 's1' })
        ok(await a.send({ op: 'renew', name: 'ada', epoch: e1 }))
        refused(await b.send({ op: 'renew', name: 'ada', epoch: e1 + 1 }), 'stale')

        // The same session, reconnected, supersedes itself; the old connection hears it.
        const c = await greeted(env)
        const e2 = ok(await c.send({ op: 'acquire', name: 'ada', holder: holder('s1') })).epoch as number
        expect(e2).toBeGreaterThan(e1)
        await waitFor(() => a.pushes.length)
        expect(a.pushes[0]).toMatchObject({ push: 'lease-lost', name: 'ada', epoch: e1, reason: 'superseded' })
        refused(await a.send({ op: 'renew', name: 'ada', epoch: e1 }), 'stale')

        // A worker takes over the name its lead reserved.
        const e3 = ok(await b.send({ op: 'acquire', name: 'ada', holder: holder('s2'), supersedes: e2 })).epoch as number
        expect(e3).toBeGreaterThan(e2)
        await waitFor(() => c.pushes.length)
        expect(c.pushes[0]).toMatchObject({ epoch: e2, reason: 'superseded' })

        ok(await b.send({ op: 'release', name: 'ada', epoch: e3 }))
        expect(holderOf(env.doc(), 'ada')).toMatchObject({ epoch: e3, ended: 'released' })
        ok(await b.send({ op: 'release', name: 'ada', epoch: e3 }))
        refused(await b.send({ op: 'release', name: 'ada', epoch: e1 }), 'stale')
        ok(await a.send({ op: 'acquire', name: 'ada', holder: holder('s1') }))
        for (const client of [a, b, c]) await client.close()
      } finally { await env.close() }
    })

    it('2. post: seq order, duplicates, gone, limits, hello-first, version', async () => {
      const env = await ready(make)
      try {
        const { a } = env
        const fresh = await env.connect()
        refused(await fresh.send({ op: 'post', msg: { id: 'm0', type: 'note', from: 'ada', text: 'x' } }), 'hello-first')
        expect(refused(await fresh.send({ op: 'hello', proto: 2, schema: 2, client: 't', sessionId: 's' }), 'version').text).toMatch(/hub needs updating/)
        expect(refused(await fresh.send({ op: 'hello', proto: 0, schema: 2, client: 't', sessionId: 's' }), 'version').text).toMatch(/update Room/)
        const L = { name: 'ada', epoch: ok(await a.send({ op: 'acquire', name: 'ada', holder: holder('s1') })).epoch as number }
        refused(await a.send({ op: 'post', lease: L, msg: { id: 'mx', type: 'nope', from: 'ada' } }), 'invalid')
        // Every post carries the poster's own name lease (wave 4).
        expect(refused(await a.send({ op: 'post', msg: { id: 'm0', type: 'note', from: 'ada', text: 'x' } }), 'invalid').text).toBe("a post carries the poster's name lease")

        const first = ok(await a.send({ op: 'post', lease: L, msg: { id: 'm1', type: 'note', from: 'ada', text: 'hello' } }))
        const second = ok(await a.send({ op: 'post', lease: L, msg: { id: 'm2', type: 'note', from: 'ada', text: 'again' } }))
        expect(second.seq as number).toBeGreaterThan(first.seq as number)
        expect(first.at).toBe(env.clock.wall())
        expect(env.doc().messages().map(m => [m.id, (m as unknown as { seq: number }).seq, m.priority])).toEqual([['m1', first.seq, 'fyi'], ['m2', second.seq, 'fyi']])
        expect(env.doc().metaMap.get('hubSeq')).toBe(second.seq)

        const again = ok(await a.send({ op: 'post', lease: L, msg: { id: 'm1', type: 'note', from: 'ada', text: 'hello' } }))
        expect(again).toMatchObject({ duplicate: true, seq: first.seq })
        expect(env.doc().messages()).toHaveLength(2)
        env.doc().doc.transact(() => { env.doc().archive.set('m-old', ['note', 'ada', 1, []]) })
        const gone = ok(await a.send({ op: 'post', lease: L, msg: { id: 'm-old', type: 'note', from: 'ada', text: 'x' } }))
        expect(gone).toMatchObject({ duplicate: true, gone: true })
        expect(gone).not.toHaveProperty('seq')

        refused(await a.send({ op: 'post', lease: L, msg: { id: 'big', type: 'note', from: 'ada', text: 'x'.repeat(70 * 1024) } }), 'too-large')
        for (let i = 0; i < OWED_PER_RECIPIENT; i++) ok(await a.send({ op: 'post', lease: L, msg: { id: `q${i}`, type: 'question', from: 'ada', to: 'bob', text: `q${i}` } }))
        expect(refused(await a.send({ op: 'post', lease: L, msg: { id: 'q-over', type: 'question', from: 'ada', to: 'bob', text: 'one more' } }), 'over-cap').text).toMatch(/bob has 200 undelivered/)
        ok(await a.send({ op: 'post', lease: L, msg: { id: 'auto-1', type: 'note', from: 'ada', to: 'bob', text: 'automatic' }, auto: true }))

        const epoch = ok(await a.send({ op: 'acquire', name: 'ada', holder: holder('s1') })).epoch as number
        refused(await a.send({ op: 'post', lease: { name: 'ada', epoch: epoch + 1 }, msg: { id: 'm3', type: 'note', from: 'ada', text: 'x' } }), 'stale')
        ok(await a.send({ op: 'post', lease: { name: 'ada', epoch }, msg: { id: 'm3', type: 'note', from: 'ada', text: 'x' } }))
        await fresh.close(); await a.close()
      } finally { await env.close() }
    })

    it('3. the lease ends 45 s after the last renew on the hub clock; the name is grantable', async () => {
      const env = await ready(make)
      try {
        const { a } = env
        const epoch = ok(await a.send({ op: 'acquire', name: 'ada', holder: holder('s1') })).epoch as number
        env.clock.advance(30_000)
        ok(await a.send({ op: 'renew', name: 'ada', epoch }))
        env.clock.advance(LEASE_TTL_MS - 1)
        await env.tick()
        expect(holderOf(env.doc(), 'ada')).not.toHaveProperty('ended')
        env.clock.advance(1)
        await env.tick()
        expect(holderOf(env.doc(), 'ada')).toMatchObject({ epoch, ended: 'expired' })
        await waitFor(() => a.pushes.length)
        expect(a.pushes[0]).toMatchObject({ name: 'ada', epoch, reason: 'expired' })
        const b = await greeted(env)
        ok(await b.send({ op: 'acquire', name: 'ada', holder: holder('s2') }))
        await a.close(); await b.close()
      } finally { await env.close() }
    })

    it('4. restart: a higher incarnation, values above all earlier ones, leases kept, the settle window', async () => {
      const env = await ready(make)
      try {
        const { a } = env
        const before = env.incarnation()
        const ada = ok(await a.send({ op: 'acquire', name: 'ada', holder: holder('s1') })).epoch as number
        const seq = ok(await a.send({ op: 'post', lease: { name: 'ada', epoch: ada }, msg: { id: 'm1', type: 'note', from: 'ada', text: 'x' } })).seq as number
        const snapshot = Y.encodeStateAsUpdate(env.doc().doc)
        const cy = ok(await a.send({ op: 'acquire', name: 'cy', holder: holder('s3') })).epoch as number
        const dee = ok(await a.send({ op: 'acquire', name: 'dee', holder: holder('s4') })).epoch as number
        await a.close()

        // The successor's doc lacks the last grants (cy, dee): their holders have not synced yet.
        env.clock.advance(1_000)
        await env.restart(snapshot)
        expect(env.incarnation()).toBeGreaterThan(before)
        const c = await greeted(env)
        expect(ok(await c.hello()).incarnation).toBe(env.incarnation())
        expect(refused(await c.send({ op: 'acquire', name: 'bob', holder: holder('s2') }), 'starting').retryMs).toBe(1000)
        ok(await c.send({ op: 'renew', name: 'cy', epoch: cy }))
        refused(await c.send({ op: 'acquire', name: 'cy', holder: holder('other') }), 'held')

        env.clock.advance(SETTLE_MS)
        refused(await c.send({ op: 'renew', name: 'dee', epoch: dee }), 'stale')
        const bob = ok(await c.send({ op: 'acquire', name: 'bob', holder: holder('s2') })).epoch as number
        const seq2 = ok(await c.send({ op: 'post', lease: { name: 'bob', epoch: bob }, msg: { id: 'm2', type: 'note', from: 'ada', text: 'y' } })).seq as number
        expect(bob).toBeGreaterThan(Math.max(ada, cy, dee, seq))
        expect(seq2).toBeGreaterThan(Math.max(ada, cy, dee, seq))
        // A carried lease gets a fresh TTL from the restart, not from its grant a second earlier.
        env.clock.advance(LEASE_TTL_MS - SETTLE_MS - 1)
        await env.tick()
        expect(holderOf(env.doc(), 'ada')).not.toHaveProperty('ended')
        env.clock.advance(1)
        await env.tick()
        expect(holderOf(env.doc(), 'ada')).toMatchObject({ epoch: ada, ended: 'expired' })
        await c.close()
      } finally { await env.close() }
    })

    it('5. durability: losing the last doc updates never repeats a value', async () => {
      const env = await ready(make)
      try {
        const { a } = env
        const snapshot = Y.encodeStateAsUpdate(env.doc().doc)
        const issued: number[] = []
        issued.push(ok(await a.send({ op: 'acquire', name: 'ada', holder: holder('s1') })).epoch as number)
        for (let i = 0; i < 3; i++) issued.push(ok(await a.send({ op: 'post', lease: { name: 'ada', epoch: issued[0] }, msg: { id: `m${i}`, type: 'note', from: 'ada', text: 'x' } })).seq as number)
        await a.close()
        await env.restart(snapshot)
        await env.restart(snapshot)
        env.clock.advance(SETTLE_MS)
        const c = await greeted(env)
        const epoch2 = ok(await c.send({ op: 'acquire', name: 'ada', holder: holder('s2') })).epoch as number
        const later = [epoch2, ok(await c.send({ op: 'post', lease: { name: 'ada', epoch: epoch2 }, msg: { id: 'm0', type: 'note', from: 'ada', text: 'x' } })).seq as number]
        for (const v of later) expect(v).toBeGreaterThan(Math.max(...issued))
        await c.close()
      } finally { await env.close() }
    })

    it("6. re-assertion: a stale replica's holder and meta lose; resurrected archived messages go", async () => {
      const env = await ready(make)
      try {
        const { a } = env
        const epoch = ok(await a.send({ op: 'acquire', name: 'ada', holder: holder('s1') })).epoch as number
        const seq = ok(await a.send({ op: 'post', lease: { name: 'ada', epoch }, msg: { id: 'm1', type: 'note', from: 'ada', text: 'x' } })).seq as number
        const doc = env.doc()
        doc.doc.transact(() => { doc.archive.set('m-archived', ['note', 'ada', 1, []]) })
        // A replica that saw everything writes older values over them (a value copy with new CRDT items).
        const replica = new Y.Doc()
        Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc.doc))
        const stale = new RoomDoc(replica)
        replica.transact(() => {
          stale.participants.set('ada\u0000holder', { ...holder('old'), epoch: epoch - 1, at: 1 })
          stale.participants.set('zed\u0000holder', { ...holder('z'), epoch: epoch - 1, at: 1 })
          stale.metaMap.set('hubSeq', seq - 1)
          stale.bus.push([{ id: 'm-archived', type: 'note', from: 'ada', text: 'x', at: 1, priority: 'fyi', fromKind: 'agent' } as never])
          stale.bus.push([{ id: 'm-replica', type: 'note', from: 'ada', text: 'kept', at: 2, priority: 'fyi', fromKind: 'agent' } as never])
          stale.bus.push([{ id: 'm1', type: 'note', from: 'ada', text: 'x', at: 3, priority: 'fyi', fromKind: 'agent' } as never])
        })
        doc.doc.transact(() => { Y.applyUpdate(doc.doc, Y.encodeStateAsUpdate(replica)) }, 'replica')
        expect(holderOf(doc, 'ada')).toMatchObject({ sessionId: 'old' })
        await env.tick()
        expect(holderOf(doc, 'ada')).toMatchObject({ sessionId: 's1', epoch })
        expect(holderOf(doc, 'ada')).not.toHaveProperty('ended')
        expect(holderOf(doc, 'zed')).toMatchObject({ ended: 'expired' })
        expect(doc.metaMap.get('hubSeq')).toBe(seq)
        expect(doc.messages().map(m => m.id)).toEqual(['m1', 'm-replica'])
        await a.close()
      } finally { await env.close() }
    })
  })
}

/** The hub in process: connections are plain objects, pushes are delivered synchronously. */
export function memoryEnv(extra: Partial<Pick<HubHost, 'holderDead' | 'authority' | 'counterLimit'>> & { store?: HubHost['store']; logs?: string[] } = {}): MakeEnv {
  return async clock => {
    let max: number | undefined
    const store = extra.store ?? serializedStore({ read: async () => max, write: async v => { max = v } })
    let doc = new RoomDoc()
    const clients = new Map<object, Push[]>()
    const start = async () => {
      const hub = await startHub({ doc, mono: clock.mono, wall: clock.wall, log: l => { extra.logs?.push(l) }, store, ...extra })
      hub.onPush((conn, push) => clients.get(conn)?.push(push))
      return hub
    }
    let hub: Hub = await start()
    let n = 0
    return {
      clock,
      doc: () => doc,
      incarnation: () => hub.incarnation,
      async connect() {
        const conn = {}
        const pushes: Push[] = []
        clients.set(conn, pushes)
        const p: Principal = { local: true }
        const send = async (body: Body) => hub.handle(conn, { v: 1, id: `r${++n}`, ...body }, p)
        return { send, pushes, hello: () => send({ op: 'hello', proto: 1, schema: 2, client: 'contract', sessionId: 'c' }), async close() { hub.closed(conn); clients.delete(conn) } }
      },
      async tick() { hub.tick() },
      async restart(state) {
        hub.stop()
        if (state) { doc = new RoomDoc(new Y.Doc()); Y.applyUpdate(doc.doc, state) }
        hub = await start()
      },
      async close() { hub.stop() },
    }
  }
}
