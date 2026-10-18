import { realGitCommonDir } from '@room/roomd'
import { manifestPaths, RoomDoc, splitParticipants } from '@room/shared'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import * as Y from 'yjs'
import type { Session } from '../src/session.js'
import { handlers } from '../src/tools/collect.js'
import type { HandlerState } from '../src/tools/context.js'
import { projectWorkers } from '../src/worker-projector.js'
import { closeRegistryForDir, localWorkers, registryForDir } from '../src/worker-registry.js'
import { isOwnedWorkerWorktree, roomWorkerPathMatchesBranch } from '../src/worker-state.js'
import { hubSeam } from './fixtures/hub.js'
import { publishFixture } from './fixtures/manifest.js'
import { clearFixtureProcesses, fixtureLiveness } from './fixtures/process-liveness.js'
import { testPolicyStore } from './policy-fixture.js'
import { registerWorkers, workerByTag, type FixtureWorker } from './registry-fixture.js'

// Collection runs real Git and filesystem cleanup; wait for outcomes, not a 5 s wall-clock cap.
vi.setConfig({ testTimeout: 30_000 })

// Synthetic worker PIDs must use the same liveness facts as registerWorkers/finishWorker.
vi.mock('../src/leases.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/leases.js')>()
  return { ...actual, liveness: (identity: Parameters<typeof actual.liveness>[0]) => fixtureLiveness(identity, actual.liveness) }
})

const collectRefHook = vi.hoisted(() => ({ call: undefined as undefined | ((ref: string) => void) }))
const gitPathCalls = vi.hoisted(() => [] as string[][])
vi.mock('@room/roomd/git', async importOriginal => {
  const actual = await importOriginal<typeof import('@room/roomd/git')>()
  return { ...actual, git: async (...args: Parameters<typeof actual.git>) => {
    const result = await actual.git(...args)
    if (args[1][0] === 'rev-parse' && args[1].includes('--git-path')) gitPathCalls.push(args[1])
    if (args[1][0] === 'update-ref' && args[1][1]?.startsWith('refs/room/collect-head/')) collectRefHook.call?.(args[1][1])
    return result
  } }
})
const release = vi.hoisted(() => vi.fn())
vi.mock('../src/tools/claims.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/tools/claims.js')>(), releaseClaimsOnDone: release }))
let root: string, lead: string, worker: string, base: string
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const put = (dir: string, p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text) }

beforeEach(() => {
  clearFixtureProcesses()
  release.mockReset()
  gitPathCalls.length = 0
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-collect-')))
  lead = path.join(root, 'lead'); worker = path.join(lead, '.room', 'workers', 'test'); fs.mkdirSync(lead)
  git(lead, 'init', '-q'); git(lead, 'config', 'user.name', 'Lead'); git(lead, 'config', 'user.email', 'lead@example.test')
  put(lead, 'file.txt', 'base\n'); put(lead, '.gitignore', 'artifact.bin\nnode_modules/\n.room/\n')
  git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'base'); base = git(lead, 'rev-parse', 'HEAD')
  git(lead, 'worktree', 'add', '-qb', 'room/test', worker)
})
afterEach(async () => { collectRefHook.call = undefined; await closeRegistryForDir(lead); fs.rmSync(root, { recursive: true, force: true }) })

/** Every lead's projector in the session's room, as each lead session would run it. */
async function projectAll(s: Session): Promise<void> {
  const registry = await registryForDir(s.dir)
  for (const lead of new Set(registry.list().filter(r => r.room === s.roomName).map(r => r.lead.participant))) await projectWorkers(s, registry, lead, 'joined')
}

function setup(status: FixtureWorker['status'] = 'done') {
  const w: FixtureWorker = { tag: 'test', name: 'lead+test', lead: 'lead', dir: worker, branch: 'room/test', status, summary: 'finished\nextra', base, host: 'codex', task: 'task', startedAt: 1, pid: 0 }
  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ base, branch: 'main', repo: 'test' })
  // Workers described before the first call; `sync` writes them to the registry once, as spawn would have.
  const pending = new Map<string, FixtureWorker>([['test', w]])
  const s = { ...hubSeam(room), policyStore: testPolicyStore(), dir: lead, local: {}, roomName: 'local/test', roomUrl: 'ws://127.0.0.1:1/local%2Ftest', me: { name: 'lead', kind: 'agent' }, room, awareness: { getStates: () => new Map() }, daemon: { fence: 'test' } } as unknown as Session
  const autoRetire = vi.fn(async () => {})
  const state = { S: () => s, rooms: { all: () => [s], holding: () => s, holdingWorker: () => s, reserve: () => true, unreserve() {}, autoRetire, project: () => projectAll(s), hasHandle: () => false, tracking: () => true }, myWorkers: () => localWorkers(lead), workerAlive: () => false, ctx: { listCwdProcesses: () => [] } } as unknown as HandlerState
  const sync = async () => { if (pending.size) { await registerWorkers(s, [...pending.values()]); pending.clear() } }
  const set = (tag: string, value: FixtureWorker) => { pending.set(tag, value) }
  const get = (tag: string): FixtureWorker => { const found = pending.get(tag); if (!found) throw new Error(`worker ${tag} is already registered`); return found }
  return { call: async (args: Record<string, unknown>) => {
    await sync()
    return handlers(state).room_collect(args)
  }, sync, set, get, pending, autoRetire, state, s, w }
}

const LINES = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'
/** Commit LINES as app.py in the lead and bring the worker's branch up to it; returns that HEAD. */
function commitLines() {
  put(lead, 'app.py', LINES); git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'lines')
  const head = git(lead, 'rev-parse', 'HEAD')
  git(worker, 'merge', '-q', '--ff-only', head)
  return head
}
/** Commit files on a worker's branch the way spawn carries the lead's uncommitted work, and record that commit as the worker's base. */
function carry(t: ReturnType<typeof setup>, dir: string, tag: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) put(dir, p, text)
  git(dir, 'add', '-A'); git(dir, '-c', 'user.name=Room', '-c', 'user.email=room@localhost', 'commit', '-qm', 'room: carried-in uncommitted work from lead')
  const commit = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'update-ref', `refs/room/carry/${tag}`, commit)
  t.set(tag, { ...t.get(tag), base: commit, carriedBase: commit })
}

async function startWorktreeProcess() {
  const ready = path.join(root, 'process-ready')
  const child = spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 1000)', ready], { cwd: worker, stdio: 'ignore' })
  try { await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), { timeout: 15_000 }) }
  catch { child.kill('SIGKILL'); throw new Error('worktree process did not start') }
  return child
}

async function ownershipEvidence(t: ReturnType<typeof setup>): Promise<string | undefined> {
    if (process.platform !== 'win32') return undefined
    const registry = await registryForDir(lead)
    const record = registry.reserved('test')
    return JSON.stringify({
      lead, worker, leadRoot: fs.realpathSync(lead), workerRoot: fs.realpathSync(worker),
      pathMatches: roomWorkerPathMatchesBranch(lead, worker, 'room/test'),
      commonLead: await realGitCommonDir(lead), commonWorker: await realGitCommonDir(worker),
      branch: git(worker, 'branch', '--show-current'),
      owned: await isOwnedWorkerWorktree(lead, t.w, 'lead'),
      record: record && { id: record.id, phase: record.phase, lead: record.lead.participant, room: record.lead.room, dir: record.dir },
      status: record && registry.status(record.id),
      trusted: !!await registry.trusted({ participant: 'lead', room: t.s.roomName, dir: lead }, 'test'),
    })
  }
function seedPresence(t: ReturnType<typeof setup>) {
    const name = t.w.name
    publishFixture(t.s.room, name, 'new.txt', 'worker change')
    t.s.room.setScope({ by: name, byKind: 'agent', area: 'test', summary: 'editing', paths: ['new.txt'] })
    t.s.room.addClaim({ by: name, byKind: 'agent', path: 'new.txt', from: 1, to: 1, intent: 'editing' })
  }
function expectRetired(t: ReturnType<typeof setup>) {
    const room = t.s.room, name = t.w.name
    expect(manifestPaths(room, name)).toEqual([])
    expect(room.overlays.has(name)).toBe(false)
    expect(room.scopes.has(name)).toBe(false)
    expect(room.openClaims().filter(c => c.by === name)).toEqual([])
    expect(workerByTag(lead, t.w.tag)).toBeUndefined()
    expect(room.workerViewOf(name)).toBeUndefined()
    const groups = splitParticipants({ presences: [], workers: [...room.workerViews.values()], retiredWorkers: room.retiredWorkers(), scopes: [...room.scopes.entries()], overlayPeople: [...room.overlays.keys()], changesByPerson: new Map(), claims: room.openClaims(), now: Date.now() })
    expect([...groups.active, ...groups.offlineTeammates].map(p => p.name)).not.toContain(name)
  }
function useLegacyWorker(t: ReturnType<typeof setup>, name: string) {
    git(lead, 'worktree', 'remove', '--force', worker)
    git(lead, 'branch', '-D', 'room/test')
    worker = path.join(lead, '.room', 'workers', name)
    git(lead, 'worktree', 'add', '-qb', `room/${name}`, worker)
    t.pending.delete(t.w.tag)
    Object.assign(t.w, { tag: `${name}-2`, name: `lead+${name}-2`, dir: worker, branch: `room/${name}` })
    t.set(t.w.tag, t.w)
  }
function second(t: ReturnType<typeof setup>, status: FixtureWorker['status'] = 'done') {
    const dir = path.join(lead, '.room', 'workers', 'second')
    git(lead, 'worktree', 'add', '-qb', 'room/second', dir)
    t.set('second', { ...t.w, tag: 'second', name: 'lead+second', dir, branch: 'room/second', status, exitCode: status === 'failed' ? 1 : 0, finishedAt: 1 })
    t.set('test', { ...t.w, exitCode: 0, finishedAt: 2 })
    return dir
  }
function httpxWorkers(borrowerStatus: FixtureWorker['status'] = 'done', recordOwner = true) {
    const t = setup()
    const original = worker
    worker = path.join(lead, '.room', 'workers', 'port-fix')
    git(original, 'branch', '-m', 'room/port-fix')
    git(lead, 'worktree', 'move', original, worker)
    t.pending.delete('test')
    t.set('port-fix', { ...t.w, tag: 'port-fix', name: 'lead+port-fix', dir: worker, branch: 'room/port-fix' })
    t.set('port-bools', { ...t.w, tag: 'port-bools', name: 'lead+port-bools', dir: worker, branch: 'room/port-fix', ...(recordOwner ? { sharedWith: 'w_port-fix' } : {}), status: borrowerStatus })
    return t
  }
async function reportedRunning() {
    const t = setup('running'); t.set('test', { ...t.w, status: 'running', pid: 4_190_001 })
    await t.sync()
    const registry = await registryForDir(lead)
    const record = registry.list().find(r => r.tag === 'test')!, run = record.runs[0]
    await registry.writeReport(record.id, { run: 1, nonce: run.nonce, chain: [], joinedAt: record.createdAt, done: { at: Date.now(), summary: 'finished', changed: [] } })
    expect(registry.status(record.id)).toMatchObject({ status: 'running', summary: 'finished' })
    let at = 0
    t.state.now = () => at
    return { t, tick: (ms: number) => { at += ms }, elapsed: () => at }
  }
async function previewSetup() {
  const t = setup()
  await t.sync()
  return t
}

export { base, carry, collectRefHook, commitLines, expectRetired, git, gitPathCalls, httpxWorkers, lead, LINES, ownershipEvidence, previewSetup, put, release, reportedRunning, root, second, seedPresence, setup, startWorktreeProcess, useLegacyWorker, worker }
