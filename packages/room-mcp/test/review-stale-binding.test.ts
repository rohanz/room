import { expect, it } from 'vitest'
import { RoomDoc, outgoing, owed, participantRecord, type RetiredWorker } from '@room/shared'
import * as core from '@room/hub-core'
import { ConflictSlots, slotKey } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'
import type { Post } from '../src/post.js'

it.each([true, false])('does not retire a live successor fallback using a stale replica worker binding (managed=%s)', async managed => {
  const room = new RoomDoc(); let tick = 0, max: number | undefined, seq = 0
  const hub = await core.startHub({ doc: room, mono: () => tick, wall: Date.now,
    store: core.serializedStore({ read: async () => max, write: async n => { max = n } }), log() {} })
  try {
    tick += core.SETTLE_MS
    const conn = {}, principal = { local: true } as const
    hub.handle(conn, { v: 1, id: 'hello', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: 's' }, principal)
    ;(hub as any).noticeContract(conn, { capabilities: { 'room.notice-lifecycle': 1 } })
    const acquire = (name: string, workerId?: string) => hub.handle(conn, { v: 1, id: name, op: 'acquire', name,
      holder: { sessionId: 's', pid: 1, startTime: '', executable: '', ...(workerId ? { workerId } : {}) } }, principal)
    const grant = acquire('A') as any; expect(grant.ok).toBe(true)
    expect(acquire('B', 'w2').ok).toBe(true)
    const actual = participantRecord(room, 'B')!.holder!
    room.participants.set('B\0holder', { ...actual, workerId: 'w1' })
    const replies: Record<string, unknown>[] = []
    const post = ((from, body, options) => {
      const id = options!.id!, msg = outgoing(from, body, id)
      const result = hub.handle(conn, { v: 1, id: `p${++seq}`, op: 'post', lease: { name: 'A', epoch: grant.epoch }, auto: true, msg }, principal)
      return Object.assign(Promise.resolve({ ...result, msg }), { id })
    }) as Post
    const session = { room, me: { name: 'A', kind: 'agent' }, post, lease: { fence: () => String(grant.epoch), sessionId: 's' },
      contract: { capabilities: managed ? { 'room.notice-lifecycle': 1 } : {} }, hub: { noticeIncarnation: () => hub.incarnation,
        noticeLifecycle: async (intent: Record<string, unknown>) => {
          const reply = hub.handle(conn, { v: 1, id: `n${++seq}`, op: 'notice-lifecycle', generation: hub.incarnation, ...intent }, principal)
          replies.push(reply); return reply
        } } } as unknown as Session
    const slots = new ConflictSlots(room, post, () => String(grant.epoch), Date.now, () => {}, post, () => true, session)
    await slots.settle(slotKey('A', 'merge', 'B', 'x'), { owner: 'A', other: 'B', kind: 'merge', path: 'x', status: 'conflict', inputs: 'current w2 publication', factId: 'conflict', lines: [1] })
    await slots.replay('A')
    if (managed) expect(replies).toContainEqual(expect.objectContaining({ ok: false, reason: 'stale' }))
    else expect(replies).toEqual([])
    const before = owed(room, { name: 'A' }, { frontier: 0, routed: new Set() }, {})
    expect(before).toHaveLength(1)
    expect(before[0]!.noticeSubjects).toBeUndefined() // no rejected or unmanaged worker binding
    // Correct public identity arrives; producer has exited, so no new comparison replaces its fallback.
    room.participants.set('B\0holder', actual)
    const retired = { id: 'w1', name: 'B', tag: 'B', lead: 'A', host: 'codex', task: '', summary: '', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: Date.now(), outcome: 'clean' } as RetiredWorker & { id: string }
    room.retireWorker('w1', retired, () => {})
    expect(owed(room, { name: 'A' }, { frontier: 0, routed: new Set() }, {}).map(m => m.id)).toEqual(before.map(m => m.id))
    expect(room.outcomes.has(before[0]!.id)).toBe(false)
  } finally { hub.stop(); room.doc.destroy() }
})
