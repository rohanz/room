import { afterEach, describe, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, formatMsg, type ClaimMsg, type PlanMsg, type Worker } from '@room/shared'
import { Rooms } from '../src/registry.js'
import type { Session } from '../src/session.js'
import type { HandlerState } from '../src/tools/context.js'
import { handlers } from '../src/tools/messaging.js'
import { install, releaseClaimsOnDone } from '../src/tools/claims.js'

const close: (() => void)[] = []
afterEach(() => { close.splice(0).forEach(f => f()); vi.useRealTimers() })
const clock = 600_000
const worker = (patch: Partial<Worker> = {}): Worker => ({
  tag: 'state', name: 'lead+state', host: 'codex', task: 'fix state', dir: '/tmp/state', branch: 'room/state',
  pid: 123, startedAt: 1, status: 'done', finishedAt: clock - 180_000, summary: 'Fixed state.\nTests passed.', lead: 'lead', exitCode: 0, ...patch,
})

function fixture() {
  const sessions: Session[] = []
  const makeSession = (roomName: string) => {
    const room = new RoomDoc(), awareness = new Awareness(room.doc)
    awareness.setLocalState({ user: { name: 'lead', kind: 'agent' } })
    const s = { room, awareness, roomName, me: { name: 'lead', kind: 'agent' }, local: true,
      provider: { synced: true }, daemon: { touch: vi.fn() } } as unknown as Session
    sessions.push(s)
    return s
  }
  const s = makeSession('primary')
  const rooms = new Rooms({ primary: () => s, setPrimary() {}, observeClaims() {}, attach: () => ({ stop() {} }) })
  const state = {
    S: () => s, rooms, now: () => clock, myWorkers: (x: Session) => Array.from(x.room.workers.values()),
    workerAlive: vi.fn(() => false), presences: (x: Session) => Array.from(x.awareness.getStates().values()),
    upgrade: async () => [], setPresence: vi.fn(), forMe: () => false, seen: new Set<string>(),
  } as unknown as HandlerState
  close.push(() => sessions.forEach(x => { rooms.remove(x); x.awareness.destroy(); x.room.doc.destroy() }))
  return { s, rooms, state, makeSession, tools: handlers(state) }
}

describe('unavailable addressed recipients', () => {
  it('records questions to exited workers, and send and wait return the same one-line notice', async () => {
    const { s, tools } = fixture()
    s.room.setWorker(worker())
    const sent = await tools.room_send({ type: 'question', to: 'lead+state', text: 'Can you review?' })
    const question = s.room.messages().find(m => m.type === 'question')!
    const notice = 'lead+state finished 3m ago and will not answer; its summary: Fixed state. Tests passed.'
    expect(sent).toContain(notice)
    expect(sent).not.toContain('to block for the answer')
    expect(await tools.room_wait({ questionId: question.id })).toBe(notice)
  })

  it('routes retired worker questions to the workers room and reads the archive', async () => {
    const { rooms, makeSession, tools } = fixture()
    const ws = makeSession('workers'); rooms.add(ws, 'workers')
    const w = worker()
    ws.room.setWorker(w)
    ws.room.retireParticipant(w.name, { ...w, summary: 'Archived fix', finishedAt: w.finishedAt!, retiredAt: clock, files: [], fileCount: 0, outcome: 'merged' })
    const sent = await tools.room_send({ type: 'question', to: w.name, text: 'More?' })
    const question = ws.room.messages().find(m => m.type === 'question')!
    expect(sent).toContain('(in the workers room)')
    expect(await tools.room_wait({ questionId: question.id })).toBe('lead+state finished 3m ago and will not answer; its summary: Archived fix')
  })

  it.each(['question', 'note', 'changed', 'answer'])('reports an unknown addressee for %s without dropping history', async type => {
    const { s, tools } = fixture()
    const sent = await tools.room_send({ type, to: 'nobody', text: 'hello', paths: ['a.ts'], inReplyTo: 'old' })
    expect(sent).toContain('nobody called nobody is or was in this room; participants: lead')
    expect(s.room.messages().at(-1)).toMatchObject({ type, to: 'nobody' })
    if (type === 'question') expect(await tools.room_wait({ questionId: s.room.messages().at(-1)!.id })).toContain('nobody called nobody')
  })

  it('preserves the timeout for an offline teammate and infers the recipient of an answer', async () => {
    vi.useFakeTimers()
    const { s, tools } = fixture()
    s.room.setOverlay('Ada', 'a.ts', 'work')
    expect(await tools.room_send({ type: 'question', to: 'Ada', text: 'Review?' })).toContain('Ada is offline; it will see this when it returns')
    const waiting = tools.room_wait({ questionId: s.room.messages().at(-1)!.id, timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    expect(await waiting).toContain('timeout after 10ms')
    const original = s.room.post({ name: 'Ada', kind: 'agent' }, { type: 'question', to: 'lead', text: 'why?' })
    expect(await tools.room_send({ type: 'answer', inReplyTo: original.id, text: 'because' })).toContain('Ada is offline')
  })

  it('allows questions to a running worker whose process still lives, including a reused archived name', async () => {
    const { s, state, tools } = fixture()
    const old = worker()
    s.room.setWorker(old)
    s.room.retireParticipant(old.name, { ...old, summary: 'old', finishedAt: old.finishedAt!, retiredAt: clock, files: [], fileCount: 0, outcome: 'clean' })
    s.room.setWorker(worker({ status: 'running', startedAt: clock, exitCode: undefined }))
    vi.mocked(state.workerAlive).mockReturnValue(true)
    expect(await tools.room_send({ type: 'question', to: old.name, text: 'follow-up' })).toContain('to block for the answer')
  })

  it.each(['done', 'failed', 'dismissed'] as const)('returns immediately for a %s worker whose process still lives', async status => {
    vi.useFakeTimers()
    const { s, state, tools } = fixture()
    s.room.setWorker(worker({ status, exitCode: undefined, finishedAt: clock }))
    vi.mocked(state.workerAlive).mockReturnValue(true)
    const sent = await tools.room_send({ type: 'question', to: 'lead+state', text: 'More?' })
    const notice = 'lead+state reported ' + status + ' 0m ago and will not answer; its summary: Fixed state. Tests passed.'
    expect(sent).toContain(notice)
    expect(sent).not.toContain('to block for the answer')
    expect(await tools.room_wait({ questionId: s.room.messages().at(-1)!.id })).toBe(notice)
    expect(state.setPresence).not.toHaveBeenCalled()
  })

  it('recognizes offline teammates from retained membership even without current edits or messages', async () => {
    const { s, tools } = fixture()
    s.room.colors.set('Ada', 0)
    expect(await tools.room_send({ type: 'note', to: 'Ada', text: 'Review later' })).toContain('Ada is offline; it will see this when it returns')
  })

  it('detects a gone local worker before its exit callback updates the record', async () => {
    const { s, tools } = fixture()
    s.room.setWorker(worker({ status: 'running', exitCode: undefined, finishedAt: undefined, summary: undefined }))
    expect(await tools.room_send({ type: 'note', to: 'lead+state', text: 'Review?' })).toContain('lead+state finished and will not answer; its summary: no summary recorded')
  })

  it('ends an active question wait as soon as the recipient exits and removes its observer', async () => {
    const { s, state, tools } = fixture()
    s.room.setWorker(worker({ status: 'running', exitCode: undefined }))
    vi.mocked(state.workerAlive).mockReturnValue(true)
    await tools.room_send({ type: 'question', to: 'lead+state', text: 'Review?' })
    const off = vi.spyOn(s.room.doc, 'off')
    const waiting = tools.room_wait({ questionId: s.room.messages().at(-1)!.id })
    s.room.updateWorker('state', { exitCode: 1, status: 'failed', summary: 'crashed' })
    expect(await waiting).toContain('will not answer; its summary: crashed')
    expect(off).toHaveBeenCalledWith('update', expect.any(Function))
  })

  it('prefers an already recorded answer over the later exit', async () => {
    const { s, tools } = fixture()
    s.room.setWorker(worker())
    await tools.room_send({ type: 'question', to: 'lead+state', text: 'Review?' })
    const q = s.room.messages().at(-1)!
    s.room.post({ name: 'lead+state', kind: 'agent' }, { type: 'answer', inReplyTo: q.id, to: 'lead', text: 'Reviewed' })
    expect(await tools.room_wait({ questionId: q.id })).toContain('answered:')
  })
})

describe('finishing claim notices', () => {
  it('keeps full summaries out of releases and plans while preserving mirrors and other owners', () => {
    const { s } = fixture()
    s.room.setScope({ by: 'lead', byKind: 'agent', area: 'fix', summary: 'task', paths: ['a.ts'] })
    const plan = { kind: 'add' as const, symbol: 'helper' }
    const c = s.room.addClaim({ by: 'lead', byKind: 'agent', path: 'a.ts', from: 1, to: 2, intent: 'add helper', plans: [plan] })
    const msg = s.room.post<ClaimMsg>(s.me, { type: 'claim', claimId: c.id, path: c.path, from_line: 1, to_line: 2, intent: c.intent, plans: c.plans })
    s.room.setClaimMsg(c.id, msg.id); s.room.markSeen('Ada', [msg.id])
    const kept = s.room.addClaim({ by: 'lead', byKind: 'agent', path: 'b.ts', from: 1, to: 2, intent: 'mirror', mirrorOf: 'running' })
    const other = s.room.addClaim({ by: 'Ada', byKind: 'agent', path: 'c.ts', from: 1, to: 2, intent: 'other' })
    expect(releaseClaimsOnDone(s, claim => claim.mirrorOf === 'running')).toBe(1)
    expect(s.room.openClaims().map(c => c.id)).toEqual([kept.id, other.id])
    expect(s.room.scope('lead')).toBeUndefined()
    const releases = s.room.messages().filter(m => m.type === 'release')
    expect(releases).toHaveLength(0)
    const plans = s.room.messages().filter((m): m is PlanMsg => m.type === 'plan')
    expect(plans).toHaveLength(0)
    expect(s.room.messages().filter(m => m.type === 'note')).toMatchObject([{ priority: 'fyi', text: 'lead released 1 claim(s); ended 1 plan(s)' }])
  })

  it('keeps explicit plan cancellations as interrupts with their explanation', () => {
    const { s, state } = fixture()
    install(state)
    const c = s.room.addClaim({ by: 'lead', byKind: 'agent', path: 'a.ts', from: 1, to: 1, intent: 'fix' })
    state.planChanged(s, c, { kind: 'add', symbol: 'helper' }, 'cancelled', 'changed direction')
    expect(s.room.messages().at(-1)).toMatchObject({ priority: 'interrupt', text: 'changed direction' })
  })
})

 it('keeps a lead waiting quietly while workers run', async () => {
   vi.useFakeTimers()
   const { s, tools } = fixture()
   for (const tag of ['a', 'b', 'c']) s.room.setWorker(worker({ tag, name: 'lead+' + tag, status: 'running', exitCode: undefined }))
   const waiting = tools.room_wait({ timeoutMs: 10 })
   await vi.advanceTimersByTimeAsync(10)
   expect(await waiting).toContain('nothing yet; 3 workers still running (a, b, c); nothing needs you')
 })

 it('releases another worker selectively while preserving its scope and other owners', () => {
   const { s } = fixture()
   s.room.setScope({ by: 'lead+state', byKind: 'agent', area: 'fix', summary: 'task', paths: ['src/'] })
   const add = (by: string, path: string) => s.room.addClaim({ by, byKind: 'agent', path, from: 1, to: 1, intent: 'fix', plans: [{ kind: 'add', symbol: 'helper' }] })
   add('lead+state', 'src/a.ts'); const keep = add('lead+state', 'src/b.ts'); const other = add('Ada', 'src/a.ts')
   expect(releaseClaimsOnDone(s, c => c.path !== 'src/a.ts', 'lead+state', false)).toBe(1)
   expect(s.room.openClaims().map(c => c.id)).toEqual([keep.id, other.id])
   expect(s.room.scope('lead+state')).toBeDefined()
   expect(s.room.messages()).toMatchObject([{ type: 'note', priority: 'fyi' }])
   expect(releaseClaimsOnDone(s, undefined, 'lead+state')).toBe(1)
   expect(s.room.scope('lead+state')).toBeUndefined()
 })
