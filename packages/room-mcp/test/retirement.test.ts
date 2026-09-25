import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc, type Worker } from '@room/shared'
import { shouldRetire, workerGitFacts, prepareWorktree, saveDiscardPatch, type RetirementFacts } from '../src/workers.js'
import { Rooms } from '../src/registry.js'
import type { Session } from '../src/session.js'
import { handlers as collectHandlers } from '../src/tools/collect.js'
import type { HandlerState } from '../src/tools/context.js'

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
    [{ merged: true, clean: false, ahead: 0 }, undefined],
    [{ merged: true, clean: true, ahead: 0, uncommitted: 0 }, 'merged'],
    [{ merged: true, clean: true, ahead: undefined }, undefined],
    [{ clean: true, ahead: 0 }, 'clean'],
    [{ clean: false, ahead: 0 }, undefined],
    [{ clean: true, ahead: 1 }, undefined],
    [{ clean: true, ahead: undefined }, undefined],
  ] as [Partial<RetirementFacts>, string | undefined][])('evaluates %j as %s', (patch, outcome) => {
    expect(shouldRetire({ ...facts, ...patch })).toBe(outcome)
  })
})

it('does not count the lead checkout edits as an existing-dir worker\'s uncommitted files', async () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'lead-only'), 'lead edit')
  const w = { ...worker(dir), branch: 'main', status: 'dismissed' as const }
  expect((await workerGitFacts(dir, w)).uncommitted).toBeUndefined()
})

it('does not inspect a separate checkout that Room does not own even if its branch looks like a worker branch', async () => {
  const { dir } = repo(), { dir: external, git } = repo()
  git('checkout', '-qb', 'room/w')
  writeFileSync(join(external, 'outside'), 'external edit')
  expect((await workerGitFacts(dir, worker(external))).uncommitted).toBeUndefined()
})

describe('git facts and lead evaluation', () => {
  it('auto-retires a worker whose worktree vanished and keeps unmerged commits', async () => {
    const { dir, git } = repo(), r = registry(dir)
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    const w = { ...worker(prepared.dir), base: prepared.base }
    writeFileSync(join(w.dir, 'worker.txt'), 'work')
    execFileSync('git', ['-C', w.dir, 'add', 'worker.txt'])
    execFileSync('git', ['-C', w.dir, 'commit', '-qm', 'worker'])
    r.room.setWorker(w)
    r.room.setOverlay(w.name, 'worker.txt', 'work')
    r.room.addClaim({ by: w.name, byKind: 'agent', path: 'worker.txt', from: 1, to: 1, intent: 'work' })
    rmSync(w.dir, { recursive: true, force: true })
    await r.rooms.retireWorkers()
    expect(r.room.workers.has(w.tag)).toBe(false)
    expect(r.room.overlays.has(w.name)).toBe(false)
    expect(r.room.openClaims().filter(c => c.by === w.name)).toEqual([])
    expect(git('branch', '--list', 'room/w')).toContain('room/w')
    expect(git('worktree', 'list', '--porcelain')).not.toContain(w.dir)
    r.close()
  })
  it('retains a done worker and its actionable record when ignored output remains', async () => {
    const { dir } = repo(), r = registry(dir)
    writeFileSync(join(dir, '.gitignore'), 'artifact.bin\n')
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    const w = { ...worker(prepared.dir), base: prepared.base }
    writeFileSync(join(w.dir, 'artifact.bin'), 'worker artifact')
    r.room.setWorker(w)
    await r.rooms.retireWorkers()
    expect(existsSync(join(w.dir, 'artifact.bin'))).toBe(true)
    expect(r.room.workers.get('w')).toBeDefined()
    expect(r.room.retiredWorkers()).toEqual([])
    r.room.updateWorker('w', { status: 'dismissed', dismissedAt: 2 })
    await r.rooms.retireWorkers()
    expect(r.room.workers.get('w')).toBeDefined()
    expect(r.room.retiredWorkers()).toEqual([])
    r.close()
  })

  it('retains the record when automatic worktree cleanup cannot safely complete', async () => {
    const { dir } = repo(), r = registry(dir)
    const w = { ...worker(dir), branch: 'main' }
    r.room.setWorker(w)
    await r.rooms.retireWorkers()
    expect(r.room.workers.get('w')).toBeDefined()
    expect(r.room.retiredWorkers()).toEqual([])
    r.close()
  })

  it('retires a carried worker that made no own changes and removes its worktree', async () => {
    const { dir, git } = repo(), r = registry(dir)
    writeFileSync(join(dir, 'a'), 'lead WIP')
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    expect(prepared.carried?.commit).toBe(prepared.base)
    const w = { ...worker(prepared.dir), base: prepared.base }
    expect(await workerGitFacts(dir, w)).toEqual({ merged: false, clean: true, ahead: 0, uncommitted: 0 })
    r.room.setWorker(w)
    await r.rooms.retireWorkers()
    expect(r.room.retiredWorkers()).toMatchObject([{ outcome: 'clean' }])
    expect(existsSync(prepared.dir)).toBe(false)
    expect(git('rev-parse', 'HEAD')).not.toBe(prepared.base)
    r.close()
  })

  it('saves only worker edits in a discard patch after a real carried commit', async () => {
    const { dir } = repo()
    writeFileSync(join(dir, 'a'), 'lead WIP')
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    const w = { ...worker(prepared.dir), base: prepared.base }
    expect(await saveDiscardPatch(dir, w)).toBeUndefined()
    writeFileSync(join(w.dir, 'worker.txt'), 'worker output')
    const patch = await saveDiscardPatch(dir, w)
    expect(patch).toBeDefined()
    const text = readFileSync(patch!, 'utf8')
    expect(text).toContain('worker output')
    expect(text).not.toContain('lead WIP')
    expect(text).not.toContain('diff --git a/a b/a')
  })

  it('counts worker commits after the carried base and recognizes their merge', async () => {
    const { dir, git } = repo()
    writeFileSync(join(dir, 'a'), 'lead WIP')
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    const w = { ...worker(prepared.dir), base: prepared.base }
    writeFileSync(join(w.dir, 'worker.txt'), 'worker output')
    execFileSync('git', ['-C', w.dir, 'add', 'worker.txt'])
    execFileSync('git', ['-C', w.dir, 'commit', '-qm', 'worker output'])
    expect(await workerGitFacts(dir, w)).toEqual({ merged: false, clean: true, ahead: 1, uncommitted: 0 })
    git('restore', 'a')
    git('merge', '--ff-only', w.branch)
    expect(await workerGitFacts(dir, w)).toEqual({ merged: true, clean: true, ahead: 0, uncommitted: 0 })
  })

  it('does not retire a carried no-op worker while collection waits for its exit', async () => {
    const { dir } = repo(), r = registry(dir)
    appendFileSync(join(dir, '.git', 'info', 'exclude'), '.room/\n')
    writeFileSync(join(dir, 'a'), 'lead WIP')
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    const w = { ...worker(prepared.dir), base: prepared.base }
    r.room.setWorker(w)
    let alive = true
    const state = {
      S: () => r.s, rooms: r.rooms, now: Date.now, workerAlive: () => alive,
      ctx: { sleep: async () => { await r.rooms.retireWorkers(r.s); alive = false } },
    } as unknown as HandlerState
    const reply = await collectHandlers(state).room_collect({})
    expect(reply).toContain('Changes from w: already present. Nothing committed or staged.')
    expect(reply).toContain('cleaned up w')
    expect(r.room.retiredWorkers()).toMatchObject([{ files: [], fileCount: 0 }])
    expect(existsSync(w.dir)).toBe(false)
    r.close()
  })

  it('retires a merged worker whose only untracked path is a Room-linked input', async () => {
    const { dir, git } = repo(), r = registry(dir)
    writeFileSync(join(dir, '.gitignore'), '.room/\ndata/\n')
    git('add', '.gitignore'); git('commit', '-qm', 'ignore inputs')
    const prepared = await prepareWorktree(dir, 'w')
    const w = { ...worker(prepared.dir), base: prepared.base, link: ['data'] }
    mkdirSync(join(dir, 'data')); writeFileSync(join(dir, 'data', 'input'), 'input')
    symlinkSync(join(dir, 'data'), join(w.dir, 'data'))
    writeFileSync(join(w.dir, 'a'), 'worker output')
    execFileSync('git', ['-C', w.dir, 'commit', '-qam', 'output'])
    git('merge', '--ff-only', w.branch)
    expect(execFileSync('git', ['-C', w.dir, 'status', '--porcelain']).toString()).toBe('?? data\n')
    r.room.setWorker(w)
    r.room.setOverlay(w.name, 'a', 'worker output')
    await r.rooms.retireWorkers()
    expect(r.room.workers.has(w.tag)).toBe(false)
    expect(r.room.retiredWorkers()).toMatchObject([{ outcome: 'merged' }])
    expect(r.room.changedPaths(w.name)).toEqual([])
    r.close()
  })
  it('distinguishes merged, dirty, ahead, clean and missing worktrees', async () => {
    const { dir, git } = repo(), work = join(dir, '.room', 'workers', 'w')
    git('worktree', 'add', '-qb', 'room/w', work)
    const w = { ...worker(work), base: git('rev-parse', 'HEAD') }
    expect(await workerGitFacts(dir, w)).toEqual({ merged: false, clean: true, ahead: 0, uncommitted: 0 })
    writeFileSync(join(work, 'a'), 'two')
    expect(await workerGitFacts(dir, w)).toEqual({ merged: false, clean: false, ahead: 0, uncommitted: 1 })
    execFileSync('git', ['-C', work, 'commit', '-qam', 'worker change'])
    expect(await workerGitFacts(dir, w)).toEqual({ merged: false, clean: true, ahead: 1, uncommitted: 0 })
    git('merge', '--ff-only', 'room/w')
    expect(await workerGitFacts(dir, w)).toEqual({ merged: true, clean: true, ahead: 0, uncommitted: 0 })
    expect(await workerGitFacts(dir, { ...w, dir: '/does-not-exist', branch: 'missing' })).toEqual({ merged: false, clean: false, ahead: undefined })
  })

  it('retires only this lead’s exited done workers; failures need dismissal; handles block retirement', async () => {
    const { dir, git } = repo(), r = registry(dir), work = join(dir, '.room', 'workers', 'w')
    git('worktree', 'add', '-qb', 'room/w', work)
    const w = worker(work)
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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { dir } = repo(), r = registry(dir), missing = join(dir, '.room', 'workers', 'w')
    r.room.setWorker({ ...worker(missing), status: 'failed', dismissedAt: 2 })
    await vi.advanceTimersByTimeAsync(60_000)
    await r.rooms.retireWorkers()
    expect(r.room.retiredWorkers()).toHaveLength(1)
    r.rooms.remove(r.s)
    r.room.setWorker({ ...worker(missing), startedAt: 2, dismissedAt: 3 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.room.workers.size).toBe(1)
    r.room.doc.destroy()
  })
})

it('keeps uncommitted work visible until the lead commits and merges it; merged dirty work stays live', async () => {
  const { dir, git } = repo(), r = registry(dir)
  const prepared = await prepareWorktree(dir, 'w')
  const w = { ...worker(prepared.dir), base: prepared.base }
  r.room.setWorker(w)
  writeFileSync(join(w.dir, 'a'), 'worker edit')
  writeFileSync(join(w.dir, 'new\nfile'), 'untracked')
  r.room.setOverlay(w.name, 'a', 'worker edit')
  await r.rooms.retireWorkers()
  expect(r.room.workers.has(w.tag)).toBe(true)
  expect(r.room.changedPaths(w.name)).toEqual(['a'])
  expect(await workerGitFacts(dir, w)).toMatchObject({ ahead: 0, clean: false, uncommitted: 2 })
  execFileSync('git', ['-C', w.dir, 'add', '.'])
  execFileSync('git', ['-C', w.dir, 'commit', '-qm', 'lead commits worker work'])
  await r.rooms.retireWorkers()
  expect(r.room.workers.has(w.tag)).toBe(true)
  git('merge', '--ff-only', w.branch)
  writeFileSync(join(w.dir, 'a'), 'dirty after merge')
  await r.rooms.retireWorkers()
  expect(r.room.workers.has(w.tag)).toBe(true)
  execFileSync('git', ['-C', w.dir, 'restore', 'a'])
  await r.rooms.retireWorkers()
  expect(r.room.retiredWorkers()).toMatchObject([{ outcome: 'merged' }])
  expect(r.room.changedPaths(w.name)).toEqual([])
  r.close()
})

it('retires clean zero-commit and legacy workers as clean, and archives dismissed dirty file counts', async () => {
  const { dir } = repo(), r = registry(dir)
  const prepared = await prepareWorktree(dir, 'w')
  const w = { ...worker(prepared.dir), base: prepared.base }
  r.room.setWorker(w)
  await r.rooms.retireWorkers()
  expect(r.room.retiredWorkers()).toMatchObject([{ outcome: 'clean' }])
  // a clean retirement removes the worktree and its branch; the next worker of that tag starts fresh
  expect(existsSync(w.dir)).toBe(false)
  await prepareWorktree(dir, 'w')
  const legacy = { ...w, base: undefined, startedAt: 2 }
  writeFileSync(join(w.dir, 'a'), 'two')
  execFileSync('git', ['-C', w.dir, 'commit', '-qam', 'change'])
  execFileSync('git', ['-C', dir, 'merge', '--ff-only', w.branch])
  r.room.setWorker(legacy)
  await r.rooms.retireWorkers()
  expect(r.room.retiredWorkers().at(-1)?.outcome).toBe('clean')
  await prepareWorktree(dir, 'w')
  writeFileSync(join(w.dir, 'a'), 'three')
  writeFileSync(join(w.dir, 'new'), 'untracked')
  r.room.setWorker({ ...w, startedAt: 3, dismissedAt: 4 })
  await r.rooms.retireWorkers()
  expect(r.room.retiredWorkers().at(-1)).toMatchObject({ outcome: 'dismissed', uncommitted: 2 })
  r.close()
})

it('retains workers when the worktree, branch, fork commit or lead git state is unknown', async () => {
  const { dir } = repo(), r = registry(dir)
  const prepared = await prepareWorktree(dir, 'w')
  const w = { ...worker(prepared.dir), base: prepared.base }
  for (const patch of [{ dir: '/missing' }, { branch: 'missing' }, { base: 'missing' }]) {
    r.room.setWorker({ ...w, ...patch })
    await r.rooms.retireWorkers()
    expect(r.room.workers.has(w.tag)).toBe(true)
  }
  expect((await workerGitFacts('/missing', w)).ahead).toBeUndefined()
  expect(r.room.retiredWorkers()).toEqual([])
  r.close()
})
