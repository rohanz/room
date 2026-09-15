import { describe, it, expect } from 'vitest'
import { shouldWake } from '../src/wake.js'
import type { Claim, Msg, Identity } from '@room/shared'

const me: Identity = { name: 'Rohan', kind: 'agent' }
const msg = (o: Partial<Msg> & { type: Msg['type'] }): Msg =>
  ({ id: 'm_1', at: 1, priority: 'notify', from: 'Kieran', fromKind: 'agent', text: 't', ...o }) as Msg
const mine: Claim = { id: 'c_me', path: 'app.py', from: 10, to: 20, by: 'Rohan', byKind: 'agent', intent: 'refactor', at: 1 }

describe('shouldWake', () => {
  it('uses the base registry rule for channel wakes', () => {
    const ev = { kind: 'msg', msg: msg({ type: 'base', base: 'abc', prev: 'def', commits: 1, paths: [], summary: 'update' }) } as const
    expect(shouldWake(me, ev, [], false)).toBeNull()
    expect(shouldWake(me, ev, [], true)?.meta.type).toBe('base')
  })
  it('ignores my own messages', () => {
    expect(shouldWake(me, { kind: 'msg', msg: msg({ type: 'question', from: 'Rohan', fromKind: 'agent', to: 'Kieran' }) })).toBeNull()
  })
  it('wakes on a question to me, with meta and content', () => {
    const w = shouldWake(me, { kind: 'msg', msg: msg({ type: 'question', to: 'Rohan', text: 'ok?' }) })!
    expect(w).not.toBeNull()
    expect(w.content.split('\n')[0]).toBe("[notify] Kieran's agent → Rohan's agent asks: ok?")
    expect(JSON.parse(w.content.split('\n')[1]).id).toBe('m_1')
    expect(w.meta).toEqual({ type: 'question', from: 'Kieran', from_kind: 'agent', msg_id: 'm_1' })
    for (const k of Object.keys(w.meta)) expect(k).toMatch(/^[a-z0-9_]+$/)
  })
  it('does not wake on a question to someone else', () => {
    expect(shouldWake(me, { kind: 'msg', msg: msg({ type: 'question', to: 'Alice' }) })).toBeNull()
  })
  it('broadcast changed is read on next action; addressed changed wakes and includes path', () => {
    expect(shouldWake(me, { kind: 'msg', msg: msg({ type: 'changed', paths: ['a.py'], summary: 's', priority: 'notify' } as any) })).toBeNull()
    const w = shouldWake(me, { kind: 'msg', msg: msg({ type: 'changed', to: 'Rohan', paths: ['a.py'], summary: 's', priority: 'notify' } as any) })!
    expect(w.meta.path).toBe('a.py')
    expect(w.meta.type).toBe('changed')
  })
  it('answer only when addressed to me; note never', () => {
    expect(shouldWake(me, { kind: 'msg', msg: msg({ type: 'answer', inReplyTo: 'x' } as any) })).toBeNull()
    expect(shouldWake(me, { kind: 'msg', msg: msg({ type: 'answer', to: 'Rohan', inReplyTo: 'x' } as any) })).not.toBeNull()
    expect(shouldWake(me, { kind: 'msg', msg: msg({ type: 'note', from: 'Kieran', fromKind: 'human' }) })).toBeNull()
  })
  it('interrupts wake even when broadcast; fyi never wakes', () => {
    expect(shouldWake(me, { kind: 'msg', msg: msg({ type: 'note', text: 'stop', priority: 'interrupt' } as any) })).not.toBeNull()
    expect(shouldWake(me, { kind: 'msg', msg: msg({ type: 'note', to: 'Rohan', text: 'x', priority: 'fyi' } as any) })).toBeNull()
  })
  it('wakes on overlapping claim by another party, not on disjoint or own', () => {
    const other: Claim = { ...mine, id: 'c_o', by: 'Kieran', from: 15, to: 30 }
    const w = shouldWake(me, { kind: 'claim', claim: other }, [mine])!
    expect(w.meta).toMatchObject({ type: 'claim_overlap', from: 'Kieran', path: 'app.py', msg_id: 'c_o' })
    expect(shouldWake(me, { kind: 'claim', claim: { ...other, from: 21, to: 30 } }, [mine])).toBeNull()
    expect(shouldWake(me, { kind: 'claim', claim: other }, [])).toBeNull()
    expect(shouldWake(me, { kind: 'claim', claim: { ...other, by: 'Rohan' } }, [mine])).toBeNull()
  })
  it('wakes when a human cursor enters my claim', () => {
    const w = shouldWake(me, { kind: 'cursor', who: { name: 'Kieran', kind: 'human' }, cursor: { path: 'app.py', from: 12, to: 12 } }, [mine])!
    expect(w.meta).toMatchObject({ type: 'cursor_in_claim', from: 'Kieran', msg_id: 'c_me' })
    expect(shouldWake(me, { kind: 'cursor', who: { name: 'Kieran', kind: 'agent' }, cursor: { path: 'app.py', from: 12, to: 12 } }, [mine])).toBeNull()
    expect(shouldWake(me, { kind: 'cursor', who: { name: 'Kieran', kind: 'human' }, cursor: { path: 'app.py', from: 1, to: 2 } }, [mine])).toBeNull()
  })
})
