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

it('uses the same reported runtime line online and for recorded offline workers', async () => {
  const { participantIdentityLine, deriveParticipants } = await import('./views.js')
  const p = { user: { name: 'rohanz+codex', kind: 'agent' as const, owner: 'rohanz', label: 'codex', color: '#000' } }
  expect(participantIdentityLine([p], p.user.name)).toBe('rohanz+codex · agent of rohanz · codex')
  expect(participantIdentityLine([{ ...p, host: 'codex', model: 'gpt-6-astra', effort: 'medium' }], p.user.name)).toBe('rohanz+codex · agent of rohanz · codex · gpt-6-astra · medium')
  expect(participantIdentityLine([], 'unknown')).toBe('unknown')
  const worker = { name: p.user.name, tag: 'codex', host: 'codex' as const, model: 'gpt-6-astra', effort: 'medium', task: 'test', dir: '/', branch: 'main', pid: 1, startedAt: 1, status: 'done' as const, lead: 'rohanz' }
  const input = { presences: [], workers: [worker], scopes: [], overlayPeople: [], changesByPerson: new Map(), claims: [] }
  expect(deriveParticipants(input)[0]).toMatchObject({ online: false, identity: 'agent of rohanz · codex · gpt-6-astra · medium' })
  expect(participantIdentityLine([{ ...p, model: 'actual' }], p.user.name, worker)).toContain('actual · medium')
})

it('splits active workers, offline teammates and retired history with shared lead counts', async () => {
  const { splitParticipants } = await import('./views.js')
  const worker: Worker = { name: 'lead+run', tag: 'run', lead: 'lead', host: 'codex', task: 'task', dir: '/', branch: 'main', pid: 1, startedAt: 1, status: 'running' }
  const retired = { name: 'lead+old', tag: 'old', lead: 'lead', host: 'codex' as const, task: 'task', summary: 'shipped', files: ['a.ts'], fileCount: 60, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'merged' as const }
  const input = {
    presences: [{ user: { name: 'lead', kind: 'agent' as const, color: '#000' } }, { user: { name: retired.name, kind: 'agent' as const, color: '#000' } }],
    workers: [worker, { ...worker, name: 'lead+failed', tag: 'failed', status: 'failed' as const }],
    scopes: [], overlayPeople: ['offline', retired.name], changesByPerson: new Map(), claims: [], retiredWorkers: [retired],
  }
  const groups = splitParticipants(input)
  expect(groups.active.map(p => p.name)).toEqual(['lead', 'lead+failed', 'lead+run'])
  expect(groups.offlineTeammates.map(p => p.name)).toEqual(['offline'])
  expect(groups.retiredWorkers).toEqual([retired])
  expect(groups.workerGroups).toMatchObject([{ lead: 'lead', running: 1, active: [{ name: 'lead+failed' }, { name: 'lead+run' }], retiredWorkers: [retired] }])
  const reused = splitParticipants({ ...input, workers: [...input.workers, { ...worker, name: retired.name, tag: retired.tag, startedAt: 4 }] })
  expect(reused.active.map(p => p.name)).toContain(retired.name)
  expect(reused.retiredWorkers).toEqual([retired])
})

it('keeps running and failed worker details while compacting finished history', async () => {
  const { workerLines } = await import('./views.js')
  const worker: Worker = { name: 'lead+run', tag: 'run', lead: 'lead', host: 'codex', task: 'task', dir: '/', branch: 'main', pid: 1, startedAt: 1, status: 'running' }
  const retired = { name: 'lead+old', tag: 'old', lead: 'lead', host: 'codex' as const, model: 'actual-model', task: 'task', summary: 'shipped', files: ['a.ts'], fileCount: 60, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'merged' as const }
  const inputs = (['running', 'failed', 'done', 'dismissed'] as const).map(status => ({ worker: { ...worker, tag: status, status }, changedCount: 0, now: 10 }))
  const compact = workerLines(inputs, { retiredWorkers: [retired] }).join('\n')
  expect(compact).toContain('running (codex, running')
  expect(compact).toContain('failed (codex, failed')
  expect(compact).toContain('finished: 3 (all=true lists them)')
  expect(compact).not.toContain('done (codex')
  expect(compact).not.toContain('shipped')
  const expanded = workerLines(inputs, { all: true, retiredWorkers: [retired] }).join('\n')
  expect(expanded).toContain('done (codex, done')
  expect(expanded).toContain('old (merged, actual-model): shipped · 60 files')
  expect(expanded).not.toContain('all=true')
  expect(workerLines([], { retiredWorkers: [retired] })).toEqual(['workers (1):', '  finished: 1 (all=true lists them)'])
})

it('uses consistent activity wording at the action and worker thresholds', async () => {
  const { activityLabel } = await import('./views.js')
  expect(activityLabel(0, 89_999)).toBe('working')
  expect(activityLabel(0, 90_000)).toBe('last action 1m ago')
  expect(activityLabel(0, 240_000)).toBe('last action 4m ago')
  expect(activityLabel(undefined, 240_000)).toBe('activity unknown')
  expect(activityLabel(500_000, 240_000)).toBe('working')
  expect(activityLabel(0, 300_000, { running: true })).toBe('running')
  expect(activityLabel(0, 360_000, { running: true })).toBe('running · quiet 6m')
  const worker: Worker = { tag: 'test', name: 'Ada+test', lead: 'Ada', host: 'codex', dir: '/tmp/test', branch: 'test', task: 'test', pid: 1, startedAt: 0, status: 'running' }
  expect(workerLine({ worker, changedCount: 0, now: 360_000 })[0]).toContain('running · quiet 6m')
  expect(workerLine({ worker, changedCount: 0, now: 360_000, lastActive: 350_000 })[0]).not.toContain('quiet')
  expect(workerLine({ worker, changedCount: 0, now: 360_000, processGone: true })[0]).toContain('running (process gone)')
})

 it.each(['done', 'failed', 'dismissed'] as const)('uses completion time for %s worker activity', async status => {
  const { activityLabel } = await import('./views.js')
  expect(activityLabel(359_000, 360_000, { worker: { status, finishedAt: 0 } })).toBe('finished 6m ago')
  expect(activityLabel(359_000, 360_000, { worker: { status } })).toBe('finished 1s ago')
  expect(activityLabel(undefined, 360_000, { worker: { status } })).toBe('finished (time unknown)')
})

it.each([undefined, 'idle', 'synced'])('omits duplicate recency for status %s', status => {
  expect(personLine({ name: 'Ada', presences: [{ user: { name: 'Ada', kind: 'agent', color: '#000' }, status, lastActive: Date.now() }], changedPaths: [], messages: [], share: 'full' })).toBe('no task declared')
})
