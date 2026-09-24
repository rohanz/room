import { afterEach, describe, expect, it } from 'vitest'
import {
  MessageKinds,
  RoomDoc,
  formatMsg,
  messageEndsWait,
  messageForMe,
  registerMessageKind,
  shouldWakeOnMsg,
  type MsgBase,
  type BaseMsg,
  type PlanMsg,
  type NoteMsg,
  type QuestionMsg,
} from './index.js'

declare module './types.js' {
  interface MessageMap {
    ping: PingMsg
  }
}

interface PingMsg extends MsgBase {
  type: 'ping'
  text: string
}

describe('MessageKinds', () => {
  afterEach(() => { delete MessageKinds.ping })

  it('wakes for base moves only with uncommitted work', () => {
    const room = new RoomDoc()
    const m = room.post<BaseMsg>({ name: 'Kieran', kind: 'agent' }, { type: 'base', base: 'abc', prev: 'def', commits: 1, summary: 'update', paths: [] })
    const me = { name: 'Rohan', kind: 'agent' } as const
    expect(shouldWakeOnMsg(me, m, [], false).wake).toBe(false)
    expect(shouldWakeOnMsg(me, m, [], true).wake).toBe(true)
    room.doc.destroy()
  })

  it('uses a registered priority when posting a waking kind', () => {
    registerMessageKind('ping', { audience: 'broadcast', wakes: 'always', priority: 'interrupt', format: m => m.text })
    const room = new RoomDoc()
    const m = room.post<PingMsg>({ name: 'Kieran', kind: 'agent' }, { type: 'ping', text: 'look' })
    expect(m.priority).toBe('interrupt')
    expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, m).wake).toBe(true)
    room.doc.destroy()
  })

  it('routes, wakes and formats a newly registered kind without tool changes', () => {
    registerMessageKind('ping', {
      audience: 'addressed',
      wakes: 'addressed',
      priority: 'notify',
      format: m => `[${m.priority}] ping from ${m.from}: ${m.text}`,
    })
    const ping: PingMsg = {
      id: 'm_ping', type: 'ping', priority: 'notify', from: 'Kieran', fromKind: 'agent',
      to: 'Rohan', at: 1, text: 'please look',
    }

    expect(messageForMe({ name: 'Rohan' }, ping)).toBe(true)
    expect(messageForMe({ name: 'Ada' }, ping)).toBe(false)
    expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, ping).wake).toBe(true)
    expect(shouldWakeOnMsg({ name: 'Ada', kind: 'agent' }, ping).wake).toBe(false)
    expect(formatMsg(ping)).toBe('[notify] ping from Kieran: please look')
  })
})

it('addresses a note as a waking notification while leaving broadcast notes as FYI', () => {
  const room = new RoomDoc()
  const from = { name: 'Kieran', kind: 'agent' } as const
  const addressed = room.post<NoteMsg>(from, { type: 'note', to: 'Rohan', text: 'please also check the report' })
  const broadcast = room.post<NoteMsg>(from, { type: 'note', text: 'progress update' })
  expect(addressed.priority).toBe('notify')
  expect(messageEndsWait(addressed, { me: 'Rohan' })).toBe(true)
  expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, addressed).wake).toBe(true)
  expect(formatMsg(addressed)).toBe("[notify] Kieran's agent → Rohan's agent: please also check the report")
  expect(broadcast.priority).toBe('fyi')
  expect(messageEndsWait(broadcast, { me: 'Rohan' })).toBe(false)
  expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, broadcast).wake).toBe(false)
  room.doc.destroy()
})

it('keeps a lead asleep for its own worker progress notes, but wakes for actionable worker events', () => {
  const me = { name: 'Rohan', kind: 'agent' } as const
  const ownWorkers = new Set(['Rohan+money'])
  const base = { id: 'm_worker', at: 1, from: 'Rohan+money', fromKind: 'agent', to: 'Rohan' } as const
  const wake = (m: import('./types.js').Msg) => shouldWakeOnMsg(me, m, [], false, ownWorkers).wake
  expect(wake({ ...base, type: 'note', priority: 'notify', text: 'progress' })).toBe(false)
  expect(wake({ ...base, type: 'question', priority: 'notify', text: 'which field?' })).toBe(true)
  expect(wake({ ...base, type: 'done', priority: 'fyi', tag: 'money', summary: 'finished', changed: [] })).toBe(true)
  expect(wake({ ...base, type: 'note', priority: 'interrupt', text: 'failed' })).toBe(true)
  expect(wake({ ...base, type: 'note', priority: 'notify', from: 'Ada+worker', text: 'other agent' })).toBe(true)
  expect(wake({ ...base, type: 'note', priority: 'notify', fromKind: 'human', text: 'human' })).toBe(true)
})

it('does not treat an answer to someone else as the answer to my wait', () => {
  const answer = { id: 'm_answer', at: 1, type: 'answer', priority: 'notify', from: 'worker', fromKind: 'agent',
    to: 'Ada', inReplyTo: 'm_question', text: 'yes' } as const
  expect(messageEndsWait(answer, { questionId: 'm_question', me: 'Rohan' })).toBe(false)
  expect(messageEndsWait(answer, { questionId: 'm_question', me: 'Ada' })).toBe(true)
})

 it('filters own agentic messages but keeps an explicitly addressed same-named human message', () => {
   const room = new RoomDoc()
   for (const kind of ['human', 'agent', 'bot', 'ci'] as const) {
     const m = room.post<NoteMsg>({ name: 'Rohan', kind }, { type: 'note', text: 'own', priority: 'interrupt', to: 'Rohan' })
     expect(messageForMe({ name: 'Rohan' }, m)).toBe(kind === 'human')
   }
   room.doc.destroy()
 })

 it('keeps ended plans out of inboxes and wakeups even when addressed', () => {
   const room = new RoomDoc()
   const m = room.post<PlanMsg>({ name: 'Kieran', kind: 'agent' }, { type: 'plan', status: 'cancelled', claimId: 'c', path: 'a.ts', plan: { kind: 'add', symbol: 'f' }, text: 'session ended', to: 'Rohan' })
   expect(m.priority).toBe('fyi')
   expect(messageForMe({ name: 'Rohan' }, m)).toBe(false)
   expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, m).wake).toBe(false)
   room.doc.destroy()
 })

it.each(['scope', 'release', 'claim'] as const)('%s stays feed-only and never wakes, even with an urgency override', type => {
  for (const priority of ['fyi', 'notify', 'interrupt'] as const) {
    const m = { id: 'routine', type, priority, from: 'Kieran', fromKind: 'agent', at: 1 } as import('./types.js').Msg
    expect(MessageKinds[type].wakes).toBe('never')
    expect(MessageKinds[type].inbox).toBe(false)
    expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, m).wake).toBe(false)
    expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, { ...m, to: 'Rohan' }).wake).toBe(false)
  }
})

it('changed is feed-only as a broadcast; the copy addressed to someone who uses the symbol wakes them', () => {
  const m = { id: 'rename', type: 'changed', priority: 'notify', from: 'Kieran', fromKind: 'agent', at: 1, paths: ['a.py'], summary: 'renamed f', symbols: ['f'] } as import('./types.js').Msg
  expect(MessageKinds.changed.inbox).toBe(false)
  expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, m).wake).toBe(false)
  expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, { ...m, to: 'Rohan' }).wake).toBe(true)
})

it('addresses merge conflicts to the affected participant as a waking notification', () => {
  const room = new RoomDoc()
  const m = room.post<import('./types.js').MergeConflictMsg>({ name: 'room', kind: 'bot' }, { type: 'merge-conflict', to: 'Rohan', path: 'api.ts', text: 'your file and Kieran’s now conflict' })
  expect(m.priority).toBe('notify')
  expect(messageForMe({ name: 'Rohan' }, m)).toBe(true)
  expect(messageForMe({ name: 'Ada' }, m)).toBe(false)
  expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, m)).toMatchObject({ wake: true, mustAnswer: true })
  expect(shouldWakeOnMsg({ name: 'Ada', kind: 'agent' }, m).wake).toBe(false)
  room.doc.destroy()
})

it('formats a tagged question recipient by its Room name', () => {
  const room = new RoomDoc()
  const question = room.post<QuestionMsg>({ name: 'Rohan', kind: 'agent' }, { type: 'question', to: 'rohanz+codex', text: 'which lines?' })
  expect(formatMsg(question)).toBe("[notify] Rohan's agent → rohanz+codex asks: which lines?")
  room.doc.destroy()
})
