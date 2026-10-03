import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { participantRecord, participantsView } from '@room/shared'
import { joinSession, leaveSession, type Session } from '../src/session.js'
import { createTools } from '../src/tools.js'
import { IDLE_CLAIMS_MS, releaseIdleHeld } from '../src/presence-end.js'
import { rememberTag } from '../src/choice.js'

let dir: string
const cleanups: (() => Promise<void> | void)[] = []
const prevRoomEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ROOM_')))
const clearRoomEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith('ROOM_')) delete process.env[k] }
const log = () => {}

beforeAll(() => {
  clearRoomEnv()
  dir = mkdtempSync(join(tmpdir(), 'room-names-join-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'Ada')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
})
afterEach(async () => { vi.unstubAllEnvs(); for (const c of cleanups.splice(0).reverse()) { try { await c() } catch { /* ignore */ } } })
afterAll(() => { clearRoomEnv(); Object.assign(process.env, prevRoomEnv) })

async function join1(sessionId: string, extra: { tag?: string } = {}): Promise<Session> {
  const s = await joinSession({ dir, sessionId, log, ...extra })
  cleanups.push(() => leaveSession(s))
  return s
}
const holder = (s: Session, name: string) => participantRecord(s.room, name)?.holder

describe('joining under the hub name lease (registry §15; wave-0 rehearsal §2)', () => {
  it('does not give Claude a remembered automatic Codex label', async () => {
    await rememberTag(dir, 'codex-2')
    vi.stubEnv('ROOM_HOST', 'claude')
    const s = await join1('cross-host')
    expect(s.awareness.getLocalState()?.host).toBe('claude')
    expect(s.me.name).not.toMatch(/\+codex(?:-\d+)?$/)
  }, 45_000)

  it('a second session gets the next candidate; the name, its fence and presence all follow the hub lease', async () => {
    const a = await join1('sa')
    const b = await join1('sb')
    expect(a.me.name).toBe('Ada')
    expect(b.me.name).toMatch(/^Ada\+/)
    expect(b.autoTagNote).toMatch(/Ada is in use by another session/)
    await vi.waitFor(() => expect(holder(b, 'Ada')).toMatchObject({ sessionId: 'sa', epoch: a.lease!.epoch }))
    expect(a.lease!.fence()).toBe(String(a.lease!.epoch))
    await vi.waitFor(() => expect(a.room.manifestHead.get('Ada')?.fence).toBe(String(a.lease!.epoch)))
    await vi.waitFor(() => expect(participantsView(b.room, b.awareness, Date.now()).find(p => p.name === 'Ada')?.fresh).toBe(true))
    expect(a.lease!.paused()).toBeUndefined()
  }, 45_000)

  it('room_state shows a quiet session by its own idle measure (registry §18)', async () => {
    const a = await join1('sa')
    const b = await join1('sb')
    b.awareness.setLocalStateField('idleMin', 25)
    const tools = createTools({ getSession: () => a, setSession: () => {}, cwd: dir, log: () => {} })
    await vi.waitFor(async () => expect(await tools.call('room_state', { all: true })).toMatch(new RegExp(`${b.me.name.replace('+', '\\+')}.*idle 25 min`)), { timeout: 10_000, interval: 200 })
    await tools.shutdown()
  }, 45_000)

  it('a fresh session reusing a released name does not inherit its done status', async () => {
    const a = await join1('old-status', { tag: 'status-reuse' })
    const oldTools = createTools({ getSession: () => a, setSession: () => {}, cwd: dir, log })
    await oldTools.call('room_done', { summary: 'old hooks task finished' })
    expect(a.room.messages().some(m => m.type === 'note' && m.text.includes('old hooks task finished'))).toBe(true)
    await oldTools.shutdown()
    await leaveSession(a)
    const b = await join1('new-status', { tag: 'status-reuse' })
    expect(b.room.messages().some(m => m.type === 'note' && m.text.includes('old hooks task finished'))).toBe(true)
    const tools = createTools({ getSession: () => b, setSession: () => {}, cwd: dir, log })
    try {
      const state = await tools.call('room_state', { all: true })
      const ownLine = state.split('\n').find(line => line.includes('(you):'))
      expect(ownLine).toBeDefined()
      expect(ownLine).not.toContain('done')
      expect(ownLine).not.toContain('old hooks task')
      expect(b.awareness.getLocalState()?.joinedAt).toBeTypeOf('number')
    } finally { await tools.shutdown() }
  }, 45_000)

  it('H1: after eight idle hours a session releases its own claims and scope, with one notice (registry §18)', async () => {
    const a = await join1('sa')
    await vi.waitFor(() => expect(holder(a, 'Ada')?.sessionId).toBe('sa'))
    a.room.setScope({ by: 'Ada', byKind: 'agent', area: 'x', summary: 'x', paths: ['app.py'] })
    a.room.addClaim({ path: 'app.py', from: 1, to: 1, by: 'Ada', byKind: 'agent', intent: 'edit' })
    const mono = () => 10 * IDLE_CLAIMS_MS
    expect(await releaseIdleHeld(a, 'idle-1', IDLE_CLAIMS_MS - 1, mono)).toBe(false)
    expect(await releaseIdleHeld(a, 'idle-1', IDLE_CLAIMS_MS, mono)).toBe(true)
    expect(a.room.openClaims()).toEqual([])
    expect(a.room.scope('Ada')).toBeUndefined()
    expect(await releaseIdleHeld(a, 'idle-1', IDLE_CLAIMS_MS, mono)).toBe(false)
    expect(a.room.messages().filter(m => m.id === 'idle-claims:sa:idle-1')).toHaveLength(1)
  }, 45_000)

  it('leaving releases the hub lease at once; the next session of this worktree takes the bare name back', async () => {
    const a = await join1('sa')
    const b = await join1('sb')
    await leaveSession(a)
    await vi.waitFor(() => expect(holder(b, 'Ada')?.ended).toBe('released'))
    const c = await join1('sc')
    expect(c.me.name).toBe('Ada')
    expect(holder(c, 'Ada')).toMatchObject({ sessionId: 'sc' })
  }, 45_000)

  it('refuses an explicit tag another session holds', async () => {
    await join1('sa', { tag: 'ci' })
    await expect(joinSession({ dir, sessionId: 'sb', tag: 'ci', log })).rejects.toThrow(/Ada\+ci is held by another session/)
  }, 45_000)

  it('an MCP restart in the same host session takes the name over, and the predecessor stands down (row 16)', async () => {
    const a = await join1('s1')
    const a2 = await join1('s1')
    expect(a2.me.name).toBe('Ada')
    expect(a2.lease!.epoch).toBeGreaterThan(a.lease!.epoch!)
    a.lease!.check()
    expect(a.lease!.state).toBe('superseded')
    expect(a.lease!.paused()).toMatch(/stood down/)
    // The stood-down session says so in every reply and writes nothing under the name (hub §7).
    const tools = createTools({ getSession: () => a, setSession: () => {}, cwd: dir, log: () => {} })
    const claim = await tools.call('room_claim', { path: 'app.py', from: 1, to: 1, intent: 'edit' })
    expect(claim).toMatch(/^\[room\] a newer Room process of this session took over Ada; this one has stood down\.[\s\S]*not done: room_claim writes under your name/)
    expect(a.room.openClaims()).toEqual([])
    expect(await tools.call('room_state', {})).toMatch(/^\[room\] a newer Room process/)
    await tools.shutdown()
  }, 45_000)
})
