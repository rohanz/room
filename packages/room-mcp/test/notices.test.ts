import { publishFixture } from './fixtures/manifest.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, formatMsg, type ClaimMsg, type PlanMsg, type WorkerStatus, type WorkerView } from '@room/shared'
import { Rooms } from '../src/registry.js'
import { Ledger } from '../src/ledger.js'
import type { Session } from '../src/session.js'
import type { HandlerState } from '../src/tools/context.js'
import type { LocalWorker } from '../src/worker-status.js'
import { handlers } from '../src/tools/messaging.js'
import { createClaims, releaseClaimsOnDone } from '../src/tools/claims.js'
import { hubAppend } from '@room/shared/testing'
import { hubSeam } from './fixtures/hub.js'

/** No release notices to send here. */
const ignore = () => {}

const close: (() => void)[] = []
afterEach(() => { close.splice(0).forEach(f => f()); vi.useRealTimers() })
const clock = 600_000
const worker = (patch: Partial<LocalWorker> = {}): LocalWorker => ({
  id: `w_${patch.tag ?? 'state'}`, tag: 'state', name: 'lead+state', host: 'codex', task: 'fix state', dir: '/tmp/state', branch: 'room/state',
  pid: 123, startedAt: 1, status: 'done', finishedAt: clock - 180_000, summary: 'Fixed state.\nTests passed.', lead: 'lead', exitCode: 0,
  budget: { threads: 1, memGb: 1, nice: 10 }, share: 'full', ...patch,
})
const viewStatus: Record<LocalWorker['status'], WorkerStatus> = { running: 'running', done: 'done', failed: 'failed', dismissed: 'stopped' }
/** The room's view of a worker, as its lead's projector writes it. */
const viewOf = (w: LocalWorker): WorkerView => ({
  id: w.id, tag: w.tag, name: w.name, lead: w.lead, mode: 'local', host: w.host, task: w.task, branch: w.branch,
  status: viewStatus[w.status], run: 1, startedAt: w.startedAt, fence: '1',
  ...(w.summary !== undefined ? { summary: w.summary } : {}), ...(w.finishedAt !== undefined ? { finishedAt: w.finishedAt } : {}),
  ...(w.exitCode !== undefined ? { exitCode: w.exitCode } : {}),
})

function fixture() {
  const sessions: Session[] = []
  /** Each session's own workers, as the lead's registry lists them. */
  const own = new Map<Session, LocalWorker[]>()
  /** Another lead's worker is only a view; the lead's own worker is also in its registry. */
  const addWorker = (x: Session, w: LocalWorker) => {
    if (w.lead === x.me.name) own.set(x, [...(own.get(x) ?? []).filter(o => o.id !== w.id), w])
    if (!x.room.participants.has(`${w.lead}\u0000holder`)) x.room.participants.set(`${w.lead}\u0000holder`, { sessionId: 'test', epoch: 1, pid: 1, startTime: 't', executable: 'e', at: clock })
    x.room.workerViews.set(w.id, viewOf(w))
  }
  const retire = (x: Session, w: LocalWorker, archive: { summary: string; outcome: 'merged' | 'clean' }) => {
    own.set(x, (own.get(x) ?? []).filter(o => o.id !== w.id))
    x.room.retireWorker(w.id, { id: w.id, name: w.name, tag: w.tag, lead: w.lead, host: w.host, task: w.task, startedAt: w.startedAt,
      finishedAt: w.finishedAt!, retiredAt: clock, files: [], fileCount: 0, ...archive }, ignore)
  }
  const makeSession = (roomName: string) => {
    const room = new RoomDoc(), awareness = new Awareness(room.doc)
    awareness.setLocalState({ user: { name: 'lead', kind: 'agent' } })
    const s = { room, awareness, roomName, me: { name: 'lead', kind: 'agent' }, local: true,
      ...hubSeam(room), provider: { synced: true }, daemon: { touch: vi.fn() } } as unknown as Session
    sessions.push(s)
    return s
  }
  const s = makeSession('primary')
  const rooms = new Rooms({ primary: () => s, setPrimary() {}, attach: () => ({ stop() {} }) })
  const state = {
    S: () => s, rooms, now: () => clock, myWorkers: (x: Session) => own.get(x) ?? [],
    workerAlive: vi.fn(() => false), presences: vi.fn((x: Session) => Array.from(x.awareness.getStates().values())),
    upgrade: async () => [], setPresence: vi.fn(), forMe: () => false, scheduleInboxWrite: vi.fn(),
    ledger: new Ledger({ sessionId: () => 'test-session', route: () => ({}) }),
  } as unknown as HandlerState
  close.push(() => sessions.forEach(x => { rooms.remove(x); x.awareness.destroy(); x.room.doc.destroy() }))
  return { s, rooms, state, makeSession, addWorker, retire, tools: handlers(state) }
}

describe('unavailable addressed recipients', () => {
  it('M12 treats a remote terminal view from an old lead fence as stale', async () => {
    const { s, addWorker, tools } = fixture()
    const remote = worker({ name: 'other+state', lead: 'other', summary: 'old completion' })
    addWorker(s, remote)
    s.room.participants.set('other\u0000holder', { sessionId: 'new-lead', epoch: 2, pid: 1, startTime: 't', executable: 'e', at: clock })
    const sent = await tools.room_send({ type: 'question', to: remote.name, text: 'Current status?' })
    expect(sent).toContain('stale')
    expect(sent).not.toContain('old completion')
    expect(sent).toContain('questionId=')
  })
  it('records questions to another lead\'s exited worker, and send and wait return the same one-line notice', async () => {
    const { s, addWorker, tools } = fixture()
    addWorker(s, worker({ lead: 'other' }))
    const sent = await tools.room_send({ type: 'question', to: 'lead+state', text: 'Can you review?' })
    const question = s.room.messages().find(m => m.type === 'question')!
    const notice = 'lead+state finished 3m ago and will not answer; its summary: Fixed state. Tests passed.'
    expect(sent).toContain(notice)
    expect(sent).not.toContain('to block for the answer')
    expect(await tools.room_wait({ questionId: question.id })).toBe(notice)
  })

  it('routes retired worker questions to the workers room and reads the archive', async () => {
    const { rooms, makeSession, addWorker, retire, tools } = fixture()
    const ws = makeSession('workers'); rooms.add(ws, 'workers')
    const w = worker()
    addWorker(ws, w)
    retire(ws, w, { summary: 'Archived fix', outcome: 'merged' })
    const sent = await tools.room_send({ type: 'question', to: w.name, text: 'More?' })
    expect(sent).toBe('error: lead+state was collected or discarded and cannot be resumed')
    expect(ws.room.messages().some(m => m.type === 'question')).toBe(false)
  })

  it.each(['question', 'note', 'changed', 'answer'])('rejects an unknown addressee before posting %s', async type => {
    const { s, tools } = fixture()
    const sent = await tools.room_send({ type, to: 'nobody', text: 'hello', paths: ['a.ts'], inReplyTo: 'old' })
    if (type === 'answer') expect(sent).toContain('invalid inReplyTo old; no unanswered questions addressed to you')
    else expect(sent).toContain('nobody called nobody is or was in this room; participants: lead')
    expect(s.room.messages()).toEqual([])
  })

  it('resolves a unique bare tag to the sender\'s worker, including the workers room', async () => {
    const { s, rooms, makeSession, addWorker, state, tools } = fixture()
    const ws = makeSession('workers'); rooms.add(ws, 'workers')
    addWorker(ws, worker({ status: 'running', exitCode: undefined, finishedAt: undefined }))
    vi.mocked(state.workerAlive).mockReturnValue(true)
    const sent = await tools.room_send({ type: 'question', to: 'state', text: 'Ready?' })
    expect(sent).toContain('(in the workers room)')
    expect(ws.room.messages().at(-1)).toMatchObject({ type: 'question', to: 'lead+state' })
    expect(s.room.messages()).toEqual([])
  })

  it('accepts a note reply addressed by the sender worker tag', async () => {
    const { rooms, makeSession, addWorker, state, tools } = fixture()
    const ws = makeSession('workers'); rooms.add(ws, 'workers')
    addWorker(ws, worker({ status: 'running', exitCode: undefined, finishedAt: undefined }))
    vi.mocked(state.workerAlive).mockReturnValue(true)
    const note = hubAppend(ws.room, { name: 'lead+state', kind: 'agent' }, { type: 'note', to: 'lead', text: 'Update?' })
    const reply = await tools.room_send({ type: 'note', to: 'state', inReplyTo: note.id, text: 'On it' })
    expect(reply).not.toMatch(/^error:/)
    expect(ws.room.messages().at(-1)).toMatchObject({ type: 'note', to: 'lead+state', inReplyTo: note.id, text: 'On it' })
  })

  it('rejects an ambiguous bare worker tag before posting and lists the full name', async () => {
    const { s, rooms, makeSession, addWorker, tools } = fixture()
    const ws = makeSession('workers'); rooms.add(ws, 'workers')
    addWorker(s, worker({ status: 'running', exitCode: undefined, finishedAt: undefined }))
    addWorker(ws, worker({ status: 'running', exitCode: undefined, finishedAt: undefined }))
    const sent = await tools.room_send({ type: 'note', to: 'state', text: 'Ready?' })
    expect(sent).toBe('error: worker tag state is ambiguous; use a full name: lead+state')
    expect(s.room.messages()).toEqual([])
    expect(ws.room.messages()).toEqual([])
  })

  it('preserves the timeout for an offline teammate and infers the recipient of an answer', async () => {
    vi.useFakeTimers()
    const { s, tools } = fixture()
    publishFixture(s.room, 'Ada', 'a.ts', 'work')
    expect(await tools.room_send({ type: 'question', to: 'Ada', text: 'Review?' })).toContain('Ada is offline; it will see this when it returns')
    const waiting = tools.room_wait({ questionId: s.room.messages().at(-1)!.id, timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    expect(await waiting).toContain('timeout after 10ms')
    const original = hubAppend(s.room, { name: 'Ada', kind: 'agent' }, { type: 'question', to: 'lead', text: 'why?' })
    expect(await tools.room_send({ type: 'answer', inReplyTo: original.id, text: 'because' })).toContain('Ada is offline')
  })

  it('allows questions to a running worker whose process still lives, including a reused archived name', async () => {
    const { s, state, addWorker, retire, tools } = fixture()
    const old = worker({ id: 'w_old' })
    addWorker(s, old)
    retire(s, old, { summary: 'old', outcome: 'clean' })
    addWorker(s, worker({ id: 'w_new', status: 'running', startedAt: clock, exitCode: undefined }))
    vi.mocked(state.workerAlive).mockReturnValue(true)
    expect(await tools.room_send({ type: 'question', to: old.name, text: 'follow-up' })).toContain('to block for the answer')
  })

  // Another lead's worker is known only by its view: its process shows as its presence, its status in the view's vocabulary.
  it.each([['done', 'done'], ['failed', 'failed'], ['dismissed', 'stopped']] as const)('returns immediately for a %s worker whose process still lives', async (status, shown) => {
    vi.useFakeTimers()
    const { s, state, addWorker, tools } = fixture()
    addWorker(s, worker({ lead: 'other', status, exitCode: undefined, finishedAt: clock }))
    vi.mocked(state.workerAlive).mockReturnValue(true)
    const presences = vi.mocked(state.presences as (x: Session) => unknown[])
    presences.mockImplementation(x => [...Array.from(x.awareness.getStates().values()), { user: { name: 'lead+state', kind: 'agent' } }])
    const sent = await tools.room_send({ type: 'question', to: 'lead+state', text: 'More?' })
    const notice = 'lead+state reported ' + shown + ' 0m ago and will not answer; its summary: Fixed state. Tests passed.'
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
    const { s, addWorker, tools } = fixture()
    addWorker(s, worker({ status: 'running', exitCode: undefined, finishedAt: undefined, summary: undefined }))
    expect(await tools.room_send({ type: 'note', to: 'lead+state', text: 'Review?' })).toContain('lead+state finished and will not answer; its summary: no summary recorded')
  })

  it('ends an active question wait as soon as the recipient exits and removes its observer', async () => {
    const { s, state, addWorker, tools } = fixture()
    addWorker(s, worker({ status: 'running', exitCode: undefined }))
    vi.mocked(state.workerAlive).mockReturnValue(true)
    await tools.room_send({ type: 'question', to: 'lead+state', text: 'Review?' })
    const off = vi.spyOn(s.room.doc, 'off')
    const waiting = tools.room_wait({ questionId: s.room.messages().at(-1)!.id })
    // The registry records the exit and the projector rewrites the view.
    addWorker(s, worker({ status: 'failed', exitCode: 1, summary: 'crashed' }))
    expect(await waiting).toContain('will not answer; its summary: crashed')
    expect(off).toHaveBeenCalledWith('update', expect.any(Function))
  })

  it('prefers an already recorded answer over the later exit', async () => {
    const { s, addWorker, tools } = fixture()
    addWorker(s, worker({ lead: 'other' }))
    await tools.room_send({ type: 'question', to: 'lead+state', text: 'Review?' })
    const q = s.room.messages().at(-1)!
    hubAppend(s.room, { name: 'lead+state', kind: 'agent' }, { type: 'answer', inReplyTo: q.id, to: 'lead', text: 'Reviewed' })
    expect(await tools.room_wait({ questionId: q.id })).toContain('answered:')
  })
})

describe('finishing claim notices', () => {
  it('keeps full summaries out of releases and plans while preserving mirrors and other owners', async () => {
    const { s } = fixture()
    s.room.setScope({ by: 'lead', byKind: 'agent', area: 'fix', summary: 'task', paths: ['a.ts'] })
    const plan = { kind: 'add' as const, symbol: 'helper' }
    const c = s.room.addClaim({ by: 'lead', byKind: 'agent', path: 'a.ts', from: 1, to: 2, intent: 'add helper', plans: [plan] })
    const msg = hubAppend<ClaimMsg>(s.room, s.me, { type: 'claim', claimId: c.id, path: c.path, from_line: 1, to_line: 2, intent: c.intent, plans: c.plans })
    s.room.setClaimMsg(c.id, msg.id); s.room.markSeen('Ada', [msg.id], { s: 'other-session', via: 'reply' })
    const kept = s.room.addClaim({ by: 'lead', byKind: 'agent', path: 'b.ts', from: 1, to: 2, intent: 'mirror', mirrorOf: 'running' })
    const other = s.room.addClaim({ by: 'Ada', byKind: 'agent', path: 'c.ts', from: 1, to: 2, intent: 'other' })
    expect(releaseClaimsOnDone(s, claim => claim.mirrorOf === 'running')).toBe(1)
    expect(s.room.openClaims().map(c => c.id)).toEqual([kept.id, other.id])
    expect(s.room.scope('lead')).toBeUndefined()
    const releases = s.room.messages().filter(m => m.type === 'release')
    expect(releases).toHaveLength(0)
    const plans = s.room.messages().filter((m): m is PlanMsg => m.type === 'plan')
    expect(plans).toHaveLength(0)
    await vi.waitFor(() => expect(s.room.messages().filter(m => m.type === 'note')).toMatchObject([{ priority: 'fyi', text: 'lead released 1 claim(s); ended 1 plan(s)' }]))
  })

  it('keeps explicit plan cancellations as interrupts with their explanation', async () => {
    const { s, state } = fixture()
    state.planChanged = createClaims({ log: vi.fn(), ctx: state.ctx }).planChanged
    const c = s.room.addClaim({ by: 'lead', byKind: 'agent', path: 'a.ts', from: 1, to: 1, intent: 'fix' })
    const shown = hubAppend(s.room, s.me, { type: 'claim', claimId: c.id, path: c.path, from_line: 1, to_line: 1, intent: 'fix' })
    s.room.setClaimMsg(c.id, shown.id)
    s.room.markSeen('kieran', [shown.id], { s: 'other-session', via: 'reply' })
    state.planChanged(s, { ...c, msgId: shown.id }, { kind: 'add', symbol: 'helper' }, 'cancelled', 'changed direction')
    // the feed entry is fyi; whoever was shown the plan gets the interrupt
    await vi.waitFor(() => expect(s.room.messages().find(m => m.type === 'plan' && m.to === 'kieran')).toMatchObject({ priority: 'interrupt', text: 'changed direction' }))
  })
})

 it('keeps a lead waiting quietly while workers run', async () => {
   vi.useFakeTimers()
   const { s, addWorker, tools } = fixture()
   for (const tag of ['a', 'b', 'c']) addWorker(s, worker({ tag, name: 'lead+' + tag, status: 'running', exitCode: undefined }))
   const waiting = tools.room_wait({ timeoutMs: 10 })
   await vi.advanceTimersByTimeAsync(10)
   expect(await waiting).toContain('nothing yet; 3 workers still running (a, b, c); nothing needs you')
 })

 it('releases another worker selectively while preserving its scope and other owners', async () => {
   const { s } = fixture()
   s.room.setScope({ by: 'lead+state', byKind: 'agent', area: 'fix', summary: 'task', paths: ['src/'] })
   const add = (by: string, path: string) => s.room.addClaim({ by, byKind: 'agent', path, from: 1, to: 1, intent: 'fix', plans: [{ kind: 'add', symbol: 'helper' }] })
   add('lead+state', 'src/a.ts'); const keep = add('lead+state', 'src/b.ts'); const other = add('Ada', 'src/a.ts')
   expect(releaseClaimsOnDone(s, c => c.path !== 'src/a.ts', 'lead+state', false)).toBe(1)
   expect(s.room.openClaims().map(c => c.id)).toEqual([keep.id, other.id])
   expect(s.room.scope('lead+state')).toBeDefined()
   await vi.waitFor(() => expect(s.room.messages()).toMatchObject([{ type: 'note', priority: 'fyi' }]))
   expect(releaseClaimsOnDone(s, undefined, 'lead+state')).toBe(1)
   expect(s.room.scope('lead+state')).toBeUndefined()
 })
