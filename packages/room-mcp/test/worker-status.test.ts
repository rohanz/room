import { describe, expect, it } from 'vitest'
import { statusOf, realStateInput, type WorkerRecord, type Run } from '../src/worker-status.js'
import { decideRegistryCollect } from '../src/worker-state.js'

const token = { pid: 31, startTime: 'start', executable: '/bin/agent', sessionId: 's', nonce: 'n' }
const run = (launch?: Run['launch'], mode: Run['mode'] = 'fresh'): Run => ({ n: 1, mode, intentAt: 1, nonce: 'n', busFrontier: 0, promptMsgIds: [], launcher: token, logStart: 0, ...(launch ? { launch } : {}) })
const record = (phase: WorkerRecord['phase'], r: Run = run()): WorkerRecord => ({
  v: 1, id: 'w_01', tag: 'tests', name: 'lead+tests', mode: 'local', room: 'local/repo',
  lead: { participant: 'lead', room: 'local/repo', instance: token }, host: 'codex',
  budget: { threads: 1, memGb: 1, nice: 10 }, share: 'declared', task: 'tests',
  dir: '/tmp/repo/.room/workers/tests', outside: false, branch: 'room/tests', prep: { step: 'prepared' },
  capabilities: { resume: true, signal: true, collect: 'delta' }, phase, runs: [r], createdAt: 1, seq: 1,
})
const alive = () => 'alive' as const
const dead = () => 'dead' as const

describe('statusOf', () => {
  it.each([
    ['retired', 'retired'], ['abandoned', 'abandoned'], ['collecting', 'collecting'],
    ['discarding', 'collecting'], ['retiring', 'collecting'],
  ] as const)('maps phase %s', (phase, status) => expect(statusOf(record(phase), undefined, undefined, undefined, alive).status).toBe(status))

  it('keeps an absent launch ambiguous after its launcher dies', () => {
    expect(statusOf(record('prepared'), undefined, undefined, undefined, dead).status).toBe('ambiguous')
    expect(statusOf(record('prepared'), undefined, undefined, undefined, alive).status).toBe('starting')
  })

  it('handles never, imported, live, unknown and dead launches', () => {
    expect(statusOf(record('prepared', run({ outcome: 'never', error: 'ENOENT' })), undefined, undefined, undefined, dead).status).toBe('failed')
    expect(statusOf(record('active', run({ outcome: 'imported' })), undefined, undefined, undefined, dead).status).toBe('imported')
    const launched = record('active', run({ outcome: 'launched', pid: 42, process: { ...token, pid: 42 } }))
    expect(statusOf(launched, undefined, undefined, undefined, alive).status).toBe('running')
    expect(statusOf(launched, undefined, undefined, undefined, () => 'unknown').status).toBe('unknown')
    expect(statusOf(launched, undefined, undefined, undefined, dead).status).toBe('running')
    expect(statusOf(launched, undefined, undefined, undefined, alive, 61_001).note).toContain('has not joined')
  })

  it('lets a done report win over a later SIGKILL, witnessed or unwitnessed', () => {
    const r = record('active', run({ outcome: 'launched', pid: 42 }))
    const reports = [{ run: 1, nonce: 'n', chain: [], joinedAt: 2, done: { at: 3, summary: 'done', changed: [] } }]
    for (const witnessed of [true, false]) expect(statusOf(r, undefined, reports, [{ run: 1, code: null, signal: 'SIGKILL', at: 4, witnessed }], dead).status).toBe('done')
  })

  it('uses the previous done report when a resume never starts or exits without witness', () => {
    const first = run({ outcome: 'launched', pid: 42 })
    const previous = { run: 1, nonce: 'n', chain: [], joinedAt: 2, done: { at: 3, summary: 'done', changed: [] } }
    const next = { ...run({ outcome: 'never', error: 'spawn error' }, 'resume'), n: 2 }
    const r = { ...record('active', first), runs: [first, next] }
    expect(statusOf(r, undefined, [previous], undefined, dead).status).toBe('done')
    r.runs[1] = { ...next, launch: { outcome: 'launched', pid: 43 } }
    expect(statusOf(r, undefined, [previous], [{ run: 2, code: null, at: 5, witnessed: false }], dead).status).toBe('done')
  })

  it('preserves a prior done through two failed resume launches (S3)', () => {
    const first = run({ outcome: 'launched', pid: 42 })
    const failed = (n: number): Run => ({ ...run({ outcome: 'never', error: 'spawn error' }, 'resume'), n })
    const r = { ...record('active', first), runs: [first, failed(2), failed(3)] }
    const reports = [{ run: 1, nonce: 'n', chain: [], joinedAt: 2, done: { at: 3, summary: 'completed', changed: [] } }]
    expect(statusOf(r, undefined, reports, undefined, dead)).toMatchObject({ status: 'done', note: 'follow-up not delivered', summary: 'completed' })
  })

  it('classifies witnessed success without room_done, failures, stop and unwitnessed loss', () => {
    const launched = record('active', run({ outcome: 'launched', pid: 42 }))
    expect(statusOf(launched, undefined, [], [{ run: 1, code: 0, at: 5, witnessed: true }], dead).status).toBe('failed')
    expect(statusOf(launched, undefined, [], [{ run: 1, code: 137, at: 5, witnessed: true }], dead).note).toContain('137')
    expect(statusOf(launched, undefined, [], [{ run: 1, code: null, at: 5, witnessed: false }], dead).status).toBe('failed')
    launched.stop = { reason: 'lead-session-ended', at: 4, run: 1 }
    expect(statusOf(launched, undefined, [], [{ run: 1, code: null, at: 5, witnessed: false }], dead).status).toBe('stopped')
  })

  it('preserves earlier done after a witnessed successful follow-up', () => {
    const first = run({ outcome: 'launched', pid: 42 })
    const second = { ...run({ outcome: 'launched', pid: 43 }, 'resume'), n: 2 }
    const r = { ...record('active', first), runs: [first, second] }
    const reports = [{ run: 1, nonce: 'n', chain: [], joinedAt: 2, done: { at: 3, summary: 'done', changed: [] } }]
    expect(statusOf(r, undefined, reports, [{ run: 2, code: 0, at: 5, witnessed: true }], dead).status).toBe('done')
  })

  it('maps ambiguous and imported to safe legacy decision inputs', () => {
    const r = record('active', run({ outcome: 'ambiguous', at: 2 }))
    const mapped = realStateInput(r, statusOf(r, undefined, undefined, undefined, dead))
    expect(mapped.status).toBe('running')
    expect(mapped.pid).toBe(0)
    expect(mapped.hostSessionId).toBeUndefined()
    const imported = record('active', run({ outcome: 'imported' }))
    imported.capabilities.collect = 'copy'
    expect(realStateInput(imported, statusOf(imported, undefined, undefined, undefined, dead)).status).toBe('dismissed')
    expect(decideRegistryCollect(r, statusOf(r, undefined, undefined, undefined, dead), { worktree: 'present', hostSession: false,
      finished: false, status: 'running', dismissed: false }, true, true)).toBe('skip-status')
    expect(decideRegistryCollect(imported, statusOf(imported, undefined, undefined, undefined, dead), { worktree: 'present', hostSession: false,
      finished: true, status: 'dismissed', dismissed: true }, true, true)).toBe('skip-status')
    expect(decideRegistryCollect(imported, statusOf(imported, undefined, undefined, undefined, dead), { worktree: 'present', hostSession: false,
      finished: true, status: 'dismissed', dismissed: true }, true, true, 'copy')).toBe('inspect')
  })
})
