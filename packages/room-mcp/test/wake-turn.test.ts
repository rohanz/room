import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { RoomDoc, claimReleaseText, type NoteMsg, type PushedMsg } from '@room/shared'
import { manifestKey } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { Ledger } from '../src/ledger.js'
import { createRelevance } from '../src/relevance.js'
import type { WakeReconcilerOptions } from '../src/wake-reconciler.js'
import { createMidTurnSender, createWakeSender } from '../src/wake-path.js'
import { WakeReconciler } from '../src/wake-reconciler.js'
import { CodexTurnProbe } from '../src/codex-turn.js'
import { formatDeliveryHealth } from '../src/doctor.js'
import type { Session } from '../src/session.js'
import { hubSeam } from './fixtures/hub.js'
import { visiblePeer } from './fixtures/visible.js'

const dirs: string[] = []
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function rig(started: boolean, options: Partial<WakeReconcilerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'room-wake-turn-'))
  dirs.push(dir)
  const home = join(dir, 'codex')
  vi.stubEnv('CODEX_HOME', home)
  const id = '019a0000-0000-7000-8000-123456789abc'
  const rollout = join(home, 'sessions', '2026', '09', '30', `rollout-test-${id}.jsonl`)
  mkdirSync(join(home, 'sessions', '2026', '09', '30'), { recursive: true })
  const event = (type: string) => appendFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type } }) + '\n')
  if (started) event('task_started')
  else event('task_complete')
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial'])
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const room = new RoomDoc(), awareness = new Awareness(room.doc)
  const s = { room, awareness, me: { name: 'Pat', kind: 'agent' }, dir, roomName: 'r',
    ...hubSeam(room) } as unknown as Session
  const ledger = new Ledger({ sessionId: () => id, route: () => ({}), relevant: createRelevance() })
  ledger.bind(s)
  const texts: string[] = []
  const log: string[] = []
  const wakes = new WakeReconciler({ ledger, bound: () => ({ id, host: 'codex' }), sessionDir: () => undefined,
    send: async (_target, text) => { texts.push(text); return 'queue' }, log: line => log.push(line), busyPollMs: 20, pollMs: 20, windowMs: 0, ...options })
  wakes.attach(s)
  const note = () => hubAppend<NoteMsg>(room, { name: 'Ana', kind: 'agent' }, { type: 'note', to: 'Pat', text: 'please check' })
  const close = () => { wakes.stop(); awareness.destroy(); room.doc.destroy() }
  return { s, ledger, wakes, texts, log, note, event, close, head, room, id, rollout, dir }
}

function appendItems(rollout: string, count = 1_300) {
  appendFileSync(rollout, Array.from({ length: count }, (_, n) => JSON.stringify({
    type: 'response_item', payload: { n, text: 'x'.repeat(1_000) },
  }) + '\n').join(''))
}

it('queues a standalone idle thread when the daemon explicitly reports it not loaded', async () => {
  const r = rig(false, { codexTurn: new CodexTurnProbe({ status: async () => ({ kind: 'unknown', reason: 'notLoaded' }) }) })
  try {
    r.note()
    await vi.waitFor(() => expect(r.texts).toHaveLength(1))
    expect(r.wakes.health().state).toMatchObject({ kind: 'idle', source: 'legacy' })
  } finally { r.close() }
})

it('does not retry uncertain mid-turn submissions or count them as confirmed wakes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const post = vi.fn(async () => ({ kind: 'uncertain' as const, reason: 'connection lost after submit' }))
  const r = rig(true, { midTurn: createMidTurnSender({ env: {}, post }) })
  try {
    r.note()
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(100)
    expect(post).toHaveBeenCalledOnce()
    expect(r.wakes.health()).toMatchObject({ handedToHost: 0, wakeRecorded: 0, uncertainWakeRecorded: 1,
      attempt: { outcome: 'uncertain' } })
    r.event('task_complete')
    await vi.waitFor(() => expect(r.texts).toHaveLength(1))
  } finally { r.close() }
})

it('treats active-to-idle between probes as a normal race with no degraded notice', async () => {
  let active = true
  const post = vi.fn(async () => { active = false; return { kind: 'idle' as const } })
  const r = rig(true, { codexTurn: { busy: async () => active }, midTurn: createMidTurnSender({ env: {}, post }) })
  try {
    r.note()
    await vi.waitFor(() => expect(r.texts).toHaveLength(1))
    expect(post).toHaveBeenCalledOnce()
    expect(r.ledger.noticeCount()).toBe(0)
    expect(r.wakes.health().degraded).toBeUndefined()
  } finally { r.close() }
})

it('backs off unknown host probes even when unrelated document changes reconcile', async () => {
  vi.useFakeTimers()
  const state = vi.fn(async () => ({ kind: 'unknown' as const, source: 'host' as const, reason: 'status-unavailable' }))
  const r = rig(false, { codexTurn: { state, busy: async () => true } })
  try {
    r.note()
    await vi.advanceTimersByTimeAsync(0)
    expect(state).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(state).toHaveBeenCalledTimes(2)
    r.note(); r.wakes.reconcile()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(state).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(state).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(state).toHaveBeenCalledTimes(3)
    expect(r.texts).toHaveLength(0)
  } finally { r.close() }
})

it('offers a bounded notice for a new degradation reason and withdraws it on recovery', async () => {
  vi.useFakeTimers()
  let result: 'unavailable' | 'throw' | 'joined' = 'unavailable'
  const post = vi.fn(async () => {
    if (result === 'throw') throw new Error('private host error')
    return result === 'joined' ? { kind: 'joined' as const, turnId: 'turn' } : { kind: 'unavailable' as const, reason: 'private error' }
  })
  const r = rig(true, { codexTurn: { busy: async () => true }, midTurn: createMidTurnSender({ env: {}, post }), busyPollMs: 1000 })
  try {
    r.note()
    await vi.advanceTimersByTimeAsync(0)
    const first = r.ledger.open('reply')
    expect(r.ledger.notices(first).map(n => n.text).join()).toContain('transport-unavailable')
    r.ledger.commit(first)
    result = 'throw'
    await vi.advanceTimersByTimeAsync(1000)
    const second = r.ledger.open('reply')
    expect(r.ledger.notices(second).map(n => n.text).join()).toContain('transport-failed')
    r.ledger.release(second)
    result = 'joined'
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.ledger.noticeCount()).toBe(0)
    expect(r.wakes.degradation()).toBeUndefined()
  } finally { r.close() }
})

it('finds task_started in a cold rollout larger than the unread window', async () => {
  const r = rig(true)
  try {
    appendItems(r.rollout)
    const probe = new CodexTurnProbe({ contactAgeMs: () => 20_000 })
    expect(await probe.busy(r.id)).toBe(true)
  } finally { r.close() }
})

it('finds task_started after a warm task_complete despite a large append', async () => {
  const r = rig(false)
  try {
    r.event('task_complete')
    const probe = new CodexTurnProbe({ contactAgeMs: () => 20_000 })
    expect(await probe.busy(r.id)).toBe(false)
    r.event('task_started')
    appendItems(r.rollout)
    expect(await probe.busy(r.id)).toBe(true)
  } finally { r.close() }
})

it('finds task_complete after a warm task_started despite a large append', async () => {
  const r = rig(true)
  try {
    const probe = new CodexTurnProbe({ contactAgeMs: () => 20_000 })
    expect(await probe.busy(r.id)).toBe(true)
    r.event('task_complete')
    appendItems(r.rollout)
    expect(await probe.busy(r.id)).toBe(false)
  } finally { r.close() }
})

it('stays busy while the backward scan budget is exhausted, then resolves', async () => {
  const r = rig(false)
  try {
    r.event('task_complete')
    appendItems(r.rollout, 9_000)
    const probe = new CodexTurnProbe({ contactAgeMs: () => 20_000 })
    expect(await probe.busy(r.id)).toBe(true)
    expect(await probe.busy(r.id)).toBe(false)
  } finally { r.close() }
})

it('keeps unavailable state conservative even after the last Room contact ages out', async () => {
  const r = rig(false)
  try {
    rmSync(r.rollout)
    let age = 3_000
    const probe = new CodexTurnProbe({ contactAgeMs: () => age })
    expect(await probe.busy(r.id)).toBe(true)
    age = 11_000
    expect(await probe.busy(r.id)).toBe(true)
  } finally { r.close() }
})

it('prefers supported thread status over contradictory private rollout events', async () => {
  const r = rig(true)
  try {
    const status = vi.fn().mockResolvedValue({ kind: 'idle' })
    const probe = new CodexTurnProbe({ status })
    expect(await probe.busy(r.id)).toBe(false)
    r.event('task_complete')
    status.mockResolvedValue({ kind: 'active', waiting: ['waitingOnApproval'] })
    expect(await probe.busy(r.id)).toBe(true)
    status.mockResolvedValue({ kind: 'unknown', reason: 'systemError' })
    expect(await probe.busy(r.id)).toBe(true)
    status.mockResolvedValue({ kind: 'unavailable', reason: 'disconnected' })
    expect(await probe.busy(r.id)).toBe(true)
    status.mockResolvedValue({ kind: 'idle' }) // reconnect uses fresh status
    expect(await probe.busy(r.id)).toBe(false)
  } finally { r.close() }
})

it('uses bounded legacy rollout inference only for a missing or unsupported status transport', async () => {
  const r = rig(false)
  try {
    const status = vi.fn().mockResolvedValue({ kind: 'unavailable', reason: 'unsupported', legacy: true })
    const probe = new CodexTurnProbe({ status })
    expect(await probe.busy(r.id)).toBe(false)
    r.event('task_started')
    expect(await probe.busy(r.id)).toBe(true)
  } finally { r.close() }
})

it('handles standalone threads alongside a daemon only with exact-thread lifecycle evidence', async () => {
  const r = rig(false)
  try {
    const probe = new CodexTurnProbe({ status: async () => ({ kind: 'unknown', reason: 'notLoaded' }) })
    expect(await probe.state(r.id)).toEqual({ kind: 'idle', source: 'legacy' })
    r.event('task_started') // a stale completion cannot make the newer active turn idle
    expect(await probe.state(r.id)).toEqual({ kind: 'active', source: 'legacy' })
    writeFileSync(r.rollout, '')
    expect(await probe.state(r.id)).toEqual({ kind: 'unknown', source: 'legacy', reason: 'no-turn-evidence' })
    expect(await probe.state('another-thread')).toEqual({ kind: 'unknown', source: 'legacy', reason: 'no-turn-evidence' })
  } finally { r.close() }
})

it('reports transport attempt separately from handoff and explicit answers without message content', async () => {
  const post = vi.fn(async () => ({ kind: 'joined' as const, turnId: 'turn' }))
  const midTurn = createMidTurnSender({ env: { CODEX_HOME: '/missing' }, post })
  const r = rig(true, { midTurn })
  try {
    const m = r.note()
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce())
    expect(r.wakes.health()).toMatchObject({ retainedAddressed: 1, pendingAddressed: 1, handedToHost: 0, wakeRecorded: 1,
      attempt: { via: 'turn', outcome: 'submitted' } })
    const batch = r.ledger.open('reply')
    r.ledger.select(r.s, batch); r.ledger.commit(batch)
    expect(r.wakes.health()).toMatchObject({ pendingAddressed: 0, handedToHost: 1, answersRecorded: 0 })
    const q = hubAppend(r.room, r.s.me, { type: 'question', to: 'Ana', text: 'secret question' })
    hubAppend(r.room, { name: 'Ana', kind: 'agent' }, { type: 'answer', to: 'Pat', inReplyTo: q.id, text: 'secret answer' })
    expect(r.wakes.health().answersRecorded).toBe(1)
    const report = formatDeliveryHealth(r.wakes.health())
    expect(report).toContain('content handed to host 1')
    expect(report).toContain('answers from requested recipients 1')
    expect(report).toContain('do not prove reading or action')
    expect(report).not.toMatch(/secret|please check|Ana|Pat|019a|m_\w+/)
    expect(JSON.stringify(r.wakes.health())).not.toContain(m.id)
  } finally { r.close() }
})

it('bounds failed mid-turn attempts per message even when new messages change the batch', async () => {
  const midTurn = vi.fn(async (_target: unknown, _text: string) => undefined)
  const r = rig(true, { midTurn })
  try {
    r.note()
    await vi.waitFor(() => expect(midTurn).toHaveBeenCalledTimes(3))
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(midTurn).toHaveBeenCalledTimes(3)
    expect(r.ledger.noticeCount()).toBe(1)
    expect(r.wakes.health().degraded).toBe('mid-turn-retry-limit')
    hubAppend(r.room, { name: 'Ben', kind: 'agent' }, { type: 'note', to: 'Pat', text: 'new content' })
    await vi.waitFor(() => expect(midTurn).toHaveBeenCalledTimes(6))
    for (const [, text] of midTurn.mock.calls.slice(3)) { expect(text).toContain('Ben'); expect(text).not.toContain('Ana') }
    expect(r.ledger.noticeCount()).toBe(1)
    r.event('task_complete')
    await vi.waitFor(() => expect(r.texts).toHaveLength(1)) // failed mid-turn attempts preserve idle fallback
    expect(r.texts[0]).toContain('2 things')
  } finally { r.close() }
})

it('keeps health sampling bounded while reporting all pending addressed work', () => {
  const r = rig(true)
  try {
    r.room.doc.transact(() => {
      for (let i = 0; i < 1001; i++) hubAppend(r.room, { name: 'Ana', kind: 'agent' }, { type: 'note', to: 'Pat', text: 'secret' })
    })
    const health = r.wakes.health()
    expect(health).toMatchObject({ retainedAddressed: 1000, pendingAddressed: 1001, sampled: true })
    expect(formatDeliveryHealth(health)).toContain('sample capped at 1000 entries')
    expect(JSON.stringify(health).length).toBeLessThan(500)
  } finally { r.close() }
})

it('keeps the last turn event across more than a tail of item lines, including a partial final line', async () => {
  const r = rig(true)
  try {
    const probe = new CodexTurnProbe({ contactAgeMs: () => 20_000 })
    expect(await probe.busy(r.id)).toBe(true)
    appendFileSync(r.rollout, Array.from({ length: 250 }, (_, n) => JSON.stringify({ type: 'response_item', payload: { n, text: 'x'.repeat(800) } }) + '\n').join(''))
    expect(await probe.busy(r.id)).toBe(true)
    appendFileSync(r.rollout, Array.from({ length: 1_200 }, (_, n) => JSON.stringify({ type: 'response_item', payload: { n, text: 'y'.repeat(1_000) } }) + '\n').join(''))
    expect(await probe.busy(r.id)).toBe(true) // backward scan finds the latest task_started
    const complete = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })
    appendFileSync(r.rollout, complete.slice(0, 25))
    expect(await probe.busy(r.id)).toBe(true)
    appendFileSync(r.rollout, complete.slice(25) + '\n')
    expect(await probe.busy(r.id)).toBe(false)
  } finally { r.close() }
})

it('leaves own-commit claim release owed without waking, but wakes for other release reasons', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const r = rig(false)
  try {
    const own = hubAppend<NoteMsg>(r.room, { name: 'room', kind: 'bot' }, {
      type: 'note', to: 'Pat', priority: 'notify', text: claimReleaseText('app.py', 3, 9, r.head),
    })
    await vi.advanceTimersByTimeAsync(80)
    expect(r.ledger.candidates(r.s).map(m => m.id)).toContain(own.id)
    expect(r.texts).toEqual([])
    const foreign = hubAppend<NoteMsg>(r.room, { name: 'room', kind: 'bot' }, {
      type: 'note', to: 'Pat', priority: 'notify', text: claimReleaseText('other.py', 1, 2, 'f'.repeat(40)),
    })
    const other = hubAppend<NoteMsg>(r.room, { name: 'room', kind: 'bot' }, {
      type: 'note', to: 'Pat', priority: 'notify', text: 'released your claim on app.py:3-9: you requested release',
    })
    await vi.waitFor(() => expect(r.texts).toHaveLength(1))
    expect(r.texts[0]).toContain('2 things may need you')
    expect(r.ledger.candidates(r.s).map(m => m.id)).toContain(foreign.id)
    expect(r.ledger.candidates(r.s).map(m => m.id)).toContain(other.id)
  } finally { r.close() }
})

it('wakeable does no synchronous child-process work for claim-release ancestry', () => {
  const r = rig(false)
  try {
    hubAppend<NoteMsg>(r.room, { name: 'room', kind: 'bot' }, {
      type: 'note', to: 'Pat', priority: 'notify', text: claimReleaseText('app.py', 3, 9, r.head),
    })
    const bin = join(r.s.dir, 'bin'), called = join(r.s.dir, 'git-called')
    mkdirSync(bin)
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nprintf "called\\n" >> "$ROOM_SYNC_GIT_LOG"\nexec "$ROOM_REAL_GIT" "$@"\n', { mode: 0o755 })
    vi.stubEnv('ROOM_REAL_GIT', execFileSync('which', ['git'], { encoding: 'utf8' }).trim())
    vi.stubEnv('ROOM_SYNC_GIT_LOG', called)
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    ;(r.wakes as unknown as { wakeable: () => unknown }).wakeable()
    expect(existsSync(called)).toBe(false)
  } finally { r.close() }
})

it('does not queue a mid-turn message that the hook then receipts', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const midTurn = vi.fn(async () => 'turn' as const)
  const r = rig(true, { midTurn })
  try {
    const m = r.note()
    await vi.waitFor(() => expect(midTurn).toHaveBeenCalledOnce())
    expect(r.texts).toEqual([])
    const hook = r.ledger.open('hook')
    expect(r.ledger.select(r.s, hook).map(x => x.id)).toContain(m.id)
    r.ledger.commit(hook)
    r.event('task_complete')
    await vi.advanceTimersByTimeAsync(80)
    expect(r.texts).toEqual([])
  } finally { r.close() }
})

it('queues exactly once after task_complete for a message still unseen', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const r = rig(true)
  try {
    r.note()
    await vi.advanceTimersByTimeAsync(80)
    expect(r.texts).toEqual([])
    r.event('task_complete')
    await vi.waitFor(() => expect(r.texts).toHaveLength(1))
    expect(r.texts[0]).toContain('if it shows nothing new, they were already delivered: do nothing further')
    await vi.advanceTimersByTimeAsync(80)
    expect(r.texts).toHaveLength(1)
    expect(r.log.join('\n')).toContain(r.id)
  } finally { r.close() }
})

it('treats turn_aborted as idle', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const r = rig(true)
  try {
    r.note()
    await vi.advanceTimersByTimeAsync(80)
    expect(r.texts).toEqual([])
    r.event('turn_aborted')
    await vi.waitFor(() => expect(r.texts).toHaveLength(1))
  } finally { r.close() }
})

it('rechecks a push against HEAD when the busy turn ends', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const r = rig(true)
  try {
    visiblePeer(r.room, 'Ana')
    r.room.manifestHead.set('Pat', { base: r.head, fence: 'f', coverage: { kind: 'all' }, level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true })
    const entries = new Y.Map()
    entries.set('work.txt', { fence: 'f' })
    r.room.manifest.set(manifestKey('Pat', 'f'), entries as never)
    execFileSync('git', ['-C', r.s.dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'next'])
    const pushed = execFileSync('git', ['-C', r.s.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    execFileSync('git', ['-C', r.s.dir, 'reset', '-q', '--hard', r.head])
    const notice = hubAppend<PushedMsg>(r.room, { name: 'Ana', kind: 'agent' }, { type: 'pushed', branch: 'main', upstream: 'origin/main', fromSha: r.head, toSha: pushed, commits: 1, paths: [], summary: 'next' })
    expect(r.ledger.candidates(r.s).map(m => m.id)).toContain(notice.id)
    await vi.advanceTimersByTimeAsync(80)
    expect(r.texts).toEqual([])
    execFileSync('git', ['-C', r.s.dir, 'reset', '-q', '--hard', pushed])
    expect(r.ledger.candidates(r.s).map(m => m.id)).not.toContain(notice.id)
    r.event('task_complete')
    await vi.advanceTimersByTimeAsync(80)
    expect(r.texts).toEqual([])
  } finally { r.close() }
})


it('joins notify once while busy, then queues each still-owed message once after idle', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const midTurn = vi.fn(async (_target: unknown, _text: string) => 'turn' as const)
  let sessionDir: string | undefined
  const r = rig(true, { midTurn, sessionDir: () => sessionDir })
  sessionDir = r.dir
  try {
    const note = r.note()
    const done = hubAppend(r.room, { name: 'worker', kind: 'agent' }, { type: 'done', to: 'Pat', tag: 'worker', summary: 'finished', changed: [] })
    await vi.waitFor(() => expect(midTurn).toHaveBeenCalledOnce())
    expect(midTurn.mock.calls[0][1]).toContain('Ana sent a note')
    expect(midTurn.mock.calls[0][1]).not.toContain('worker finished')
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(r.dir, 'wakes.json'), 'utf8')).r[note.id].via).toBe('turn'))
    expect(r.ledger.candidates(r.s).map(m => m.id)).toContain(note.id)
    expect(JSON.parse(readFileSync(join(r.dir, 'wakes.json'), 'utf8')).r[done.id]).toBeUndefined()
    r.event('task_complete')
    await vi.waitFor(() => expect(r.texts).toHaveLength(1))
    expect(r.texts[0]).toContain('worker finished')
    expect(r.texts[0]).toContain('Ana sent a note')
    expect(JSON.parse(readFileSync(join(r.dir, 'wakes.json'), 'utf8')).r[note.id].via).toBe('queue')
    r.event('task_complete')
    r.wakes.reconcile()
    await vi.advanceTimersByTimeAsync(80)
    expect(r.texts).toHaveLength(1)
    r.event('task_started')
    r.wakes.reconcile()
    await vi.advanceTimersByTimeAsync(80)
    expect(r.texts).toHaveLength(1)
    expect(midTurn).toHaveBeenCalledOnce()
  } finally { r.close() }
})

it('coalesces addressed own-worker completions during a busy turn, without progress or duplicate wakes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const midTurn = vi.fn(async (_target: unknown, _text: string) => 'turn' as const)
  const r = rig(true, { midTurn, ownWorkers: () => new Set(['worker', 'worker2']), windowMs: 100 })
  try {
    r.room.doc.transact(() => {
      for (const name of ['worker', 'worker2']) {
        hubAppend(r.room, { name, kind: 'agent' }, { type: 'note', to: 'Pat', text: 'private progress' })
        hubAppend(r.room, { name, kind: 'agent' }, { type: 'done', to: 'Pat', tag: name, summary: 'private completion', changed: [] })
      }
      hubAppend(r.room, { name: 'other', kind: 'agent' }, { type: 'done', to: 'Pat', tag: 'other', summary: 'peer completion', changed: [] })
    })
    await vi.waitFor(() => expect(midTurn).toHaveBeenCalledOnce())
    expect(midTurn.mock.calls[0][1]).toContain('2 things')
    expect(midTurn.mock.calls[0][1]).toContain('worker finished; worker2 finished')
    expect(midTurn.mock.calls[0][1]).not.toMatch(/private|progress|other/)
    expect(r.ledger.candidates(r.s)).toHaveLength(5) // a wake is not a receipt
    r.wakes.reconcile()
    await vi.advanceTimersByTimeAsync(140)
    expect(midTurn).toHaveBeenCalledOnce()
    r.event('task_complete')
    await vi.waitFor(() => expect(r.texts).toHaveLength(1))
    expect(r.texts[0]).toContain('3 things')
    expect(r.texts[0]).not.toContain('progress')
  } finally { r.close() }
})

it.each(['unavailable', 'throw'])('retries mid-turn %s without duplicate wakes after success', async failure => {
  let calls = 0
  const midTurn = vi.fn(async () => {
    if (++calls < 3) { if (failure === 'throw') throw new Error('unavailable'); return undefined }
    return 'turn' as const
  })
  const r = rig(true, { midTurn })
  try {
    r.note()
    await vi.waitFor(() => expect(calls).toBe(3))
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(calls).toBe(3)
    expect(r.log.filter(line => line.includes('mid-turn failed'))).toHaveLength(failure === 'throw' ? 1 : 0)
    r.event('task_complete')
    await vi.waitFor(() => expect(r.texts).toHaveLength(1))
    expect(calls).toBe(3)
  } finally { r.close() }
})

it('coalesces urgent mid-turn wakes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const midTurn = vi.fn(async (_target: unknown, _text: string) => 'turn' as const)
  const r = rig(true, { midTurn, windowMs: 200 })
  try {
    r.note()
    await vi.waitFor(() => expect(midTurn).toHaveBeenCalledOnce())
    r.note(); r.note()
    await vi.advanceTimersByTimeAsync(60)
    expect(midTurn).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(midTurn).toHaveBeenCalledTimes(2))
    expect(midTurn.mock.calls[1][1]).toContain('2 things')
  } finally { r.close() }
})

it('never calls the mid-turn sender for Claude', async () => {
  const midTurn = vi.fn(async (_target: unknown, _text: string) => 'turn' as const)
  const r = rig(true, { midTurn, bound: () => ({ id: 'claude', host: 'claude' }) })
  try {
    r.note()
    await vi.waitFor(() => expect(r.texts).toHaveLength(1))
    expect(midTurn).not.toHaveBeenCalled()
  } finally { r.close() }
})

it('ROOM_WAKE=off suppresses mid-turn transport', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const post = vi.fn()
  const env = { ROOM_WAKE: 'off' }
  const queue = vi.fn(async () => {})
  const midTurn = createMidTurnSender({ env, post })
  const send = createWakeSender({ env, queue, notify: vi.fn() })
  const r = rig(true, { midTurn, send })
  try {
    r.note()
    await vi.advanceTimersByTimeAsync(80)
    expect(post).not.toHaveBeenCalled()
    r.event('task_complete')
    await vi.advanceTimersByTimeAsync(80)
    expect(queue).not.toHaveBeenCalled()
    expect(r.texts).toEqual([])
  } finally { r.close() }
})

it('rechecks the bound session after a busy probe', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const midTurn = vi.fn(async (_target: unknown, _text: string) => 'turn' as const)
  let bound = { id: 'initial', host: 'codex' as const }
  const r = rig(true, { midTurn, bound: () => bound, codexTurn: { busy: async () => { bound = { id: bound.id === 'initial' ? 'replacement' : 'initial', host: 'codex' }; return true } }, pollMs: 1000 })
  try {
    r.note()
    await vi.advanceTimersByTimeAsync(80)
    expect(midTurn).not.toHaveBeenCalled()
  } finally { r.close() }
})


it('mid-turn sender maps daemon outcomes, skips Claude and logs each failure reason once', async () => {
  const post = vi.fn().mockResolvedValue({ kind: 'unavailable', reason: 'thread not found' })
  const log = vi.fn()
  const send = createMidTurnSender({ env: { CODEX_HOME: '/missing-room-codex-home' }, post, log, clientVersion: '0.17.11' })
  const target = { id: 'thread', host: 'codex' as const }
  expect(await send({ id: 'claude', host: 'claude' }, 'pointer')).toBeUndefined()
  expect(post).not.toHaveBeenCalled()
  expect(await send(target, 'pointer')).toBeUndefined()
  expect(await send(target, 'pointer')).toBeUndefined()
  expect(log).toHaveBeenCalledOnce()
  post.mockResolvedValue({ kind: 'idle' })
  expect(await send(target, 'pointer')).toBe('idle')
  post.mockResolvedValue({ kind: 'joined', turnId: 'turn' })
  expect(await send(target, 'pointer')).toBe('turn')
  expect(log).toHaveBeenLastCalledWith('wake: Codex mid-turn joined turn turn of session thread')
  expect(post).toHaveBeenLastCalledWith({ socketPath: undefined, threadId: 'thread', text: 'pointer', clientVersion: '0.17.11' })
  post.mockResolvedValue({ kind: 'unavailable', reason: 'thread not found' })
  await send(target, 'pointer')
  expect(log).toHaveBeenCalledTimes(3)
})

it('uses kind priorities for legacy messages with no explicit priority', async () => {
  const midTurn = vi.fn(async (_target: unknown, _text: string) => 'turn' as const)
  const r = rig(true, { midTurn })
  try {
    r.room.doc.transact(() => {
      r.note()
      hubAppend(r.room, { name: 'worker', kind: 'agent' }, { type: 'done', to: 'Pat', tag: 'worker', summary: 'finished', changed: [] })
      const legacy = r.room.bus.toArray().map(({ priority: _priority, ...m }) => m)
      r.room.bus.delete(0, r.room.bus.length)
      r.room.bus.push(legacy)
    })
    await vi.waitFor(() => expect(midTurn).toHaveBeenCalledOnce())
    expect(midTurn.mock.calls[0][1]).toContain('Ana sent a note')
    expect(midTurn.mock.calls[0][1]).not.toContain('worker finished')
    r.event('task_complete')
    await vi.waitFor(() => expect(r.texts).toHaveLength(1))
    expect(r.texts[0]).toContain('worker finished')
  } finally { r.close() }
})
