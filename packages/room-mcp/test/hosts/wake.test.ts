import { expect, it, vi } from 'vitest'
import { createWakeFacets } from '../../src/hosts/wake.js'
import { createMidTurnSender } from '../../src/hosts/codex-wake.js'
import { createWakeSender } from '../../src/hosts/wake.js'

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

it('production probe reads live contact age and forwards the client version', async () => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const protocol = await import('../../src/hosts/codex-app-server.js')
  const { createProductionWakeProbe } = await import('../../src/hosts/wake.js')
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'room-probe-'))
  const status = vi.spyOn(protocol, 'readCodexThreadStatus').mockResolvedValue({ kind: 'unknown', reason: 'notLoaded' })
  vi.stubEnv('CODEX_HOME', home)
  let age: number | undefined = 0
  try {
    const probe = createProductionWakeProbe(() => age, 'test-version')
    expect(await probe.state!('thread')).toEqual({ kind: 'active', source: 'contact' })
    age = 10_000
    expect(await probe.state!('thread')).toEqual({ kind: 'unknown', source: 'legacy', reason: 'no-turn-evidence' })
    age = undefined
    expect(await probe.busy('thread')).toBe(true)
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread', clientVersion: 'test-version' }))
  } finally { status.mockRestore(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }) }
})
