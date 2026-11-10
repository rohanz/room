import fs from 'node:fs'
import path from 'node:path'
import { exitedPid } from '../../relay/test/exited-pid.js'
import { rm } from 'node:fs/promises'
import { disposePreviewFixture } from './fixtures/preview-disposal.js'
import { publishFixture } from './fixtures/manifest.js'
import { seedRegistryWorker, finishWorker, fixtureId, patchPublisher, registerWorkers, workerByTag, type FixtureWorker } from './registry-fixture.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc, manifestPaths } from '@room/shared'
import { WorkerRegistry, closeRegistryForDir, localWorkers, registryForDir } from '../src/worker-registry.js'
import { prepareWorktree, saveDiscardPatch } from '../src/worker-git.js'
import { worktreeGitDirFromDotGit } from '@room/roomd'
import { PolicyStore, sharingFile } from '../src/policy-store.js'
import { decideRetire, workerRealState, type WorkerRealState } from '../src/worker-state.js'
import { Rooms } from '../src/registry.js'
import type { Session } from '../src/session.js'
import { handlers as collectHandlers } from '../src/tools/collect.js'
import type { HandlerState } from '../src/tools/context.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { fixtureProcess } from './fixtures/process-liveness.js'

const facts: WorkerRealState = { worktree: 'present', process: 'not-ours', hostSession: false, finished: true, status: 'done', dismissed: false, merged: false, clean: false, ahead: 1 }
// Seeding a registry worker takes seconds (lease guards and process probes).
vi.setConfig({ testTimeout: 60_000 })

const workerGitFacts = async (dir: string, w: FixtureWorker) => {
  const state = await workerRealState(dir, w, { git: true, leadName: w.lead })
  return { merged: state.merged ?? false, clean: state.clean ?? false, ahead: state.ahead, ...(state.uncommitted !== undefined ? { uncommitted: state.uncommitted } : {}) }
}
const worker = (dir: string): FixtureWorker => ({ id: 'lead/w#1', name: 'lead+w', tag: 'w', lead: 'lead', host: 'codex', task: 'task', dir, branch: 'room/w', pid: exitedPid(), startedAt: 1, status: 'done', summary: 'done', exitCode: 0 })
const dirs: string[] = []
const maintenanceDirs = new Set<string>()
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) {
    if (maintenanceDirs.has(dir)) await disposePreviewFixture(dir, { registries: [dir] })
    else { await closeRegistryForDir(dir); await rm(dir, { recursive: true, force: true }) }
  }
  maintenanceDirs.clear()
})

let sweepTime = Date.now()
function nextSweep() { vi.spyOn(Date, 'now').mockReturnValue(sweepTime += 3_600_001) }

describe('clone-wide cleanup after the original lead is gone', () => {
  it.each(['recorded', 'missing'])('keeps a retired legacy checkout while its host still runs (start time %s)', async identityState => {
    nextSweep()
    const { dir } = repo(), r = registry(dir)
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    const w = { ...worker(prepared.dir), base: prepared.base, pid: 812348, processStartTime: 'fixture:legacy-host' }
    const workers = await registerWorkers(r.s, [w]), id = fixtureId(w)
    const archive = { ...await workers.archiveOf((await workers.read(id))!, { summary: 'done', disposition: 'collected' }), keptWorktree: w.dir, keptReason: 'clean exit not confirmed' }
    await workers.beginRetirement(id, archive, { keptWorktree: w.dir })
    await workers.finishCleanup(id, r.s.roomName)
    if (identityState === 'missing') await mutateWorkerFixture(workers, id, old => ({ ...old, runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: w.pid } }], seq: old.seq + 1 }))
    const identity = fixtureProcess(w.pid, w.processStartTime, 'codex')
    vi.spyOn(r.rooms, 'probe').mockReturnValue(identity)
    await r.rooms.autoRetire()
    expect(existsSync(w.dir)).toBe(true)
    expect((await workers.read(id))?.keptWorktree).toBe(w.dir)
    r.close()
  })

  it('removes leftover sidecars of an already-retired worker without a kept marker', async () => {
    nextSweep()
    const { dir } = repo(), r = registry(dir), w = worker(join(dir, '.room/workers/w'))
    const workers = await registerWorkers(r.s, [w]), id = fixtureId(w)
    await workers.beginRetirement(id, await workers.archiveOf((await workers.read(id))!, { summary: 'done' }))
    await workers.finishCleanup(id, r.s.roomName)
    mkdirSync(join(dir, '.room/workers'), { recursive: true })
    writeFileSync(join(dir, '.room/workers/w.log'), 'old log')
    await r.rooms.autoRetire()
    expect(existsSync(join(dir, '.room/workers/w.log'))).toBe(false)
    r.close()
  })

  it.each(['gone', 'branch', 'checkout', 'process', 'other-lead', 'team', 'record'])('reconciles only safe local orphan kept archives: %s', async condition => {
    nextSweep()
    const { dir, git } = repo(), r = registry(dir), w = worker(join(dir, '.room/workers/w'))
    const workers = await registerWorkers(r.s, [w]), id = fixtureId(w)
    const archive = { ...await workers.archiveOf((await workers.read(id))!, { summary: 'done', disposition: 'collected' }), keptWorktree: w.dir, keptReason: 'nested workers remain' }
    if (condition !== 'record') {
      rmSync(join(workers.root, 'workers', id + '.json'))
      rmSync(join(workers.root, 'tags', 'w.json'))
    } else {
      const identity = fixtureProcess(812349, 'fixture:retained-host', 'codex')
      await mutateWorkerFixture(workers, id, old => ({ ...old, runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: identity.pid, process: identity } }], seq: old.seq + 1 }))
      vi.spyOn(r.rooms, 'probe').mockReturnValue(identity)
    }
    if (condition === 'other-lead') archive.lead = 'someone-else'
    r.room.doc.getArray('retiredWorkers').push([archive])
    r.room.workerViews.delete(id)
    if (condition !== 'team') r.s.local = {} as Session['local']
    if (condition === 'checkout') mkdirSync(w.dir, { recursive: true })
    if (condition === 'branch') git('branch', 'room/w')
    if (condition === 'process') vi.spyOn(r.rooms, 'listCwdProcesses', 'get').mockReturnValue(() => [{ pid: 812349, cwd: w.dir, command: 'codex' }])
    mkdirSync(join(dir, '.room/workers'), { recursive: true })
    writeFileSync(join(dir, '.room/workers/w.log'), 'orphan log')
    await r.rooms.autoRetire()
    expect(r.room.retiredWorkers()[0].keptWorktree).toBe(condition === 'gone' ? undefined : w.dir)
    expect(existsSync(join(dir, '.room/workers/w.log'))).toBe(condition !== 'gone')
    r.close()
  })

  it.each(['dead-lead', 'renamed-lead'])('finishes already-collected output from %s and names it in the log', async lead => {
    nextSweep()
    const { dir } = repo(), r = registry(dir)
    const prepared = await prepareWorktree(dir, 'w', lead)
    const w = { ...worker(prepared.dir), lead, base: prepared.base }
    const workers = await registerWorkers(r.s, [w])
    await workers.deferCollectCleanup(fixtureId(w), 'clean exit not confirmed')
    const log = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await r.rooms.autoRetire()
    expect((await workers.read(fixtureId(w)))?.phase).toBe('retired')
    expect(existsSync(w.dir)).toBe(false)
    expect(log.mock.calls.flat().join('')).toContain('cleaned up w')
    r.close()
  })

  it('does not let mutually nested pending records block each other', async () => {
    nextSweep()
    const { dir } = repo(), r = registry(dir)
    const a = await prepareWorktree(dir, 'a-worker', 'lead'), b = await prepareWorktree(dir, 'b-worker', 'lead')
    const wa = { ...worker(a.dir), id: 'a', tag: 'a-worker', branch: 'room/a-worker', name: 'lead+a', lead: 'lead+b', base: a.base }
    const wb = { ...worker(b.dir), id: 'b', tag: 'b-worker', branch: 'room/b-worker', name: 'lead+b', lead: 'lead+a', base: b.base }
    const workers = await registerWorkers(r.s, [wa, wb])
    for (const w of [wa, wb]) await workers.deferCollectCleanup(fixtureId(w), 'nested workers remain')
    await r.rooms.autoRetire()
    for (const w of [wa, wb]) {
      expect((await workers.read(fixtureId(w)))?.phase).toBe('retired')
      expect(existsSync(w.dir)).toBe(false)
    }
    r.close()
  })

  it('cleans actual nested pending worktrees before their already-collected parent', async () => {
    nextSweep()
    const { dir } = repo(), r = registry(dir)
    const parent = await prepareWorktree(dir, 'w', 'departed-lead')
    const w = { ...worker(parent.dir), lead: 'departed-lead', base: parent.base }
    const nested = await prepareWorktree(parent.dir, 'child', w.name)
    const child = { ...worker(nested.dir), id: 'child', tag: 'child', branch: 'room/child', name: 'lead+w+child', lead: w.name, base: nested.base }
    const workers = await registerWorkers(r.s, [w, child])
    for (const item of [w, child]) await workers.deferCollectCleanup(fixtureId(item), 'cleanup incomplete')
    await r.rooms.autoRetire()
    for (const item of [w, child]) expect((await workers.read(fixtureId(item)))?.phase).toBe('retired')
    expect(existsSync(w.dir)).toBe(false)
    r.close()
  })

  it('ignores a nested record whose process and checkout are gone even if its branch survives', async () => {
    nextSweep()
    const { dir, git } = repo(), r = registry(dir)
    const a = await prepareWorktree(dir, 'w', 'lead')
    git('branch', 'room/child')
    const w = { ...worker(a.dir), base: a.base }
    const child = { ...worker(join(dir, '.room/workers/child')), id: 'child', tag: 'child', branch: 'room/child', name: 'lead+w+child', lead: w.name, hostSessionId: 'retained' }
    const workers = await registerWorkers(r.s, [w, child])
    await workers.deferCollectCleanup(fixtureId(w), 'nested workers remain')
    await r.rooms.autoRetire()
    expect((await workers.read(fixtureId(w)))?.phase).toBe('retired')
    expect(git('branch', '--list', 'room/child')).toContain('room/child')
    r.close()
  })

  it('finishes pending collection when a different process reused its pid', async () => {
    nextSweep()
    const { dir } = repo(), r = registry(dir)
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    const w = { ...worker(prepared.dir), base: prepared.base, pid: 812345, processStartTime: 'fixture:old-host' }
    const workers = await registerWorkers(r.s, [w])
    fixtureProcess(w.pid, 'fixture:unrelated-new-host', 'codex')
    const probe = vi.spyOn(r.rooms, 'probe').mockReturnValue({ startTime: 'fixture:unrelated-new-host', executable: 'codex' })
    await workers.deferCollectCleanup(fixtureId(w), 'clean exit not confirmed')
    const state = { rooms: r.rooms, S: () => r.s, now: Date.now, ctx: { probe: r.rooms.probe.bind(r.rooms), listCwdProcesses: () => [] }, workerAlive: () => false } as unknown as HandlerState
    const reply = await collectHandlers(state).room_collect({ tag: 'w' })
    expect(reply).toContain('cleaned up w')
    expect((await workers.read(fixtureId(w)))?.phase).toBe('retired')
    probe.mockRestore()
    r.close()
  })

  it('projects retiring records for a departed lead in a room this clone still holds', async () => {
    nextSweep()
    const { dir } = repo(), r = registry(dir)
    const w = { ...worker(join(dir, '.room/workers/w')), lead: 'departed-lead' }
    const workers = await registerWorkers(r.s, [w]), id = fixtureId(w)
    await workers.beginRetirement(id, await workers.archiveOf((await workers.read(id))!, { summary: 'collected', disposition: 'collected' }))
    expect((await workers.read(id))?.cleanup?.[r.s.roomName]).toBe('pending')
    await r.rooms.autoRetire()
    expect((await workers.read(id))?.phase).toBe('retired')
    expect(r.room.workerViews.has(id)).toBe(false)
    expect(r.room.retiredWorkers().some(entry => entry.id === id)).toBe(true)
    r.close()
  })

  it('finishes another lead’s retirement without rewriting its active sibling views or fence', async () => {
    nextSweep()
    const { dir } = repo(), r = registry(dir)
    const prepared = await prepareWorktree(dir, 'sibling', 'another-lead')
    const sibling = { ...worker(prepared.dir), id: 'sibling', tag: 'sibling', branch: 'room/sibling', name: 'lead+sibling', lead: 'another-lead', base: prepared.base, hostSessionId: 'retained' }
    const ended = { ...worker(join(dir, '.room/workers/w')), lead: 'another-lead' }
    const workers = await registerWorkers(r.s, [ended, sibling]), id = fixtureId(ended)
    const original = { ...r.room.workerViews.get(fixtureId(sibling))!, fence: 'other-lead-live-fence' }
    r.room.workerViews.set(fixtureId(sibling), original)
    await workers.beginRetirement(id, await workers.archiveOf((await workers.read(id))!, { summary: 'done' }))
    await r.rooms.autoRetire()
    expect((await workers.read(id))?.phase).toBe('retired')
    expect(r.room.workerViews.get(fixtureId(sibling))).toEqual(original)
    r.close()
  })

  it.each(['clean exit not confirmed', 'cleanup incomplete', 'nested workers remain'])('clears legacy kept markers and sidecars after a missing checkout (%s)', async keptReason => {
    nextSweep()
    const { dir } = repo(), r = registry(dir)
    const w = { ...worker(join(dir, '.room/workers/w')), lead: 'departed-lead' }
    const workers = await registerWorkers(r.s, [w]), id = fixtureId(w)
    const archive = { ...await workers.archiveOf((await workers.read(id))!, { summary: 'done', disposition: 'collected' }), keptWorktree: w.dir, keptReason }
    await workers.beginRetirement(id, archive, { keptWorktree: w.dir })
    await workers.finishCleanup(id, r.s.roomName)
    r.room.doc.getArray('retiredWorkers').push([archive])
    mkdirSync(join(dir, '.room/workers'), { recursive: true })
    const files = ['.log', '.mcp.log', '.env.sh', '.shell-env.mjs'].map(suffix => join(dir, '.room/workers', 'w' + suffix))
    for (const file of files) writeFileSync(file, 'leftover')
    await r.rooms.autoRetire()
    expect((await workers.read(id))?.keptWorktree).toBeUndefined()
    expect(r.room.retiredWorkers()[0].keptWorktree).toBeUndefined()
    for (const file of files) expect(existsSync(file)).toBe(false)
    r.close()
  })
})
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'room-retirement-')); dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@test'); git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'a'), 'one'); git('add', '.'); git('commit', '-qm', 'initial')
  return { dir, git }
}
function registry(dir: string) {
  // Local state is already migrated: worktrees these tests create are registered by the fixture, not imported.
  mkdirSync(join(dir, '.git', 'room', 'registry'), { recursive: true })
  writeFileSync(join(dir, '.git', 'room', 'registry', 'migration.json'), JSON.stringify({ v: 1, sources: {}, done: true }))
  const room = new RoomDoc()
  const s = { ...hubSeam(room), policyStore: testPolicyStore(), room, dir, me: { name: 'lead' }, roomName: 'local/repo/main', roomUrl: 'ws://team/local%2Frepo%2Fmain',
    daemon: { fence: 'lead-session' }, provider: { on() {}, off() {} } } as unknown as Session
  let primary: Session | null = s
  const rooms = new Rooms({ primary: () => primary, setPrimary: p => { primary = p }, attach: () => ({ stop() {} }), listCwdProcesses: () => [] })
  rooms.track(s)
  const autoRetire = rooms.autoRetire.bind(rooms)
  rooms.autoRetire = async () => { maintenanceDirs.add(dir); await autoRetire() }
  const has = async (tag: string) => !!(await workerByTag(dir, tag))
  return { room, s, rooms, has, close: () => { rooms.remove(s); room.doc.destroy() } }
}

describe('decideRetire', () => {
  it.each([
    [{ process: 'ours', dismissed: true, merged: true, clean: true, ahead: 0 }, undefined],
    [{ status: 'failed', merged: true, clean: true, ahead: 0 }, undefined],
    [{ status: 'failed', dismissed: true }, 'dismissed'],
    [{ dismissed: true, merged: true }, 'dismissed'],
    [{ merged: true, clean: false, ahead: 0 }, undefined],
    [{ merged: true, clean: true, ahead: 0, uncommitted: 0 }, 'merged'],
    [{ merged: true, clean: true, ahead: undefined }, undefined],
    [{ clean: true, ahead: 0 }, 'clean'],
    [{ clean: false, ahead: 0 }, undefined],
    [{ clean: true, ahead: 1 }, undefined],
    [{ clean: true, ahead: undefined }, undefined],
  ] as [Partial<WorkerRealState>, string | undefined][])('evaluates %j as %s', (patch, outcome) => {
    expect(decideRetire({ ...facts, ...patch })).toBe(outcome)
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
  it('retains checkout and coordination when a borrower record blocks auto-retirement', async () => {
    const { dir } = repo(), r = registry(dir)
    try {
      const prepared = await prepareWorktree(dir, 'w', 'lead'), owner = { ...worker(prepared.dir), base: prepared.base }
      const borrower = { ...owner, id: 'w_borrower', tag: 'borrower', name: 'lead+borrower', sharedWith: fixtureId(owner), status: 'running' as const }
      await registerWorkers(r.s, [owner, borrower])
      r.room.addClaim({ by: owner.name, byKind: 'agent', path: 'a', from: 1, to: 1, intent: 'work' })
      const store = await registryForDir(dir)
      writeFileSync(join(store.root, 'workers', `${fixtureId(borrower)}.json`), '{malformed')
      await expect(r.rooms.autoRetire()).rejects.toThrow(fixtureId(borrower))
      expect(existsSync(owner.dir)).toBe(true)
      expect((await store.read(fixtureId(owner)))?.phase).toBe('active')
      expect(r.room.openClaims().some(c => c.by === owner.name)).toBe(true)
    } finally { r.close() }
  })

  it('auto-retires a worker whose worktree vanished and keeps unmerged commits', async () => {
    const { dir, git } = repo(), r = registry(dir)
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    const w = { ...worker(prepared.dir), base: prepared.base }
    writeFileSync(join(w.dir, 'worker.txt'), 'work')
    execFileSync('git', ['-C', w.dir, 'add', 'worker.txt'])
    execFileSync('git', ['-C', w.dir, 'commit', '-qm', 'worker'])
    await registerWorkers(r.s, [w])
    publishFixture(r.room, w.name, 'worker.txt', 'work')
    r.room.addClaim({ by: w.name, byKind: 'agent', path: 'worker.txt', from: 1, to: 1, intent: 'work' })
    rmSync(w.dir, { recursive: true, force: true })
    await r.rooms.autoRetire()
    expect((await r.has(w.tag))).toBe(false)
    expect(r.room.manifestHead.has(w.name)).toBe(false)
    expect(r.room.openClaims().filter(c => c.by === w.name)).toEqual([])
    expect(git('branch', '--list', 'room/w')).toContain('room/w')
    expect(git('worktree', 'list', '--porcelain')).not.toContain(w.dir)
    r.close()
  })
  it('keeps a vanished done worker with a host session addressable for follow-up', async () => {
    const { dir, git } = repo(), r = registry(dir)
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    const w = { ...worker(prepared.dir), hostSessionId: 'host-session' }
    await registerWorkers(r.s, [w])
    rmSync(w.dir, { recursive: true, force: true })
    await r.rooms.autoRetire()
    expect((await r.has('w'))).toBe(true)
    expect(git('branch', '--list', 'room/w')).toContain('room/w')
    r.close()
  })
  it('retains a done worker and its actionable record when ignored output remains', async () => {
    const { dir } = repo(), r = registry(dir)
    writeFileSync(join(dir, '.gitignore'), 'artifact.bin\n')
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    const w = { ...worker(prepared.dir), base: prepared.base }
    writeFileSync(join(w.dir, 'artifact.bin'), 'worker artifact')
    await registerWorkers(r.s, [w])
    await r.rooms.autoRetire()
    expect(existsSync(join(w.dir, 'artifact.bin'))).toBe(true)
    expect((await r.has('w'))).toBe(true)
    expect(r.room.retiredWorkers()).toEqual([])
    await finishWorker(r.s, 'w', { status: 'dismissed' })
    await r.rooms.autoRetire()
    expect((await r.has('w'))).toBe(true)
    expect(r.room.retiredWorkers()).toEqual([])
    r.close()
  })

  it('finishes a pending collection once the host is gone, under collect’s ignored and uncollected rules', async () => {
    const { dir, git } = repo(), r = registry(dir)
    writeFileSync(join(dir, '.gitignore'), 'artifact.bin\n'); git('add', '.'); git('commit', '-qm', 'ignore')
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    // A finished host session normally keeps a worker addressable; a pending collection is cleaned anyway.
    const w = { ...worker(prepared.dir), base: prepared.base, hostSessionId: 'host-session' }
    const workers = await registerWorkers(r.s, [w])
    const id = fixtureId(w)
    // Collection applied the worker's edit to the lead, then could not confirm its host's clean exit.
    writeFileSync(join(w.dir, 'a'), 'worker edit'); writeFileSync(join(dir, 'a'), 'worker edit')
    writeFileSync(join(w.dir, 'artifact.bin'), 'ignored output')
    await workers.deferCollectCleanup(id, 'exit not witnessed')
    await r.rooms.autoRetire()
    expect((await workers.read(id))).toMatchObject({ phase: 'active', collectPending: { reason: 'uncopied ignored artifacts' } })
    expect(existsSync(join(w.dir, 'artifact.bin'))).toBe(true)
    rmSync(join(w.dir, 'artifact.bin'))
    // Written after collection: the lead does not hold it, so the worktree stays with a live record.
    writeFileSync(join(w.dir, 'late.txt'), 'late')
    await r.rooms.autoRetire()
    expect((await workers.read(id))?.phase).toBe('active')
    expect(r.room.retiredWorkers()).toEqual([])
    rmSync(join(w.dir, 'late.txt'))
    await r.rooms.autoRetire()
    expect((await workers.read(id))?.phase).toBe('retired')
    expect((await workers.read(id))?.keptWorktree).toBeUndefined()
    expect(existsSync(prepared.dir)).toBe(false)
    expect(git('branch', '--list', 'room/w')).toBe('')
    expect(r.room.retiredWorkers()).toMatchObject([{ tag: 'w', disposition: 'collected' }])
    r.close()
  })

  it('keeps a pending collection live while a nested worker remains, then finishes it', async () => {
    const { dir } = repo(), r = registry(dir)
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    const w = { ...worker(prepared.dir), base: prepared.base }
    const childDir = await prepareWorktree(dir, 'c', 'lead')
    const child: FixtureWorker = { ...worker(childDir.dir), id: 'lead+w/c#1', name: 'lead+w+c', tag: 'c', lead: 'lead+w', branch: 'room/c', base: childDir.base, status: 'running' }
    const workers = await registerWorkers(r.s, [w, child])
    const id = fixtureId(w)
    await workers.deferCollectCleanup(id, 'nested workers remain: c')
    await r.rooms.autoRetire()
    expect((await workers.read(id))).toMatchObject({ phase: 'active', collectPending: { reason: 'nested workers remain: c' } })
    expect(existsSync(prepared.dir)).toBe(true)
    await workers.beginRetirement(fixtureId(child), (await workers.archiveOf((await workers.read(fixtureId(child)))!, { summary: 'gone' })))
    await r.rooms.autoRetire()
    expect((await workers.read(id))?.phase).toBe('retired')
    expect(existsSync(prepared.dir)).toBe(false)
    r.close()
  })

  it('completes retirement of a record whose completion was never posted before it began retiring', async () => {
    const { dir } = repo(), r = registry(dir)
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    const w = { ...worker(prepared.dir), base: prepared.base, status: 'running' as const }
    const workers = await registerWorkers(r.s, [w])
    const id = fixtureId(w), record = (await workers.read(id))!
    // Report and exit land, and retirement begins, before any projection posts the completion.
    await workers.writeReport(id, { run: 1, nonce: record.runs[0].nonce, chain: [], joinedAt: record.createdAt, done: { at: Date.now(), summary: 'done', changed: [] } })
    await workers.writeExit(id, { run: 1, code: 0, at: Date.now(), witnessed: true })
    await workers.beginRetirement(id, (await workers.archiveOf(record, { summary: 'done' })))
    await r.rooms.project()
    expect((await workers.read(id))?.phase).toBe('retired')
    expect((await workers.read(id))?.runs[0].posted).toBeDefined()
    expect(r.room.retiredWorkers().map(entry => entry.tag)).toEqual(['w'])
    r.close()
  })

  it('adopts a 0.17.30 retired record kept for an unconfirmed exit once its output is fully collected', async () => {
    const { dir, git } = repo(), r = registry(dir)
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    const w = { ...worker(prepared.dir), base: prepared.base }
    const workers = await registerWorkers(r.s, [w])
    const id = fixtureId(w)
    writeFileSync(join(w.dir, 'a'), 'worker edit'); writeFileSync(join(dir, 'a'), 'worker edit')
    writeFileSync(join(w.dir, 'late.txt'), 'written after collection')
    const archive = { ...(await workers.archiveOf((await workers.read(id))!, { summary: 'done', disposition: 'collected' })), keptWorktree: w.dir, keptReason: 'clean exit not confirmed' }
    await workers.beginRetirement(id, archive, { keptWorktree: w.dir })
    await r.rooms.project()
    expect((await workers.read(id))?.phase).toBe('retired')
    expect(r.room.retiredWorkers()[0].keptWorktree).toBe(w.dir)
    // Something the lead does not hold stays for the lead to recover; nothing is deleted.
    await r.rooms.autoRetire()
    expect(existsSync(join(w.dir, 'late.txt'))).toBe(true)
    expect((await workers.read(id))?.keptWorktree).toBe(w.dir)
    rmSync(join(w.dir, 'late.txt'))
    await r.rooms.autoRetire()
    expect(existsSync(prepared.dir)).toBe(false)
    expect(git('branch', '--list', 'room/w')).toBe('')
    expect((await workers.read(id))?.phase).toBe('retired')
    expect((await workers.read(id))?.keptWorktree).toBeUndefined()
    expect((await workers.read(id))?.archive?.keptReason).toBeUndefined()
    expect(r.room.retiredWorkers()[0].keptWorktree).toBeUndefined()
    r.close()
  })

  it('retains the record when automatic worktree cleanup cannot safely complete', async () => {
    const { dir } = repo(), r = registry(dir)
    const w = { ...worker(dir), branch: 'main' }
    await registerWorkers(r.s, [w])
    await r.rooms.autoRetire()
    expect((await r.has('w'))).toBe(true)
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
    await registerWorkers(r.s, [w])
    await r.rooms.autoRetire()
    expect(r.room.retiredWorkers()).toMatchObject([{ outcome: 'clean' }])
    expect(existsSync(prepared.dir)).toBe(false)
    expect(git('rev-parse', 'HEAD')).not.toBe(prepared.base)
    r.close()
  })

  it('removes the worktree of a clean worker that reported done before its host exited non-zero', async () => {
    // Its report wins (registry §6): retiring it without cleanup orphaned the worktree.
    const { dir } = repo(), r = registry(dir)
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    await registerWorkers(r.s, [{ ...worker(prepared.dir), base: prepared.base, exitCode: 1 }])
    await r.rooms.autoRetire()
    expect(r.room.retiredWorkers()).toMatchObject([{ outcome: 'clean' }])
    expect(existsSync(prepared.dir)).toBe(false)
    r.close()
  })

  it('saves only worker edits in a discard patch after a real carried commit', async () => {
    const { dir } = repo()
    writeFileSync(join(dir, 'a'), 'lead WIP')
    const prepared = await prepareWorktree(dir, 'w', 'lead')
    const w = { ...worker(prepared.dir), base: prepared.base }
    expect(await saveDiscardPatch(dir, w, patchPublisher(dir, w.tag))).toBeUndefined()
    writeFileSync(join(w.dir, 'worker.txt'), 'worker output')
    const patch = await saveDiscardPatch(dir, w, patchPublisher(dir, w.tag))
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
    const w = { ...worker(prepared.dir), base: prepared.base, carriedBase: prepared.carriedBase, carriedUntracked: prepared.carriedUntracked }
    await registerWorkers(r.s, [w])
    let alive = true
    const state = {
      S: () => r.s, rooms: r.rooms, now: Date.now, workerAlive: () => alive,
      ctx: { listCwdProcesses: () => [], sleep: async () => { alive = false } },
    } as unknown as HandlerState
    maintenanceDirs.add(dir)
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
    await registerWorkers(r.s, [w])
    publishFixture(r.room, w.name, 'a', 'worker output')
    await r.rooms.autoRetire()
    expect((await r.has(w.tag))).toBe(false)
    expect(r.room.retiredWorkers()).toMatchObject([{ outcome: 'merged' }])
    expect(manifestPaths(r.room, w.name)).toEqual([])
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
    await registerWorkers(r.s, [w])
    publishFixture(r.room, w.name, 'a', 'published')
    const proc = { pid: 1, onExit() {}, kill: () => true }
    r.rooms.setHandle(r.s, fixtureId(w), proc)
    await r.rooms.autoRetire(); expect((await r.has(w.tag))).toBe(true)
    r.rooms.dropHandle(r.s, fixtureId(w), proc)
    await r.rooms.autoRetire()
    expect(r.room.retiredWorkers()).toMatchObject([{ id: fixtureId(w), outcome: 'clean', files: ['a'], summary: 'done' }])
    await registerWorkers(r.s, [{ ...w, id: 'w_second', startedAt: 2, status: 'failed', exitCode: 1 }])
    await r.rooms.autoRetire(); expect((await r.has(w.tag))).toBe(true)
    await finishWorker(r.s, w.tag, { status: 'dismissed' })
    await r.rooms.autoRetire(); expect(r.room.retiredWorkers().at(-1)).toMatchObject({ id: 'w_second', outcome: 'dismissed' })
    await registerWorkers(r.s, [{ ...w, id: 'w_third', lead: 'someone else' }])
    await r.rooms.autoRetire(); expect((await r.has(w.tag))).toBe(true)
    r.close()
  })

  it('evaluates on the slow timer and cancels it when the session leaves', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { dir } = repo(), r = registry(dir), missing = join(dir, '.room', 'workers', 'w')
    await registerWorkers(r.s, [{ ...worker(missing), status: 'dismissed' }])
    await vi.advanceTimersByTimeAsync(60_000)
    await r.rooms.autoRetire()
    expect(r.room.retiredWorkers()).toHaveLength(1)
    r.rooms.remove(r.s)
    await registerWorkers(r.s, [{ ...worker(missing), id: 'w_later', startedAt: 2, status: 'dismissed' }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect((await localWorkers(dir))).toHaveLength(1)
    r.room.doc.destroy()
  })
})

it('keeps uncommitted work visible until the lead commits and merges it; merged dirty work stays live', async () => {
  const { dir, git } = repo(), r = registry(dir)
  const prepared = await prepareWorktree(dir, 'w')
  const w = { ...worker(prepared.dir), base: prepared.base }
  await registerWorkers(r.s, [w])
  writeFileSync(join(w.dir, 'a'), 'worker edit')
  writeFileSync(join(w.dir, 'new\nfile'), 'untracked')
  publishFixture(r.room, w.name, 'a', 'worker edit')
  await r.rooms.autoRetire()
  expect((await r.has(w.tag))).toBe(true)
  expect(manifestPaths(r.room, w.name)).toEqual(['a'])
  expect(await workerGitFacts(dir, w)).toMatchObject({ ahead: 0, clean: false, uncommitted: 2 })
  execFileSync('git', ['-C', w.dir, 'add', '.'])
  execFileSync('git', ['-C', w.dir, 'commit', '-qm', 'lead commits worker work'])
  await r.rooms.autoRetire()
  expect((await r.has(w.tag))).toBe(true)
  git('merge', '--ff-only', w.branch)
  writeFileSync(join(w.dir, 'a'), 'dirty after merge')
  await r.rooms.autoRetire()
  expect((await r.has(w.tag))).toBe(true)
  execFileSync('git', ['-C', w.dir, 'restore', 'a'])
  await r.rooms.autoRetire()
  expect(r.room.retiredWorkers()).toMatchObject([{ outcome: 'merged' }])
  expect(manifestPaths(r.room, w.name)).toEqual([])
  r.close()
})

it('retires clean zero-commit and legacy workers as clean, and archives dismissed dirty file counts', async () => {
  const { dir } = repo(), r = registry(dir)
  const prepared = await prepareWorktree(dir, 'w')
  const w = { ...worker(prepared.dir), base: prepared.base }
  await registerWorkers(r.s, [w])
  await r.rooms.autoRetire()
  expect(r.room.retiredWorkers()).toMatchObject([{ outcome: 'clean' }])
  // a clean retirement removes the worktree and its branch; the next worker of that tag starts fresh
  expect(existsSync(w.dir)).toBe(false)
  await prepareWorktree(dir, 'w')
  const legacy = { ...w, id: 'w_legacy', base: undefined, startedAt: 2 }
  writeFileSync(join(w.dir, 'a'), 'two')
  execFileSync('git', ['-C', w.dir, 'commit', '-qam', 'change'])
  execFileSync('git', ['-C', dir, 'merge', '--ff-only', w.branch])
  await registerWorkers(r.s, [legacy])
  await r.rooms.autoRetire()
  expect(r.room.retiredWorkers().at(-1)?.outcome).toBe('clean')
  await prepareWorktree(dir, 'w')
  writeFileSync(join(w.dir, 'a'), 'three')
  writeFileSync(join(w.dir, 'new'), 'untracked')
  await registerWorkers(r.s, [{ ...w, id: 'w_dismissed', startedAt: 3, status: 'dismissed' }])
  await r.rooms.autoRetire()
  expect(r.room.retiredWorkers().at(-1)).toMatchObject({ outcome: 'dismissed', uncommitted: 2 })
  r.close()
})

it('clears a dismissed dirty worker sharing record while keeping another room', async () => {
  const { dir } = repo(), r = registry(dir)
  const prepared = await prepareWorktree(dir, 'w', 'lead')
  const w = { ...worker(prepared.dir), base: prepared.base, status: 'dismissed' as const }
  writeFileSync(join(w.dir, 'a'), 'dirty work')
  await PolicyStore.open({ dir: w.dir, room: r.s.roomName, participant: w.name, requested: 'declared' })
  await PolicyStore.open({ dir: w.dir, room: 'repo/main', participant: w.name, requested: 'declared' })
  const sharing = await sharingFile(w.dir, r.s.roomName, w.name)
  const other = await sharingFile(w.dir, 'repo/main', w.name)
  await registerWorkers(r.s, [w])
  await r.rooms.autoRetire()
  expect(r.room.retiredWorkers().at(-1)?.outcome).toBe('dismissed')
  expect(existsSync(w.dir)).toBe(true)
  expect(existsSync(sharing)).toBe(false)
  expect(existsSync(other)).toBe(true)
  r.close()
})

it('removes a matching legacy grant during retirement so it cannot migrate on a later join', async () => {
  const { dir } = repo(), r = registry(dir)
  const prepared = await prepareWorktree(dir, 'w', 'lead')
  const w = { ...worker(prepared.dir), base: prepared.base, status: 'dismissed' as const }
  writeFileSync(join(w.dir, 'a'), 'dirty work')
  const legacy = join(worktreeGitDirFromDotGit(w.dir), 'room-retained-declared.json')
  writeFileSync(legacy, JSON.stringify({ server: 'ws://team', room: r.s.roomName, participant: w.name, paths: ['a'] }))
  await registerWorkers(r.s, [w])
  await r.rooms.autoRetire()
  expect(r.room.retiredWorkers().at(-1)?.outcome).toBe('dismissed')
  expect(existsSync(w.dir)).toBe(true)
  expect(existsSync(legacy)).toBe(false)
  const reopened = await PolicyStore.open({ dir: w.dir, room: r.s.roomName, participant: w.name, server: 'ws://team', requested: 'declared' })
  expect(reopened.retained).toEqual([])
  r.close()
})

it('retains workers when the worktree, branch, fork commit or lead git state is unknown', async () => {
  for (const patch of [{ dir: '/missing' }, { branch: 'missing' }, { base: 'missing' }]) {
    const { dir } = repo(), r = registry(dir)
    const prepared = await prepareWorktree(dir, 'w')
    const w = { ...worker(prepared.dir), base: prepared.base }
    await registerWorkers(r.s, [{ ...w, ...patch }])
    await r.rooms.autoRetire()
    expect((await r.has(w.tag))).toBe(true)
    expect(r.room.retiredWorkers()).toEqual([])
    expect((await workerGitFacts('/missing', w)).ahead).toBeUndefined()
    r.close()
  }
})

async function retiredSidecars(dir: string, s: Session, patch = {}) {
  const { registry, record } = await seedRegistryWorker(dir, 'same', patch)
  await registry.beginRetirement(record.id, await registry.archiveOf(record, { summary: 'done' }))
  await registry.finishCleanup(record.id, s.roomName)
  return { registry, record }
}

it('preserves sidecars inside an unrelated outside checkout on a later retirement sweep', async () => {
  nextSweep()
  const { dir } = repo(), r = registry(dir), outside = mkdtempSync(join(tmpdir(), 'room-outside-sidecars-'))
  dirs.push(outside)
  try {
    const checkout = join(outside, '.room/workers/existing'); mkdirSync(checkout, { recursive: true })
    await retiredSidecars(dir, r.s, { room: r.s.roomName, dir: checkout, outside: true,
      capabilities: { collect: 'none', signal: false, resume: false }, logFile: join(dir, '.room/workers/same.log') })
    for (const suffix of ['.log', '.mcp.log', '.env.sh', '.shell-env.mjs']) writeFileSync(join(outside, '.room/workers/same' + suffix), 'outside owned')
    await r.rooms.autoRetire()
    for (const suffix of ['.log', '.mcp.log', '.env.sh', '.shell-env.mjs']) expect(readFileSync(join(outside, '.room/workers/same' + suffix), 'utf8')).toBe('outside owned')
  } finally { r.close() }
})

it('preserves another lead same-tag successor sidecars after a stale retired reservation read', async () => {
  nextSweep()
  const { dir } = repo(), r = registry(dir)
  try {
    const { registry: workers, record } = await retiredSidecars(dir, r.s, { room: r.s.roomName })
    let spawned = false
    const original = WorkerRegistry.prototype.reserved, log = join(dir, '.room/workers/same.log')
    vi.spyOn(WorkerRegistry.prototype, 'reserved').mockImplementation(async function (this: WorkerRegistry, tag) {
      const value = await original.call(this, tag)
      if (!spawned && this.commonDir === workers.commonDir && tag === 'same' && value?.id === record.id) {
        spawned = true
        await seedRegistryWorker(dir, 'same', { name: 'other-lead+same', lead: { ...record.lead, participant: 'other-lead' } })
        mkdirSync(path.dirname(log), { recursive: true })
        for (const suffix of ['.log', '.mcp.log', '.env.sh', '.shell-env.mjs']) writeFileSync(join(dir, '.room/workers/same' + suffix), 'successor transcript')
      }
      return value
    })
    await r.rooms.autoRetire()
    expect(spawned).toBe(true)
    expect((await original.call(workers, 'same'))?.id).not.toBe(record.id)
    for (const suffix of ['.log', '.mcp.log', '.env.sh', '.shell-env.mjs']) expect(readFileSync(join(dir, '.room/workers/same' + suffix), 'utf8')).toBe('successor transcript')
  } finally { r.close() }
})

it('preserves a successor created after an orphan archive inventory was captured', async () => {
  nextSweep()
  const { dir } = repo(), r = registry(dir), w = worker(join(dir, '.room/workers/w'))
  try {
    r.s.local = {} as Session['local']
    const workers = await registerWorkers(r.s, [w]), id = fixtureId(w)
    r.room.doc.getArray('retiredWorkers').push([{ ...await workers.archiveOf((await workers.read(id))!, { summary: 'done' }),
      keptWorktree: w.dir, keptReason: 'cleanup incomplete' }])
    r.room.workerViews.delete(id)
    rmSync(join(workers.root, 'workers', id + '.json'))
    rmSync(join(workers.root, 'tags', 'w.json'))
    const original = WorkerRegistry.prototype.list
    let spawned = false
    vi.spyOn(WorkerRegistry.prototype, 'list').mockImplementation(async function (this: WorkerRegistry, ...args) {
      const inventory = await original.apply(this, args)
      if (!spawned && this.commonDir === workers.commonDir && !inventory.records.length) {
        spawned = true
        await seedRegistryWorker(dir, 'w', { name: 'another+w', lead: { participant: 'another', room: r.s.roomName, instance: workers.instance } })
        mkdirSync(join(dir, '.room/workers'), { recursive: true })
        writeFileSync(join(dir, '.room/workers/w.log'), 'live successor')
      }
      return inventory
    })
    await r.rooms.autoRetire()
    expect(spawned).toBe(true)
    expect(readFileSync(join(dir, '.room/workers/w.log'), 'utf8')).toBe('live successor')
    expect(r.room.retiredWorkers()[0].keptWorktree).toBe(w.dir)
  } finally { r.close() }
})
