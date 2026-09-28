import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializedStore, startHub, type Hub } from '@room/hub-core'
import { highestSeq, RoomDoc, type Msg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { Ledger } from '../src/ledger.js'
import type { Session } from '../src/session.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import { seedRegistryWorker } from './registry-fixture.js'

// Ledger "Cursor: a seq frontier (hub)": the frontier is the highest hub seq a session had observed at its
// first bind; hub §3 makes every later accepted seq larger, across hub restarts too.

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'room-cursor-')); execFileSync('git', ['-C', dir, 'init', '-q']) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(async () => { vi.unstubAllEnvs(); await closeRegistryForDir(dir) })

const session = (room: RoomDoc, name = 'pat'): Session => ({ room, me: { name, kind: 'agent' }, roomName: 'r', dir } as unknown as Session)
const ledger = (sessionDir?: string) => new Ledger({ sessionId: () => 'host-1', sessionDir: () => sessionDir, route: () => ({}) })
const ids = (messages: readonly Msg[]) => messages.map(m => m.id)

/** Post a broadcast through a hub, as a client's `post` request does (hub §2.3). */
function post(hub: Hub, id: string): number {
  const conn = {}
  expect(hub.handle(conn, { v: 1, id: `h-${id}`, op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: 'poster' }, { local: true })).toMatchObject({ ok: true })
  const reply = hub.handle(conn, { v: 1, id: `p-${id}`, op: 'post', auto: true, msg: { id, type: 'note', priority: 'notify', from: 'quinn', text: id } }, { local: true }) as { ok: boolean; seq: number }
  expect(reply).toMatchObject({ ok: true })
  return reply.seq
}

describe('the seq frontier', () => {
  it('a hub restart: a broadcast from a higher incarnation orders after every earlier seq, even when the wall clock went back', async () => {
    const room = new RoomDoc()
    let max: number | undefined
    const store = serializedStore({ read: async () => max, write: async v => { max = v } })
    let wall = Date.now()
    const host = { doc: room, mono: () => performance.now(), wall: () => wall, log: () => {}, store }
    const first = await startHub(host)
    const before = post(first, 'm_before')
    const s = session(room), l = ledger()
    l.bind(s)
    expect(l.frontier(s)).toBe(before)
    first.stop()
    wall -= 3_600_000
    const second = await startHub(host)
    expect(second.incarnation).toBeGreaterThan(first.incarnation)
    const after = post(second, 'm_after')
    expect(after).toBeGreaterThan(before)
    expect(ids(l.candidates(s))).toEqual(['m_after'])
    second.stop()
  })

  it('an MCP restart in the same host session keeps the frontier (cursor.json)', () => {
    const room = new RoomDoc(), sessionDir = join(dir, 'session-a')
    hubAppend(room, { name: 'quinn', kind: 'agent' }, { type: 'note', priority: 'notify', text: 'before' })
    const s = session(room)
    ledger(sessionDir).bind(s)
    const during = hubAppend(room, { name: 'quinn', kind: 'agent' }, { type: 'note', priority: 'notify', text: 'while the MCP restarted' })
    const restarted = ledger(sessionDir)
    restarted.bind(s)
    expect(ids(restarted.candidates(s))).toEqual([during.id])
    // A new session takes the highest seq at its own first bind.
    const fresh = ledger(join(dir, 'session-b'))
    fresh.bind(s)
    expect(fresh.frontier(s)).toBe(highestSeq(room))
    expect(fresh.candidates(s)).toEqual([])
  })

  it("a spawned worker seeds from its own run record's busFrontier: the lead's later briefing is owed, earlier chatter is not", async () => {
    const room = new RoomDoc()
    const lead = { name: 'lead', kind: 'agent' as const }
    hubAppend(room, lead, { type: 'note', priority: 'notify', text: 'old chatter' })
    const atIntent = highestSeq(room)
    const { record } = await seedRegistryWorker(dir, 'money', { name: 'lead+money' })
    await (await registryForDir(dir)).update(record.id, old => ({ ...old, runs: [{ ...old.runs[0], busFrontier: atIntent }], seq: old.seq + 1 }))
    const briefing = hubAppend(room, lead, { type: 'note', priority: 'notify', text: 'also mind the rounding' })
    hubAppend(room, { name: 'quinn', kind: 'agent' }, { type: 'note', priority: 'notify', text: 'after the worker bound' })
    vi.stubEnv('ROOM_WORKER_ID', record.id)
    vi.stubEnv('ROOM_WORKER_RUN', '1')
    const s = session(room, 'lead+money'), l = ledger()
    l.bind(s)
    expect(l.frontier(s)).toBe(atIntent)
    expect(ids(l.candidates(s))).toContain(briefing.id)
    expect(l.candidates(s).map(m => 'text' in m ? m.text : '')).not.toContain('old chatter')
    // Anyone else, or another participant's record, takes the highest seq at first bind.
    const someone = session(room, 'someone')
    expect(ledger().frontier(someone)).toBe(highestSeq(room))
  })
})
