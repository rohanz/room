import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import { LEASE_TTL_MS, SETTLE_MS } from '@room/hub-core'
import { AuthorityLock, startRelay, type StartedRelay } from '@room/relay'
import { acceptedGit, participantRecord, participantsView } from '@room/shared'
import { HubClient, hubTransport } from '../src/hub-client.js'
import { probeProcess } from '../src/worker-process.js'
import type { InstanceToken } from '../src/leases.js'
import { acquireName, nameLeaseFile, NameRefused, ownsLocalName, ParticipantLease, takeLocalName, type Candidate, type NameLease } from '../src/names.js'

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

const self = probeProcess(process.pid)!
const token = (sessionId: string, nonce = randomUUID()): InstanceToken => ({ pid: process.pid, startTime: self.startTime!, executable: self.executable!, sessionId, nonce })
const holderOf = (t: InstanceToken) => ({ sessionId: t.sessionId, pid: t.pid, startTime: t.startTime, executable: t.executable })
function commonDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-names-'))
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const lease = (roomKey: string, name: string, holder: InstanceToken, extra: Partial<NameLease> = {}): NameLease => ({ roomKey, name, holder, host: 'claude', worktree: '/w', at: 1, ...extra })
const candidates = (base: string): Candidate[] => [{ name: base, tag: '' }, { name: `${base}+claude`, tag: 'claude' }, { name: `${base}+claude-2`, tag: 'claude-2' }]

describe('the local name lease (registry §15 table)', () => {
  const file = () => nameLeaseFile(commonDir(), 'local/r', 'ben')
  const aliveProbe = () => ({ startTime: self.startTime, executable: self.executable })

  it('refuses another live session, and recovers a dead holder', async () => {
    const f = file()
    const a = token('sa'), b = token('sb')
    expect(await takeLocalName(f, lease('local/r', 'ben', a))).toEqual({ ok: true })
    expect(await takeLocalName(f, lease('local/r', 'ben', b))).toMatchObject({ ok: false, liveness: 'alive', worktree: '/w' })
    const dead = { ...token('sd'), pid: 2 ** 22 + 17 }
    fs.rmSync(f); expect(await takeLocalName(f, lease('local/r', 'ben', dead))).toEqual({ ok: true })
    expect(await takeLocalName(f, lease('local/r', 'ben', b))).toEqual({ ok: true })
    expect(ownsLocalName(f, b)).toBe(true)
  })

  it('lets the same session take over by nonce, so the predecessor sees it stood down (row 16)', async () => {
    const f = file()
    const first = token('s1'), second = token('s1')
    await takeLocalName(f, lease('local/r', 'ben', first))
    expect(await takeLocalName(f, lease('local/r', 'ben', second))).toEqual({ ok: true })
    expect(ownsLocalName(f, first)).toBe(false)
    expect(ownsLocalName(f, second)).toBe(true)
  })

  it('lets an admitted worker take over its lead\'s reservation, and takeover=true only an unknown holder', async () => {
    const f = file()
    await takeLocalName(f, lease('local/r', 'ben', token('lead'), { workerId: 'w_1' }))
    expect(await takeLocalName(f, lease('local/r', 'ben', token('other')))).toMatchObject({ ok: false })
    expect(await takeLocalName(f, lease('local/r', 'ben', token('worker'), { workerId: 'w_1' }), { workerId: 'w_1' })).toEqual({ ok: true })
    expect(await takeLocalName(f, lease('local/r', 'ben', token('x')), { takeover: true })).toMatchObject({ ok: false, liveness: 'alive' })
    const unknown = () => ({})
    expect(await takeLocalName(f, lease('local/r', 'ben', token('x')), { takeover: true, probe: unknown })).toEqual({ ok: true })
    expect(aliveProbe()).toBeTruthy()
  })
})

/** A relay whose hub runs on a test clock, and sessions that reach it through their own providers. */
async function relayHub() {
  const common = commonDir()
  let mono = 1_000, wall = Date.UTC(2026, 8, 28, 12)
  const relay: StartedRelay = await startRelay(0, { key: 'k', commonDir: common, hub: { lock: AuthorityLock.take(common)!, mono: () => mono, wall: () => wall } })
  cleanup.push(() => relay.close())
  const room = 'local/names/main'
  const connect = async (sessionId: string, clock?: { mono: () => number; wall: () => number }) => {
    const doc = new Y.Doc()
    const provider = new WebsocketProvider(`ws://127.0.0.1:${relay.port}`, encodeURIComponent(room), doc, { WebSocketPolyfill: WebSocket as any, params: { key: 'k' } })
    await new Promise<void>(resolve => provider.once('sync', () => resolve()))
    const hub = new HubClient({ transport: hubTransport(provider), client: 'test', sessionId, local: true, ...clock })
    cleanup.push(() => { hub.close(); provider.destroy(); doc.destroy() })
    await hub.hello()
    return { doc, provider, hub }
  }
  // The hub starts with the room's first connection; its settle window passes on the test clock.
  const first = await connect('warmup')
  for (let i = 0; i < 100 && !relay.hubRoom(room)?.hub; i++) await new Promise(r => setTimeout(r, 10))
  mono += SETTLE_MS; wall += SETTLE_MS
  first.provider.destroy()
  return { relay, room, connect, advance: (ms: number) => { mono += ms; wall += ms }, doc: () => relay.hubRoom(room)!.doc }
}

describe('names from the hub over a real relay socket', () => {
  it('two clones at one instant under one name: the hub grants one, the other takes the next candidate (row 15)', async () => {
    const env = await relayHub()
    const [a, b] = await Promise.all([env.connect('sa'), env.connect('sb')])
    const ta = token('sa'), tb = token('sb')
    const [ga, gb] = await Promise.all([
      acquireName({ commonDir: commonDir(), roomKey: env.room, candidates: candidates('ben'), token: ta, holder: holderOf(ta), host: 'claude', worktree: '/a', hub: a.hub }),
      acquireName({ commonDir: commonDir(), roomKey: env.room, candidates: candidates('ben'), token: tb, holder: holderOf(tb), host: 'claude', worktree: '/b', hub: b.hub }),
    ])
    expect([ga.name, gb.name].sort()).toEqual(['ben', 'ben+claude'])
    const loser = ga.name === 'ben' ? gb : ga
    expect(loser.passed.get('ben')).toBe('held by another session')
    expect(ga.epoch).not.toBe(gb.epoch)
    const holder = participantRecord(env.doc(), 'ben')!.holder!
    expect(String(holder.epoch)).toBe(String(ga.name === 'ben' ? ga.epoch : gb.epoch))
  })

  it('refuses an explicit tag that another session holds', async () => {
    const env = await relayHub()
    const [a, b] = await Promise.all([env.connect('sa'), env.connect('sb')])
    const ta = token('sa'), tb = token('sb')
    await acquireName({ commonDir: commonDir(), roomKey: env.room, candidates: [{ name: 'ben+ci', tag: 'ci' }], explicit: true, token: ta, holder: holderOf(ta), host: 'claude', worktree: '/a', hub: a.hub })
    await expect(acquireName({ commonDir: commonDir(), roomKey: env.room, candidates: [{ name: 'ben+ci', tag: 'ci' }], explicit: true, token: tb, holder: holderOf(tb), host: 'claude', worktree: '/b', hub: b.hub }))
      .rejects.toBeInstanceOf(NameRefused)
  })

  it('a holder whose lease lapses pauses, loses the name to a later session and says so; its late writes are rejected by fence', async () => {
    const env = await relayHub()
    let clientMono = 0, clientWall = 0
    const a = await env.connect('sa', { mono: () => clientMono, wall: () => clientWall })
    const b = await env.connect('sb')
    const ta = token('sa'), tb = token('sb')
    const common = commonDir()
    const got = await acquireName({ commonDir: common, roomKey: env.room, candidates: candidates('ben'), token: ta, holder: holderOf(ta), host: 'claude', worktree: '/a', hub: a.hub })
    const fences: Array<string | undefined> = []
    const held = new ParticipantLease({ name: got.name, file: got.file, token: ta, holder: holderOf(ta), hub: a.hub, epoch: got.epoch, onChange: f => fences.push(f), tickMs: 60_000 })
    cleanup.push(() => held.end())
    const oldFence = held.fence()!
    expect(oldFence).toBe(String(got.epoch))
    // A laptop asleep past the TTL: the client clock alone pauses it (hub §4.3), before the hub re-grants.
    a.provider.disconnect()
    clientWall += LEASE_TTL_MS + 15_000
    expect(held.fence()).toBeUndefined()
    expect(held.paused()).toMatch(/^\[room\] hub unreachable; coordination paused/)
    env.advance(LEASE_TTL_MS)
    const other = await acquireName({ commonDir: commonDir(), roomKey: env.room, candidates: candidates('ben'), token: tb, holder: holderOf(tb), host: 'claude', worktree: '/b', hub: b.hub })
    expect(other.name).toBe('ben')
    a.provider.connect()
    await new Promise<void>(resolve => a.provider.once('sync', () => resolve()))
    await expect.poll(() => { held.check(); return held.state }, { timeout: 15_000 }).toBe('taken')
    expect(held.paused()).toBe('[room] another session now holds ben; rejoin to take a new name. Coordination is paused; your files are unaffected.')
    expect(fs.existsSync(got.file)).toBe(false)
    expect(fences).toEqual([undefined])
    // A write the sleeper made under its lapsed lease carries the old fence; readers reject it.
    const doc = env.doc()
    doc.participants.set('ben\0git', { branch: 'main', head: 'h', base: 'b', anchored: true, rev: 1, fence: oldFence })
    expect(acceptedGit(participantRecord(doc, 'ben'), participantsView(doc, { getStates: () => new Map() }, Date.now()))).toBe('updating')
  })

  it('re-acquires a lapsed lease the hub still holds for this session, under a new epoch', async () => {
    const env = await relayHub()
    let clientWall = 0
    const a = await env.connect('sa', { mono: () => 0, wall: () => clientWall })
    const ta = token('sa')
    const got = await acquireName({ commonDir: commonDir(), roomKey: env.room, candidates: candidates('ben'), token: ta, holder: holderOf(ta), host: 'claude', worktree: '/a', hub: a.hub })
    const fences: Array<string | undefined> = []
    const held = new ParticipantLease({ name: got.name, file: got.file, token: ta, holder: holderOf(ta), hub: a.hub, epoch: got.epoch, onChange: f => fences.push(f), tickMs: 60_000 })
    cleanup.push(() => held.end())
    clientWall += LEASE_TTL_MS
    // The hub still answers: the line names the lapsed lease, not an unreachable hub (hub rehearsal observation a).
    expect(held.paused()).toBe('[room] the name lease on ben lapsed; coordination paused while it is re-acquired. Your files are unaffected; messages and claims resume when it is back.')
    await expect.poll(() => { held.check(); return held.state }, { timeout: 15_000 }).toBe('held')
    expect(fences).toHaveLength(2)
    expect(fences[0]).toBeUndefined()
    expect(Number(fences[1])).toBeGreaterThan(got.epoch!)
    expect(participantRecord(env.doc(), 'ben')!.holder!.epoch).toBe(Number(fences[1]))
  })

  it('same-session MCP replacement: the predecessor stands down on its next check (row 16)', async () => {
    const env = await relayHub()
    const common = commonDir()
    const a = await env.connect('s1'), a2 = await env.connect('s1')
    const first = token('s1'), second = token('s1')
    const got = await acquireName({ commonDir: common, roomKey: env.room, candidates: candidates('ben'), token: first, holder: holderOf(first), host: 'claude', worktree: '/a', hub: a.hub })
    const old = new ParticipantLease({ name: got.name, file: got.file, token: first, holder: holderOf(first), hub: a.hub, epoch: got.epoch, tickMs: 60_000 })
    cleanup.push(() => old.end())
    const next = await acquireName({ commonDir: common, roomKey: env.room, candidates: candidates('ben'), token: second, holder: holderOf(second), host: 'claude', worktree: '/a', hub: a2.hub })
    expect(next.name).toBe('ben')
    expect(next.epoch).toBeGreaterThan(got.epoch!)
    old.check()
    expect(old.state).toBe('superseded')
    expect(old.fence()).toBeUndefined()
    expect(old.paused()).toMatch(/newer Room process of this session took over ben/)
    await old.end()
    // Standing down releases nothing that is now the successor's.
    expect(ownsLocalName(next.file, second)).toBe(true)
    expect(participantRecord(env.doc(), 'ben')!.holder).toMatchObject({ epoch: next.epoch })
    expect(participantRecord(env.doc(), 'ben')!.holder!.ended).toBeUndefined()
  })

  it('a worker takes over the name its lead reserved by the epoch, and the lead is never paused by it (row 3)', async () => {
    const env = await relayHub()
    const lead = await env.connect('lead'), worker = await env.connect('worker'), stranger = await env.connect('stranger')
    const tl = token('lead'), tw = token('worker'), ts = token('stranger')
    const epoch = await lead.hub.reserve('ben+w', { ...holderOf(tl), workerId: 'w_1' })
    const explicit = [{ name: 'ben+w', tag: 'w' }]
    await expect(acquireName({ commonDir: commonDir(), roomKey: env.room, candidates: explicit, explicit: true, token: ts, holder: holderOf(ts), host: 'claude', worktree: '/s', hub: stranger.hub }))
      .rejects.toThrow('ben+w is held by another session')
    const got = await acquireName({ commonDir: commonDir(), roomKey: env.room, candidates: explicit, explicit: true, token: tw, holder: { ...holderOf(tw), workerId: 'w_1' },
      host: 'claude', worktree: '/w', hub: worker.hub, supersedes: epoch, workerId: 'w_1' })
    expect(got.epoch).toBeGreaterThan(epoch)
    expect(participantRecord(env.doc(), 'ben+w')!.holder).toMatchObject({ sessionId: 'worker', workerId: 'w_1' })
    expect(lead.hub.paused()).toBeUndefined()
  })

  it('a worker that starts after its reservation expired (45 s) still gets its name, with a new epoch', async () => {
    const env = await relayHub()
    const lead = await env.connect('lead'), worker = await env.connect('worker')
    const tl = token('lead'), tw = token('worker')
    const epoch = await lead.hub.reserve('ben+w', { ...holderOf(tl), workerId: 'w_1' })
    env.advance(LEASE_TTL_MS)
    const got = await acquireName({ commonDir: commonDir(), roomKey: env.room, candidates: [{ name: 'ben+w', tag: 'w' }], explicit: true, token: tw,
      holder: { ...holderOf(tw), workerId: 'w_1' }, host: 'claude', worktree: '/w', hub: worker.hub, supersedes: epoch, workerId: 'w_1' })
    expect(got.epoch).toBeGreaterThan(epoch)
    expect(participantRecord(env.doc(), 'ben+w')!.holder).toMatchObject({ sessionId: 'worker', epoch: got.epoch })
  })

  it('ending the hold releases the hub lease before the file, so the name is free at once', async () => {
    const env = await relayHub()
    const a = await env.connect('sa'), b = await env.connect('sb')
    const ta = token('sa'), tb = token('sb')
    const got = await acquireName({ commonDir: commonDir(), roomKey: env.room, candidates: candidates('ben'), token: ta, holder: holderOf(ta), host: 'claude', worktree: '/a', hub: a.hub })
    const held = new ParticipantLease({ name: got.name, file: got.file, token: ta, holder: holderOf(ta), hub: a.hub, epoch: got.epoch, tickMs: 60_000 })
    await held.end()
    expect(participantRecord(env.doc(), 'ben')!.holder!.ended).toBe('released')
    expect(fs.existsSync(got.file)).toBe(false)
    const next = await acquireName({ commonDir: commonDir(), roomKey: env.room, candidates: candidates('ben'), token: tb, holder: holderOf(tb), host: 'claude', worktree: '/b', hub: b.hub })
    expect(next.name).toBe('ben')
  })
})
