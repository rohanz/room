import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, type QuestionMsg } from '@room/shared'
import { Rooms } from '../src/registry.js'
import { Ledger } from '../src/ledger.js'
import { sessionDirectory, type Session } from '../src/session.js'
import type { SessionBinding } from '../src/binding.js'
import { startArbitration } from '../src/arbitration.js'
import { createTools } from '../src/tools.js'
import type { SendWake } from '../src/wake-path.js'
import { testPolicyStore } from './policy-fixture.js'
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
  let launchedIds: string[] = []
  const resume = vi.spyOn(rooms, 'resumeWorker').mockImplementation(async (_session, _worker, prompt, _spawner, _channel, _max, _log, _at, _wait, beforeLaunch) => {
    expect(prompt).toBe('price_cents')
    launchedIds = (await beforeLaunch?.())?.ids ?? []
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
  expect(launchedIds).toContain(answer!.id)
  // The mocked launcher never confirms a prompt turn; its IDs remain owed until that happens.
  expect(main.room.seen(worker.name).has(answer!.id)).toBe(false)
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

it('S1: a 100-second wait consumes an answer arriving after the 60-second reply lease', async () => {
  vi.useFakeTimers()
  const { main, tools, state } = fixture()
  main.room.colors.set('Ada', 0)
  const question = hubAppend(main.room, { name: 'lead', kind: 'agent' }, { type: 'question', to: 'Ada', text: 'ready?' })
  const waiting = tools.room_wait({ questionId: question.id, timeoutMs: 100_000 })
  expect(state.setPresence).toHaveBeenCalledWith(main, { status: `waiting for answer to ${question.id}` })
  await vi.advanceTimersByTimeAsync(61_000)
  const answer = hubAppend(main.room, { name: 'Ada', kind: 'agent' },
    { type: 'answer', to: 'lead', inReplyTo: question.id, text: 'yes after 61 seconds' })
  expect(await waiting).toContain('yes after 61 seconds')
  expect(main.room.seen('lead').get(answer.id)).toMatchObject({ via: 'wait' })
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

describe('wakes (ledger test 11, MF8)', () => {
  const SID = 'wake-session'
  const HOOKS = resolve(__dirname, '../../../plugins/room/hooks')
  const kieran = { name: 'Kieran', kind: 'agent' as const }
  let dir: string
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'room-wakes-')); execFileSync('git', ['-C', dir, 'init', '-q']) })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    rmSync(join(dir, '.git/room'), { recursive: true, force: true })
    for (const name of ['ROOM_HOST', 'ROOM_WORKER_ID', 'ROOM_WAKE', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_SESSION_ID']) vi.stubEnv(name, undefined)
  })
  afterEach(() => vi.unstubAllEnvs())
  const sdir = () => sessionDirectory(join(dir, '.git'), SID)

  /** A bound Codex session's Room MCP: tools, ledger, wakes and the hooks' arbitration endpoint. */
  async function mcp(send: SendWake, room = new RoomDoc(), hookLeaseMs = 10_000) {
    const s = { room, awareness: new Awareness(room.doc), me: { name: 'Rohan', kind: 'agent' }, dir, roomUrl: 'ws://127.0.0.1:9/r', roomName: 'r', browserUrl: '',
      shareMax: 'full', shareRequested: 'full', ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true }, daemon: { touch() {}, async stop() {} } } as unknown as Session
    const binding: SessionBinding = { bound: () => ({ id: SID, host: 'codex' }), id: () => SID, dir: sdir, commonDir: () => join(dir, '.git') }
    const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, binding, wake: send, hookLeaseMs })
    tools.attachHooks(s)
    const arbitration = await startArbitration({ binding, ledger: tools.ledger, select: () => tools.hookSelect(), hookLeaseMs })
    return { s, tools, async close() { await arbitration.close(); await tools.shutdown(); s.awareness.destroy() } }
  }
  const recorder = () => {
    const texts: string[] = []
    const send: SendWake = async (target, text) => { expect(target).toEqual({ id: SID, host: 'codex' }); texts.push(text); return 'queue' }
    return { texts, send }
  }
  const quiet = () => new Promise(r => setTimeout(r, 100))

  it('the Codex queue text has no body; the content is delivered once, by the reply, and never woken again', async () => {
    const { texts, send } = recorder()
    const m = await mcp(send)
    try {
      const q = hubAppend<QuestionMsg>(m.s.room, kieran, { type: 'question', to: 'Rohan', text: 'which token do we use?' })
      await vi.waitFor(() => expect(texts).toHaveLength(1))
      expect(texts[0]).toMatch(/^\[room\] 1 thing may need you: Kieran asked a question\. Call room_state; if it shows nothing new, they were already delivered: do nothing further\. \(#\d+\)$/)
      expect(m.s.room.seen('Rohan').has(q.id)).toBe(false)
      expect(JSON.parse(readFileSync(join(sdir(), 'wakes.json'), 'utf8'))).toMatchObject({ r: { [q.id]: { via: 'queue' } } })
      const reply = await m.tools.call('room_state', {})
      expect(reply).toContain(`[inbox 1]\n  [${q.id}] QUESTION FOR YOU: `)
      expect(m.s.room.seen('Rohan').get(q.id)).toMatchObject({ s: SID, via: 'reply' })
      const noOp = await m.tools.call('room_state', {})
      expect(noOp.split('\n').slice(0, 4)).toContain('nothing new for you since your last read; no action needed')
      expect(noOp).not.toContain('[inbox')
      await quiet()
      expect(texts).toHaveLength(1)
    } finally { await m.close() }
  })

  it('the wake fails, the MCP restarts in the same session, and M is woken once', async () => {
    const room = new RoomDoc()
    const failing = vi.fn(async () => { throw new Error('codex: thread is busy') })
    const first = await mcp(failing, room)
    const q = hubAppend<QuestionMsg>(room, kieran, { type: 'question', to: 'Rohan', text: 'still there?' })
    await vi.waitFor(() => expect(failing).toHaveBeenCalled())
    await first.close()
    const { texts, send } = recorder()
    const second = await mcp(send, room)
    try {
      await vi.waitFor(() => expect(texts).toHaveLength(1))
      expect(texts[0]).toContain('Kieran asked a question')
      expect(room.seen('Rohan').has(q.id)).toBe(false)
      await quiet()
      expect(texts).toHaveLength(1)
    } finally { await second.close() }
  })

  it('messages owed before the session first bound are left for its first reply, not woken', async () => {
    const room = new RoomDoc()
    const q = hubAppend<QuestionMsg>(room, kieran, { type: 'question', to: 'Rohan', text: 'asked before you arrived' })
    const { texts, send } = recorder()
    const m = await mcp(send, room)
    try {
      await quiet()
      expect(texts).toEqual([])
      expect(await m.tools.call('room_state', {})).toContain('asked before you arrived')
      expect(room.seen('Rohan').has(q.id)).toBe(true)
    } finally { await m.close() }
  })

  it('a wait cancel triggers a reconcile: the interrupt the wait had selected is woken', async () => {
    const { texts, send } = recorder()
    const m = await mcp(send)
    try {
      const abort = new AbortController()
      const waiting = m.tools.call('room_wait', { timeoutMs: 5_000 }, abort.signal)
      await vi.waitFor(() => expect(m.s.awareness.getLocalState()).toMatchObject({ status: 'waiting' }))
      hubAppend(m.s.room, kieran, { type: 'note', to: 'Rohan', priority: 'interrupt', text: 'stop the migration' })
      abort.abort()
      await waiting
      await vi.waitFor(() => expect(texts).toHaveLength(1))
      expect(texts[0]).toContain('Kieran sent a note')
      expect(m.s.room.seen('Rohan').size).toBe(0)
    } finally { await m.close() }
  })

  it('a hook reserves M and dies; its lease expires with no other event, and M is woken', async () => {
    const { texts, send } = recorder()
    const m = await mcp(send, new RoomDoc(), 200)
    try {
      hubAppend(m.s.room, kieran, { type: 'question', to: 'Rohan', text: 'rebased yet?' })
      const { items } = m.tools.hookSelect() // selected in the same tick, then never confirmed
      expect(items.map(i => i.line).join('\n')).toContain('rebased yet?')
      await quiet()
      expect(texts).toEqual([])
      await vi.waitFor(() => expect(texts).toHaveLength(1), { timeout: 1_000 })
      expect(texts[0]).toContain('Kieran asked a question')
    } finally { await m.close() }
  })

  it('the 2026-09-27 Codex queue scenario: a queued pointer, then the edit hook hands M off once; no duplicate, no loss', async () => {
    const { texts, send } = recorder()
    const m = await mcp(send)
    const runHook = (input: object) => new Promise<string>((res, rej) => {
      const p = execFile('node', [join(HOOKS, 'before-edit.mjs')], { cwd: HOOKS }, (err, out) => err ? rej(err) : res(out))
      p.stdin!.end(JSON.stringify({ session_id: SID, cwd: dir, tool_name: 'Write', tool_input: { file_path: 'app.py' }, ...input }))
    })
    const context = (out: string) => out ? JSON.parse(out).hookSpecificOutput.additionalContext as string : ''
    const peer = new Awareness(new Y.Doc())
    peer.setLocalState({ user: { name: 'Kieran', kind: 'agent', color: '#111' }, status: 'idle', lastActive: Date.now() })
    applyAwarenessUpdate(m.s.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
    try {
      const q = hubAppend<QuestionMsg>(m.s.room, kieran, { type: 'question', to: 'Rohan', text: 'is app.py yours?' })
      await vi.waitFor(() => expect(texts).toHaveLength(1))
      expect(texts[0]).not.toContain('is app.py yours?')
      await new Promise(r => setTimeout(r, 250)) // state.json lands
      const shown = context(await runHook({}))
      expect(shown.split('is app.py yours?')).toHaveLength(2)
      expect(m.s.room.seen('Rohan').get(q.id)).toMatchObject({ via: 'hook' })
      expect(context(await runHook({}))).not.toContain('is app.py yours?')
      expect(await m.tools.call('room_state', {})).not.toContain('[inbox')
      await quiet()
      expect(texts).toHaveLength(1)
    } finally { peer.destroy(); await m.close() }
  })
})
