import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { participantRecord } from '@room/shared'
import { joinSession, leaveSession, type Session } from '../src/session.js'

let dir: string
const sessions: Session[] = []
const prevRoomEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ROOM_')))
const clearRoomEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith('ROOM_')) delete process.env[k] }
const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString().trim()

beforeAll(() => {
  clearRoomEnv()
  dir = mkdtempSync(join(tmpdir(), 'room-publisher-join-'))
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'Ada')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
})
afterEach(async () => { for (const s of sessions.splice(0).reverse()) { try { await leaveSession(s) } catch { /* gone */ } } })
afterAll(() => { clearRoomEnv(); Object.assign(process.env, prevRoomEnv) })

const publishing = (s: Session) => s.daemon.inputs.policy.publisher

describe('one publisher per checkout, end to end (registry §16, D5)', () => {
  it('five sessions in one checkout, local room: one publisher; a commit gives one git.rev bump, from it, and no notice (row 23b)', async () => {
    for (let i = 0; i < 5; i++) sessions.push(await joinSession({ dir, sessionId: `s${i}`, log: () => {} }))
    expect(new Set(sessions.map(s => s.me.name)).size).toBe(5)
    expect(sessions.filter(publishing)).toHaveLength(1)
    const publisher = sessions.find(publishing)!
    const others = sessions.filter(s => s !== publisher)
    await vi.waitFor(() => {
      for (const s of others) expect(publisher.room.manifestHead.get(s.me.name)).toMatchObject({ coverage: { kind: 'none', reason: 'not-publisher' }, publisher: publisher.me.name })
    }, { timeout: 10_000 })
    await vi.waitFor(() => expect(participantRecord(publisher.room, publisher.me.name)?.git?.rev).toBeGreaterThan(0), { timeout: 10_000 })
    const before = participantRecord(publisher.room, publisher.me.name)!.git!.rev
    writeFileSync(join(dir, 'a.txt'), 'a\n'); git('add', '.'); git('commit', '-qm', 'a')
    const head = git('rev-parse', 'HEAD')
    await vi.waitFor(() => expect(participantRecord(publisher.room, publisher.me.name)?.git).toMatchObject({ head, rev: before + 1 }), { timeout: 15_000 })
    // Every other daemon has polled HEAD by now (3 s): none wrote a record or a notice.
    await new Promise(resolve => setTimeout(resolve, 4_000))
    expect(participantRecord(publisher.room, publisher.me.name)!.git!.rev).toBe(before + 1)
    for (const s of others) expect(participantRecord(publisher.room, s.me.name)?.git).toBeUndefined()
    expect(publisher.room.messages().filter(m => m.type === 'pushed' || m.type === 'base')).toEqual([])
  }, 90_000)

  it('the publisher leaves: another session in the checkout takes over on its next tick, never two at once (row 24)', async () => {
    for (let i = 0; i < 3; i++) sessions.push(await joinSession({ dir, sessionId: `s${i}`, log: () => {} }))
    const publisher = sessions.find(publishing)!
    await leaveSession(publisher)
    sessions.splice(sessions.indexOf(publisher), 1)
    await vi.waitFor(() => expect(sessions.filter(publishing)).toHaveLength(1), { timeout: 15_000 })
    const next = sessions.find(publishing)!
    await vi.waitFor(() => expect(next.room.manifestHead.get(next.me.name)?.coverage).toEqual({ kind: 'all' }), { timeout: 15_000 })
  }, 90_000)
})
