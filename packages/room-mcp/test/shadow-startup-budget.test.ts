// Lifecycle pacing and deadline regressions run in default and TEST_SCALE=1 passes.
import './shadow-git-fixture.js'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from '@room/shared'
import { ConflictShadow } from '../src/conflict-shadow.js'
import type { Session } from '../src/session.js'
import { repo } from './worker-refresh-fixture.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('paces back-to-back lifecycle captures without losing history or comparing a partial queue', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const room = new RoomDoc(new Y.Doc()), logs: string[] = []
  const shadow = new ConflictShadow({ dir: repo, room, me: { name: 'lead' } } as Session, line => logs.push(line))
  const state = shadow as any
  state.initialized = true
  state.registry = { list: async () => ({ records: [], blockers: [] }), close() {} }
  vi.spyOn(shadow.graph, 'storageBudget').mockResolvedValue(0)
  const events: string[] = []
  vi.spyOn(state, 'event').mockImplementation(async (event: any) => {
    await new Promise(resolve => setTimeout(resolve, 6000))
    events.push(event.record.id)
  })
  const observe = vi.spyOn(state, 'pass').mockResolvedValue(undefined)
  try {
    for (const id of ['one', 'two']) {
      const ticket = shadow.reserve('spawn', shadow.preparation())!
      ticket.make = () => ({ kind: 'spawn', record: { id, name: id } as never, supplied: false })
    }
    clearTimeout(state.timer); state.timer = undefined
    state.start()
    await vi.advanceTimersByTimeAsync(6000)
    expect(events).toEqual(['one'])
    expect(observe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(11000)
    expect(events).toEqual(['one', 'two'])
    expect(state.applied).toBe(2)
    expect(state.halted).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(observe).toHaveBeenCalledTimes(1)
    expect(logs.some(line => line.includes('family stopped'))).toBe(false)
  } finally {
    // Avoid testing filesystem cleanup under a fake timer; the graph was never initialized.
    state.cleanup = Promise.resolve(); shadow.stop(); room.doc.destroy()
  }
})

it.each(['lifecycle spawn', 'observation'])('still shuts down once when %s cannot finish a bounded job', async stage => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const room = new RoomDoc(new Y.Doc()), logs: string[] = []
  const shadow = new ConflictShadow({ dir: repo, room, me: { name: 'lead' } } as Session, line => logs.push(line))
  const state = shadow as any
  state.initialized = true; state.cleanup = Promise.resolve()
  state.registry = { list: async () => ({ records: [], blockers: [] }), close() {} }
  vi.spyOn(shadow.graph, 'storageBudget').mockResolvedValue(0)
  const hung = vi.spyOn(state, stage === 'observation' ? 'pass' : 'event').mockImplementation(() => new Promise(() => {}))
  if (stage !== 'observation') {
    const ticket = shadow.reserve('spawn', shadow.preparation())!
    ticket.make = () => ({ kind: 'spawn', record: { id: 'one', name: 'one' } as never, supplied: false })
    clearTimeout(state.timer); state.timer = undefined
  }
  try {
    state.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(state.closed).toBe(true)
    expect(logs.filter(line => line.includes('family stopped for this session'))).toEqual([
      `conflict shadow: family stopped for this session: over budget: private pass deadline exceeded during ${stage} (lead) (swallowed)`,
    ])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hung).toHaveBeenCalledTimes(1)
    expect(state.queue.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally { shadow.stop(); room.doc.destroy() }
})

it('names the observation stage when its deadline check rejects before the timer fires', async () => {
  const room = new RoomDoc(new Y.Doc()), logs: string[] = []
  const shadow = new ConflictShadow({ dir: repo, room, me: { name: 'lead' } } as Session, line => logs.push(line))
  const state = shadow as any
  state.initialized = true; state.cleanup = Promise.resolve()
  state.registry = { list: async () => ({ records: [], blockers: [] }), close() {} }
  vi.spyOn(shadow.graph, 'storageBudget').mockResolvedValue(0)
  vi.spyOn(state, 'pass').mockRejectedValue(new Error('over budget'))
  try {
    await shadow.idle()
    expect(state.halted).toBe(true)
    expect(logs).toEqual([
      'conflict shadow: family stopped for this session: over budget during observation; lead history unavailable (lead) (swallowed)',
    ])
  } finally { shadow.stop(); room.doc.destroy() }
})

it.each([true, false])('halts before losing or checkpointing an over-budget event (lead actor=%s)', async hasLead => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const room = new RoomDoc(new Y.Doc()), logs: string[] = []
  const shadow = new ConflictShadow({ dir: repo, room, me: { name: 'lead' } } as Session, line => logs.push(line))
  const state = shadow as any
  state.initialized = true; state.cleanup = Promise.resolve()
  state.registry = { list: async () => ({ records: [], blockers: [] }), close() {} }
  if (hasLead) state.actors.set('lead', { name: 'lead', id: 'lead', node: 'node', tree: 'tree',
    entries: new Map(), gaps: new Set(), covered: new Set(), events: [] })
  vi.spyOn(shadow.graph, 'storageBudget').mockResolvedValue(0)
  vi.spyOn(state, 'validateHistory').mockResolvedValue(undefined)
  vi.spyOn(state, 'publication').mockReturnValue(undefined)
  const event = vi.spyOn(state, 'event').mockImplementation(async () => {
    // The synchronous budget check wins before the timeout callback gets a turn.
    now = shadow.graph.deadline
    throw new Error('over budget')
  })
  const lost = vi.spyOn(state, 'lost'), remember = vi.spyOn(state, 'remember'), observe = vi.spyOn(state, 'pass')
  const ticket = shadow.reserve('spawn', shadow.preparation(), { id: 'worker', name: 'worker' })!
  ticket.make = () => ({ kind: 'spawn', record: { id: 'worker', name: 'worker' } as never, supplied: false })
  // reserve() may save the existing generation; only execution may apply a new one.
  remember.mockClear()
  try {
    await shadow.idle()
    expect(state.halted).toBe(true)
    expect(event).toHaveBeenCalledTimes(1); expect(lost).not.toHaveBeenCalled()
    expect(remember).not.toHaveBeenCalled(); expect(state.applied).toBe(0)
    expect(state.queue.size).toBe(0); expect(observe).not.toHaveBeenCalled()
    expect(logs.filter(line => line.includes('family stopped for this session'))).toEqual([
      'conflict shadow: family stopped for this session: over budget during lifecycle spawn; lead history unavailable (lead) (swallowed)',
    ])
    await vi.advanceTimersByTimeAsync(60_000); await shadow.idle()
    expect(event).toHaveBeenCalledTimes(1); expect(state.applied).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally { shadow.stop(); await state.removal; room.doc.destroy() }
})

for (const hasLead of [true, false]) for (const scenario of ['remove', 'spawn Git failure', 'completed event', 'collection waiting', 'factory no-op'] as const) {
  it(`halts by the clock after ${scenario}, before checkpoint (lead actor=${hasLead})`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const room = new RoomDoc(new Y.Doc()), logs: string[] = []
    const shadow = new ConflictShadow({ dir: repo, room, me: { name: 'lead' } } as Session, line => logs.push(line))
    const state = shadow as any
    state.initialized = true; state.cleanup = Promise.resolve()
    state.registry = { list: async () => ({ records: [], blockers: [] }), close() {} }
    vi.spyOn(state, 'retire').mockImplementation(() => {})
    const actor = (name: string) => ({ name, id: name, node: 'node', tree: 'tree',
      entries: new Map(), gaps: new Set(), covered: new Set(), events: [] })
    if (hasLead) state.actors.set('lead', actor('lead'))
    state.actors.set('worker', actor('worker'))
    vi.spyOn(shadow.graph, 'storageBudget').mockResolvedValue(0)
    vi.spyOn(state, 'validateHistory').mockResolvedValue(undefined)
    vi.spyOn(state, 'publication').mockReturnValue(undefined)
    const kind = scenario === 'remove' ? 'remove' : scenario === 'collection waiting' ? 'collection' : 'spawn'
    const ticket = shadow.reserve(kind, shadow.preparation(), { id: 'worker', name: 'worker' })!
    if (scenario === 'remove') {
      // Real remove() swallows pin()'s deadline rejection as participant cleanup failure.
      ;(shadow.graph as any).pins.set('worker', 'old-pin')
      vi.spyOn(shadow.graph as any, 'clearLock').mockImplementation(async () => { now = shadow.graph.deadline })
      ticket.make = () => ({ kind: 'remove', name: 'worker', id: 'worker' })
    } else if (scenario === 'factory no-op') {
      ticket.make = () => { now = shadow.graph.deadline; return { kind: 'unsupported', id: '', reason: 'no-op' } }
    } else {
      vi.spyOn(state, 'event').mockImplementation(async () => {
        now = shadow.graph.deadline
        if (scenario === 'spawn Git failure') throw new Error('shadow Git step failed: hash-object')
        if (scenario === 'collection waiting') return false
      })
      ticket.make = () => ({ kind: 'spawn', record: { id: 'worker', name: 'worker' } as never, supplied: false })
    }
    const lost = vi.spyOn(state, 'lost'), remember = vi.spyOn(state, 'remember'), observe = vi.spyOn(state, 'pass')
    try {
      await shadow.idle()
      expect(state.halted).toBe(true)
      expect(lost).not.toHaveBeenCalled(); expect(remember).not.toHaveBeenCalled()
      expect(state.applied).toBe(0); expect(state.queue.size).toBe(0)
      expect(observe).not.toHaveBeenCalled()
      expect(logs.filter(line => line.includes('family stopped for this session'))).toEqual([
        `conflict shadow: family stopped for this session: over budget during lifecycle ${kind}; lead history unavailable (lead) (swallowed)`,
      ])
      await vi.advanceTimersByTimeAsync(60_000); await shadow.idle()
      expect(state.applied).toBe(0); expect(lost).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally { shadow.stop(); await state.removal; room.doc.destroy() }
  })
}
