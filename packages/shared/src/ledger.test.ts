import { describe, it, expect } from 'vitest'
import { RoomDoc } from './doc.js'
import { scopeCovers } from './ledger.js'
import type { ChangedMsg, ClaimMsg, NoteMsg } from './types.js'
import { hubAppend } from './testing.js'

const rohan = { name: 'Rohan', kind: 'agent' as const }
const kieran = { name: 'Kieran', kind: 'agent' as const }

describe('ledger', () => {
  it('scopeCovers matches exact paths and directories', () => {
    expect(scopeCovers({ paths: ['auth/'] }, 'auth/session.py')).toBe(true)
    expect(scopeCovers({ paths: ['auth'] }, 'auth/session.py')).toBe(true)
    expect(scopeCovers({ paths: ['auth/login.py'] }, 'auth/login.py')).toBe(true)
    expect(scopeCovers({ paths: ['auth'] }, 'authz/x.py')).toBe(false)
    expect(scopeCovers({ paths: ['.'] }, 'src/a.ts')).toBe(true)
    expect(scopeCovers({ paths: [''] }, 'a')).toBe(false)
    expect(scopeCovers({ paths: ['/'] }, 'a')).toBe(false)
    expect(scopeCovers({ paths: ['src\\'] }, './src/a.ts')).toBe(true)
    expect(scopeCovers({ paths: ['src/a.ts'] }, 'src')).toBe(false)
  })

  it('filters by area through scopes and by path, ignoring chatter', () => {
    const r = new RoomDoc()
    r.setScope({ by: 'Rohan', byKind: 'agent', area: 'auth', summary: 'login flow', paths: ['auth/'] })
    hubAppend<ChangedMsg>(r, kieran, { type: 'changed', paths: ['auth/utils.py'], summary: 'rename validate', symbols: ['validate'] })
    hubAppend<ChangedMsg>(r, kieran, { type: 'changed', paths: ['orders/api.py'], summary: 'unrelated' })
    hubAppend<NoteMsg>(r, kieran, { type: 'note', text: 'hi' })
    hubAppend<ClaimMsg>(r, rohan, { type: 'claim', claimId: 'c1', path: 'auth/session.py', from_line: 1, to_line: 3, intent: 'x', plans: [{ kind: 'rename', symbol: 'a' }] })
    const auth = r.ledger({ area: 'auth' })
    expect(auth.map(m => m.type)).toEqual(['changed', 'claim'])
    expect(r.ledger({ path: 'orders/api.py' }).length).toBe(1)
    expect(r.ledger({ area: 'auth', limit: 1 })[0].type).toBe('claim')
    expect(r.areaSummary()[0]).toMatch(/^auth \(Rohan\): 1 change in the last 10 min by Kieran$/)
  })

  it('release records unfulfilled plans in the feed line', () => {
    const r = new RoomDoc()
    const m = hubAppend(r, rohan, { type: 'release', claimId: 'c', path: 'a.py', summary: 'done', unfulfilled: [{ kind: 'rename', symbol: 'foo', detail: 'bar' }] } as any)
    expect(m.priority).toBe('fyi')
  })
})
