import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc, type Worker } from '@room/shared'
import { shouldRetire, workerGitFacts, type RetirementFacts } from '../src/workers.js'
import { Rooms } from '../src/registry.js'
import type { Session } from '../src/session.js'

const facts: RetirementFacts = { exited: true, done: true, dismissed: false, merged: false, clean: false, ahead: 1 }
const worker = (dir: string): Worker => ({ id: 'lead/w#1', name: 'lead+w', tag: 'w', lead: 'lead', host: 'codex', task: 'task', dir, branch: 'room/w', pid: -1, startedAt: 1, status: 'done', summary: 'done', exitCode: 0 })
const dirs: string[] = []
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'room-retirement-')); dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@test'); git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'a'), 'one'); git('add', '.'); git('commit', '-qm', 'initial')
  return { dir, git }
}
function registry(dir: string) {
  const room = new RoomDoc()
  const s = { room, dir, me: { name: 'lead' }, roomName: 'local/repo/main' } as Session
  let primary: Session | null = s
  const rooms = new Rooms({ primary: () => primary, setPrimary: p => { primary = p }, observeClaims() {}, attach: () => ({ stop() {} }) })
  rooms.track(s)
  return { room, s, rooms, close: () => { rooms.remove(s); room.doc.destroy() } }
}

describe('shouldRetire', () => {
  it.each([
    [{ exited: false, dismissed: true, merged: true, clean: true, ahead: 0 }, undefined],
    [{ done: false, merged: true, clean: true, ahead: 0 }, undefined],
    [{ done: false, dismissed: true }, 'dismissed'],
    [{ dismissed: true, merged: true }, 'dismissed'],
    [{ merged: true, clean: false }, 'merged'],
    [{ clean: true, ahead: 0 }, 'clean'],
    [{ clean: false, ahead: 0 }, undefined],
    [{ clean: true, ahead: 1 }, undefined],
    [{ clean: true, ahead: undefined }, undefined],
  ] as [Partial<RetirementFacts>, string | undefined][])('evaluates %j as %s', (patch, outcome) => {
    expect(shouldRetire({ ...facts, ...patch })).toBe(outcome)
  })
})

describe('git facts and lead evaluation', () => {
  it('distinguishes merged, dirty, ahead, clean and missing worktrees', async () => {
    const { dir, git } = repo(), work = join(dir, 'work')
    git('worktree', 'add', '-qb', 'room/w', work)
    const w = worker(work)
    expect(await workerGitFacts(dir, w)).toEqual({ merged: true, clean: true, ahead: 0 })
    writeFileSync(join(work, 'a'), 'two')
    expect(await workerGitFacts(dir, w)).toEqual({ merged: true, clean: false, ahead: 0 })
    execFileSync('git', ['-C', work, 'commit', '-qam', 'worker change'])
    expect(await workerGitFacts(dir, w)).toEqual({ merged: false, clean: true, ahead: 1 })
    git('merge', '--ff-only', 'room/w')
    expect(await workerGitFacts(dir, w)).toEqual({ merged: true, clean: true, ahead: 0 })
    expect(await workerGitFacts(dir, { ...w, dir: '/does-not-exist', branch: 'missing' })).toEqual({ merged: false, clean: false, ahead: undefined })
  })

  it('retires only this lead’s exited done workers; failures need dismissal; handles block retirement', async () => {
    const { dir } = repo(), r = registry(dir)
    const w = worker(dir)
    r.room.setWorker(w)
    r.room.setOverlay(w.name, 'a', 'published')
    const proc = { pid: 1, onExit() {}, kill: () => true }
    r.rooms.setHandle(r.s, w.id!, proc)
    await r.rooms.retireWorkers(); expect(r.room.workers.has(w.tag)).toBe(true)
    r.rooms.dropHandle(r.s, w.id, proc)
    await r.rooms.retireWorkers()
    expect(r.room.retiredWorkers()).toMatchObject([{ outcome: 'clean', files: ['a'], summary: 'done' }])
    r.room.setWorker({ ...w, startedAt: 2, status: 'failed' })
    await r.rooms.retireWorkers(); expect(r.room.workers.has(w.tag)).toBe(true)
    r.room.updateWorker(w.tag, { dismissedAt: 3 })
    await r.rooms.retireWorkers(); expect(r.room.retiredWorkers().at(-1)?.outcome).toBe('dismissed')
    r.room.setWorker({ ...w, lead: 'someone else' })
    await r.rooms.retireWorkers(); expect(r.room.workers.has(w.tag)).toBe(true)
    r.close()
  })

  it('evaluates on the slow timer and cancels it when the session leaves', async () => {
    vi.useFakeTimers()
    const r = registry('/missing')
    r.room.setWorker({ ...worker('/missing'), status: 'failed', dismissedAt: 2 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.room.retiredWorkers()).toHaveLength(1)
    r.rooms.remove(r.s)
    r.room.setWorker({ ...worker('/missing'), startedAt: 2, dismissedAt: 3 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.room.workers.size).toBe(1)
    r.room.doc.destroy()
  })
})
