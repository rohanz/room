import { afterEach, describe, expect, it } from 'vitest'
import {
  MessageKinds,
  RoomDoc,
  formatMsg,
  messageForMe,
  registerMessageKind,
  shouldWakeOnMsg,
  type MsgBase,
  type BaseMsg,
  type PlanMsg,
  type NoteMsg,
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

 it('never routes own messages, even human or explicitly addressed messages', () => {
   const room = new RoomDoc()
   for (const kind of ['human', 'agent', 'bot', 'ci'] as const) {
     const m = room.post<NoteMsg>({ name: 'Rohan', kind }, { type: 'note', text: 'own', priority: 'interrupt', to: 'Rohan' })
     expect(messageForMe({ name: 'Rohan' }, m)).toBe(false)
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

it.each(['scope', 'release', 'changed', 'claim'] as const)('%s stays feed-only and never wakes, even with an urgency override', type => {
  for (const priority of ['fyi', 'notify', 'interrupt'] as const) {
    const m = { id: 'routine', type, priority, from: 'Kieran', fromKind: 'agent', at: 1 } as import('./types.js').Msg
    expect(MessageKinds[type].wakes).toBe('never')
    expect(MessageKinds[type].inbox).toBe(false)
    expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, m).wake).toBe(false)
    expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, { ...m, to: 'Rohan' }).wake).toBe(false)
  }
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
