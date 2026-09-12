import { describe, expect, it } from 'vitest'
import type { Claim, Presence, Scope } from '@room/shared'
import { parseRoomUrl } from './conn.ts'
import { deriveParticipants, deriveStatePill } from './panels.ts'

describe('state pill: done and working', () => {
  it('shows done after room_done and working while scoped', () => {
    const base = { online: true, behindBase: false, claims: [] as never[] }
    expect(deriveStatePill({ ...base, statuses: [{ kind: 'agent', status: 'done: coupons landed' }] })).toBe('done')
    expect(deriveStatePill({ ...base, statuses: [{ kind: 'agent', status: 'on orders: coupons' }] })).toBe('working')
  })
})

describe('room URL parsing', () => {
  it('keeps the last segment encoded and decodes it for display', () => {
    expect(parseRoomUrl('ws://localhost:1244/local%2Fbare%2Fmain')).toEqual({
      serverUrl: 'ws://localhost:1244',
      encodedRoomName: 'local%2Fbare%2Fmain',
      displayRoomName: 'local/bare/main',
    })
  })
})

describe('participant cards', () => {
  it('unions awareness, scopes and overlay keys', () => {
    const now = 2_000_000
    const presences: Presence[] = [
      { user: { name: 'Rohan', kind: 'human', color: '#111' }, status: 'viewing', lastActive: now - 2_000 },
      { user: { name: 'Rohan', kind: 'agent', color: '#222' }, status: 'working', lastActive: now - 1_000 },
    ]
    const scope: Scope = { by: 'Kieran', byKind: 'agent', area: 'auth', summary: 'tokens', paths: ['src/auth'], at: 1 }
    const oldClaim: Claim = { id: 'c1', path: 'src/auth/token.ts', from: 2, to: 4, by: 'Kieran', byKind: 'agent', intent: 'rotate token', at: now - 11 * 60_000 }
    const result = deriveParticipants({
      presences,
      scopes: [['Kieran', scope]],
      overlayPeople: ['Ada'],
      changesByPerson: new Map([['Rohan', ['src/ui.ts']], ['Kieran', ['src/auth/token.ts']], ['Ada', ['README.md']]]),
      claims: [oldClaim],
      now,
    })
    expect(result.map(person => person.name)).toEqual(['Ada', 'Kieran', 'Rohan'])
    expect(result.find(person => person.name === 'Rohan')).toMatchObject({ online: true, files: ['src/ui.ts'] })
    expect(result.find(person => person.name === 'Kieran')).toMatchObject({ online: false, claims: [{ stale: true }] })
  })

  it('derives one state pill with operational states taking precedence', () => {
    const base = { online: true, behindBase: false, statuses: [] as { kind: 'agent'; status: string }[], claims: [] as (Claim & { stale: boolean })[] }
    const claim: Claim & { stale: boolean } = {
      id: 'c', path: 'src/parser.ts', from: 1, to: 3, by: 'Ada', byKind: 'agent', intent: 'rename parser', at: 1, stale: false,
      plans: [{ kind: 'rename', symbol: 'parse', detail: 'parse_payload' }],
    }
    expect(deriveStatePill({ ...base, online: false })).toBe('offline')
    expect(deriveStatePill({ ...base, statuses: [{ kind: 'agent', status: 'waiting on Rohan' }] })).toBe('waiting on Rohan')
    expect(deriveStatePill({ ...base, behindBase: true })).toBe('behind base')
    expect(deriveStatePill({ ...base, statuses: [{ kind: 'agent', status: 'ahead by 1' }] })).toBe('ahead (unpushed)')
    expect(deriveStatePill({ ...base, claims: [claim] })).toBe('editing parse')
    expect(deriveStatePill(base)).toBe('idle')
  })
})
