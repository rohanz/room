import { describe, it, expect } from 'vitest'
import { RoomDoc } from './doc.js'
import { scopeCovers } from './ledger.js'
import type { ChangedMsg, ClaimMsg, NoteMsg } from './types.js'
import * as Y from 'yjs'

const rohan = { name: 'Rohan', kind: 'agent' as const }
const kieran = { name: 'Kieran', kind: 'agent' as const }

describe('ledger', () => {
  it('scopeCovers matches exact paths and directories', () => {
    expect(scopeCovers({ paths: ['auth/'] }, 'auth/session.py')).toBe(true)
    expect(scopeCovers({ paths: ['auth'] }, 'auth/session.py')).toBe(true)
    expect(scopeCovers({ paths: ['auth/login.py'] }, 'auth/login.py')).toBe(true)
    expect(scopeCovers({ paths: ['auth'] }, 'authz/x.py')).toBe(false)
  })

  it('filters by area through scopes and by path, ignoring chatter', () => {
    const r = new RoomDoc()
    r.setScope({ by: 'Rohan', byKind: 'agent', area: 'auth', summary: 'login flow', paths: ['auth/'] })
    r.post<ChangedMsg>(kieran, { type: 'changed', paths: ['auth/utils.py'], summary: 'rename validate', symbols: ['validate'] })
    r.post<ChangedMsg>(kieran, { type: 'changed', paths: ['orders/api.py'], summary: 'unrelated' })
    r.post<NoteMsg>(kieran, { type: 'note', text: 'hi' })
    r.post<ClaimMsg>(rohan, { type: 'claim', claimId: 'c1', path: 'auth/session.py', from_line: 1, to_line: 3, intent: 'x', plans: [{ kind: 'rename', symbol: 'a' }] })
    const auth = r.ledger({ area: 'auth' })
    expect(auth.map(m => m.type)).toEqual(['changed', 'claim'])
    expect(r.ledger({ path: 'orders/api.py' }).length).toBe(1)
    expect(r.ledger({ area: 'auth', limit: 1 })[0].type).toBe('claim')
    expect(r.areaSummary()[0]).toMatch(/^auth \(Rohan\): 1 change in the last 10 min by Kieran$/)
  })

  it('release records unfulfilled plans in the feed line', () => {
    const r = new RoomDoc()
    const m = r.post(rohan, { type: 'release', claimId: 'c', path: 'a.py', summary: 'done', unfulfilled: [{ kind: 'rename', symbol: 'foo', detail: 'bar' }] } as any)
    expect(m.priority).toBe('fyi')
  })

  it('trims routine history into an area ledger while keeping open questions actionable', () => {
    const r = new RoomDoc()
    r.setScope({ by: 'Rohan', byKind: 'agent', area: 'auth', summary: 'login', paths: ['auth/'] })
    for (let i = 0; i < 5; i++) r.post<ChangedMsg>(rohan, { type: 'changed', paths: ['auth/a.ts'], summary: `change ${i}` })
    const q = r.post(kieran, { type: 'question', to: 'Rohan', text: 'which token?' } as any)
    r.post(rohan, { type: 'release', claimId: 'c-old', path: 'auth/a.ts', summary: 'partial', unfulfilled: [{ kind: 'rename', symbol: 'token' }] } as any)
    r.post<NoteMsg>(rohan, { type: 'note', text: 'newest' })

    expect(r.trimBus(1)).toBe(6)
    expect(r.messages().map(m => m.id)).toContain(q.id)
    expect(r.archivedLedger({ area: 'auth' }).counts.changed).toBe(5)
    r.post(kieran, { type: 'answer', inReplyTo: q.id, text: 'access token' } as any)
    expect(r.trimBus(1)).toBeGreaterThan(0)
    expect(r.archivedLedger({ area: 'auth' }).unfulfilled[0].plans[0].symbol).toBe('token')
  })

  it('syncs compact ledger history to a client joining after trimming', () => {
    const first = new RoomDoc()
    first.setScope({ by: 'Rohan', byKind: 'agent', area: 'api', summary: 'endpoint', paths: ['api/'] })
    first.post<ChangedMsg>(rohan, { type: 'changed', paths: ['api/x.ts'], summary: 'one' })
    first.post<ChangedMsg>(kieran, { type: 'changed', paths: ['api/y.ts'], summary: 'two' })
    expect(first.trimBus(0)).toBe(2)
    const late = new RoomDoc()
    Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(first.doc))
    expect(late.messages()).toHaveLength(0)
    expect(late.archivedLedger({ area: 'api' })).toMatchObject({ messages: 2, counts: { changed: 2 } })
    expect(Object.keys(late.archivedLedger({ area: 'api' }).lastSeen).sort()).toEqual(['Kieran', 'Rohan'])
  })
})
