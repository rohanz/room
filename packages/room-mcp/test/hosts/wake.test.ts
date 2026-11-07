import { expect, it, vi } from 'vitest'
import { createWakeFacets } from '../../src/hosts/wake.js'
import { createMidTurnSender, createWakeSender } from '../../src/wake-path.js'

it('exposes unneeded state for the inbox host and conservative state for a failed probe', async () => {
  const probe = { state: vi.fn(async () => ({ kind: 'unknown' as const, source: 'host' as const, reason: 'status-unavailable' })), busy: vi.fn() }
  const send = vi.fn(async () => 'socket' as const)
  const facet = createWakeFacets({ send, probe })
  const target = { host: 'claude' as const, id: 'session', surface: 'interactive' as const }
  expect(await facet('claude').state(target)).toEqual({ kind: 'unneeded' })
  expect(probe.state).not.toHaveBeenCalled()
  expect(await facet('claude').send(target, 'pointer', 'idle')).toEqual({ kind: 'submitted', via: 'socket' })
  expect(await facet('codex').state({ ...target, host: 'codex' })).toEqual({ kind: 'unknown', source: 'host', reason: 'status-unavailable' })
})

it.each(['joined', 'uncertain', 'idle', 'unavailable'] as const)('normalizes %s without manufacturing acceptance', async kind => {
  const post = vi.fn(async () => kind === 'joined' ? { kind, turnId: 'turn' } : kind === 'idle' ? { kind } : { kind, reason: 'reason' })
  const queue = vi.fn(async () => {})
  const send = createWakeSender({ env: {}, notify: vi.fn(), queue })
  const facet = createWakeFacets({ send, midTurn: createMidTurnSender({ env: {}, post }) })('codex')
  const target = { host: 'codex' as const, id: 'thread', surface: 'shared-app-server' as const }
  expect(await facet.send(target, 'pointer', 'active')).toEqual(kind === 'joined' ? { kind: 'submitted', via: 'turn' }
    : kind === 'uncertain' ? { kind, via: 'turn' } : { kind })
  expect(queue).not.toHaveBeenCalled()
  expect(await facet.send(target, 'pointer', 'idle')).toEqual({ kind: 'submitted', via: 'queue' })
  expect(queue).toHaveBeenCalledOnce()
})
