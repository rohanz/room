import { afterEach, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, type Worker } from '@room/shared'
import { Rooms } from '../src/registry.js'
import type { Session } from '../src/session.js'
import type { HandlerState } from '../src/tools/context.js'
import { handlers, install } from '../src/tools/messaging.js'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.useRealTimers() })

function fixture() {
  const sessions: Session[] = []
  const makeSession = (roomName: string) => {
    const room = new RoomDoc(), awareness = new Awareness(room.doc)
    awareness.setLocalState({ user: { name: 'lead', kind: 'agent' } })
    const s = { room, awareness, roomName, me: { name: 'lead', kind: 'agent' }, local: true,
      provider: { synced: true }, daemon: { touch: vi.fn() } } as unknown as Session
    sessions.push(s)
    return s
  }
  const main = makeSession('main')
  const rooms = new Rooms({ primary: () => main, setPrimary() {}, observeClaims() {}, attach: () => ({ stop() {} }) })
  const state = {
    S: () => main, rooms, now: () => Date.now(), myWorkers: (s: Session) => Array.from(s.room.workers.values()),
    workerAlive: () => true, presences: (s: Session) => Array.from(s.awareness.getStates().values()),
    upgrade: async () => [], setPresence: vi.fn(), forMe: (s: Session, m: { to?: string }) => m.to === s.me.name,
    seen: new Set<string>(), scheduleInboxWrite: vi.fn(), mine: () => [], msgInMyAreas: () => false,
    others: () => [], upgraded: new Set<string>(), log: vi.fn(),
  } as unknown as HandlerState
  cleanups.push(() => sessions.forEach(s => { rooms.remove(s); s.awareness.destroy(); s.room.doc.destroy() }))
  return { main, rooms, makeSession, state, tools: handlers(state) }
}

it('accepts message as an alias for room_send text', async () => {
  const { main, tools } = fixture()
  const sent = await tools.room_send({ type: 'note', message: 'working on it' })
  expect(sent).toContain('working on it')
  expect(main.room.messages().at(-1)).toMatchObject({ type: 'note', text: 'working on it' })
})

it('automatically addresses an inReplyTo answer to the asker even when to is wrong', async () => {
  const { main, tools } = fixture()
  const question = main.room.post({ name: 'worker', kind: 'agent' }, { type: 'question', to: 'lead', text: 'which field?' })
  main.room.colors.set('worker', 0)
  main.room.colors.set('bystander', 0)
  const sent = await tools.room_send({ type: 'answer', inReplyTo: question.id, to: 'bystander', text: 'price_cents' })
  expect(sent).toContain('price_cents')
  expect(main.room.messages().at(-1)).toMatchObject({ type: 'answer', to: 'worker', inReplyTo: question.id })
})

it('refuses an implicit answer when no unanswered question matches the recipient', async () => {
  const { main, tools } = fixture()
  main.room.colors.set('Ada', 0)
  const answered = main.room.post({ name: 'Ada', kind: 'agent' }, { type: 'question', to: 'lead', text: 'Already handled?' })
  main.room.post({ name: 'lead', kind: 'agent' }, { type: 'answer', to: 'Ada', inReplyTo: answered.id, text: 'Yes' })
  expect(await tools.room_send({ type: 'answer', to: 'Ada', text: 'Again' })).toBe('error: answer requires inReplyTo; no unanswered question from Ada addressed to you')
})

it('answers the only unanswered question from the recipient and names it in the reply', async () => {
  const { main, tools } = fixture()
  main.room.colors.set('Ada', 0)
  const question = main.room.post({ name: 'Ada', kind: 'agent' }, { type: 'question', to: 'lead', text: 'Which field?' })
  const sent = await tools.room_send({ type: 'answer', to: 'Ada', text: 'price_cents' })
  expect(sent).toContain(`answered ${question.id}`)
  expect(main.room.messages().at(-1)).toMatchObject({ type: 'answer', to: 'Ada', inReplyTo: question.id, text: 'price_cents' })
})

it('infers the recipient when one unanswered question exists and to is omitted', async () => {
  const { main, tools } = fixture()
  const question = main.room.post({ name: 'Ada', kind: 'agent' }, { type: 'question', to: 'lead', text: 'Ready?' })
  const sent = await tools.room_send({ type: 'answer', text: 'Yes' })
  expect(sent).toContain(`answered ${question.id}`)
  expect(main.room.messages().at(-1)).toMatchObject({ type: 'answer', to: 'Ada', inReplyTo: question.id })
})

it('lists multiple unanswered questions with previews when inReplyTo is omitted', async () => {
  const { main, tools } = fixture()
  const first = main.room.post({ name: 'Ada', kind: 'agent' }, { type: 'question', to: 'lead', text: 'Which field?' })
  const second = main.room.post({ name: 'Bea', kind: 'agent' }, { type: 'question', to: 'lead', text: 'x'.repeat(100) })
  const sent = await tools.room_send({ type: 'answer', text: 'The answer' })
  expect(sent).toContain('error: answer requires inReplyTo')
  expect(sent).toContain(`${first.id}: Which field?`)
  expect(sent).toContain(`${second.id}: ${'x'.repeat(79)}…`)
  expect(sent).not.toContain('x'.repeat(80))
  expect(main.room.messages()).toHaveLength(2)
})

it('finds a read answer sent before room_wait even if another room holds the question', async () => {
  const { main, rooms, makeSession, state, tools } = fixture()
  const workers = makeSession('workers'); rooms.add(workers, 'workers')
  const question = workers.room.post({ name: 'lead', kind: 'agent' }, { type: 'question', to: 'worker', text: 'which field?' })
  const answer = main.room.post({ name: 'worker', kind: 'agent' }, { type: 'answer', to: 'lead', inReplyTo: question.id, text: 'price_cents' })
  state.seen.add(answer.id)
  main.room.markSeen('lead', [answer.id]) // another room_state already showed the answer
  expect(await tools.room_wait({ questionId: question.id, timeoutMs: 10 })).toContain('price_cents')
  expect(main.room.seen('lead').has(answer.id)).toBe(true)
})

it('caps oversized waits at 100 seconds and says to call again', async () => {
  vi.useFakeTimers()
  const { tools } = fixture()
  const waiting = tools.room_wait({ timeoutMs: 600_000 })
  await vi.advanceTimersByTimeAsync(100_000)
  expect(await waiting).toContain('waited 100 s (the most per call); call again')
})

it('surfaces an addressed worker question before a routine note while waiting', async () => {
  const { main, rooms, makeSession, tools } = fixture()
  const workers = makeSession('workers'); rooms.add(workers, 'workers')
  const worker: Worker = { tag: 'money', name: 'lead+money', lead: 'lead', host: 'codex', task: 't', dir: '/tmp/money',
    branch: 'room/money', pid: 1, startedAt: 1, status: 'running' }
  workers.room.setWorker(worker)
  main.room.post({ name: 'Ada', kind: 'agent' }, { type: 'note', to: 'lead', text: 'routine' })
  workers.room.post({ name: worker.name, kind: 'agent' }, { type: 'question', to: 'lead', text: 'which field?' })
  const result = await tools.room_wait({ timeoutMs: 10 })
  expect(result).toContain('question from a worker')
  expect(result).toContain('answer it with room_send type=answer inReplyTo=')
})

it.each([false, true])('keeps the second same-tick question unread during a wait (workers room: %s)', async workersRoom => {
  const { main, rooms, makeSession, state, tools } = fixture()
  const source = workersRoom ? makeSession('workers') : main
  if (workersRoom) rooms.add(source, 'workers')
  const waiting = tools.room_wait({ timeoutMs: 1000 })
  await vi.waitFor(() => expect(state.setPresence).toHaveBeenCalledWith(main, { status: 'waiting' }))
  const a = source.room.post({ name: 'Ada', kind: 'agent' }, { type: 'question', to: 'lead', text: 'first?' })
  const b = source.room.post({ name: 'Bea', kind: 'agent' }, { type: 'question', to: 'lead', text: 'second?' })
  expect(await waiting).toContain('first?')
  expect(source.room.seen('lead').has(a.id)).toBe(true)
  expect(source.room.seen('lead').has(b.id)).toBe(false)
  expect(await tools.room_wait({ timeoutMs: 10 })).toContain('second?')
})

it('puts an unread worker question ahead of notes with a clear reply instruction', () => {
  const { main, rooms, makeSession, state } = fixture()
  const workers = makeSession('workers'); rooms.add(workers, 'workers')
  install(state)
  main.room.post({ name: 'Ada', kind: 'agent' }, { type: 'note', to: 'lead', text: 'routine' })
  const q = workers.room.post({ name: 'lead+money', kind: 'agent' }, { type: 'question', to: 'lead', text: 'which field?' })
  const block = state.inbox(main)
  expect(block).toContain('QUESTION FOR YOU')
  expect(block.indexOf('QUESTION FOR YOU')).toBeLessThan(block.indexOf('routine'))
  expect(block).toContain(`room_send type=answer inReplyTo=${q.id}`)
})
