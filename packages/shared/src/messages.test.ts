import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MessageKinds,
  claimReleaseText,
  parseClaimRelease,
  RoomDoc,
  formatMsg,
  messageEndsWait,
  messageForMe,
  registerMessageKind,
  shouldWakeOnMsg,
  type MsgBase,
  type Msg,
  type Claim,
  type BaseMsg,
  type PlanMsg,
  type NoteMsg,
  type QuestionMsg,
  type MergeConflictMsg,
  type ConflictMsg,
  type ScopeMsg,
} from './index.js'
import { hubAppend } from './testing.js'

declare module './types.js' {
  interface MessageMap {
    ping: PingMsg
  }
}

interface PingMsg extends MsgBase {
  type: 'ping'
  text: string
}

describe('claim release text', () => {
  it('builds and parses the exact roomd notice', () => {
    const text = claimReleaseText('src/app.py', 2, 4, 'abc123def0')
    expect(text).toBe('released your claim on src/app.py:2-4: that code changed in abc123def0')
    expect(parseClaimRelease(text)).toEqual({ path: 'src/app.py', from: 2, to: 4, sha: 'abc123def0' })
  })

  it('parses colons in paths and rejects unrelated text', () => {
    expect(parseClaimRelease('released your claim on src/a:b.py:2-4: that code changed in abc123def0'))
      .toEqual({ path: 'src/a:b.py', from: 2, to: 4, sha: 'abc123def0' })
    expect(parseClaimRelease('released your claim on src/app.py:2-4: something else')).toBeUndefined()
    expect(parseClaimRelease('prefix released your claim on src/app.py:2-4: that code changed in abc123def0')).toBeUndefined()
  })
})

describe('MessageKinds', () => {
  afterEach(() => { delete MessageKinds.ping })

  it('renders a possible merge notice without a certified conflict label', () => {
    const room = new RoomDoc()
    const msg = hubAppend<MergeConflictMsg>(room, { name: 'room', kind: 'agent' }, { type: 'merge-conflict', path: 'x', to: 'A', priority: 'fyi', text: 'A changed x outside their declared area; Room cannot check this merge' })
    expect(formatMsg(msg)).not.toContain('CONFLICT on')
    expect(formatMsg(msg)).toContain('POSSIBLE conflict')
    const cleared = hubAppend<MergeConflictMsg>(room, { name: 'room', kind: 'agent' }, { type: 'merge-conflict', path: 'x', to: 'A', priority: 'fyi', clearedFrom: 'conflict', text: 'x: the conflict with B cleared' })
    expect(formatMsg(cleared)).toContain('CONFLICT cleared on x')
    const clearedPossibility = hubAppend<MergeConflictMsg>(room, { name: 'room', kind: 'agent' }, { type: 'merge-conflict', path: 'x', to: 'A', priority: 'fyi', clearedFrom: 'possible', text: 'x: the possible conflict with B cleared' })
    expect(formatMsg(clearedPossibility)).toContain('POSSIBLE conflict cleared on x')
    const approximateClaim = hubAppend<ConflictMsg>(room, { name: 'room', kind: 'agent' }, { type: 'conflict', claimId: 'c', otherClaimId: '', path: 'x', to: 'A', priority: 'fyi', text: 'claims in x may overlap; line mapping is approximate' })
    expect(formatMsg(approximateClaim)).toContain('POSSIBLE conflict on x')
  })

  it('does not wake for a historical base move', () => {
    const room = new RoomDoc()
    const m = hubAppend<BaseMsg>(room, { name: 'Kieran', kind: 'agent' }, { type: 'base', base: 'abc', prev: 'def', commits: 1, summary: 'update', paths: [] })
    const me = { name: 'Rohan', kind: 'agent' } as const
    expect(shouldWakeOnMsg(me, m, [], false).wake).toBe(false)
    expect(shouldWakeOnMsg(me, m, [], true).wake).toBe(false)
    room.doc.destroy()
  })

  it('uses a registered priority when posting a waking kind', () => {
    registerMessageKind('ping', { audience: 'broadcast', wakes: 'always', priority: 'interrupt', format: m => m.text })
    const room = new RoomDoc()
    const m = hubAppend<PingMsg>(room, { name: 'Kieran', kind: 'agent' }, { type: 'ping', text: 'look' })
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

it('formats only the newest declared scope in a live area as current', () => {
  const room = new RoomDoc()
  const worker = { name: 'Rohan+worker', kind: 'agent' } as const
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  try {
    const old = hubAppend<ScopeMsg>(room, worker, { type: 'scope', area: 'api', summary: 'old work', paths: ['api/a.ts'] })
    room.setScope({ by: worker.name, byKind: worker.kind, area: 'api', summary: 'old work', paths: ['./api/a.ts', 'api/a.ts'] })
    expect(formatMsg(old, { scopes: room.allScopes(), messages: room.messages() })).toContain('is on api: old work')
    clock.mockReturnValue(1_500)
    const revised = hubAppend<ScopeMsg>(room, worker, { type: 'scope', area: 'api', summary: 'revised work', paths: ['api/b.ts'] })
    room.setScope({ by: worker.name, byKind: worker.kind, area: 'api', summary: 'revised work', paths: ['api/b.ts'] })
    const revisedContext = { scopes: room.allScopes(), messages: room.messages() }
    expect(formatMsg(old, revisedContext)).toContain('earlier: Rohan+worker was on api (00:00:01): old work')
    expect(formatMsg(revised, revisedContext)).toContain('is on api: revised work')
    clock.mockReturnValue(2_000)
    const moved = hubAppend<ScopeMsg>(room, worker, { type: 'scope', area: 'web', summary: 'new work', paths: ['web/a.ts'] })
    room.setScope({ by: worker.name, byKind: worker.kind, area: 'web', summary: 'new work', paths: ['web/a.ts'] })
    const context = { scopes: room.allScopes(), messages: room.messages() }
    expect(formatMsg(old, context)).toContain('earlier: Rohan+worker was on api (00:00:01): old work')
    expect(formatMsg(moved, context)).toContain('Rohan+worker is on web: new work')
    room.setScope({ by: worker.name, byKind: worker.kind, area: 'api', summary: 'old work', paths: ['api/a.ts'] })
    const restored = { scopes: room.allScopes(), messages: room.messages() }
    expect(formatMsg(old, restored)).toContain('is on api: old work')
    expect(formatMsg(revised, restored)).toContain('earlier: Rohan+worker was on api')
    expect(formatMsg(moved, restored)).toContain('earlier: Rohan+worker was on web')
    room.scopes.delete(worker.name)
    expect(formatMsg(moved, { scopes: room.allScopes(), messages: room.messages() })).toContain('earlier: Rohan+worker was on web (00:00:02): new work')
  } finally { clock.mockRestore(); room.doc.destroy() }
})

it('addresses a note as a waking notification while leaving broadcast notes as FYI', () => {
  const room = new RoomDoc()
  const from = { name: 'Kieran', kind: 'agent' } as const
  const addressed = hubAppend<NoteMsg>(room, from, { type: 'note', to: 'Rohan', text: 'please also check the report' })
  const broadcast = hubAppend<NoteMsg>(room, from, { type: 'note', text: 'progress update' })
  expect(addressed.priority).toBe('notify')
  expect(messageEndsWait(addressed, { me: 'Rohan' })).toBe(true)
  expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, addressed).wake).toBe(true)
  expect(formatMsg(addressed)).toBe("[notify] Kieran's agent → Rohan's agent: please also check the report")
  expect(broadcast.priority).toBe('fyi')
  expect(messageEndsWait(broadcast, { me: 'Rohan' })).toBe(false)
  expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, broadcast).wake).toBe(false)
  room.doc.destroy()
})

it.each(['fyi', 'notify', 'interrupt'] as const)('routes a broadcast %s note to other participants with the matching wake behavior', priority => {
  const room = new RoomDoc()
  const note = hubAppend<NoteMsg>(room, { name: 'Kieran', kind: 'agent' }, { type: 'note', text: 'shared update', priority })
  expect(messageForMe({ name: 'Rohan' }, note)).toBe(priority !== 'fyi')
  expect(messageForMe({ name: 'Ada' }, note)).toBe(priority !== 'fyi')
  expect(messageForMe({ name: 'Kieran' }, note)).toBe(false)
  expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, note).wake).toBe(priority === 'interrupt')
  expect(shouldWakeOnMsg({ name: 'Kieran', kind: 'agent' }, note).wake).toBe(false)
  expect(messageEndsWait(note, { me: 'Rohan' })).toBe(priority === 'interrupt')
  expect(messageEndsWait(note, { me: 'Rohan', claimId: 'c_held' })).toBe(priority === 'interrupt')
  expect(messageEndsWait(note, { me: 'Rohan', questionId: 'm_question' })).toBe(priority === 'interrupt')
  expect(messageEndsWait(note, { me: 'Kieran' })).toBe(false)
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
     const m = hubAppend<NoteMsg>(room, { name: 'Rohan', kind }, { type: 'note', text: 'own', priority: 'interrupt', to: 'Rohan' })
     expect(messageForMe({ name: 'Rohan' }, m)).toBe(kind === 'human')
   }
   room.doc.destroy()
 })

 it('keeps ended plans out of inboxes and wakeups even when addressed', () => {
   const room = new RoomDoc()
   const m = hubAppend<PlanMsg>(room, { name: 'Kieran', kind: 'agent' }, { type: 'plan', status: 'cancelled', claimId: 'c', path: 'a.ts', plan: { kind: 'add', symbol: 'f' }, text: 'session ended', to: 'Rohan' })
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
  const m = hubAppend<import('./types.js').MergeConflictMsg>(room, { name: 'room', kind: 'bot' }, { type: 'merge-conflict', to: 'Rohan', path: 'api.ts', text: 'your file and Kieran’s now conflict' })
  expect(m.priority).toBe('notify')
  expect(messageForMe({ name: 'Rohan' }, m)).toBe(true)
  expect(messageForMe({ name: 'Ada' }, m)).toBe(false)
  expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, m)).toMatchObject({ wake: true, mustAnswer: true })
  expect(shouldWakeOnMsg({ name: 'Ada', kind: 'agent' }, m).wake).toBe(false)
  room.doc.destroy()
})

it('formats a tagged question recipient by its Room name', () => {
  const room = new RoomDoc()
  const question = hubAppend<QuestionMsg>(room, { name: 'Rohan', kind: 'agent' }, { type: 'question', to: 'rohanz+codex', text: 'which lines?' })
  expect(formatMsg(question)).toBe("[notify] Rohan's agent → rohanz+codex asks: which lines?")
  room.doc.destroy()
})

it('renders a released claim as history and an open one as current', () => {
  const claim = { id: 'm1', type: 'claim', priority: 'fyi', from: 'Kieran', fromKind: 'agent', at: 1000, claimId: 'c1', path: 'api/pricing.py', from_line: 3, to_line: 9, intent: 'add tax' } as Msg
  const open = [{ id: 'c1', by: 'Kieran', byKind: 'agent', path: 'api/pricing.py', from: 3, to: 9, intent: 'add tax', at: 1000 }] as unknown as Claim[]
  expect(formatMsg(claim, { scopes: [], messages: [claim], claims: open })).toContain('Kieran\'s agent claims api/pricing.py:3-9')
  expect(formatMsg(claim, { scopes: [], messages: [claim], claims: [] })).toContain('earlier: Kieran\'s agent claimed api/pricing.py:3-9 (00:00:01) — add tax')
  expect(formatMsg(claim)).toContain('claims api/pricing.py:3-9')
})
