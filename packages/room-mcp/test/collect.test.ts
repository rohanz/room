import { publishFixture } from './fixtures/manifest.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handlers } from '../src/tools/collect.js'
import { handlers as fileHandlers, linkSharedDirs, materializeMergedFile } from '../src/tools/files.js'
import type { HandlerState } from '../src/tools/context.js'
import type { Session } from '../src/session.js'
import { signalWorker, pidAlive } from '../src/worker-process.js'
import { RoomDoc, manifestPaths, splitParticipants, workerLines } from '@room/shared'
import * as Y from 'yjs'
import { git as roomGit } from '@room/roomd/git'
import { PolicyStore, sharingFile } from '../src/policy-store.js'
import { finishWorker, registerWorkers, workerByTag, type FixtureWorker } from './registry-fixture.js'
import { closeRegistryForDir, localWorkers, registryForDir } from '../src/worker-registry.js'
import { projectWorkers } from '../src/worker-projector.js'
import { autoRetire } from '../src/retire.js'
import { cleanupWorker, type WorkerCleanupPreservation } from '../src/worker-git.js'
import { realStateInput } from '../src/worker-status.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

// Collection runs real Git and filesystem cleanup; wait for outcomes, not a 5 s wall-clock cap.
vi.setConfig({ testTimeout: 30_000 })

const release = vi.hoisted(() => vi.fn())
vi.mock('../src/tools/claims.js', () => ({ releaseClaimsOnDone: release }))
let root: string, lead: string, worker: string, base: string
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const put = (dir: string, p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text) }

beforeEach(() => {
  release.mockReset()
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-collect-')))
  lead = path.join(root, 'lead'); worker = path.join(lead, '.room', 'workers', 'test'); fs.mkdirSync(lead)
  git(lead, 'init', '-q'); git(lead, 'config', 'user.name', 'Lead'); git(lead, 'config', 'user.email', 'lead@example.test')
  put(lead, 'file.txt', 'base\n'); put(lead, '.gitignore', 'artifact.bin\nnode_modules/\n.room/\n')
  git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'base'); base = git(lead, 'rev-parse', 'HEAD')
  git(lead, 'worktree', 'add', '-qb', 'room/test', worker)
})
afterEach(async () => { await closeRegistryForDir(lead); fs.rmSync(root, { recursive: true, force: true }) })

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

describe('room_collect', () => {
  it.each(['done', 'dismissed', 'running'] as const)('keeps a %s worker when its live pid cannot be verified', async status => {
    const t = setup(status)
    const current = { ...t.w, id: 'worker-id', pid: process.pid, startedAt: Date.now(), exitCode: status === 'running' ? undefined : 0 }
    t.set('test', current)
    t.state.ctx = { listCwdProcesses: () => [], probe: () => ({}) } as never
    t.state.dismissWorker = vi.fn(async () => 'signalled')
    put(worker, 'new.txt', 'worker change')
    for (const args of [{ tag: 'test' }, { tag: 'test', discard: true }]) {
      const reply = await t.call(args)
      expect(reply).toContain(`could not verify test's process (pid ${process.pid}); left running, not stopped`)
      expect(workerByTag(lead, 'test')).toMatchObject({ tag: 'test', status, pid: process.pid })
      expect(fs.existsSync(worker)).toBe(true)
    }
    expect(t.state.dismissWorker).not.toHaveBeenCalled()
    expect(t.s.room.retiredWorkers()).toHaveLength(0)
  })
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

  it('retires collected worker with ignored output and shows only its kept worktree', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker change')
    put(worker, 'artifact.bin', 'ignored output')
    // The worker's declared grant ended while new.txt was shared, so its policy retains that path.
    const policy = await PolicyStore.open({ dir: worker, room: t.s.roomName, participant: t.w.name, server: 'ws://127.0.0.1:1', requested: 'declared' })
    await policy.declare(['new.txt'])
    await policy.settle(await policy.declare([]), new Map([['new.txt', { state: 'shared', change: 'A' }]]), [])
    expect(policy.retained).toEqual(['new.txt'])
    const retained = await sharingFile(worker, t.s.roomName, t.w.name)
    expect(fs.existsSync(retained)).toBe(true)
    seedPresence(t)
    expect(await t.call({ tag: 'test' })).toContain(`kept artifact.bin at ${path.join(worker, 'artifact.bin')}`)
    expect(fs.existsSync(worker)).toBe(true)
    expect(fs.existsSync(retained)).toBe(false)
    expectRetired(t)
    expect(t.s.room.retiredWorkers()[0].keptWorktree).toBe(worker)
    expect(workerLines([], { retiredWorkers: t.s.room.retiredWorkers() }).join('\n')).toContain('kept: uncopied ignored artifacts')
    const lines = workerLines([], { all: true, retiredWorkers: t.s.room.retiredWorkers() }).join('\n')
    expect(lines).toContain(`kept for ignored output at ${worker}`)
    expect(lines).not.toContain('uncommitted')
    expect(lines).toContain('workers (1):')
  })
  it('refuses to stop a worker in an unmanaged existing directory', async () => {
    const t = setup('running')
    t.set('test', { ...t.w, dir: lead, branch: 'main', model: 'worker-model' })
    let alive = true
    const stopped = vi.fn(async () => { alive = false; return 'pid signalled' })
    t.state.workerAlive = () => alive
    t.state.dismissWorker = stopped as never
    const result = await t.call({ tag: 'test', discard: true })
    expect(stopped).not.toHaveBeenCalled()
    expect(result).toContain('no local worker capability')
    expect(fs.existsSync(lead)).toBe(true)
    expect(t.s.room.retiredWorkers()).toEqual([])
  })
  it('keeps a finished worker when process ownership becomes unknown during discard', async () => {
    const t = setup()
    t.set('test', { ...t.w, pid: 4242, processStartTime: 'fixed-start' })
    let readable = true
    t.state.ctx = { listCwdProcesses: () => [], probe: () => readable ? { startTime: 'fixed-start', executable: 'codex' } : {} } as never
    t.state.dismissWorker = vi.fn(async () => {
      readable = false
      return "could not verify test's process; left running, not stopped"
    }) as never
    const reply = await t.call({ tag: 'test', discard: true })
    expect(reply).toContain("could not verify test's process")
    expect(reply).toContain('left running, not stopped')
    expect(workerByTag(lead, 'test')).toBeDefined()
    expect(t.s.room.retiredWorkers()).toHaveLength(0)
    expect(fs.existsSync(worker)).toBe(true)
  })
  it('stops worktree processes even when ignored output keeps the collected worktree', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker change')
    put(worker, 'artifact.bin', 'ignored output')
    const child = await startWorktreeProcess()
    t.state.ctx.listCwdProcesses = () => [{ pid: child.pid!, cwd: worker, command: 'node' }]
    try {
      const reply = await t.call({ tag: 'test' })
      expect(reply).toContain('kept test: uncopied ignored artifacts')
      expect(reply).toContain(`pid ${child.pid}`)
      expect(reply).toContain('stopped processes from test:')
      expect(fs.existsSync(worker)).toBe(true)
    } finally { child.kill('SIGKILL') }
  })
  it('cleans regenerable ignored output while retaining other ignored artifacts', async () => {
    fs.appendFileSync(path.join(lead, '.git/info/exclude'), 'dist/\n.astro/\ntest-results/\n.venv/\n')
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker change')
    for (const p of ['dist/app.js', '.astro/cache.json', 'test-results/trace.zip']) put(worker, p, 'regenerable')
    const reply = await t.call({ tag: 'test' })
    expect(reply).toContain('cleaned up test')
    expect(reply).not.toContain('uncopied ignored artifacts')
    expect(reply).not.toContain('dist/app.js')
    expect(fs.existsSync(path.join(lead, 'dist/app.js'))).toBe(false)
    expect(fs.existsSync(worker)).toBe(false)

    const other = path.join(lead, '.room', 'workers', 'other')
    git(lead, 'worktree', 'add', '-qb', 'room/other', other)
    t.set('other', { ...t.w, tag: 'other', name: 'lead+other', dir: other, branch: 'room/other', exitCode: 0 })
    put(other, '.venv/lib.py', 'unrecoverable')
    const kept = await t.call({ tag: 'other' })
    expect(kept).toContain('kept .venv/')
    expect(fs.existsSync(other)).toBe(true)
  })

  it('names a worktree server before the worker host exits during collect', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'file.txt', 'worker edit\n')
    const child = await startWorktreeProcess()
    let live = true
    t.state.workerAlive = () => live
    t.state.ctx = { listCwdProcesses: () => [{ pid: child.pid!, cwd: worker, command: 'node' }], sleep: async () => { child.kill('SIGTERM'); live = false } } as never
    try {
      const reply = await t.call({ tag: 'test' })
      expect(reply).toMatch(new RegExp(`stopped processes from test: [^\\n]+ \\(pid ${child.pid}\\)`))
    } finally { child.kill('SIGKILL') }
  })

  it('names a worktree server before dismissing the host during discard', async () => {
    const t = setup('running')
    put(worker, 'file.txt', 'worker edit\n')
    const child = await startWorktreeProcess()
    t.state.ctx.listCwdProcesses = () => [{ pid: child.pid!, cwd: worker, command: 'node' }]
    let live = true
    t.state.workerAlive = () => live
    t.state.dismissWorker = async () => { child.kill('SIGTERM'); live = false; return 'worker signalled' }
    try {
      const reply = await t.call({ tag: 'test', discard: true })
      expect(reply).toMatch(new RegExp(`stopped processes: [^\\n]+ \\(pid ${child.pid}\\)`))
    } finally { child.kill('SIGKILL') }
  })

  it('discards ignored output from a retired collected worker with force', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker change')
    put(worker, 'artifact.bin', 'ignored output')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test: new.txt')
    expect(workerByTag(lead, 'test')).toBeUndefined()
    expect(await t.call({ tag: 'test', discard: true })).toContain('discard refused; ignored artifacts')
    expect(fs.existsSync(worker)).toBe(true)
    expect(await t.call({ tag: 'test', discard: true, force: true })).toContain('discarded test')
    expect(fs.existsSync(worker)).toBe(false)
    expect(t.s.room.retiredWorkers()[0].keptWorktree).toBeUndefined()
    expectRetired(t)
  }, 30_000)
  it('refuses, then force-discards, a worker whose carried path lies under an ignored directory', async () => {
    // Live (databricks, 2026-09-28): force=true failed in `git add -A` because a carried path sat under data/raw/.
    const t = setup('failed')
    put(worker, 'data/raw/static/stops.csv', 'id\n1\n')
    const sha = git(worker, 'hash-object', 'data/raw/static/stops.csv')
    t.set('test', { ...t.w, status: 'failed', carriedUntracked: [{ path: 'data/raw/static/stops.csv', sha, mode: 0o644 }] })
    put(worker, '.gitignore', 'artifact.bin\nnode_modules/\n.room/\ndata/raw/\n.venv/\ndata/tmp/\n')
    put(worker, '.venv/bin/python', 'x'); put(worker, 'data/tmp/scratch.parquet', 'y'); put(worker, 'file.txt', 'worker edit\n')
    const refused = await t.call({ tag: 'test', discard: true })
    expect(refused).toMatch(/^error: discard refused; ignored artifacts not covered by a recovery patch: .*\.venv\/.*data\/tmp\//)
    expect(fs.existsSync(path.join(lead, '.room', 'discarded'))).toBe(false)
    expect(fs.existsSync(worker)).toBe(true)
    const forced = await t.call({ tag: 'test', discard: true, force: true })
    expect(forced).toMatch(/^discarded test; recovery patch: \S+\.patch \(kept for a week\); deleted without a copy: .*\.venv\/.*data\/tmp\//)
    const patch = fs.readFileSync(forced.match(/recovery patch: (\S+\.patch)/)![1], 'utf8')
    expect(patch.match(/^diff --git .*$/gm)).toEqual(['diff --git a/.gitignore b/.gitignore', 'diff --git a/file.txt b/file.txt'])
    expect(fs.existsSync(worker)).toBe(false)
  })
  it('refuses to forget a kept worktree that is no longer an owned Room worktree', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker change')
    put(worker, 'artifact.bin', 'ignored output')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test: new.txt')
    expect(t.s.room.retiredWorkers()[0].keptWorktree).toBe(worker)
    git(worker, 'checkout', '-qb', 'elsewhere')
    expect(await t.call({ tag: 'test', discard: true, force: true })).toBe(`error: worker is not an owned Room worktree; retained ${worker}`)
    expect(fs.existsSync(path.join(worker, 'artifact.bin'))).toBe(true)
    expect(t.s.room.retiredWorkers()[0].keptWorktree).toBe(worker)
  })
  it('preflights ignored output before stopping worktree processes', async () => {
    const t = setup('failed')
    put(worker, 'artifact.bin', 'ignored output')
    const child = await startWorktreeProcess()
    t.state.ctx.listCwdProcesses = () => [{ pid: child.pid!, cwd: worker, command: 'node' }]
    try {
      const reply = await t.call({ tag: 'test', discard: true })
      expect(reply).toContain('discard refused; ignored artifacts')
      expect(reply).not.toContain(`pid ${child.pid}`)
      expect(pidAlive(child.pid!)).toBe(true)
      expect(fs.existsSync(worker)).toBe(true)
    } finally { child.kill('SIGKILL') }
  })

  it('discards worker and clears its overlay, claims, scope and presence', async () => {
    const t = setup('failed')
    seedPresence(t)
    expect(await t.call({ tag: 'test', discard: true })).toBe('discarded test')
    expectRetired(t)
  })

  function second(t: ReturnType<typeof setup>, status: FixtureWorker['status'] = 'done') {
    const dir = path.join(lead, '.room', 'workers', 'second')
    git(lead, 'worktree', 'add', '-qb', 'room/second', dir)
    t.set('second', { ...t.w, tag: 'second', name: 'lead+second', dir, branch: 'room/second', status, exitCode: status === 'failed' ? 1 : 0, finishedAt: 1 })
    t.set('test', { ...t.w, exitCode: 0, finishedAt: 2 })
    return dir
  }
  it('collects all finished workers in finish order, unstaged, cleans both and leaves history unchanged', async () => {
    const t = setup(), other = second(t), history = git(lead, 'log', '--oneline')
    put(worker, 'a.txt', 'a'); put(other, 'b.txt', 'b')
    const result = await t.call({})
    expect(result).toContain('Changes from second, test: a.txt, b.txt')
    expect(git(lead, 'log', '--oneline')).toBe(history)
    expect(git(lead, 'diff', '--cached')).toBe('')
    expect(git(lead, 'status', '--porcelain')).toContain('?? a.txt')
    expect(git(lead, 'status', '--porcelain')).toContain('?? b.txt')
    for (const dir of [worker, other]) expect(fs.existsSync(dir)).toBe(false)
    for (const tag of ['test', 'second']) expect(git(lead, 'branch', '--list', 'room/' + tag)).toBe('')
    expect(release).toHaveBeenCalledTimes(2)
    expect(localWorkers(lead)).toEqual([]); expect(t.s.room.workerViews.size).toBe(0)
  }, 30_000)
  it('skips a vanished worktree with its reason and still collects the other worker', async () => {
    const t = setup(), other = second(t)
    put(other, 'survived.txt', 'kept')
    fs.rmSync(worker, { recursive: true, force: true })
    const result = await t.call({})
    expect(result).toContain('skipped test: no local worker capability (worktree missing or unmanaged)')
    expect(result).toContain('Changes from second: survived.txt')
    expect(fs.readFileSync(path.join(lead, 'survived.txt'), 'utf8')).toBe('kept')
    expect(workerByTag(lead, 'test')).toBeDefined()
  })
  it.each([false, true])('discards a vanished worktree with merged commits (pruned first: %s)', async pruned => {
    const t = setup()
    seedPresence(t)
    git(lead, 'branch', 'room/og-cards')
    const otherBranch = git(lead, 'rev-parse', 'room/og-cards')
    put(worker, 'landed.txt', 'landed')
    git(worker, 'add', '.'); git(worker, 'commit', '-qm', 'worker work')
    const commit = git(worker, 'rev-parse', 'HEAD')
    git(lead, 'merge', '-q', '--ff-only', commit)
    fs.rmSync(worker, { recursive: true, force: true })
    if (pruned) git(lead, 'worktree', 'prune')
    const reply = await t.call({ tag: 'test', discard: true })
    expect(reply).toContain('discarded test; its worktree was already gone')
    expect(git(lead, 'branch', '--list', 'room/test')).toBe('')
    expect(git(lead, 'rev-parse', 'room/og-cards')).toBe(otherBranch)
    expect(workerByTag(lead, 'test')).toBeUndefined()
  })
  it('removes both worker logs when discarding an already vanished worktree', async () => {
    const t = setup()
    for (const suffix of ['.log', '.mcp.log']) put(lead, `.room/workers/test${suffix}`, 'log')
    fs.rmSync(worker, { recursive: true, force: true })
    expect(await t.call({ tag: 'test', discard: true })).toContain('discarded test; its worktree was already gone')
    expect(fs.existsSync(path.join(lead, '.room/workers/test.log'))).toBe(false)
    expect(fs.existsSync(path.join(lead, '.room/workers/test.mcp.log'))).toBe(false)
    expect(t.s.room.retiredWorkers()).toHaveLength(1)
  })
  it('keeps unmerged branch commits when discarding a vanished worktree', async () => {
    const t = setup()
    seedPresence(t)
    for (const name of ['one', 'two']) {
      put(worker, `${name}.txt`, name)
      git(worker, 'add', '.'); git(worker, 'commit', '-qm', name)
    }
    fs.rmSync(worker, { recursive: true, force: true })
    const reply = await t.call({ tag: 'test', discard: true })
    expect(reply).toContain('discarded test; its worktree was already gone')
    expect(git(lead, 'branch', '--list', 'room/test')).toContain('room/test')
    expect(workerByTag(lead, 'test')).toBeUndefined()
  })
  it('keeps a user commit at the worker base after the lead resets behind it', async () => {
    const t = setup()
    put(lead, 'user.txt', 'user commit')
    git(lead, 'add', 'user.txt'); git(lead, 'commit', '-qm', 'user commit')
    const userCommit = git(lead, 'rev-parse', 'HEAD')
    git(worker, 'merge', '--ff-only', userCommit)
    t.set('test', { ...t.w, base: userCommit })
    git(lead, 'reset', '--hard', 'HEAD^')
    fs.rmSync(worker, { recursive: true, force: true })
    const reply = await t.call({ tag: 'test', discard: true })
    expect(reply).toContain('discarded test; its worktree was already gone')
    expect(git(lead, 'rev-parse', 'room/test')).toBe(userCommit)
  })
  it('deletes a vanished worker branch containing only the carried base', async () => {
    const t = setup()
    put(lead, 'carried.txt', 'lead edit')
    carry(t, worker, 'test', { 'carried.txt': 'lead edit' })
    fs.rmSync(worker, { recursive: true, force: true })
    const reply = await t.call({ tag: 'test', discard: true })
    expect(reply).toContain('discarded test; its worktree was already gone')
    expect(git(lead, 'branch', '--list', 'room/test')).toBe('')
    expect(fs.readFileSync(path.join(lead, 'carried.txt'), 'utf8')).toBe('lead edit')
    expect(workerByTag(lead, 'test')).toBeUndefined()
  })
  it('keeps a vanished worker branch with a commit after the carried base', async () => {
    const t = setup()
    put(lead, 'carried.txt', 'lead edit')
    carry(t, worker, 'test', { 'carried.txt': 'lead edit' })
    put(worker, 'worker.txt', 'worker edit')
    git(worker, 'add', 'worker.txt'); git(worker, 'commit', '-qm', 'worker work')
    const workerCommit = git(worker, 'rev-parse', 'HEAD')
    fs.rmSync(worker, { recursive: true, force: true })
    const reply = await t.call({ tag: 'test', discard: true })
    expect(reply).toContain('discarded test; its worktree was already gone')
    expect(git(lead, 'rev-parse', 'room/test')).toBe(workerCommit)
    expect(workerByTag(lead, 'test')).toBeUndefined()
  })
  it('discards a legacy replacement record when its worktree and branch are already absent', async () => {
    const t = setup()
    useLegacyWorker(t, 'og-sections')
    seedPresence(t)
    fs.rmSync(worker, { recursive: true, force: true })
    git(lead, 'worktree', 'prune')
    git(lead, 'branch', '-D', 'room/og-sections')
    const reply = await t.call({ tag: 'og-sections-2', discard: true })
    expect(reply).toContain('discarded og-sections-2; its worktree was already gone')
    expect(workerByTag(lead, t.w.tag)).toBeUndefined()
  })
  it('keeps commits on a legacy replacement branch after its worktree vanishes', async () => {
    const t = setup()
    useLegacyWorker(t, 'e2e-static')
    seedPresence(t)
    put(worker, 'worker.txt', 'unmerged')
    git(worker, 'add', 'worker.txt'); git(worker, 'commit', '-qm', 'worker work')
    const branchCommit = git(lead, 'rev-parse', 'room/e2e-static')
    fs.rmSync(worker, { recursive: true, force: true })
    git(lead, 'worktree', 'prune')
    const reply = await t.call({ tag: 'e2e-static-2', discard: true })
    expect(reply).toContain('discarded e2e-static-2; its worktree was already gone')
    expect(git(lead, 'rev-parse', 'room/e2e-static')).toBe(branchCommit)
    expect(workerByTag(lead, t.w.tag)).toBeUndefined()
  })
  it('explains that plain collect cannot collect a vanished worktree and leaves its record', async () => {
    const t = setup()
    put(worker, 'not-landed.txt', 'worker commit')
    git(worker, 'add', 'not-landed.txt'); git(worker, 'commit', '-qm', 'worker commit')
    const branchHead = git(lead, 'rev-parse', 'room/test')
    fs.rmSync(worker, { recursive: true, force: true })
    expect(await t.call({ tag: 'test' })).toContain('no local worker capability')
    expect(workerByTag(lead, 'test')).toBeDefined()
    expect(git(lead, 'rev-parse', 'room/test')).toBe(branchHead)
  })
  it('names a missing cwd in the shared git helper error', async () => {
    fs.rmSync(worker, { recursive: true, force: true })
    await expect(roomGit(worker, ['status'])).rejects.toThrow(`worktree ${worker} no longer exists`)
  })
  it('skips one worker with an internal git ls-files error and collects the other', async () => {
    const t = setup(), other = second(t)
    put(worker, 'broken.txt', 'broken'); put(other, 'survived.txt', 'kept')
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nif [ "$1" = ls-files ] && [ "$(pwd)" = "$ROOM_TEST_FAIL_DIR" ]; then echo "injected ls-files error" >&2; exit 3; fi\nexec /usr/bin/git "$@"\n', { mode: 0o755 })
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    vi.stubEnv('ROOM_TEST_FAIL_DIR', fs.realpathSync(worker))
    let result: string
    try { result = await t.call({}) }
    finally { vi.unstubAllEnvs() }
    expect(result).toContain('skipped test: git ls-files -z failed: injected ls-files error')
    expect(result).toContain('Changes from second: survived.txt')
  }, 30_000)
  it('reports Directory not empty during cleanup and retains the worktree for recovery', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker edit')
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin)
    const marker = path.join(root, 'remove-failed')
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\ncase " $* " in *" worktree remove "*) if [ ! -f "$ROOM_TEST_MARKER" ]; then touch "$ROOM_TEST_MARKER"; echo "Directory not empty" >&2; exit 1; fi;; esac\nexec /usr/bin/git "$@"\n', { mode: 0o755 })
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    vi.stubEnv('ROOM_TEST_MARKER', marker)
    let result: string
    try { result = await t.call({ tag: 'test' }) }
    finally { vi.unstubAllEnvs() }
    expect(result).toContain('Changes from test: new.txt')
    expect(result).toContain('Directory not empty')
    expect(result).toContain('cleanup incomplete')
    expect(fs.existsSync(worker)).toBe(true)
    expect(t.s.room.retiredWorkers()[0].keptWorktree).toBe(worker)
  })
  it('serializes parallel collects through the worktree lease', async () => {
    const t = setup(), other = second(t)
    put(worker, 'first.txt', 'first'); put(other, 'second.txt', 'second')
    const [first, queued] = await Promise.all([t.call({ tag: 'test' }), t.call({ tag: 'second' })])
    expect(first).toContain('Changes from test: first.txt')
    expect(queued).toContain('Changes from second: second.txt')
  })
  it('keeps both workers and all lead files when their same-line changes conflict', async () => {
    const t = setup(), other = second(t)
    put(worker, 'file.txt', 'first\n'); put(other, 'file.txt', 'second\n'); put(worker, 'new.txt', 'new')
    const result = await t.call({})
    expect(result).toContain('file.txt (second, test)')
    expect(result).toContain('room_read')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
    expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
    for (const dir of [worker, other]) expect(fs.existsSync(dir)).toBe(true)
    expect(release).not.toHaveBeenCalled()
  })
  it('collects deletion and addition together', async () => {
    const t = setup(), other = second(t)
    fs.unlinkSync(path.join(worker, 'file.txt')); put(other, 'added.txt', 'new')
    expect(await t.call({})).toContain('Nothing committed or staged')
    expect(fs.existsSync(path.join(lead, 'file.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(lead, 'added.txt'), 'utf8')).toBe('new')
  })
  it('skips running and failed workers even with force', async () => {
    const t = setup('running'), other = second(t, 'failed')
    t.set('test', { ...t.w, status: 'running' })
    put(worker, 'running.txt', 'no'); put(other, 'failed.txt', 'no')
    const result = await t.call({ force: true })
    expect(result).toContain('skipped test: running'); expect(result).toContain('skipped second: failed')
    expect(git(lead, 'status', '--porcelain')).toBe('')
  })
  it('a tag collects just that worker', async () => {
    const t = setup(), other = second(t)
    put(worker, 'one.txt', 'one'); put(other, 'two.txt', 'two')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test: one.txt')
    expect(fs.existsSync(path.join(lead, 'two.txt'))).toBe(false)
    expect(fs.existsSync(other)).toBe(true)
  })
  it('collects a worker recorded in a team session when its worktree belongs to the lead clone', async () => {
    const t = setup()
    delete (t.s as { local?: unknown }).local
    put(worker, 'team.txt', 'team work\n')
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: team.txt')
    expect(fs.readFileSync(path.join(lead, 'team.txt'), 'utf8')).toBe('team work\n')
  })
  it('breaks equal finish times by tag and leaves unrelated workers untouched', async () => {
    const t = setup(), other = second(t)
    t.set('test', { ...t.get('test'), finishedAt: 1 })
    t.set('foreign', { ...t.w, tag: 'foreign', lead: 'someone-else' })
    put(worker, 'a.txt', 'a'); put(other, 'b.txt', 'b')
    expect(await t.call({})).toContain('Changes from second, test:')
    expect(workerByTag(lead, 'foreign')).toBeDefined()
    expect(t.autoRetire).not.toHaveBeenCalled()
  })
  it('preserves deletion versus an empty-file edit as a conflict', async () => {
    const t = setup(), other = second(t)
    fs.unlinkSync(path.join(worker, 'file.txt')); put(other, 'file.txt', '')
    expect(await t.call({})).toContain('file.txt (second, test)')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
    expect(fs.existsSync(worker)).toBe(true); expect(fs.existsSync(other)).toBe(true)
  })
  it('rejects the removed commit argument as unknown', async () => {
    expect(await setup().call({ commit: true })).toBe('error: unknown argument commit')
    expect(await setup().call({ tag: 'test', commit: false })).toBe('error: unknown argument commit')
  })

  it.each([false, true])('preserves lead edits (staged=%s) without moving either HEAD or index', async staged => {
    const text = 'one\ntwo\nthree\nfour\nfive\n'; put(lead, 'file.txt', text); git(lead, 'commit', '-qam', 'lines'); git(worker, 'merge', '--ff-only', git(lead, 'rev-parse', 'HEAD'))
    const before = git(lead, 'rev-parse', 'HEAD')
    put(lead, 'file.txt', text.replace('one', 'LEAD')); if (staged) git(lead, 'add', 'file.txt')
    const index = git(lead, 'write-tree')
    put(worker, 'file.txt', text.replace('five', 'WORKER')); put(worker, 'new.txt', 'new'); put(worker, 'artifact.bin', 'ignored')
    expect(await setup().call({ tag: 'test' })).toContain('Changes from test:')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe(text.replace('one', 'LEAD').replace('five', 'WORKER'))
    expect(git(lead, 'write-tree')).toBe(index); expect(git(lead, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(worker, 'rev-parse', 'HEAD')).toBe(before)
    expect(fs.existsSync(path.join(lead, 'artifact.bin'))).toBe(false)
    expect(git(lead, 'status', '--porcelain')).toContain('?? new.txt')
  })
  it('applies binary output, executable bits and deletions, excluding linked inputs', async () => {
    const t = setup(); t.set('test', { ...t.w, link: ['data'] })
    put(lead, 'data/input', 'private'); fs.symlinkSync(path.join(lead, 'data'), path.join(worker, 'data'))
    fs.unlinkSync(path.join(worker, 'file.txt')); fs.writeFileSync(path.join(worker, 'binary'), Buffer.from([0, 255, 128, 1]))
    put(worker, 'run.sh', '#!/bin/sh\n'); fs.chmodSync(path.join(worker, 'run.sh'), 0o755)
    expect(await t.call({ tag: 'test' })).toContain('Changes from test:')
    expect(fs.existsSync(path.join(lead, 'file.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(lead, 'binary'))).toEqual(Buffer.from([0, 255, 128, 1]))
    expect(fs.statSync(path.join(lead, 'run.sh')).mode & 0o111).toBe(0o111)
    expect(fs.readFileSync(path.join(lead, 'data/input'), 'utf8')).toBe('private')
  })
  it('skips failed workers without touching their output', async () => {
    const t = setup('failed'); t.set('test', { ...t.w, exitCode: 1 })
    put(worker, 'new.txt', 'new'); expect(await t.call({ tag: 'test' })).toContain('skipped test: failed')
    expect(await t.call({ tag: 'test' })).toContain('exit code 1')
    expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
    expect(fs.existsSync(worker)).toBe(true); expect(git(lead, 'branch', '--list', 'room/test')).toContain('room/test')
  })
  it('discards a dirty running worker and restores committed, staged, unstaged and untracked output from one patch', async () => {
    const t = setup('running')
    put(worker, 'committed.txt', 'commit\n'); git(worker, 'add', '.'); git(worker, 'commit', '-qm', 'worker commit')
    put(worker, 'staged.txt', 'stage\n'); git(worker, 'add', '.')
    put(worker, 'file.txt', 'dirty\n'); put(worker, 'new.txt', 'untracked\n')
    fs.writeFileSync(path.join(worker, 'binary'), Buffer.from([0, 255, 128]))
    put(worker, 'node_modules/pkg/cache.bin', 'dependency cache')
    for (const suffix of ['.log', '.mcp.log']) put(lead, '.room/workers/test' + suffix, 'log')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await new Promise<void>(resolve => child.once('spawn', resolve))
    t.state.workerAlive = () => pidAlive(child.pid!)
    t.state.dismissWorker = async () => {
      signalWorker(child.pid!)
      await finishWorker(t.s, 'test', { status: 'dismissed' })
      return 'signalled'
    }
    try {
      const result = await t.call({ tag: 'test', discard: true })
      expect(result).toMatch(/^discarded test; recovery patch: .*kept for a week/)
      expect(result.split('\n')).toHaveLength(1)
      expect(pidAlive(child.pid!)).toBe(false)
      expect(fs.existsSync(worker)).toBe(false)
      expect(git(lead, 'branch', '--list', 'room/test')).toBe('')
      expect(fs.existsSync(path.join(lead, '.room/workers'))).toBe(false)
      expect(localWorkers(lead)).toEqual([]); expect(t.s.room.workerViews.size).toBe(0); expect(release).toHaveBeenCalled()
      const patchDir = path.join(lead, '.git/room/registry/patches')
      const patches = fs.readdirSync(patchDir)
      expect(patches).toEqual(['w_test.patch'])
      const fresh = path.join(root, 'fresh')
      git(lead, 'worktree', 'add', '--detach', fresh, base)
      git(fresh, 'apply', path.join(patchDir, patches[0]))
      for (const [p, text] of [['committed.txt', 'commit\n'], ['staged.txt', 'stage\n'], ['file.txt', 'dirty\n'], ['new.txt', 'untracked\n']]) expect(fs.readFileSync(path.join(fresh, p), 'utf8')).toBe(text)
      expect(fs.readFileSync(path.join(fresh, 'binary'))).toEqual(Buffer.from([0, 255, 128]))
      expect(fs.existsSync(path.join(fresh, 'node_modules'))).toBe(false)
    } finally { if (pidAlive(child.pid!)) child.kill('SIGKILL') }
  })
  it('refuses discard when ignored artifacts are outside the recovery patch and names what was kept', async () => {
    const t = setup('failed')
    put(worker, 'artifact.bin', 'generated model')
    put(worker, 'node_modules/pkg/cache.bin', 'dependency cache')
    const result = await t.call({ tag: 'test', discard: true })
    expect(result).toContain('ignored artifacts not covered by a recovery patch: artifact.bin')
    expect(result).toContain(`retained worktree: ${worker}`)
    expect(result).toContain(`retained worktree: ${worker}`)
    expect(result).not.toContain('node_modules')
    expect(fs.readFileSync(path.join(worker, 'artifact.bin'), 'utf8')).toBe('generated model')
    expect(workerByTag(lead, 'test')).toBeDefined()
  })
  it('discards regenerable ignored directories without force or an alarming deleted list', async () => {
    const t = setup('failed')
    put(worker, '.gitignore', 'dist/\n')
    put(worker, 'dist/a.js', 'a'); put(worker, 'dist/b.js', 'b')
    const result = await t.call({ tag: 'test', discard: true })
    expect(result).toContain('discarded test')
    expect(result).not.toContain('deleted without a copy')
    expect(fs.existsSync(worker)).toBe(false)
  })
  it('discards a clean failed worker without a patch and prunes old patches and empty folders', async () => {
    const t = setup('failed')
    put(lead, '.git/room/registry/patches/w_old.patch', 'old')
    const old = new Date(Date.now() - 8 * 86400_000)
    fs.utimesSync(path.join(lead, '.git/room/registry/patches/w_old.patch'), old, old)
    put(lead, '.room/workers/test.log', 'log')
    expect(await t.call({ tag: 'test', discard: true })).toBe('discarded test')
    await (await registryForDir(lead)).reconcile()
    expect(fs.existsSync(path.join(lead, '.git/room/registry/patches/w_old.patch'))).toBe(false)
    expect(fs.existsSync(path.join(lead, '.room'))).toBe(false)
  })
  it('keeps recent patches and another worker folder until the last cleanup', async () => {
    const t = setup(); second(t)
    put(lead, '.room/workers/second.log', 'log'); put(lead, '.room/workers/test.log', 'log')
    expect(await t.call({ tag: 'test', discard: true })).toBe('discarded test')
    expect(fs.existsSync(path.join(lead, '.room/workers'))).toBe(true)
    expect(await t.call({ tag: 'second' })).toContain('cleaned up second')
    expect(fs.existsSync(path.join(lead, '.room'))).toBe(false)
  })
  it('retains recovery patches younger than a week', async () => {
    const t = setup(); put(lead, '.room/discarded/recent.patch', 'recent')
    expect(await t.call({ tag: 'test', discard: true })).toBe('discarded test')
    expect(fs.readFileSync(path.join(lead, '.room/discarded/recent.patch'), 'utf8')).toBe('recent')
  })
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
  it('detaches port-bools, then discards port-fix and its worktree', async () => {
    const t = httpxWorkers()
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools; the worktree belongs to port-fix')
    expect(fs.existsSync(worker)).toBe(true)
    expect(workerByTag(lead, 'port-bools')).toBeUndefined()
    expect(await t.call({ tag: 'port-fix', discard: true })).toContain('discarded port-fix')
    expect(fs.existsSync(worker)).toBe(false)
  })
  it('detaches an older port-bools record without sharedWith using the canonical owner', async () => {
    const t = httpxWorkers('done', false)
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools; the worktree belongs to port-fix')
    expect(fs.existsSync(worker)).toBe(true)
  })
  it('never removes the owner checkout when discarding an already collected borrower', async () => {
    const t = httpxWorkers()
    await t.sync()
    const registry = await registryForDir(lead)
    const record = registry.read('w_port-bools')!
    const archive = { ...registry.archiveOf(record, { summary: 'kept', disposition: 'collected' }), keptWorktree: worker }
    await registry.beginRetirement(record.id, archive, { keptWorktree: worker })
    await registry.finishCleanup(record.id, t.s.roomName)
    t.s.room.retireWorker(record.id, { ...archive, id: record.id }, () => {})
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools; the worktree belongs to port-fix')
    expect(fs.existsSync(worker)).toBe(true)
    expect(workerByTag(lead, 'port-fix')).toBeDefined()
  })
  it('discards port-fix after retiring finished port-bools', async () => {
    const t = httpxWorkers()
    const result = await t.call({ tag: 'port-fix', discard: true })
    expect(result).toContain('detached port-bools')
    expect(result).toContain('discarded port-fix')
    expect(fs.existsSync(worker)).toBe(false)
    expect(workerByTag(lead, 'port-fix')).toBeUndefined()
    expect(workerByTag(lead, 'port-bools')).toBeUndefined()
  })
  it('keeps port-fix while port-bools still runs in its worktree', async () => {
    const t = httpxWorkers('running')
    const result = await t.call({ tag: 'port-fix', discard: true })
    expect(result).toContain('port-bools is still running')
    expect(fs.existsSync(worker)).toBe(true)
    expect(workerByTag(lead, 'port-fix')).toBeDefined()
  })
  it('collects the owner changes but keeps its running borrower and checkout', async () => {
    const t = httpxWorkers('running')
    put(worker, 'new.txt', 'shared output')
    const list = vi.fn(() => [])
    t.state.ctx = { listCwdProcesses: list, probe: () => undefined } as never
    const result = await t.call({ tag: 'port-fix' })
    expect(result).toContain('Changes from port-fix: new.txt')
    expect(result).toContain("kept port-fix's worktree: port-bools is still running in it")
    expect(fs.existsSync(worker)).toBe(true)
    expect(workerByTag(lead, 'port-bools')?.status).toBe('running')
    expect(fs.readFileSync(path.join(lead, 'new.txt'), 'utf8')).toBe('shared output')
    expect(list).not.toHaveBeenCalled()
  })
  it('collects an owner after retiring its finished borrower', async () => {
    const t = httpxWorkers()
    put(worker, 'new.txt', 'shared output')
    const result = await t.call({ tag: 'port-fix' })
    expect(result).toContain('retired port-bools with port-fix')
    expect(result).toContain('cleaned up port-fix')
    expect(fs.existsSync(worker)).toBe(false)
    expect(workerByTag(lead, 'port-bools')).toBeUndefined()
  })
  it('detaches the last discarded borrower without authorizing owner cleanup', async () => {
    const t = httpxWorkers('running')
    put(worker, 'new.txt', 'shared output')
    expect(await t.call({ tag: 'port-fix' })).toContain("kept port-fix's worktree")
    await finishWorker(t.s, 'port-bools', { status: 'done' })
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools')
    expect(fs.existsSync(worker)).toBe(true)
    expect((await registryForDir(lead)).read('w_port-fix')?.keptWorktree).toBe(worker)
    expect(await t.call({ tag: 'port-fix', discard: true })).toContain('discarded port-fix')
    expect(fs.existsSync(worker)).toBe(false)
  })
  it('collects the last borrower without removing the owner checkout during its own collection', async () => {
    const t = httpxWorkers('running')
    put(worker, 'new.txt', 'shared output')
    expect(await t.call({ tag: 'port-fix' })).toContain("kept port-fix's worktree")
    await finishWorker(t.s, 'port-bools', { status: 'done' })
    const result = await t.call({ tag: 'port-bools' })
    expect(result).toContain('detached port-bools; the worktree belongs to port-fix')
    expect(fs.existsSync(worker)).toBe(false)
  })
  it('keeps late ignored owner output when collecting the last borrower', async () => {
    const t = httpxWorkers('running')
    put(worker, 'new.txt', 'shared output')
    expect(await t.call({ tag: 'port-fix' })).toContain("kept port-fix's worktree")
    put(worker, 'artifact.bin', 'late ignored output')
    await finishWorker(t.s, 'port-bools', { status: 'done' })
    const result = await t.call({ tag: 'port-bools' })
    expect(result).toContain(`kept port-fix's worktree at ${worker}: ignored files not copied: artifact.bin`)
    expect(result).toContain('Copy what you need from there, then room_collect(tag="port-fix", discard=true) (add force=true to delete ignored files too)')
    expect(fs.readFileSync(path.join(worker, 'artifact.bin'), 'utf8')).toBe('late ignored output')
    const owner = (await registryForDir(lead)).read('w_port-fix')
    expect(owner?.keptWorktree).toBe(worker)
    expect(owner?.archive?.keptReason).toContain('artifact.bin')
    expect(t.s.room.retiredWorkers().find(r => r.tag === 'port-fix')?.keptReason).toContain('artifact.bin')
    expect(await t.call({ tag: 'port-fix', discard: true })).toContain('discard refused; ignored artifacts')
    expect(fs.existsSync(worker)).toBe(true)
    expect(await t.call({ tag: 'port-fix', discard: true, force: true })).toContain('discarded port-fix')
    expect(fs.existsSync(worker)).toBe(false)
  })
  it('keeps late ignored owner output when discarding the last borrower', async () => {
    const t = httpxWorkers('running')
    put(worker, 'new.txt', 'shared output')
    expect(await t.call({ tag: 'port-fix' })).toContain("kept port-fix's worktree")
    put(worker, 'artifact.bin', 'late ignored output')
    await finishWorker(t.s, 'port-bools', { status: 'done' })
    const result = await t.call({ tag: 'port-bools', discard: true })
    expect(result).toContain('detached port-bools; the worktree belongs to port-fix')
    expect(fs.readFileSync(path.join(worker, 'artifact.bin'), 'utf8')).toBe('late ignored output')
    expect((await registryForDir(lead)).read('w_port-fix')?.keptWorktree).toBe(worker)
  })
  it('keeps uncollected changes made after the owner was collected', async () => {
    const t = httpxWorkers('running')
    put(worker, 'new.txt', 'shared output')
    expect(await t.call({ tag: 'port-fix' })).toContain("kept port-fix's worktree")
    put(worker, 'late.txt', 'new borrower work')
    await finishWorker(t.s, 'port-bools', { status: 'done' })
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools')
    const registry = await registryForDir(lead)
    const owner = registry.read('w_port-fix')!, status = registry.status(owner.id)!
    const preservation: WorkerCleanupPreservation = { ignored: [], uncollected: [] }
    await registry.beginOperation(owner.id, 'collect')
    try {
      expect(await cleanupWorker(lead, { ...realStateInput(owner, status), status: 'done', exitCode: 0 }, true, false, [], {}, 'lead', [owner], preservation)).toBe(false)
    } finally { await registry.finishOperation(owner.id) }
    expect(preservation).toEqual({ ignored: [], uncollected: ['late.txt'] })
    expect(fs.readFileSync(path.join(worker, 'late.txt'), 'utf8')).toBe('new borrower work')
  })
  it('deferred retirement keeps an owner checkout while its borrower runs', async () => {
    const t = httpxWorkers('running')
    await t.sync()
    const list = vi.fn(() => [])
    const rooms = { ...t.state.rooms, probe: () => undefined, hasHandle: () => false,
      tracking: () => true, listCwdProcesses: list } as never
    await autoRetire(t.s, rooms)
    const registry = await registryForDir(lead)
    expect(registry.read('w_port-fix')?.phase).toBe('retired')
    expect(registry.read('w_port-fix')?.keptWorktree).toBe(worker)
    expect(fs.existsSync(worker)).toBe(true)
    expect(workerByTag(lead, 'port-bools')?.status).toBe('running')
    expect(list).not.toHaveBeenCalled()
    await finishWorker(t.s, 'port-bools', { status: 'done' })
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools')
    expect(fs.existsSync(worker)).toBe(true)
  })
  it('serializes a borrower resume with the owner cleanup decision', async () => {
    const t = httpxWorkers()
    t.set('port-bools', { ...t.get('port-bools'), hostSessionId: 'borrower-session' })
    await t.sync()
    const registry = await registryForDir(lead)
    expect(registry.status('w_port-bools')?.status).toBe('done')
    await registry.beginOperation('w_port-fix', 'collect')
    try {
      await expect(registry.resume('w_port-bools', 10, { nonce: 'next', busFrontier: 0, logStart: 0 }))
        .rejects.toThrow('worker operation lease held')
    } finally { await registry.finishOperation('w_port-fix') }
    await registry.resume('w_port-bools', 10, { nonce: 'next', busFrontier: 0, logStart: 0 })
    await registry.finishOperation('w_port-bools')
    put(worker, 'new.txt', 'shared output')
    const result = await t.call({ tag: 'port-fix' })
    expect(result).toContain("kept port-fix's worktree: port-bools is still running in it")
    expect(fs.existsSync(worker)).toBe(true)
  })
  it('does not admit a new borrower while owner cleanup holds its operation', async () => {
    const t = httpxWorkers()
    await t.sync()
    const registry = await registryForDir(lead)
    const prior = registry.read('w_port-bools')!
    const late = { ...prior, id: 'w_late', tag: 'late', name: 'lead+late', phase: 'intent' as const,
      prep: { step: 'plan' as const }, runs: [{ ...prior.runs[0], launch: undefined }], seq: 1 }
    await registry.beginOperation('w_port-fix', 'collect')
    try {
      await expect(registry.writeIntent(late)).rejects.toThrow('worker operation lease held')
      expect(registry.read('w_late')).toBeUndefined()
    } finally { await registry.finishOperation('w_port-fix') }
    await registry.writeIntent(late)
    expect(registry.read('w_late')?.sharedWith).toBe('w_port-fix')
    await registry.finishOperation('w_late')
  })
  it('replays an owner discard by retiring its finished borrower first', async () => {
    const t = httpxWorkers()
    await t.sync()
    const registry = await registryForDir(lead)
    await registry.beginDiscard('w_port-fix', false, [])
    await registry.replayDiscard('w_port-fix')
    expect(registry.read('w_port-bools')?.phase).toBe('retiring')
    expect(registry.read('w_port-fix')?.phase).toBe('retiring')
    expect(fs.existsSync(worker)).toBe(false)
  })
  it('discards a worker whose worktree vanished while retaining branch recovery', async () => {
    const t = setup()
    put(worker, 'new.txt', 'output')
    git(worker, 'add', 'new.txt'); git(worker, 'commit', '-qm', 'worker output')
    await t.sync()
    fs.rmSync(worker, { recursive: true, force: true })
    const result = await t.call({ tag: 'test', discard: true })
    expect(result).toContain('discarded test; its worktree was already gone')
    expect(workerByTag(lead, 'test')).toBeUndefined()
    expect(git(lead, 'branch', '--list', 'room/test')).toContain('room/test')
  })
  it('cleans both httpx registry entries after their shared worktree vanished', async () => {
    const t = httpxWorkers()
    await t.sync()
    fs.rmSync(worker, { recursive: true, force: true })
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools')
    expect(await t.call({ tag: 'port-fix', discard: true })).toContain('discarded port-fix')
    expect(workerByTag(lead, 'port-fix')).toBeUndefined()
    expect(workerByTag(lead, 'port-bools')).toBeUndefined()
  })
  it('retires the borrower when the vanished owner is discarded first', async () => {
    const t = httpxWorkers()
    await t.sync()
    fs.rmSync(worker, { recursive: true, force: true })
    const result = await t.call({ tag: 'port-fix', discard: true })
    expect(result).toContain('detached port-bools')
    expect(result).toContain('discarded port-fix; its worktree was already gone')
    expect(workerByTag(lead, 'port-fix')).toBeUndefined()
    expect(workerByTag(lead, 'port-bools')).toBeUndefined()
  })
  it('leaves all files and indexes untouched on a conflict', async () => {
    put(lead, 'file.txt', 'lead\n'); put(worker, 'file.txt', 'worker\n'); put(worker, 'new.txt', 'new')
    const before = git(lead, 'write-tree')
    expect(await setup().call({ tag: 'test' })).toContain('Nothing written; conflicting files: file.txt')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('lead\n')
    expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
    expect(git(lead, 'write-tree')).toBe(before); expect(git(worker, 'rev-parse', 'HEAD')).toBe(base)
  })
  it('cleans successful fully applied workers and their logs', async () => {
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'new'); put(lead, '.room/workers/test.log', 'log'); put(lead, '.room/workers/test.mcp.log', 'log')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test:')
    expect(fs.existsSync(worker)).toBe(false); expect(git(lead, 'branch', '--list', 'room/test')).toBe('')
    expect(fs.existsSync(path.join(lead, '.room'))).toBe(false)
    expect(t.s.room.retiredWorkers()[0].disposition).toBe('collected')
  })
  it('applies ordinary changes but retains uncopied ignored artifacts and their worktree', async () => {
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'new'); put(worker, 'artifact.bin', 'diagnostic output')
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: new.txt')
    expect(result).toContain(`kept artifact.bin at ${path.join(worker, 'artifact.bin')}`)
    expect(result).toContain(`retained worktree: ${worker}`)
    expect(result).not.toContain('cleaned up test')
    expect(fs.readFileSync(path.join(lead, 'new.txt'), 'utf8')).toBe('new')
    expect(fs.readFileSync(path.join(worker, 'artifact.bin'), 'utf8')).toBe('diagnostic output')
    expect(workerByTag(lead, 'test')).toBeUndefined()
    expect(t.s.room.retiredWorkers()[0].summary).toBe(`kept for ignored output at ${worker}`)
    expect(fs.existsSync(worker)).toBe(true)
  })

  it('merges a worker against its carried-in commit: the lead\'s later edits to carried lines survive and only the worker\'s lines land', async () => {
    commitLines()
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    put(lead, 'app.py', LINES.replace('two', 'W')); put(lead, 'notes.txt', 'draft\n')
    carry(t, worker, 'test', { 'app.py': LINES.replace('two', 'W'), 'notes.txt': 'draft\n' })
    put(lead, 'app.py', LINES.replace('two', 'W2')); put(lead, 'notes.txt', 'draft 2\n')
    put(worker, 'app.py', LINES.replace('two', 'W').replace('five', 'WORKER'))
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: app.py. Nothing committed or staged.')
    expect(fs.readFileSync(path.join(lead, 'app.py'), 'utf8')).toBe(LINES.replace('two', 'W2').replace('five', 'WORKER'))
    expect(fs.readFileSync(path.join(lead, 'notes.txt'), 'utf8')).toBe('draft 2\n')
    expect(t.s.room.retiredWorkers().map(r => r.files)).toEqual([['app.py']])
  })
  it('merges each of two workers against its own carried-in commit', async () => {
    commitLines()
    const t = setup(), other = second(t)
    put(lead, 'app.py', LINES.replace('two', 'W'))
    carry(t, worker, 'test', { 'app.py': LINES.replace('two', 'W') })
    put(lead, 'app.py', LINES.replace('two', 'W2').replace('three', 'X'))
    carry(t, other, 'second', { 'app.py': LINES.replace('two', 'W2').replace('three', 'X') })
    put(lead, 'app.py', LINES.replace('two', 'W3').replace('three', 'X2'))
    put(worker, 'app.py', LINES.replace('two', 'W').replace('seven', 'A'))
    put(other, 'app.py', LINES.replace('two', 'W2').replace('three', 'X').replace('five', 'B'))
    expect(await t.call({})).toContain('Changes from second, test: app.py.')
    expect(fs.readFileSync(path.join(lead, 'app.py'), 'utf8')).toBe('one\nW3\nX2\nfour\nB\nsix\nA\n')
  })
  it('does not treat unchanged CRLF carried files as worker edits', async () => {
    commitLines()
    git(lead, 'config', 'core.autocrlf', 'true')
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    const crlf = (value: string) => value.replace(/\n/g, '\r\n')
    put(lead, 'app.py', crlf(LINES.replace('two', 'W')))
    put(worker, 'app.py', crlf(LINES.replace('two', 'W')))
    git(worker, 'add', 'app.py'); git(worker, 'commit', '-qm', 'room: carried-in uncommitted work from lead')
    t.set('test', { ...t.get('test'), base: git(worker, 'rev-parse', 'HEAD') })
    put(lead, 'app.py', crlf(LINES.replace('two', 'W2')))
    put(worker, 'new.txt', 'worker output\n')
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: new.txt.')
    expect(fs.readFileSync(path.join(lead, 'app.py'), 'utf8')).toBe(crlf(LINES.replace('two', 'W2')))
  })
  it('does not collect unchanged carried untracked files over later lead edits', async () => {
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    put(lead, 'notes.txt', 'lead draft\n')
    put(worker, 'notes.txt', 'lead draft\n')
    const sha = git(worker, 'hash-object', '-w', 'notes.txt')
    t.set('test', { ...t.get('test'), carriedUntracked: [{ path: 'notes.txt', sha }] })
    put(lead, 'notes.txt', 'lead revised draft\n')
    put(worker, 'new.txt', 'worker output\n')
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: new.txt.')
    expect(fs.readFileSync(path.join(lead, 'notes.txt'), 'utf8')).toBe('lead revised draft\n')
  })
  it('preserves a later lead mode change on an unchanged carried untracked file', async () => {
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    put(lead, 'run.sh', '#!/bin/sh\necho lead\n')
    put(worker, 'run.sh', '#!/bin/sh\necho lead\n')
    const sha = git(worker, 'hash-object', '-w', 'run.sh')
    t.set('test', { ...t.get('test'), carriedUntracked: [{ path: 'run.sh', sha }] })
    fs.chmodSync(path.join(lead, 'run.sh'), 0o755)
    put(worker, 'new.txt', 'worker output\n')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test: new.txt.')
    expect(fs.statSync(path.join(lead, 'run.sh')).mode & 0o777).toBe(0o755)
  })
  it('merges a changed carried untracked file against the lead copy', async () => {
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    put(lead, 'notes.txt', LINES)
    put(worker, 'notes.txt', LINES)
    const sha = git(worker, 'hash-object', '-w', 'notes.txt')
    t.set('test', { ...t.get('test'), carriedUntracked: [{ path: 'notes.txt', sha }] })
    put(lead, 'notes.txt', LINES.replace('two', 'LEAD'))
    put(worker, 'notes.txt', LINES.replace('six', 'WORKER'))
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: notes.txt.')
    expect(fs.readFileSync(path.join(lead, 'notes.txt'), 'utf8')).toBe(LINES.replace('two', 'LEAD').replace('six', 'WORKER'))
  })
  it('refuses a changed carried untracked file when its private base blob is missing', async () => {
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    put(lead, 'notes.txt', 'lead revised\n')
    put(worker, 'notes.txt', 'worker revised\n')
    t.set('test', { ...t.get('test'), carriedUntracked: [{ path: 'notes.txt', sha: 'f'.repeat(40) }] })
    const result = await t.call({ tag: 'test' })
    expect(result).toMatch(/Nothing written;.*missing private base blob: notes\.txt/i)
    expect(fs.readFileSync(path.join(lead, 'notes.txt'), 'utf8')).toBe('lead revised\n')
    expect(fs.existsSync(worker)).toBe(true)
  })
  it('keeps the lead\'s later file-mode change to a carried file the worker left alone', async () => {
    put(lead, 'run.sh', '#!/bin/sh\n'); git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'script'); git(worker, 'merge', '-q', '--ff-only', git(lead, 'rev-parse', 'HEAD'))
    const t = setup()
    fs.chmodSync(path.join(lead, 'run.sh'), 0o755); fs.chmodSync(path.join(worker, 'run.sh'), 0o755)
    carry(t, worker, 'test', {})
    fs.chmodSync(path.join(lead, 'run.sh'), 0o644)
    put(worker, 'new.txt', 'new\n')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test: new.txt.')
    expect(fs.statSync(path.join(lead, 'run.sh')).mode & 0o777).toBe(0o644)
  })

  it('waits for a done worker to exit without requiring force', async () => {
    const t = setup()
    let at = 0
    const sleep = vi.fn(async (ms: number) => { at += ms })
    t.state.now = () => at
    t.state.ctx = { listCwdProcesses: () => [], sleep } as HandlerState['ctx']
    t.state.workerAlive = () => at < 10_000
    put(worker, 'new.txt', 'new')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test:')
    expect(sleep).toHaveBeenCalledTimes(40)
    expect(sleep).toHaveBeenCalledWith(250)
  })
  it('uses the confirmed exit record after waiting when cleaning up', async () => {
    const t = setup(); let alive = true
    t.state.workerAlive = () => alive
    t.state.ctx = { listCwdProcesses: () => [], sleep: async () => { alive = false } } as HandlerState['ctx']
    put(worker, 'new.txt', 'new')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test:')
    expect(fs.existsSync(worker)).toBe(false)
  })
  it('bounds the exit wait at 15 seconds and never collects a live process', async () => {
    const t = setup()
    let at = 0
    t.state.now = () => at
    t.state.ctx = { listCwdProcesses: () => [], sleep: async (ms: number) => { at += ms } } as HandlerState['ctx']
    t.state.workerAlive = () => true
    expect(await t.call({ tag: 'test' })).toContain('skipped test: process still exiting after 15 s; call room_collect tag=test again in a few seconds')
    expect(at).toBe(15_000)
    expect(git(worker, 'rev-parse', 'HEAD')).toBe(base)
    expect(await t.call({ tag: 'test', force: true })).toContain('skipped test: process still exiting')
    expect(at).toBe(30_000)
  })

  it('keeps a worker in room presence if its process is live at final collection', async () => {
    const t = setup()
    put(worker, 'new.txt', 'worker change')
    seedPresence(t)
    let alive = false
    t.state.workerAlive = () => alive
    release.mockImplementationOnce(() => { alive = true })
    expect(await t.call({ tag: 'test' })).toContain('kept test: clean exit not confirmed')
    expect(workerByTag(lead, 'test')).toBeDefined()
    expect(t.s.room.scopes.has(t.w.name)).toBe(true)
    expect(t.s.room.overlays.has(t.w.name)).toBe(true)
    expect(t.s.room.retiredWorkers()).toEqual([])
  })



  it('copies ignored and nested artifacts byte-for-byte, without committing', async () => {
    put(worker, 'artifact.bin', 'a\0b'); put(worker, 'out/nested.txt', 'nested')
    const t = setup(), before = git(lead, 'rev-parse', 'HEAD')
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['artifact.bin', 'out'] })).toBe('copied artifact.bin\ncopied out/nested.txt')
    expect(fs.readFileSync(path.join(lead, 'artifact.bin'))).toEqual(fs.readFileSync(path.join(worker, 'artifact.bin')))
    expect(git(lead, 'rev-parse', 'HEAD')).toBe(before)
    expect(fs.existsSync(worker)).toBe(true)
  })
  it('preflights the whole copy before releasing or writing, and requires force for modified destinations', async () => {
    put(worker, 'a.txt', 'a'); put(worker, 'file.txt', 'worker'); put(lead, 'file.txt', 'lead')
    const t = setup()
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['a.txt', 'file.txt'] })).toContain('lead has modified file.txt')
    expect(fs.existsSync(path.join(lead, 'a.txt'))).toBe(false); expect(release).not.toHaveBeenCalled()
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['file.txt'], force: true })).toBe('copied file.txt')
  })
  it('preserves an original and a newly created later destination during copy preparation', async () => {
    put(worker, 'file.txt', 'worker replacement\n'); put(worker, 'new.txt', 'worker new\n')
    const t = setup()
    const original = fs.readFileSync(path.join(lead, 'file.txt'))
    const realCopy = fs.promises.copyFile.bind(fs.promises)
    let copies = 0
    const seam = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (...args) => {
      await realCopy(...args)
      if (++copies === 1) put(lead, 'new.txt', 'new lead edit during copy\n')
    })
    try {
      expect(await t.call({ tag: 'test', mode: 'copy', paths: ['file.txt', 'new.txt'] })).toMatch(/new\.txt changed during collection; nothing written, retry/)
      expect(fs.readFileSync(path.join(lead, 'file.txt'))).toEqual(original)
      expect(fs.readFileSync(path.join(lead, 'new.txt'), 'utf8')).toBe('new lead edit during copy\n')
      expect(release).not.toHaveBeenCalled()
    } finally { seam.mockRestore() }
  })
  it('refuses a source changed while an earlier copy is prepared', async () => {
    put(worker, 'a.txt', 'worker a\n'); put(worker, 'b.txt', 'worker b\n')
    const t = setup()
    const realCopy = fs.promises.copyFile.bind(fs.promises)
    let copies = 0
    const seam = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (...args) => {
      await realCopy(...args)
      if (++copies === 1) put(worker, 'b.txt', 'worker b changed during copy\n')
    })
    try {
      expect(await t.call({ tag: 'test', mode: 'copy', paths: ['a.txt', 'b.txt'] })).toMatch(/b\.txt changed during collection; nothing written, retry/)
      expect(fs.existsSync(path.join(lead, 'a.txt'))).toBe(false)
      expect(fs.existsSync(path.join(lead, 'b.txt'))).toBe(false)
      expect(release).not.toHaveBeenCalled()
    } finally { seam.mockRestore() }
  })
  it('rolls back copied files and restores original leaves when a later rename fails', async () => {
    put(worker, 'file.txt', 'worker replacement\n'); put(worker, 'new.txt', 'worker new\n')
    const t = setup()
    const original = fs.readFileSync(path.join(lead, 'file.txt'))
    const rename = fs.renameSync.bind(fs)
    const seam = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('collect-copy-') && String(from).endsWith('.new') && to === path.join(lead, 'new.txt')) throw new Error('injected second rename failure')
      return rename(from, to)
    })
    try {
      expect(await t.call({ tag: 'test', mode: 'copy', paths: ['file.txt', 'new.txt'] })).toContain('injected second rename failure')
      expect(fs.readFileSync(path.join(lead, 'file.txt'))).toEqual(original)
      expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
      expect(release).not.toHaveBeenCalled()
    } finally { seam.mockRestore() }
  })
  it('yields through 2,000 copy paths without reading whole file contents into memory', async () => {
    for (let i = 0; i < 2_000; i++) put(worker, `bulk/${i.toString().padStart(4, '0')}.txt`, 'x')
    const t = setup()
    let turnRan = false, copies = 0
    const realCopy = fs.promises.copyFile.bind(fs.promises)
    const copy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (...args) => {
      expect(turnRan).toBe(true)
      copies++
      return realCopy(...args)
    })
    const read = vi.spyOn(fs, 'readFileSync')
    setImmediate(() => { turnRan = true })
    try {
      const reply = await t.call({ tag: 'test', mode: 'copy', paths: ['bulk'] })
      expect(reply.match(/^copied bulk\//gm)).toHaveLength(2_000)
      expect(copies).toBe(2_000)
      expect(read.mock.calls.filter(([name]) => typeof name === 'string' && name.includes('/bulk/'))).toHaveLength(0)
    } finally { copy.mockRestore(); read.mockRestore() }
  })
  it('refuses a destination that grows after apply preparation, before any write', async () => {
    put(worker, 'file.txt', 'worker\n')
    put(worker, 'new.txt', 'new\n')
    const t = setup()
    await t.sync()
    const registry = await registryForDir(lead)
    const begin = registry.beginCollect.bind(registry)
    const seam = vi.spyOn(registry, 'beginCollect').mockImplementation(async id => {
      await begin(id)
      fs.appendFileSync(path.join(lead, 'file.txt'), 'x'.repeat(600_000))
    })
    try {
      expect(await t.call({ tag: 'test' })).toMatch(/file\.txt changed during collection; nothing written, retry/)
      expect(fs.readFileSync(path.join(lead, 'file.txt')).length).toBeGreaterThan(512 * 1024)
      expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
      expect(workerByTag(lead, 'test')).toBeDefined()
    } finally { seam.mockRestore() }
  })
  it('treats an oversized matching copy destination as a conflict until force is explicit', async () => {
    const large = Buffer.alloc(512 * 1024 + 1, 65)
    fs.writeFileSync(path.join(worker, 'large.bin'), large)
    fs.writeFileSync(path.join(lead, 'large.bin'), large)
    const t = setup()
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['large.bin'] })).toContain('lead has modified large.bin; pass force=true')
    expect(release).not.toHaveBeenCalled()
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['large.bin'], force: true })).toBe('copied large.bin')
  })
  it('restores earlier destinations if a later apply write fails', async () => {
    put(worker, 'a.txt', 'new a\n'); put(worker, 'b.txt', 'new b\n')
    const t = setup()
    const open = fs.openSync.bind(fs)
    const seam = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (file === path.join(lead, 'b.txt') && typeof flags === 'number' && (flags & fs.constants.O_WRONLY)) throw new Error('injected write failure')
      return open(file, flags, mode)
    }) as typeof fs.openSync)
    try {
      expect(await t.call({ tag: 'test' })).toContain('injected write failure')
      expect(fs.existsSync(path.join(lead, 'a.txt'))).toBe(false)
      expect(fs.existsSync(path.join(lead, 'b.txt'))).toBe(false)
      expect(workerByTag(lead, 'test')).toBeDefined()
    } finally { seam.mockRestore() }
  })
  it('guards running workers and invalid modes', async () => {
    const t = setup('running')
    expect(await t.call({ tag: 'test' })).toContain('skipped test: running')
    expect(await t.call({ tag: 'test', mode: 'bad' })).toContain('mode must be')
    expect(await t.call({ tag: 'test', force: true })).toContain('skipped test: running')
  })
  it('rejects traversal, Git metadata, source and destination symlinks even with force', async () => {
    put(worker, 'out/value', 'value'); fs.symlinkSync(root, path.join(worker, 'escape'))
    fs.symlinkSync(root, path.join(lead, 'out'))
    const t = setup()
    for (const p of ['../escape', '.git/config', 'escape/lead/file.txt', 'out/value']) {
      expect(await t.call({ tag: 'test', mode: 'copy', paths: [p], force: true })).toMatch(/unsafe|symlink/)
    }
    expect(release).not.toHaveBeenCalled()
  })

})

async function previewSetup() {
  const t = setup()
  await t.sync()
  return t
}

describe('worker preview', () => {
  it('does not link dependencies through an archived symlink ancestor', async () => {
    const scratch = path.join(root, 'scratch'), outside = path.join(root, 'outside')
    fs.mkdirSync(path.join(lead, 'packages', 'pkg', 'node_modules', 'dep'), { recursive: true })
    fs.mkdirSync(path.join(scratch, 'packages'), { recursive: true })
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(scratch, 'packages', 'pkg'))
    await expect(linkSharedDirs(lead, scratch)).rejects.toThrow(/unsafe merged ancestor|escapes scratch tree/)
    expect(fs.existsSync(path.join(outside, 'node_modules'))).toBe(false)
  })

  it('yields within package discovery, including skipped package directories', async () => {
    const scratch = path.join(root, 'scratch')
    fs.mkdirSync(scratch)
    for (let i = 0; i < 2_000; i++) fs.mkdirSync(path.join(lead, 'packages', `pkg-${String(i).padStart(4, '0')}`), { recursive: true })
    const exists = fs.existsSync.bind(fs)
    let turned = false, lastSawTurn = false
    const seam = vi.spyOn(fs, 'existsSync').mockImplementation((file: fs.PathLike) => {
      if (String(file).endsWith('pkg-0000/node_modules')) setImmediate(() => { turned = true })
      if (String(file).endsWith('pkg-1999/node_modules')) lastSawTurn = turned
      return exists(file)
    })
    try {
      await linkSharedDirs(lead, scratch)
      expect(lastSawTurn).toBe(true)
    } finally { seam.mockRestore() }
  })

  it('yields within scoped package links before creating the last symlink', async () => {
    const scratch = path.join(root, 'scratch')
    fs.mkdirSync(path.join(lead, 'node_modules', '@scope'), { recursive: true })
    fs.mkdirSync(scratch)
    for (let i = 0; i < 96; i++) fs.mkdirSync(path.join(lead, 'node_modules', '@scope', `lib-${String(i).padStart(3, '0')}`))
    const symlink = fs.symlinkSync.bind(fs)
    let turned = false, lastSawTurn = false
    const seam = vi.spyOn(fs, 'symlinkSync').mockImplementation(((target: fs.PathLike, file: fs.PathLike, type?: fs.symlink.Type) => {
      if (String(file).endsWith('lib-000')) setImmediate(() => { turned = true })
      if (String(file).endsWith('lib-095')) lastSawTurn = turned
      return symlink(target, file, type)
    }) as typeof fs.symlinkSync)
    try {
      await linkSharedDirs(lead, scratch)
      expect(lastSawTurn).toBe(true)
    } finally { seam.mockRestore() }
  })

  it('refuses a symlink ancestor in the extracted scratch tree', () => {
    const scratch = path.join(root, 'scratch'), outside = path.join(root, 'outside')
    fs.mkdirSync(scratch); fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(scratch, 'config'))
    expect(() => materializeMergedFile(scratch, 'config/value.txt', Buffer.from('secret'))).toThrow('unsafe merged ancestor')
    expect(fs.existsSync(path.join(outside, 'value.txt'))).toBe(false)
  })

  it('does not write through a symlink restored from the ancestor archive', async () => {
    const external = path.join(root, 'external.txt')
    put(root, 'external.txt', 'outside stays intact\n')
    fs.symlinkSync(external, path.join(lead, 'config.txt'))
    git(lead, 'add', 'config.txt'); git(lead, 'commit', '-qm', 'symlink ancestor')
    const head = git(lead, 'rev-parse', 'HEAD')
    git(worker, 'merge', '-q', '--ff-only', head)
    fs.unlinkSync(path.join(lead, 'config.txt'))
    fs.unlinkSync(path.join(worker, 'config.txt'))
    put(lead, 'config.txt', 'safe lead version\n')
    put(worker, 'config.txt', 'safe lead version\n')
    put(worker, 'file.txt', 'worker edit\n')
    const t = await previewSetup()
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => head, shareOf: () => 'full', liveText: async () => undefined,
    })
    await t.sync()
    await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'cat config.txt && echo "1 passed"' })
    expect(fs.readFileSync(external, 'utf8')).toBe('outside stays intact\n')
  })

  it('runs against the same binary bytes and executable mode that collect applies', async () => {
    const t = await previewSetup()
    fs.writeFileSync(path.join(worker, 'fixture.bin'), Buffer.from([0, 255, 1]))
    put(worker, 'run.sh', '#!/bin/sh\necho run\n')
    fs.chmodSync(path.join(worker, 'run.sh'), 0o755)
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => base, shareOf: () => 'full', liveText: async () => undefined,
    })
    await t.sync()
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'test "$(od -An -tu1 fixture.bin | tr -s " " | xargs)" = "0 255 1" && test -x run.sh && echo "1 passed"' })
    expect(result).toContain('tests: PASSED (exit 0)')
  })
  it('previews the lead\'s own local intent-only worker from its worktree', async () => {
    const t = await previewSetup()
    put(worker, 'own-output.txt', 'worker output')
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [],
      withheld: () => 'lead+test shares intent only; ask them or wait for their push',
      baseFor: () => base, shareOf: () => 'intent', liveText: async () => undefined,
    })
    await t.sync()
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test' })
    expect(result).toContain('own-output.txt (lead+test only)')
  })
  it('withholds the lead\'s own intent-only worker once its worktree vanished', async () => {
    const t = await previewSetup()
    fs.rmSync(worker, { recursive: true, force: true })
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [],
      withheld: () => 'lead+test shares intent only; ask them or wait for their push',
      baseFor: () => base, shareOf: () => 'intent', liveText: async () => undefined,
    })
    await t.sync()
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test' })
    expect(result).toContain("lead+test's worktree no longer exists")
    expect(result).toContain('PARTIAL preview')
    expect(result).toContain('no manifest record')
  })
  it('previews a vanished local worker from its shared overlay instead of its checkout', async () => {
    const t = await previewSetup()
    put(worker, 'disk-only.txt', 'never shared')
    publishFixture(t.s.room, 'lead+test', 'shared.txt', 'shared change\n')
    fs.rmSync(worker, { recursive: true, force: true })
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => base, shareOf: () => 'full',
      liveText: async (_s: unknown, p: string) => p === 'shared.txt' ? 'shared change\n' : undefined,
    })
    await t.sync()
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test' })
    expect(result).toContain("lead+test's worktree no longer exists; previewing its shared overlay instead")
    expect(result).toContain('shared.txt')
    expect(result).not.toContain('disk-only.txt')
  })
  it('collects Unicode UTF-8 bytes unchanged from a worker worktree', async () => {
    const t = await previewSetup()
    const value = Buffer.from('em dash —, CJK 漢, emoji 😀\n', 'utf8')
    fs.writeFileSync(path.join(worker, 'unicode.txt'), value)
    expect(await t.call({ tag: 'test' })).toContain('Changes from test: unicode.txt')
    expect(fs.readFileSync(path.join(lead, 'unicode.txt'))).toEqual(value)
  })

  it.each([true, false])('skips linked and escaping symlinks from both sides (record=%s)', async recorded => {
    put(lead, 'data/input', 'private input')
    put(worker, '.gitignore', 'artifact.bin\ndata/\n')
    fs.symlinkSync(path.join(lead, 'data'), path.join(worker, 'data'))
    put(worker, 'new.txt', 'output')
    const t = setup()
    if (recorded) t.set('test', { ...t.get('test'), link: ['data'] })
    const ws = { ...t.s, dir: worker, me: { name: 'lead+test', kind: 'agent' } }
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => base, shareOf: () => 'full', liveText: async () => undefined,
    })
    const reason = recorded ? 'linked input' : 'symlink leaving the worktree'
    await t.sync()
    const leadResult = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test' })
    expect(leadResult).toContain(`NOT previewed (${reason}, lead+test): data`)
    expect(leadResult).toContain('new.txt (lead+test only)')
    t.state.S = () => ws as unknown as ReturnType<HandlerState['S']>
    await t.sync()
    const workerResult = await fileHandlers(t.state).room_preview_merge({ person: 'lead' })
    expect(workerResult).toContain(`NOT previewed (${reason}, lead+test): data`)
    expect(workerResult).toContain('no conflicts')
  })
  it('previews a worker against its carried-in commit, not the lead\'s HEAD', async () => {
    const head = commitLines()
    const t = setup()
    put(lead, 'app.py', LINES.replace('two', 'W')); put(lead, 'notes.txt', 'draft\n')
    carry(t, worker, 'test', { 'app.py': LINES.replace('two', 'W'), 'notes.txt': 'draft\n' })
    put(lead, 'app.py', LINES.replace('two', 'W2')); put(lead, 'notes.txt', 'draft 2\n')
    put(worker, 'app.py', LINES.replace('two', 'W').replace('five', 'WORKER'))
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: (_s: unknown, person: string) => person === 'lead' ? head : workerByTag(lead, 'test')!.base, shareOf: () => 'full',
      liveText: async () => undefined,
    })
    await t.sync()
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'cat app.py notes.txt' })
    expect(result).toContain('both changed, merge cleanly: app.py')
    expect(result).not.toContain('notes.txt (lead+test')
    expect(result).toContain('no conflicts')
    expect(result).toContain('one\nW2\nthree\nfour\nWORKER\nsix\nseven\ndraft 2')
  })
  it('discovers untracked worker paths and explicitly excludes ignored output', async () => {
    put(worker, 'new.txt', 'new\n'); put(worker, 'empty.txt', ''); put(worker, 'artifact.bin', 'artifact')
    const nested = path.join(lead, 'nested'); fs.mkdirSync(nested); git(nested, 'init', '-q')
    const t = await previewSetup()
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => base, shareOf: () => 'full',
      liveText: async (_s: unknown, p: string, person: string) => {
        try { return fs.readFileSync(path.join(person === 'lead' ? lead : worker, p), 'utf8') }
        catch { return undefined }
      },
    })
    await t.sync()
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'cat new.txt' })
    expect(result).toContain('new.txt (lead+test only)')
    expect(result).toContain('NOT previewed (gitignored, lead+test): artifact.bin')
    expect(result).toContain('empty.txt (lead+test only)')
    expect(result).toContain('NOT previewed (directory or nested repository): nested/')
    expect(result).toContain('exit 0')
  })
})
