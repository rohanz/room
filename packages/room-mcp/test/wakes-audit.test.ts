import { afterEach, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { Rooms } from '../src/registry.js'
import { Ledger } from '../src/ledger.js'
import type { Session } from '../src/session.js'
import type { HandlerState } from '../src/tools/context.js'
import type { LocalWorker } from '../src/worker-status.js'
import { createInbox, handlers } from '../src/tools/messaging.js'
import { hubAppend } from '@room/shared/testing'
import { hubSeam } from './fixtures/hub.js'

/** The lead's worker `money`, as its registry lists it. */
const money = (status: LocalWorker['status'], exitCode?: number): LocalWorker => ({ id: 'w_money', tag: 'money', name: 'lead+money', lead: 'lead',
  host: 'codex', task: 't', dir: '/tmp/money', branch: 'room/money', pid: 1, startedAt: 1, status, ...(exitCode !== undefined ? { exitCode } : {}),
  budget: { threads: 1, memGb: 1, nice: 10 }, share: 'full' })

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.useRealTimers() })

function fixture() {
  const sessions: Session[] = []
  /** Each session's own workers (its registry), with the view its projector writes. */
  const own = new Map<Session, LocalWorker[]>()
  const addWorker = (s: Session, w: LocalWorker) => {
    own.set(s, [...own.get(s) ?? [], w])
    s.room.workerViews.set(w.id, { id: w.id, tag: w.tag, name: w.name, lead: w.lead, mode: 'local', host: w.host, task: w.task,
      branch: w.branch, status: w.status === 'dismissed' ? 'stopped' : w.status, run: 1, startedAt: w.startedAt, fence: 'test',
      ...(w.exitCode !== undefined ? { exitCode: w.exitCode } : {}) })
  }
  const makeSession = (roomName: string) => {
    const room = new RoomDoc(), awareness = new Awareness(room.doc)
    awareness.setLocalState({ user: { name: 'lead', kind: 'agent' } })
    const s = { room, awareness, roomName, me: { name: 'lead', kind: 'agent' }, local: true,
      ...hubSeam(room), provider: { synced: true }, daemon: { touch: vi.fn() } } as unknown as Session
    sessions.push(s)
    return s
  }
  const main = makeSession('main')
  const rooms = new Rooms({ primary: () => main, setPrimary() {}, attach: () => ({ stop() {} }) })
  const state = {
    S: () => main, rooms, now: () => Date.now(), myWorkers: (s: Session) => own.get(s) ?? [],
    workerAlive: () => true, presences: (s: Session) => Array.from(s.awareness.getStates().values()),
    upgrade: async () => [], setPresence: vi.fn(), forMe: (s: Session, m: { to?: string }) => m.to === s.me.name,
    ledger: new Ledger({ sessionId: () => 'test-session', route: () => ({}) }), scheduleInboxWrite: vi.fn(), mine: () => [], msgInMyAreas: () => false,
    others: () => [], upgraded: new Set<string>(), log: vi.fn(),
  } as unknown as HandlerState
  cleanups.push(() => sessions.forEach(s => { rooms.remove(s); s.awareness.destroy(); s.room.doc.destroy() }))
  return { main, rooms, makeSession, addWorker, state, tools: handlers(state) }
}

it('accepts message as an alias for room_send text', async () => {
  const { main, tools } = fixture()
  const sent = await tools.room_send({ type: 'note', message: 'working on it' })
  expect(sent).toContain('working on it')
  expect(main.room.messages().at(-1)).toMatchObject({ type: 'note', text: 'working on it' })
})

it('infers the asker for an explicit inReplyTo when to is omitted', async () => {
  const { main, tools } = fixture()
  const question = hubAppend(main.room, { name: 'worker', kind: 'agent' }, { type: 'question', to: 'lead', text: 'which field?' })
  main.room.colors.set('worker', 0)
  const sent = await tools.room_send({ type: 'answer', inReplyTo: question.id, text: 'price_cents' })
  expect(sent).toContain('price_cents')
  expect(main.room.messages().at(-1)).toMatchObject({ type: 'answer', to: 'worker', inReplyTo: question.id })
})

it('refuses an explicit inReplyTo when the question is already answered, without resuming or posting', async () => {
  const { main, rooms, addWorker, tools } = fixture()
  const worker = money('done', 0)
  addWorker(main, worker)
  const answered = hubAppend(main.room, { name: worker.name, kind: 'agent' }, { type: 'question', to: 'lead', text: 'Already handled?' })
  hubAppend(main.room, { name: 'lead', kind: 'agent' }, { type: 'answer', to: worker.name, inReplyTo: answered.id, text: 'Yes' })
  const open = hubAppend(main.room, { name: worker.name, kind: 'agent' }, { type: 'question', to: 'lead', text: 'Which field?' })
  const resume = vi.spyOn(rooms, 'resumeWorker')
  const sent = await tools.room_send({ type: 'answer', to: 'money', inReplyTo: answered.id, text: 'Again' })
  expect(sent).toContain(`invalid inReplyTo ${answered.id}`)
  expect(sent).toContain(`${open.id}: Which field?`)
  expect(resume).not.toHaveBeenCalled()
  expect(main.room.messages()).toHaveLength(3)
})

it('refuses an explicit inReplyTo addressed to someone else, without resuming or posting', async () => {
  const { main, rooms, addWorker, tools } = fixture()
  const worker = money('done', 0)
  addWorker(main, worker)
  const wrong = hubAppend(main.room, { name: worker.name, kind: 'agent' }, { type: 'question', to: 'someone-else', text: 'Private question?' })
  const open = hubAppend(main.room, { name: worker.name, kind: 'agent' }, { type: 'question', to: 'lead', text: 'Which field?' })
  const resume = vi.spyOn(rooms, 'resumeWorker')
  const sent = await tools.room_send({ type: 'answer', to: 'money', inReplyTo: wrong.id, text: 'price_cents' })
  expect(sent).toContain(`invalid inReplyTo ${wrong.id}`)
  expect(sent).toContain(`${open.id}: Which field?`)
  expect(sent).not.toContain(`${wrong.id}: Private question?`)
  expect(resume).not.toHaveBeenCalled()
  expect(main.room.messages()).toHaveLength(2)
})

it('validates explicit question and note replies without answering a question with a note', async () => {
  const { main, tools } = fixture()
  main.room.colors.set('Ada', 0)
  main.room.colors.set('Bea', 0)
  main.room.colors.set('Cara', 0)
  const question = hubAppend(main.room, { name: 'Ada', kind: 'agent' }, { type: 'question', to: 'lead', text: 'Which field?' })
  const note = hubAppend(main.room, { name: 'Bea', kind: 'agent' }, { type: 'note', to: 'lead', text: 'For context' })
  const wrongQuestion = await tools.room_send({ type: 'answer', to: 'Bea', inReplyTo: question.id, text: 'price_cents' })
  expect(wrongQuestion).toContain(`invalid inReplyTo ${question.id}`)
  expect(wrongQuestion).toContain(`${question.id}: Which field?`)
  expect(main.room.messages()).toHaveLength(2)

  const sent = await tools.room_send({ type: 'answer', to: 'Bea', inReplyTo: note.id, text: 'Thanks' })
  expect(sent).toContain('sent [')
  expect(main.room.messages().at(-1)).toMatchObject({ type: 'note', to: 'Bea', inReplyTo: note.id, text: 'Thanks' })
  expect(main.room.messages().filter(m => m.type === 'answer')).toHaveLength(0)
  expect(main.room.messages().some(m => m.id === question.id)).toBe(true)

  const unaddressed = hubAppend(main.room, { name: 'Bea', kind: 'agent' }, { type: 'note', to: 'Cara', text: 'Private context' })
  expect(await tools.room_send({ type: 'note', to: 'Bea', inReplyTo: unaddressed.id, text: 'Thanks' }))
    .toBe(`error: inReplyTo ${unaddressed.id} must name a note addressed to you`)
  expect(await tools.room_send({ type: 'note', to: 'Ada', inReplyTo: note.id, text: 'Thanks' }))
    .toBe('error: note reply must go to Bea')
  expect(main.room.messages()).toHaveLength(4)
})

it('refuses an implicit answer when no unanswered question matches the recipient', async () => {
  const { main, tools } = fixture()
  main.room.colors.set('Ada', 0)
  const answered = hubAppend(main.room, { name: 'Ada', kind: 'agent' }, { type: 'question', to: 'lead', text: 'Already handled?' })
  hubAppend(main.room, { name: 'lead', kind: 'agent' }, { type: 'answer', to: 'Ada', inReplyTo: answered.id, text: 'Yes' })
  expect(await tools.room_send({ type: 'answer', to: 'Ada', text: 'Again' })).toBe('error: answer requires inReplyTo; no unanswered question from Ada addressed to you')
})

it('answers the only unanswered question from the recipient and names it in the reply', async () => {
  const { main, tools } = fixture()
  main.room.colors.set('Ada', 0)
  const question = hubAppend(main.room, { name: 'Ada', kind: 'agent' }, { type: 'question', to: 'lead', text: 'Which field?' })
  const sent = await tools.room_send({ type: 'answer', to: 'Ada', text: 'price_cents' })
  expect(sent).toContain(`answered ${question.id}`)
  expect(main.room.messages().at(-1)).toMatchObject({ type: 'answer', to: 'Ada', inReplyTo: question.id, text: 'price_cents' })
})

it('infers the recipient when one unanswered question exists and to is omitted', async () => {
  const { main, tools } = fixture()
  const question = hubAppend(main.room, { name: 'Ada', kind: 'agent' }, { type: 'question', to: 'lead', text: 'Ready?' })
  const sent = await tools.room_send({ type: 'answer', text: 'Yes' })
  expect(sent).toContain(`answered ${question.id}`)
  expect(main.room.messages().at(-1)).toMatchObject({ type: 'answer', to: 'Ada', inReplyTo: question.id })
})

it('lists multiple unanswered questions with previews when inReplyTo is omitted', async () => {
  const { main, tools } = fixture()
  const first = hubAppend(main.room, { name: 'Ada', kind: 'agent' }, { type: 'question', to: 'lead', text: 'Which field?' })
  const second = hubAppend(main.room, { name: 'Bea', kind: 'agent' }, { type: 'question', to: 'lead', text: 'x'.repeat(100) })
  const sent = await tools.room_send({ type: 'answer', text: 'The answer' })
  expect(sent).toContain('error: answer requires inReplyTo')
  expect(sent).toContain(`${first.id}: Which field?`)
  expect(sent).toContain(`${second.id}: ${'x'.repeat(79)}…`)
  expect(sent).not.toContain('x'.repeat(80))
  expect(main.room.messages()).toHaveLength(2)
})

it.each(['answered', 'new question'] as const)('posts an inferred answer after worker resume when %s arrives', async change => {
  const { main, rooms, addWorker, tools } = fixture()
  const worker = money('done', 0)
  addWorker(main, worker)
  const question = hubAppend(main.room, { name: worker.name, kind: 'agent' }, { type: 'question', to: 'lead', text: 'Which field?' })
  const resume = vi.spyOn(rooms, 'resumeWorker').mockImplementation(async (_session, _worker, prompt) => {
    expect(prompt).toBe('price_cents')
    if (change === 'answered') hubAppend(main.room, { name: 'lead', kind: 'agent' }, { type: 'answer', to: worker.name, inReplyTo: question.id, text: 'Already answered' })
    else hubAppend(main.room, { name: worker.name, kind: 'agent' }, { type: 'question', to: 'lead', text: 'Another field?' })
    return 'resumed money'
  })
  const sent = await tools.room_send({ type: 'answer', to: 'money', text: 'price_cents' })
  expect(resume).toHaveBeenCalledOnce()
  expect(sent).toContain('sent [')
  expect(sent).toContain(`answered ${question.id}`)
  const answer = main.room.messages().find(m => m.type === 'answer' && m.text === 'price_cents')
  expect(answer).toMatchObject({ type: 'answer', to: worker.name, inReplyTo: question.id })
  expect(main.room.seen(worker.name).has(answer!.id)).toBe(true)
})

it('finds a read answer sent before room_wait even if another room holds the question', async () => {
  const { main, rooms, makeSession, state, tools } = fixture()
  const workers = makeSession('workers'); rooms.add(workers, 'workers')
  const question = hubAppend(workers.room, { name: 'lead', kind: 'agent' }, { type: 'question', to: 'worker', text: 'which field?' })
  const answer = hubAppend(main.room, { name: 'worker', kind: 'agent' }, { type: 'answer', to: 'lead', inReplyTo: question.id, text: 'price_cents' })
  main.room.markSeen('lead', [answer.id], { s: 'earlier-session', via: 'reply' }) // another room_state already showed the answer
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
  const { main, rooms, makeSession, addWorker, tools } = fixture()
  const workers = makeSession('workers'); rooms.add(workers, 'workers')
  const worker = money('running')
  addWorker(workers, worker)
  hubAppend(main.room, { name: 'Ada', kind: 'agent' }, { type: 'note', to: 'lead', text: 'routine' })
  hubAppend(workers.room, { name: worker.name, kind: 'agent' }, { type: 'question', to: 'lead', text: 'which field?' })
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
  const a = hubAppend(source.room, { name: 'Ada', kind: 'agent' }, { type: 'question', to: 'lead', text: 'first?' })
  const b = hubAppend(source.room, { name: 'Bea', kind: 'agent' }, { type: 'question', to: 'lead', text: 'second?' })
  expect(await waiting).toContain('first?')
  expect(source.room.seen('lead').has(a.id)).toBe(true)
  expect(source.room.seen('lead').has(b.id)).toBe(false)
  expect(await tools.room_wait({ timeoutMs: 10 })).toContain('second?')
})

it('puts an unread worker question ahead of notes with a clear reply instruction', () => {
  const { main, rooms, makeSession, state } = fixture()
  const workers = makeSession('workers'); rooms.add(workers, 'workers')
  state.inbox = createInbox(state).inbox
  hubAppend(main.room, { name: 'Ada', kind: 'agent' }, { type: 'note', to: 'lead', text: 'routine' })
  const q = hubAppend(workers.room, { name: 'lead+money', kind: 'agent' }, { type: 'question', to: 'lead', text: 'which field?' })
  const block = state.inbox(main, state.ledger.open('reply'))
  expect(block).toContain('QUESTION FOR YOU')
  expect(block.indexOf('QUESTION FOR YOU')).toBeLessThan(block.indexOf('routine'))
  expect(block).toContain(`room_send type=answer inReplyTo=${q.id}`)
})
