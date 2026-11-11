import { afterEach, expect } from 'vitest'
import { RoomDoc, owed } from '@room/shared'
import * as core from '../src/index.js'
import { fakeClock, holder } from './contract.js'

export const bound = (id: string, workers = ['w1']) => core.workerNoticeId(id, workers)!
export const local = { local: true } as const
const close: (() => void)[] = []
afterEach(() => { for (const stop of close.splice(0)) stop() })
export async function noticeFixture(managed = true) {
  const room = new RoomDoc(), clock = fakeClock()
  let max: number | undefined, authoritative = true, serial = 0
  const hub = await core.startHub({ doc: room, mono: clock.mono, wall: clock.wall, log() {}, authority: () => authoritative,
    store: core.serializedStore({ read: async () => max, write: async n => { max = n } }) })
  clock.advance(core.SETTLE_MS)
  const conn = {}, worker = {}
  for (const [c, sessionId] of [[conn, 'session-A'], [worker, 'session-B']] as const) {
    expect(hub.handle(c, { v: 1, id: 'hello', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId }, local).ok).toBe(true)
    if (managed) hub.noticeContract(c, { capabilities: { 'room.notice-lifecycle': 1 } })
  }
  const grant = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'A', holder: holder('session-A') }, local)
  expect(grant.ok).toBe(true)
  expect(hub.handle(worker, { v: 1, id: 'b', op: 'acquire', name: 'B', holder: holder('session-B', { workerId: 'w1' }) }, local).ok).toBe(true)
  const lease = { name: 'A', epoch: Number(grant.epoch) }
  const evidence = (names = ['A', 'B']) => core.noticeEvidence(room, names)
  const record = (producer = 'producer-A') => room.doc.getMap<core.NoticeRecord>('noticeInventory').get(producer)!
  const request = (change: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const data = { ...change, ...extra }
    return hub.handle(conn, { v: 1, id: `request-${++serial}`, op: 'notice-lifecycle', generation: hub.incarnation, lease,
      producer: data.action === 'retire' ? 'retirement' : 'producer-A', expected: 0, operation: `operation-${serial}`,
      ...(data.action === 'register' ? { evidence: evidence(), episode: 'registration-token' } : {}), ...data }, local) as any
  }
  const message = (id: string, priority = 'notify', clean = false) => ({ id, from: 'room', fromKind: 'agent', to: 'A',
    type: 'merge-conflict', path: 'x', text: clean ? 'the conflict with B cleared' : 'x conflicts with B', priority,
    ...(clean ? { clearedFrom: 'conflict' } : {}) })
  const publish = (id = bound('cf:original'), extra: Record<string, unknown> = {}) => request({ action: 'register', msg: message(id), ...extra })
  const retirement = (ids = [bound('cf:original')], extra: Record<string, unknown> = {}) => ({ action: 'retire', workerId: 'w1', targets: [{
    producer: 'producer-A', expected: record()?.revision ?? 0, ids, episodes: Object.fromEntries(ids.map(id => [id, record()?.entries.find(e => e.id === id)?.episode ?? 'missing'])),
  }], ...extra })
  const retire = (ids = [bound('cf:original')], extra: Record<string, unknown> = {}) => request(retirement(ids, extra))
  const pending = () => owed(room, { name: 'A' }, { frontier: 0, routed: new Set() }, {}).map(m => m.id)
  close.push(() => { hub.stop(); room.doc.destroy() })
  return { room, hub, clock, conn, worker, lease, evidence, record, request, message, publish, retirement, retire, pending,
    setAuthority: (value: boolean) => { authoritative = value } }
}
