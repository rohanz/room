import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from '@room/shared'
import { handlers } from '../src/tools/collect.js'
import { createTools } from '../src/tools.js'
import type { HandlerState } from '../src/tools/context.js'
import type { Session } from '../src/session.js'
import type { SpawnSpec } from '../src/worker-process.js'
import { collectBaseRef, collectHeadRef, prepareWorktree } from '../src/worker-git.js'
import { closeRegistryForDir, localWorkers, registryForDir } from '../src/worker-registry.js'
import { projectWorkers } from '../src/worker-projector.js'
import type { WorkerRecord } from '../src/worker-status.js'
import { finishWorker, registerWorkers, workerByTag, type FixtureWorker } from './registry-fixture.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'
import { clearFixtureProcesses, finishFixtureProcess, fixtureLiveness, fixtureProbe, spawnFixtureProcess } from './fixtures/process-liveness.js'

// Real Git and registry state; only process liveness and the external host are synthetic.
vi.setConfig({ testTimeout: 30_000 })
vi.mock('../src/leases.js', async original => {
  const actual = await original<typeof import('../src/leases.js')>()
  return { ...actual, liveness: (identity: Parameters<typeof actual.liveness>[0]) => fixtureLiveness(identity, actual.liveness) }
})
vi.mock('../src/tools/claims.js', async original => ({ ...await original<typeof import('../src/tools/claims.js')>(), releaseClaimsOnDone: vi.fn() }))

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const put = (dir: string, rel: string, text: string) => {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8')
const durable = <T>(value: T): T => JSON.parse(JSON.stringify(value))
let root: string, lead: string, worker: string, base: string
const cleanups: (() => Promise<void>)[] = []

beforeEach(() => {
  clearFixtureProcesses()
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-keep-adversarial-')))
  lead = path.join(root, 'lead'); worker = path.join(lead, '.room/workers/test')
  fs.mkdirSync(lead)
  git(lead, 'init', '-q', '-b', 'main')
  git(lead, 'config', 'user.name', 'Lead'); git(lead, 'config', 'user.email', 'lead@example.test')
  put(lead, '.gitignore', '.room/\nartifact.bin\n')
  put(lead, 'file.txt', 'base\n'); put(lead, 'stable.txt', 'stable base\n'); put(lead, 'gone.txt', 'delete me\n')
  git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'base')
  base = git(lead, 'rev-parse', 'HEAD')
  git(lead, 'worktree', 'add', '-qb', 'room/test', worker)
})
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0)) await cleanup() }
  finally { await closeRegistryForDir(lead); fs.rmSync(root, { recursive: true, force: true }) }
})

function session(room: RoomDoc, dir: string, name: string): Session {
  return { ...hubSeam(room), policyStore: testPolicyStore(), dir, me: { name, kind: 'agent' }, room,
    local: { url: 'ws://127.0.0.1:1' }, roomName: 'local/test', roomUrl: 'ws://127.0.0.1:1/local%2Ftest',
    provider: { synced: true }, browserUrl: 'http://test', awareness: { getStates: () => new Map() },
    daemon: { fence: 'test', touch() {} } } as unknown as Session
}

async function harness(patch: Partial<FixtureWorker> = {}, dir = lead, name = 'lead', room = new RoomDoc(new Y.Doc())) {
  room.setMeta({ base, branch: 'main', repo: 'test' })
  const s = session(room, dir, name)
  const fixture: FixtureWorker = { tag: 'test', name: 'lead+test', lead: name, dir: worker, branch: 'room/test',
    status: 'done', base, host: 'codex', task: 'task', startedAt: 1, finishedAt: 2, exitCode: 0,
    hostSessionId: 'retained-test-session', pid: 0, ...patch }
  const registry = await registerWorkers(s, [fixture])
  const project = async () => {
    for (const owner of new Set(registry.list().map(record => record.lead.participant))) await projectWorkers(s, registry, owner, 'joined')
  }
  const state = { S: () => s, rooms: { all: () => [s], holding: () => s, holdingWorker: () => s,
    reserve: () => true, unreserve() {}, autoRetire: async () => {}, project, hasHandle: () => false, tracking: () => true },
    workerAlive: () => false, now: Date.now, ctx: { probe: fixtureProbe, listCwdProcesses: () => [] } } as unknown as HandlerState
  const record = (tag = fixture.tag) => registry.list().find(record => record.tag === tag)!
  return { s, registry, state, record, call: handlers(state).room_collect }
}
type Harness = Awaited<ReturnType<typeof harness>>

/** Keep advances the baseline and records retention without changing the schema version or run. */
function expectKept(t: Harness, before: WorkerRecord, sourceHead = base): WorkerRecord {
  const current = t.registry.read(before.id)!
  const snapshot = git(lead, 'rev-parse', collectHeadRef(before.tag, before.id))
  expect(current).toEqual({ ...durable({ ...before, base: snapshot, collectedKeep: true, carriedBase: undefined,
    carriedUntracked: undefined, interrupted: undefined, phase: 'active', seq: before.seq + 2 }),
    keptPublication: { paths: expect.any(Array), pending: true, base: snapshot } })
  expect(current.v).toBe(1)
  expect(current.keptWorktree).toBeUndefined()
  expect(current.archive).toBeUndefined()
  expect(current.stop).toBeUndefined()
  expect(t.registry.status(current.id)).toMatchObject({ status: 'done', run: { n: 1 } })
  expect(git(lead, 'rev-parse', collectBaseRef(before.tag, before.id))).toBe(before.base)
  expect(git(lead, 'show', '-s', '--format=%P', snapshot)).toBe(sourceHead)
  expect(git(lead, 'show', '-s', '--format=%s', snapshot)).toBe('room: kept collection baseline')
  expect(git(before.dir, 'rev-parse', 'HEAD')).toBe(sourceHead)
  expect(git(before.dir, 'diff', '--cached')).toBe('')
  expect(git(lead, 'diff', '--cached')).toBe('')
  expect(fs.existsSync(before.dir)).toBe(true)
  expect(workerByTag(lead, before.tag)?.base).toBe(snapshot)
  expect(t.s.room.retiredWorkers()).toEqual([])
  return current
}

function expectRetired(t: Harness, kept: WorkerRecord, disposition: 'collected' | 'discarded') {
  expect(t.registry.read(kept.id)).toMatchObject({ v: 1, phase: 'retired', base: kept.base,
    archive: { id: kept.id, tag: kept.tag, disposition } })
  expect(workerByTag(lead, kept.tag)).toBeUndefined()
  expect(fs.existsSync(kept.dir)).toBe(false)
  expect(git(lead, 'branch', '--list', kept.branch)).toBe('')
  expect(git(lead, 'for-each-ref', '--format=%(refname)', collectHeadRef(kept.tag, kept.id), collectBaseRef(kept.tag, kept.id))).toBe('')
  expect(git(lead, 'diff', '--cached')).toBe('')
}

function sender(t: Harness) {
  let exit: ((code: number | null) => void) | undefined
  const pid = 4_100_001
  const spawner = vi.fn((_spec: SpawnSpec) => {
    spawnFixtureProcess(pid, 'codex')
    return { pid, started: Promise.resolve(), onExit: (cb: (code: number | null) => void) => { exit = cb },
      kill: () => { finishFixtureProcess(pid); exit?.(0); return true } }
  })
  const tools = createTools({ getSession: () => t.s, setSession() {}, leave: async () => {}, log() {},
    cwd: t.s.dir, spawner, probe: fixtureProbe, listCwdProcesses: () => [] })
  cleanups.push(() => tools.shutdown())
  return { tools, spawner, finish: () => { expect(exit).toBeDefined(); finishFixtureProcess(pid); exit!(0) } }
}

describe('adversarial kept collection lifecycle', () => {
  it('refuses keep while running without moving the base, reserving a snapshot or writing any output', async () => {
    const t = await harness({ status: 'running', pid: 4_100_002, finishedAt: undefined, exitCode: undefined })
    put(worker, 'file.txt', 'unfinished\n'); put(worker, 'new.txt', 'unfinished new file\n')
    const before = t.record()
    t.state.workerAlive = () => true
    expect(await t.call({ tag: 'test', keep: true })).toContain('skipped test: running')
    expect(t.record()).toEqual(before)
    expect(t.registry.status(before.id)).toMatchObject({ status: 'running', run: { n: 1 } })
    expect(git(lead, 'for-each-ref', '--format=%(refname)', 'refs/room/collect-head', 'refs/room/collect-base')).toBe('')
    expect(read(lead, 'file.txt')).toBe('base\n'); expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
    expect(read(worker, 'file.txt')).toBe('unfinished\n'); expect(git(worker, 'rev-parse', 'HEAD')).toBe(base)
  })

  it('keeps twice, absorbs additions and deletions once, and never reapplies the lead-revised first edit', async () => {
    const t = await harness()
    put(worker, 'file.txt', 'first edit\n'); put(worker, 'new.txt', 'once\n')
    fs.rmSync(path.join(worker, 'gone.txt'))
    const firstBefore = t.record()
    expect(await t.call({ tag: 'test', keep: true })).toContain('Changes from test:')
    const first = expectKept(t, firstBefore)
    expect(read(lead, 'file.txt')).toBe('first edit\n'); expect(read(lead, 'new.txt')).toBe('once\n')
    expect(fs.existsSync(path.join(lead, 'gone.txt'))).toBe(false)
    put(lead, 'file.txt', 'lead revision\n')
    put(worker, 'new.txt', 'once\nsecond\n')
    expect(await t.call({ tag: 'test', keep: true })).toContain('Changes from test: new.txt.')
    const second = expectKept(t, first)
    expect(second.base).not.toBe(first.base)
    expect(git(lead, 'show', `${second.base}:file.txt`)).toBe('first edit')
    expect(git(lead, 'show', `${second.base}:new.txt`)).toBe('once\nsecond')
    expect(read(lead, 'file.txt')).toBe('lead revision\n'); expect(read(lead, 'new.txt')).toBe('once\nsecond\n')
    expect(fs.existsSync(path.join(lead, 'gone.txt'))).toBe(false)
    expect(read(lead, 'stable.txt')).toBe('stable base\n')
  })

  it.each([false, true])('plain collect after keep applies only the follow-up and cleans up (committed follow-up: %s)', async committed => {
    const t = await harness()
    put(worker, 'file.txt', 'collected first\n'); put(worker, 'new.txt', 'first\n')
    const before = t.record()
    expect(await t.call({ tag: 'test', keep: true })).toContain('kept test:')
    const kept = expectKept(t, before)
    put(lead, 'file.txt', 'lead owns this now\n'); put(worker, 'new.txt', 'first\nfollow-up\n')
    if (committed) { git(worker, 'add', '-A'); git(worker, 'commit', '-qm', 'follow-up') }
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: new.txt.'); expect(result).toContain('cleaned up test')
    expect(read(lead, 'file.txt')).toBe('lead owns this now\n'); expect(read(lead, 'new.txt')).toBe('first\nfollow-up\n')
    expect(read(lead, 'stable.txt')).toBe('stable base\n'); expect(read(lead, 'gone.txt')).toBe('delete me\n')
    expectRetired(t, kept, 'collected')
  })

  it('discard after keep preserves the lead edit and a recovery patch containing only uncollected work', async () => {
    const t = await harness()
    put(worker, 'file.txt', 'already collected\n')
    const before = t.record()
    expect(await t.call({ tag: 'test', keep: true })).toContain('kept test:')
    const kept = expectKept(t, before)
    put(lead, 'file.txt', 'lead revised collected work\n')
    put(worker, 'later.txt', 'recover this\n')
    const out = await t.call({ tag: 'test', discard: true })
    expect(out).toContain('discarded test'); expect(out).toContain('recovery patch:')
    const patch = read(lead, `.git/room/registry/patches/${kept.id}.patch`)
    expect(patch).toContain('recover this'); expect(patch).not.toContain('diff --git a/file.txt')
    expect(read(lead, 'file.txt')).toBe('lead revised collected work\n'); expect(fs.existsSync(path.join(lead, 'later.txt'))).toBe(false)
    expect(read(lead, 'stable.txt')).toBe('stable base\n')
    // Prove the recovery artifact can restore the new bytes against the documented kept baseline.
    const recovery = path.join(root, 'recover')
    git(lead, 'worktree', 'add', '-q', '--detach', recovery, kept.base!)
    try {
      git(recovery, 'apply', path.join(lead, '.git/room/registry/patches', `${kept.id}.patch`))
      expect(read(recovery, 'file.txt')).toBe('already collected\n'); expect(read(recovery, 'later.txt')).toBe('recover this\n')
    } finally { git(lead, 'worktree', 'remove', '--force', recovery) }
    expectRetired(t, kept, 'discarded')
  })

  it('a conflicting follow-up writes nothing, including clean paths, and retains the exact previous base', async () => {
    const t = await harness()
    put(worker, 'file.txt', 'first collected\n')
    const before = t.record()
    expect(await t.call({ tag: 'test', keep: true })).toContain('kept test:')
    const kept = expectKept(t, before)
    put(lead, 'file.txt', 'lead conflict\n'); put(worker, 'file.txt', 'worker conflict\n')
    put(worker, 'new.txt', 'otherwise clean new file\n')
    expect(await t.call({ tag: 'test', keep: true })).toContain('Nothing written; conflicting files: file.txt')
    expect(t.record()).toEqual(kept)
    expect(t.registry.status(kept.id)).toMatchObject({ status: 'done', run: { n: 1 } })
    expect(git(lead, 'rev-parse', collectHeadRef('test', kept.id))).toBe(kept.base)
    expect(git(lead, 'rev-parse', collectBaseRef('test', kept.id))).toBe(base)
    expect(read(lead, 'file.txt')).toBe('lead conflict\n'); expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
    expect(read(worker, 'file.txt')).toBe('worker conflict\n'); expect(read(worker, 'new.txt')).toBe('otherwise clean new file\n')
    expect(git(worker, 'rev-parse', 'HEAD')).toBe(base); expect(t.s.room.retiredWorkers()).toEqual([])
  })

  it('send resumes the same worktree and host session, delivers the message, and transitions done → running → done', async () => {
    const t = await harness()
    put(worker, 'file.txt', 'collected once\n')
    put(lead, '.room/workers/test.log', 'retained log\n')
    const before = t.record()
    expect(await t.call({ tag: 'test', keep: true })).toContain('kept test:')
    const kept = expectKept(t, before)
    put(lead, 'file.txt', 'lead revision after keep\n')
    const senderState = sender(t)
    const text = 'make only a follow-up edit'
    const out = await senderState.tools.call('room_send', { type: 'note', to: 'test', text })
    expect(out).toContain('resumed test')
    expect(senderState.spawner).toHaveBeenCalledOnce()
    const spec = senderState.spawner.mock.calls[0]![0]
    expect(spec.cwd).toBe(worker); expect(spec.args).toContain(kept.hostSessionId)
    expect(spec.args.join(' ')).toContain(text)
    const delivered = t.s.room.messages().filter(m => m.type === 'note' && m.to === before.name && m.text === text)
    expect(delivered).toHaveLength(1)
    const resumed = t.record()
    expect(resumed).toMatchObject({ v: 1, phase: 'active', base: kept.base, dir: worker, hostSessionId: kept.hostSessionId })
    expect(resumed.runs).toHaveLength(2); expect(resumed.runs[0]).toEqual(kept.runs[0])
    expect(resumed.runs[1]).toMatchObject({ n: 2, mode: 'resume', promptMsgIds: [delivered[0].id] })
    expect(t.registry.status(kept.id)).toMatchObject({ status: 'running', run: { n: 2 } })
    expect(read(worker, 'file.txt')).toBe('collected once\n'); expect(read(lead, 'file.txt')).toBe('lead revision after keep\n')
    expect(read(lead, '.room/workers/test.log')).toBe('retained log\n')
    put(worker, 'stable.txt', 'resumed work still running\n')
    expect(await senderState.tools.call('room_collect', { tag: 'test', keep: true })).toContain('skipped test: running')
    expect(t.record()).toEqual(resumed)
    expect(git(lead, 'rev-parse', collectHeadRef('test', kept.id))).toBe(kept.base)
    expect(read(lead, 'stable.txt')).toBe('stable base\n')
    expect(read(lead, 'file.txt')).toBe('lead revision after keep\n')
    senderState.finish()
    await vi.waitFor(() => expect(t.registry.status(kept.id)).toMatchObject({ status: 'done', exitCode: 0, run: { n: 2 } }))
    expect(t.record()).toMatchObject({ phase: 'active', base: kept.base, hostSessionId: kept.hostSessionId })
    expect(read(worker, 'stable.txt')).toBe('resumed work still running\n')
    expect(fs.existsSync(worker)).toBe(true); expect(t.s.room.retiredWorkers()).toEqual([])
  })

  it('refresh after keep and a lead commit succeeds, retaining uncollected changes on the new base', async () => {
    const t = await harness()
    put(worker, 'file.txt', 'first collected\n')
    const before = t.record()
    expect(await t.call({ tag: 'test', keep: true })).toContain('kept test:')
    const kept = expectKept(t, before)
    put(lead, 'specs/later.md', 'new lead spec\n')
    git(lead, 'add', '-A'); git(lead, 'commit', '-qm', 'commit collected output and spec')
    const target = git(lead, 'rev-parse', 'HEAD')
    put(worker, 'stable.txt', 'worker follow-up\n'); put(worker, 'later.txt', 'untracked follow-up\n')
    const senderState = sender(t)
    const out = await senderState.tools.call('room_send', { type: 'note', to: 'test', text: 'use the new spec', refresh: true })
    expect(out).toContain('rebased test onto your HEAD'); expect(out).toContain('resumed test')
    expect(senderState.spawner).toHaveBeenCalledOnce()
    expect(t.record()).toMatchObject({ v: 1, phase: 'active', base: target, dir: worker, hostSessionId: kept.hostSessionId })
    expect(git(lead, 'rev-parse', collectHeadRef('test', kept.id))).toBe(target)
    expect(t.record().carriedBase).toBeUndefined(); expect(t.record().carriedUntracked).toBeUndefined()
    expect(t.record().runs).toHaveLength(2); expect(t.registry.status(kept.id)).toMatchObject({ status: 'running', run: { n: 2 } })
    expect(git(worker, 'rev-parse', 'HEAD')).toBe(target); expect(git(worker, 'diff', '--cached')).toBe('')
    expect(read(worker, 'file.txt')).toBe('first collected\n'); expect(read(worker, 'specs/later.md')).toBe('new lead spec\n')
    expect(read(worker, 'stable.txt')).toBe('worker follow-up\n'); expect(read(worker, 'later.txt')).toBe('untracked follow-up\n')
    expect(read(lead, 'file.txt')).toBe('first collected\n'); expect(read(lead, 'stable.txt')).toBe('stable base\n')
    expect(fs.existsSync(path.join(lead, 'later.txt'))).toBe(false); expect(git(lead, 'status', '--porcelain')).toBe('')
    const delivered = t.s.room.messages().filter(m => m.type === 'note' && m.to === before.name && m.text.startsWith('use the new spec\n'))
    expect(delivered).toHaveLength(1)
    expect(delivered[0].type === 'note' && delivered[0].text).toContain('your base moved')
    expect(t.record().runs[1].promptMsgIds).toContain(delivered[0].id)
    expect(senderState.spawner.mock.calls[0]![0].args.join(' ')).toContain('use the new spec')
  })

  it('keeps a grand-worker through its lead, then forwards only its new work through both kept baselines', async () => {
    const parent = await prepareWorktree(lead, 'parent', 'lead')
    put(parent.dir, 'stable.txt', 'parent first edit\n')
    const child = await prepareWorktree(parent.dir, 'child', 'lead+parent')
    put(child.dir, 'file.txt', 'child first edit\n')
    const room = new RoomDoc(new Y.Doc())
    const top = await harness({ tag: 'parent', name: 'lead+parent', dir: parent.dir, branch: parent.branch, base: parent.base }, lead, 'lead', room)
    const nested = await harness({ tag: 'child', name: 'lead+child', dir: child.dir, branch: child.branch,
      base: child.base, carriedBase: child.base, carriedUntracked: child.carriedUntracked }, parent.dir, 'lead+parent', room)
    const childBefore = nested.record()
    expect(await nested.call({ tag: 'child', keep: true })).toContain('kept child:')
    const childKept = expectKept(nested, childBefore, git(child.dir, 'rev-parse', 'HEAD'))
    expect(read(parent.dir, 'file.txt')).toBe('child first edit\n'); expect(read(lead, 'file.txt')).toBe('base\n')
    const parentBefore = top.record()
    expect(await top.call({ tag: 'parent', keep: true })).toContain('kept parent:')
    const parentKept = expectKept(top, parentBefore, git(parent.dir, 'rev-parse', 'HEAD'))
    expect(read(lead, 'file.txt')).toBe('child first edit\n'); expect(read(lead, 'stable.txt')).toBe('parent first edit\n')
    put(lead, 'stable.txt', 'human revision\n'); put(child.dir, 'file.txt', 'child follow-up\n')
    expect(await nested.call({ tag: 'child' })).toContain('Changes from child: file.txt.')
    expectRetired(nested, childKept, 'collected')
    expect(read(parent.dir, 'file.txt')).toBe('child follow-up\n'); expect(read(parent.dir, 'stable.txt')).toBe('parent first edit\n')
    expect(read(lead, 'file.txt')).toBe('child first edit\n')
    expect(await top.call({ tag: 'parent' })).toContain('Changes from parent: file.txt.')
    expectRetired(top, parentKept, 'collected')
    expect(read(lead, 'file.txt')).toBe('child follow-up\n'); expect(read(lead, 'stable.txt')).toBe('human revision\n')
    expect(localWorkers(lead)).toEqual([]); expect(top.registry.list().every(record => record.phase === 'retired')).toBe(true)
  })

  it('keeps scratch outside the apply tree and snapshot, refreshing the saved copy on the second keep', async () => {
    const t = await harness()
    put(worker, 'file.txt', 'real edit\n'); put(worker, 'debug.log', 'scratch first\n')
    const before = t.record()
    expect(await t.call({ tag: 'test', keep: true })).toContain('scratch')
    const kept = expectKept(t, before)
    expect(read(lead, 'file.txt')).toBe('real edit\n'); expect(read(lead, '.room/scratch/test/debug.log')).toBe('scratch first\n')
    expect(fs.existsSync(path.join(lead, 'debug.log'))).toBe(false)
    expect(git(lead, 'ls-tree', '-r', '--name-only', kept.base!)).not.toContain('debug.log')
    put(worker, 'debug.log', 'scratch second\n')
    const out = await t.call({ tag: 'test', keep: true })
    expect(out).toContain('Changes from test: already present.'); expect(out).toContain('scratch')
    const second = expectKept(t, kept)
    expect(git(lead, 'rev-parse', `${second.base}^{tree}`)).toBe(git(lead, 'rev-parse', `${kept.base}^{tree}`))
    expect(read(lead, '.room/scratch/test/debug.log')).toBe('scratch second\n'); expect(read(worker, 'debug.log')).toBe('scratch second\n')
    expect(read(lead, 'file.txt')).toBe('real edit\n'); expect(fs.existsSync(path.join(lead, 'debug.log'))).toBe(false)
  })

  it('clearly refuses a vanished kept worktree and preserves its durable base and the collected lead bytes', async () => {
    const t = await harness()
    put(worker, 'file.txt', 'collected before loss\n')
    const before = t.record()
    expect(await t.call({ tag: 'test', keep: true })).toContain('kept test:')
    const kept = expectKept(t, before)
    fs.rmSync(worker, { recursive: true, force: true })
    const out = await t.call({ tag: 'test', keep: true })
    expect(out).toContain('skipped test: no local worker capability (worktree missing or unmanaged)')
    expect(t.record()).toEqual(kept); expect(t.registry.status(kept.id)).toMatchObject({ status: 'done', run: { n: 1 } })
    expect(git(lead, 'rev-parse', collectHeadRef('test', kept.id))).toBe(kept.base)
    expect(git(lead, 'rev-parse', collectBaseRef('test', kept.id))).toBe(base)
    expect(read(lead, 'file.txt')).toBe('collected before loss\n'); expect(read(lead, 'stable.txt')).toBe('stable base\n')
    expect(t.s.room.retiredWorkers()).toEqual([])
  })

  it.each([{ mode: 'copy', paths: ['file.txt'] }, { discard: true }])('refuses keep combined with %j, even after a previous keep', async args => {
    const t = await harness()
    put(worker, 'file.txt', 'first collected\n')
    const before = t.record()
    expect(await t.call({ tag: 'test', keep: true })).toContain('kept test:')
    const kept = expectKept(t, before)
    put(worker, 'file.txt', 'uncollected second\n')
    expect(await t.call({ tag: 'test', keep: true, ...args })).toContain('error: keep is only supported in apply mode without discard')
    expect(t.record()).toEqual(kept); expect(t.registry.status(kept.id)).toMatchObject({ status: 'done', run: { n: 1 } })
    expect(git(lead, 'rev-parse', collectHeadRef('test', kept.id))).toBe(kept.base)
    expect(git(lead, 'rev-parse', collectBaseRef('test', kept.id))).toBe(base)
    expect(read(lead, 'file.txt')).toBe('first collected\n'); expect(read(worker, 'file.txt')).toBe('uncollected second\n')
    expect(fs.existsSync(worker)).toBe(true); expect(t.s.room.retiredWorkers()).toEqual([])
  })
})
