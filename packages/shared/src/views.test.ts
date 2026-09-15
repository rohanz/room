import { describe, expect, it } from 'vitest'
import type { Claim, Presence, Scope, Worker } from './types.js'
import { lineDetail, areaMembershipSummary, claimLine, deriveParticipants, otherAreasLine, participantClaimLine, personLine, presentPeople, workerLine } from './views.js'

describe('shared room views', () => {
  const scope: Scope = { by: 'Kieran', byKind: 'agent', area: 'api', summary: 'handlers', paths: ['api/'], at: 1 }
  const claim: Claim = { id: 'c1', path: 'api/a.py', from: 1, to: 2, by: 'Kieran', byKind: 'agent', intent: 'tune a', at: 1 }

  it('derives participants from awareness, scopes, and overlays', () => {
    const now = 1_000_000
    const presences: Presence[] = [{ user: { name: 'Rohan', kind: 'agent', color: '#000' }, status: 'working', lastActive: now }]
    const participants = deriveParticipants({
      presences,
      scopes: [['Kieran', scope]],
      overlayPeople: ['Ada'],
      changesByPerson: new Map([['Ada', ['README.md']]]),
      claims: [claim],
      now,
    })
    expect(participants.map(p => p.name)).toEqual(['Ada', 'Kieran', 'Rohan'])
    expect(participants.find(p => p.name === 'Kieran')?.claims[0].stale).toBe(true)
  })

  it('keeps only present people for a default merge selection', () => {
    expect(presentPeople(['Ada', 'Kieran', 'Rohan'], [{ user: { name: 'Rohan', kind: 'agent', color: '#000' } }, { user: { name: 'Ada', kind: 'agent', color: '#000' } }]))
      .toEqual(['Ada', 'Rohan'])
  })

  it('keeps room_state participant and claim wording exact', () => {
    expect(personLine({ name: 'Kieran', scope, presences: [], changedPaths: ['api/a.py'], messages: [], share: 'intent' }))
      .toBe('working on api: handlers (api/); shares intent (no file text); uncommitted, not yet pushed: api/a.py')
    expect(claimLine(claim, { yours: true, stale: true }))
      .toBe("  - c1: Kieran's agent · api/a.py:1-2 · tune a (yours) [stale: owner offline]")
    expect(participantClaimLine({ ...claim, plans: [{ kind: 'rename', symbol: 'a', detail: 'b' }] }))
      .toBe('api/a.py:1-2 · tune a → rename a to b')
  })

  it('formats area membership and hidden-area counts deterministically', () => {
    expect(areaMembershipSummary(['web/', 'api/', 'web/'])).toBe('areas api/, web/')
    expect(otherAreasLine(1, ['api/'])).toBe('1 other in 1 other area (api/)')
    expect(otherAreasLine(2, ['web/', 'api/'])).toBe('2 others in 2 other areas (api/, web/)')
  })

  it('formats worker details without process inspection', () => {
    const worker: Worker = { tag: 'views', name: 'Rohan+views', host: 'codex', task: 'share browser formatting', dir: '/tmp/views', branch: 'room/views', pid: 1, startedAt: 0, status: 'running', lead: 'Rohan' }
    expect(workerLine({ worker, processGone: true, changedCount: 2, now: 60_000 })).toEqual([
      '  - views (codex, running (process gone), 1m): share browser formatting',
      '      2 changed files · branch room/views',
    ])
  })
})

it('returns only populated line detail sections without missing-data placeholders', () => {
  expect(lineDetail({}).sections).toEqual([{ label: 'Line', rows: ['unchanged from base'] }])
  const detail = lineDetail({ conflicts: [{ people: ['a', 'b'], resolved: false }] })
  expect(detail.sections.map(s => s.label)).toEqual(['Line', 'Conflict'])
  expect(detail.sections.every(s => s.rows.length > 0 && s.rows.every(Boolean))).toBe(true)
  expect(JSON.stringify(detail.sections)).not.toContain('unavailable')
  expect(lineDetail({ conflicts: [{ people: ['a', 'b'], resolved: true }] }).sections.map(s => s.label)).toEqual(['Line', 'Conflict'])
})
