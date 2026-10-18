import { base, createTools, dir, fakeSession, ignore, lead, pair, realRepo, reportDone, setFixtureRepo, setupLead, workerId } from './workers-fixture.js'
import type { Identity, Msg } from '@room/shared'
import { manifestPaths, shouldWakeOnMsg } from '@room/shared'
import { setParticipantBase } from '@room/shared/testing'
import { execFileSync, spawn } from 'node:child_process'
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { resolveConfig } from '../src/config.js'
import { reserveWorkerPort } from '../src/port-reservations.js'
import { claudeWakeUnavailable } from '../src/prompt.js'
import type { Session } from '../src/session.js'
import { workerBudget, workerCommand, workerEnv, workerPriority } from '../src/worker-config.js'
import { cleanupPreparedWorktree, prepareWorkerLinks, prepareWorktree } from '../src/worker-git.js'
import { defaultSpawner, pidAlive, probeProcess, workerLogTail, type SpawnSpec } from '../src/worker-process.js'
import { projectWorkers } from '../src/worker-projector.js'
import { registryForDir } from '../src/worker-registry.js'
import { CODEX_SHELL_FILTER } from '../src/worker-shell-env.js'
import { publishFixture } from './fixtures/manifest.js'
import { finishFixtureProcess, fixtureProbe, fixtureProcess, spawnFixtureProcess } from './fixtures/process-liveness.js'
import { visiblePeer } from './fixtures/visible.js'
import { registerWorkers, workerByTag } from './registry-fixture.js'

describe('room_spawn / room_done / room_collect discard', () => {
  function setup(worktree?: typeof prepareWorktree, maxWorkers = 2) {
    const { a, b } = pair()
    a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    let ls: Session | null = fakeSession(a, lead)
    const specs: SpawnSpec[] = []
    const exits: ((code: number | null) => void)[] = []
    const killed: number[] = []
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, maxWorkers, probe: fixtureProbe,
      spawner: spec => { specs.push(spec); const pid = 4242 + specs.length; spawnFixtureProcess(pid)
        const callbacks: ((code: number | null) => void)[] = []
        exits.push(code => { finishFixtureProcess(pid); for (const callback of callbacks) callback(code) })
        return { pid, started: Promise.resolve(), onExit: cb => { callbacks.push(cb) }, kill: () => { killed.push(1); return true } } },
      worktree: worktree ?? ((repo, tag) => prepareWorktree(repo, tag, 'rohanz')),
    })
    let ws: Session | null = fakeSession(b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    return { a, b, leadTools, workerTools, workerSession: ws!, specs, exits, killed }
  }

  it('records the owner when dir points at another worker worktree', async () => {
    const t = setup()
    expect(await t.leadTools.call('room_spawn', { tag: 'port-fix', task: 'fix port' })).toContain('spawned port-fix')
    const owner = workerByTag(dir, 'port-fix')!
    expect(await t.leadTools.call('room_spawn', { tag: 'port-bools', task: 'fix booleans', dir: owner.dir })).toContain('spawned port-bools')
    expect(workerByTag(dir, 'port-bools')?.sharedWith).toBe(owner.id)
    expect(workerByTag(dir, 'port-bools')?.dir).toBe(owner.dir)
    await t.leadTools.shutdown()
  })

  it('inherits the caller host and explains worker reporting only once', async () => {
    vi.stubEnv('ROOM_HOST', 'codex')
    try {
      const t = setup()
      const first = await t.leadTools.call('room_spawn', { tag: 'first', task: 'x' })
      const second = await t.leadTools.call('room_spawn', { tag: 'second', task: 'y' })
      expect(workerByTag(dir, 'first')?.host).toBe('codex')
      expect(first).toContain('reports through room_done'); expect(second).not.toContain('reports through room_done')
      expect(first).not.toContain('tip:')
      expect(first).toContain('browser view: http://x')
      expect(second).not.toContain('browser view:')
      expect(t.specs[0].args.join(' ')).toContain('one-line summary')
      await t.leadTools.shutdown()
    } finally { vi.unstubAllEnvs() }
  })

  it('assigns distinct dev-server ports to running workers and includes each in its brief', async () => {
    const t = setup()
    try {
      const first = await t.leadTools.call('room_spawn', { tag: 'first', task: 'serve the app' })
      const second = await t.leadTools.call('room_spawn', { tag: 'second', task: 'test the app' })
      const firstPort = workerByTag(dir, 'first')?.port
      const secondPort = workerByTag(dir, 'second')?.port
      expect(firstPort).toBe(4400)
      expect(secondPort).toBe(4401)
      expect(t.specs.map(spec => spec.env.PORT)).toEqual(['4400', '4401'])
      expect(t.specs[0].args.join(' ')).toContain('Your dev-server port is 4400')
      expect(t.specs[1].args.join(' ')).toContain('Your dev-server port is 4401')
      expect(first).toContain('port 4400')
      expect(second).toContain('port 4401')
    } finally { await t.leadTools.shutdown() }
  })

  it('keeps ports distinct across independent lead registries', async () => {
    // A second lead has no handle for the first lead's synthetic worker. Its
    // shutdown must not turn a fixture PID into a signal to an unrelated OS process.
    const realKill = process.kill.bind(process)
    const fixtureSignals: number[] = []
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (fixtureProbe(pid) && signal !== 0) { fixtureSignals.push(pid); return true }
      return realKill(pid, signal)
    })
    const first = setup(), second = setup()
    try {
      await Promise.all([
        first.leadTools.call('room_spawn', { tag: 'one', task: 'serve' }),
        second.leadTools.call('room_spawn', { tag: 'two', task: 'serve' }),
      ])
      expect(first.specs[0].env.PORT).not.toBe(second.specs[0].env.PORT)
    } finally {
      await first.leadTools.shutdown()
      await second.leadTools.shutdown()
    }
    expect(fixtureSignals).toEqual([])
  })

  it('does not assign a nested worker its parent dev-server port', async () => {
    const configHome = process.env.XDG_CONFIG_HOME!
    const parent = reserveWorkerPort('lead/parent', [], configHome)
    const { a } = pair()
    a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    let session: Session | null = fakeSession(a, workerId)
    await registerWorkers(session, [{ id: 'lead/parent', tag: 'money', name: workerId.name, lead: lead.name, host: 'codex', task: 'parent task', dir: join(dir, '.room', 'workers', 'money'), branch: 'room/money', pid: process.pid, port: parent.port, startedAt: Date.now(), status: 'running' }])
    const specs: SpawnSpec[] = []
    const tools = createTools({
      getSession: () => session, setSession: s => { session = s }, cwd: dir, probe: () => undefined,
      spawner: spec => { specs.push(spec); return { pid: 4243, started: Promise.resolve(), onExit: () => {}, kill: () => true } },
      worktree: (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    try {
      expect(parent.port).toBe(4400)
      expect(await tools.call('room_spawn', { tag: 'child', task: 'serve' })).toContain('spawned child')
      expect(specs[0].env.PORT).toBe('4401')
    } finally { await tools.shutdown(); parent.release() }
  })

  it('does not treat the caller\'s PORT as a Room reservation', async () => {
    vi.stubEnv('PORT', '4400')
    const t = setup()
    try {
      await t.leadTools.call('room_spawn', { tag: 'first', task: 'serve' })
      expect(t.specs[0].env.PORT).toBe('4400')
    } finally { await t.leadTools.shutdown() }
  })

  it('releases the reserved port on exit, collect, discard and stop', async () => {
    const file = (port: string) => join(process.env.XDG_CONFIG_HOME!, 'room', 'ports', port)
    const exited = setup()
    await exited.leadTools.call('room_spawn', { tag: 'exited', task: 'x' })
    expect(existsSync(file(exited.specs[0].env.PORT))).toBe(true)
    exited.exits[0](0)
    expect(existsSync(file(exited.specs[0].env.PORT))).toBe(false)
    await exited.leadTools.shutdown()

    const collected = setup()
    await collected.leadTools.call('room_spawn', { tag: 'collected', task: 'x' })
    await reportDone('collected', 'done')
    collected.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'collected')?.exitCode).toBe(0), { timeout: 15_000 })
    await collected.leadTools.call('room_collect', { tag: 'collected' })
    expect(existsSync(file(collected.specs[0].env.PORT))).toBe(false)
    await collected.leadTools.shutdown()

    const discarded = setup()
    await discarded.leadTools.call('room_spawn', { tag: 'discarded', task: 'x' })
    const discarding = discarded.leadTools.call('room_collect', { tag: 'discarded', discard: true })
    await vi.waitFor(() => expect(discarded.killed).toHaveLength(1), { timeout: 15_000 })
    discarded.exits[0](null)
    expect(await discarding).toContain('discarded discarded')
    expect(existsSync(file(discarded.specs[0].env.PORT))).toBe(false)
    await discarded.leadTools.shutdown()

    const stopped = setup()
    await stopped.leadTools.call('room_spawn', { tag: 'stopped', task: 'x' })
    expect(await stopped.leadTools.call('room_leave', { force: true })).toContain('left local/x')
    expect(existsSync(file(stopped.specs[0].env.PORT))).toBe(true)
    stopped.exits[0](null)
    expect(existsSync(file(stopped.specs[0].env.PORT))).toBe(false)
  }, 30_000)

  it('room_leave and shutdown stop only workers that are still running', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'finished', task: 'x' })
    await t.leadTools.call('room_spawn', { tag: 'busy', task: 'y' })
    await reportDone('finished', 'done')
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'finished')?.exitCode).toBe(0), { timeout: 15_000 })
    expect(await t.leadTools.call('room_leave', {})).toMatch(/(^|\n)error: 1 worker\(s\) still running: busy\. /)
    expect(t.killed).toEqual([])
    await t.leadTools.shutdown()
    expect(t.killed).toEqual([1])
    const registry = await registryForDir(dir)
    const busy = registry.list().find(record => record.tag === 'busy')!
    expect(registry.exits(busy.id)).toEqual([])
    // Registry §6 row 8: a live process wins even while its stop is pending.
    expect(workerByTag(dir, 'busy')).toMatchObject({ status: 'running', stopReason: 'lead-session-ended' })
    t.exits[1](null)
    await vi.waitFor(() => expect(registry.status(busy.id)?.status).toBe('stopped'), { timeout: 15_000 })
    expect(workerByTag(dir, 'finished')).toMatchObject({ status: 'done' })
    expect(workerByTag(dir, 'finished')?.stopReason).toBeUndefined()
  })

  it('releases a reserved port when spawning fails', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    let session: Session | null = fakeSession(a, lead)
    const tools = createTools({
      getSession: () => session, setSession: s => { session = s }, cwd: dir,
      spawner: () => { throw new Error('spawn failed') },
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: false }),
    })
    expect(await tools.call('room_spawn', { tag: 'failed', task: 'x' })).toContain('spawn failed')
    expect(existsSync(join(process.env.XDG_CONFIG_HOME!, 'room', 'ports', '4400'))).toBe(false)
    await tools.shutdown()
  })

  it.each(['plugin:custom@market', ''])('passes ROOM_CLAUDE_CHANNEL only with ROOM_WAKE=channels (%s)', async channel => {
    vi.stubEnv('ROOM_CLAUDE_CHANNEL', channel)
    vi.stubEnv('ROOM_WAKE', 'channels')
    vi.stubEnv('ROOM_WORKER_NICE', '0')
    try {
      const t = setup()
      expect(await t.leadTools.call('room_spawn', { tag: 'channel', task: 'check channels' })).toContain('spawned channel')
      const args = t.specs[0].args
      expect(args).toContain('-p')
      if (channel) expect(args[args.indexOf('--dangerously-load-development-channels') + 1]).toBe(channel)
      else expect(args).not.toContain('--dangerously-load-development-channels')
      await t.leadTools.shutdown()
    } finally { vi.unstubAllEnvs() }
  })

  it('reports carried file counts and records pending publication for each spawn', async () => {
    const t = setup(prepareWorktree)
    writeFileSync(join(dir, 'wip.txt'), 'work in progress\n')
    try {
      const first = await t.leadTools.call('room_spawn', { tag: 'wip1', task: 'a' })
      expect(first).toContain('carried your uncommitted work into its worktree: 1 untracked file copied')
      expect(first).not.toContain('starts from HEAD')
      expect(first).toContain('carried preview freshness pending')
      const record = (await registryForDir(dir)).reservedByTagOrName('wip1')!
      expect(record.keptPublication).toMatchObject({ paths: ['wip.txt'], pending: true, base: record.base })
      expect(await t.leadTools.call('room_send', { type: 'note', to: 'wip1', text: 'continue with your carried copy' })).toContain('sent [')
      expect(workerByTag(dir, 'wip1')?.base).toBe(execFileSync('git', ['-C', join(dir, '.room', 'workers', 'wip1'), 'rev-parse', 'HEAD']).toString().trim())
      expect(await t.leadTools.call('room_spawn', { tag: 'wip2', task: 'b' })).toContain('carried your uncommitted work into its worktree: 1 untracked file copied')
      expect(workerByTag(dir, 'wip2')?.base).toBe(base)
      expect(workerByTag(dir, 'wip2')?.carriedUntracked?.map(x => x.path)).toEqual(['wip.txt'])
    } finally { rmSync(join(dir, 'wip.txt'), { force: true }) }
    expect(await setup().leadTools.call('room_spawn', { tag: 'wip3', task: 'c' })).not.toMatch(/uncommitted change/)
  })

  it('keeps the 0.10.2 missing-work note on every carry fallback', async () => {
    const t = setup(async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true,
      ...(tag === 'carried' ? { base: 'f'.repeat(40), carried: { count: 1, commit: 'f'.repeat(40) } } : { base, carryFailed: true }) }), 3)
    writeFileSync(join(dir, 'wip.txt'), 'work in progress\n')
    try {
      expect(await t.leadTools.call('room_spawn', { tag: 'carried', task: 'first' })).toContain('carried your uncommitted work into its worktree: 1 tracked change')
      const first = await t.leadTools.call('room_spawn', { tag: 'fallback1', task: 'a' })
      expect(first).toContain('1 uncommitted change in your clone is not in this worktree, which starts from HEAD')
      expect(first).not.toContain('carried your')
      expect(await t.leadTools.call('room_spawn', { tag: 'fallback2', task: 'b' })).toContain('1 uncommitted change in your clone is not in this worktree')
    } finally { rmSync(join(dir, 'wip.txt'), { force: true }) }
  })

  it('says once per lead session that an explicit carry=false leaves uncommitted work out', async () => {
    const t = setup(async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true, base }), 3)
    writeFileSync(join(dir, 'wip.txt'), 'work in progress\n')
    try {
      const first = await t.leadTools.call('room_spawn', { tag: 'head1', task: 'a', carry: false })
      expect(first).toContain(`note: carry=false: 1 uncommitted change in your clone is not in this worktree, which starts from HEAD ${base.slice(0, 10)}.`)
      expect(first).not.toContain('Commit them')
      for (const tag of ['head2', 'head3']) expect(await t.leadTools.call('room_spawn', { tag, task: 'b', carry: false })).not.toMatch(/uncommitted change/)
    } finally { rmSync(join(dir, 'wip.txt'), { force: true }) }
  })

  it('spawns a worker with the room passed through the environment, records it, and shows it in room_state', async () => {
    const t = setup()
    const out = await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents', host: 'codex', model: 'gpt-5.6', effort: 'medium' })
    expect(out).toContain('spawned money: rohanz+money (codex gpt-5.6, pid 4243)')
    const priority = workerPriority(workerCommand('codex', 'gpt-5.6', 'unused'))
    expect(t.specs[0].cmd).toBe(priority.cmd)
    if (priority.nice) expect(t.specs[0].args.slice(0, 3)).toEqual(['-n', '10', 'codex'])
    expect(out).toContain(` · priority ${priority.nice ? 'nice 10' : 'normal'}`)
    expect(t.specs[0].env).toMatchObject({ ROOM_WORKER_HOST: 'codex', ROOM_WORKER_MODEL: 'gpt-5.6', ROOM_WORKER_EFFORT: 'medium', ROOM_TAG: 'money', ROOM_SERVER: 'local', ROOM_ROOM: 'local/x', ROOM_LEAD: 'rohanz' })
    expect(t.specs[0].cwd).toBe(join(dir, '.room', 'workers', 'money'))
    const w = workerByTag(dir, 'money')
    expect(w).toMatchObject({ name: 'rohanz+money', status: 'running', lead: 'rohanz', branch: 'room/money', base, host: 'codex', model: 'gpt-5.6', effort: 'medium' })
    const st = await t.leadTools.call('room_state', { all: true })
    expect(st).toContain('workers (1):')
    expect(st).toContain('money (codex gpt-5.6 · medium, running')
    expect(st).toContain('0 changed files · branch room/money')
    expect(await t.leadTools.call('room_state', {})).toContain('codex gpt-5.6 · medium')
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'again' })).toContain('tag in use: money')
    expect(await t.leadTools.call('room_spawn', { tag: 'bad tag', task: 'x' })).toContain('error: tag')
  })

  it('room_spawn where=local from a team room opens a local workers room, bridges it, and tears it down on leave', async () => {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x' }); setParticipantBase(team.a, lead.name, base); local.a.setMeta({ repo: 'x' }); setParticipantBase(local.a, lead.name, base)
    let ls: Session | null = fakeSession(team.a, lead, false)
    ls!.roomName = 'github.com/rohanz/x'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx'
    const specs: SpawnSpec[] = []
    const joins: { server?: string; name?: string }[] = []
    const left: string[] = []
    let onExit: ((code: number | null) => void) | undefined
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0, probe: fixtureProbe,
      join: async o => { joins.push({ server: o.server, name: o.name }); return fakeSession(local.a, lead) },
      leave: async s => { left.push(s.roomName) },
      spawner: spec => { specs.push(spec); spawnFixtureProcess(99); return { pid: 99, started: Promise.resolve(),
        onExit: cb => { onExit = code => { finishFixtureProcess(99); cb(code) } }, kill: () => { onExit?.(null); return true } } },
      worktree: (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    const out = await leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents', where: 'local' })
    expect(joins).toEqual([{ server: 'local', name: 'rohanz' }])
    expect(out).toContain('local workers room local/x')
    expect(specs[0].env).toMatchObject({ ROOM_SERVER: 'local', ROOM_ROOM: 'local/x', ROOM_LEAD: 'rohanz' })
    expect(workerByTag(dir, 'money')).toMatchObject({ status: 'running', lead: 'rohanz' })
    expect(local.a.workerViewOf('rohanz+money')).toMatchObject({ status: 'running', lead: 'rohanz' })
    // The lead's bridge projects its local worker's view into the team room (registry §13).
    expect(team.a.workerViewOf('rohanz+money')).toMatchObject({ mode: 'local', status: 'running', lead: 'rohanz' })
    // the worker declares a scope and claims in the local room; the team room sees both as the lead's
    local.b.setScope({ by: workerId.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/models.py'] })
    local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: workerId.name, byKind: 'agent', intent: 'bump' })
    // The bridge publishes the workers' paths as the lead's coordination record, never as the lead's scope (manifest §5.6).
    await vi.waitFor(() => expect(team.b.coordination.get('rohanz')?.paths).toEqual(['api/models.py']), { timeout: 15_000 })
    expect(team.b.openClaims().map(c => c.intent)).toEqual(['[money] bump'])
    expect(team.b.scopes.has(workerId.name)).toBe(false)
    const st = await leadTools.call('room_state', { all: true })
    expect(st).toContain('workers room: local (local/x')
    expect(st).toContain('money (claude, running')
    // a worker's done message reaches the lead through the workers room inbox
    let ws: Session | null = fakeSession(local.b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    await workerTools.call('room_done', { summary: 'cents done' })
    const current = await leadTools.call('room_state', {})
    expect(current).toContain('workers (1):')
    // §6 row 8: a done report with the process still alive reads as running until it exits.
    expect(current).toContain('money (claude, running')
    expect(current).toContain('finished: cents done')
    // A reported worker with a live launch handle still blocks an unforced leave.
    expect(await leadTools.call('room_leave', {})).toContain('worker(s) still running: money')
    expect(await leadTools.call('room_leave', { force: true })).toContain('left github.com/rohanz/x')
    expect(left).toEqual(['local/x', 'github.com/rohanz/x'])
    expect(team.b.openClaims()).toEqual([])
  })

  it("the lead's room_wait also returns on a question addressed to it", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const waiting = t.leadTools.call('room_wait', { timeoutMs: 3000 })
    await new Promise(r => setTimeout(r, 50))
    await t.workerTools.call('room_send', { type: 'question', text: 'which field carries the price?', to: 'rohanz' })
    const out = await waiting
    expect(out).toContain('question for you')
    expect(out).toContain('which field carries the price?')
  })

  it("a worker that exits without room_done ends the lead's wait with one no-report completion", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const waiting = t.leadTools.call('room_wait', { timeoutMs: 3000 })
    t.exits[0](0)
    const out = await waiting
    expect(out).toContain('[notify]')
    expect(out).toContain('ended without a report')
    expect(workerByTag(dir, 'money')).toMatchObject({ status: 'done', exitCode: 0 })
  })

  it('releases a no-report worker claim and replaces its fallback when its own late report arrives', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'x' })
    const claim = t.b.addClaim({ path: 'app.py', from: 1, to: 1, by: workerId.name, byKind: 'agent', intent: 'editing' })
    t.exits[0](0)
    const registry = await registryForDir(dir)
    await vi.waitFor(() => expect(registry.status(workerByTag(dir, 'money')!.id)?.noReport).toBe(true), { timeout: 15_000 })
    await projectWorkers(t.workerSession, registry, 'rohanz', 'joined')
    expect(t.a.openClaims().some(c => c.id === claim.id)).toBe(false)
    const record = registry.reserved('money')!, run = record.runs[0]
    await registry.writeReport(record.id, { run: 1, nonce: run.nonce, chain: [], joinedAt: record.createdAt,
      done: { at: Date.now(), summary: 'late real report', changed: ['app.py'] } })
    await projectWorkers(t.workerSession, registry, 'rohanz', 'joined')
    expect(registry.status(record.id)).toMatchObject({ status: 'done', summary: 'late real report' })
    expect(t.a.workerViewOf(record.name)).toMatchObject({ summary: 'late real report' })
    expect(t.a.messages().filter(m => m.type === 'done' && m.summary === 'late real report')).toHaveLength(1)
  })

  it('refuses beyond the worker budget', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    await t.leadTools.call('room_spawn', { tag: 'b', task: 'y' })
    expect(await t.leadTools.call('room_spawn', { tag: 'c', task: 'z' })).toContain('worker capacity reached')
  })

  it("the lead's room_wait returns as soon as a worker's done message arrives", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const waiting = t.leadTools.call('room_wait', { timeoutMs: 3000 })
    await t.workerTools.call('room_done', { summary: 'done in cents' })
    const out = await waiting
    expect(out).toContain('worker reported done; its process is still exiting (room_collect waits up to 15 s for it):')
    expect(out).toContain('done in cents')
  })

  it('room_collect waits for a worker that reported done while its process is still exiting', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    writeFileSync(join(workerByTag(dir, 'money')!.dir, 'cents.txt'), 'cents\n')
    await t.workerTools.call('room_done', { summary: 'done in cents' })
    // The host takes a couple of seconds to exit after room_done, as a headless Claude worker does.
    const exiting = setTimeout(() => t.exits[0](0), 2000)
    try {
      const out = await t.leadTools.call('room_collect', { tag: 'money' })
      expect(out).not.toContain('skipped')
      expect(out).toContain('cents.txt')
    } finally { clearTimeout(exiting) }
  }, 30_000)

  it("room_wait says ready to collect when the worker's process has exited", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    await t.workerTools.call('room_done', { summary: 'done in cents' })
    t.exits[0](0)
    const registry = await registryForDir(dir)
    await vi.waitFor(() => expect(registry.exits(registry.reserved('money')!.id)).toMatchObject([{ code: 0, witnessed: true }]), { timeout: 15_000 })
    const out = await t.leadTools.call('room_wait', { timeoutMs: 100 })
    expect(out).toContain('worker done, ready to collect:')
    expect(out).toContain('done in cents')
  })

  it('refuses a stale worker ID without posting a completion', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const s = fakeSession(t.b, workerId)
    t.b.setScope({ by: workerId.name, byKind: 'agent', area: 'api', summary: 'still working', paths: ['app.py'] })
    const claim = t.b.addClaim({ path: 'app.py', from: 1, to: 1, by: workerId.name, byKind: 'agent', intent: 'edit' })
    const config = { ...await resolveConfig({ dir, env: {} }), workerId: 'old-spawn' }
    const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, config })
    expect(await tools.call('room_done', { summary: 'old task finished' })).toContain('invalid worker id')
    expect(workerByTag(dir, 'money')?.status).toBe('running')
    expect(t.a.messages().some(m => m.type === 'done')).toBe(false)
    expect(t.b.openClaims().some(c => c.id === claim.id)).toBe(true)
    expect(t.b.scope(workerId.name)).toBeDefined()
  })

  it('refuses a superseded run without releasing its current claims', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const id = workerByTag(dir, 'money')!.id
    const s = fakeSession(t.b, workerId)
    const claim = t.b.addClaim({ path: 'app.py', from: 1, to: 1, by: workerId.name, byKind: 'agent', intent: 'edit' })
    const config = { ...await resolveConfig({ dir, env: {} }), workerId: id }
    const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, config })
    vi.stubEnv('ROOM_WORKER_RUN', '2')
    try {
      expect(await tools.call('room_done', { summary: 'old run' })).toContain('superseded')
      expect(t.b.openClaims().some(c => c.id === claim.id)).toBe(true)
      expect(t.a.messages().some(m => m.type === 'done')).toBe(false)
    } finally { vi.unstubAllEnvs() }
  })

  it("a worker's room_done reaches its lead as an addressed done message that wakes it, and marks the worker done", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    publishFixture(t.b, 'rohanz+money', 'app.py', 'x = 100\n')
    const out = await t.workerTools.call('room_done', { summary: 'Money type in cents, 7 tests pass' })
    expect(out).toContain('Your lead rohanz has been told (worker money)')
    const done = t.a.messages().find(m => m.type === 'done') as Msg & { type: 'done' }
    expect(done).toBeTruthy()
    expect(done.to).toBe('rohanz'); expect(done.tag).toBe('money'); expect(done.changed).toEqual(['app.py'])
    expect(shouldWakeOnMsg(lead, done).wake).toBe(true)
    expect(shouldWakeOnMsg({ name: 'someone', kind: 'agent' }, done).wake).toBe(false)
    // §6 row 8: the process is still alive, so the worker reads as running with its report's summary.
    expect(workerByTag(dir, 'money')).toMatchObject({ status: 'running', summary: 'Money type in cents, 7 tests pass' })
    // The lead's next tool call shows the done line in its inbox.
    const st = await t.leadTools.call('room_state', {})
    expect(st).toContain('finished: Money type in cents')
    // A later process exit keeps the done status and records the code.
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')).toMatchObject({ status: 'done', exitCode: 0 }), { timeout: 15_000 })
  })

  it('saves a refused room_done report and posts its completion from the exit callback (F-S3)', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'finish' })
    vi.spyOn(t.workerSession, 'post').mockImplementation(async () => ({ ok: false, text: 'not sent: hub unreachable' }))
    const reply = await t.workerTools.call('room_done', { summary: 'finished' })
    expect(reply).toContain('worker report saved; your lead has not been told yet')
    expect(reply).toContain('Call room_done again')
    expect(reply).toContain('when you exit, your lead\'s session posts it')
    const registry = await registryForDir(dir)
    const record = registry.reserved('money')!
    expect(registry.reports(record.id)[0]?.done?.summary).toBe('finished')
    expect(registry.reports(record.id)[0]?.posted).toBeUndefined()
    t.exits[0](0)
    await vi.waitFor(() => expect(registry.read(record.id)?.runs[0].posted).toBe(`wk:${record.id}:1`), { timeout: 15_000 })
    expect(t.a.messages().filter(message => message.type === 'done' && message.id === `wk:${record.id}:1`)).toHaveLength(1)
  })

  it('does not say the lead was told when the run already posted its outcome', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'finish' })
    const registry = await registryForDir(dir)
    const record = registry.reserved('money')!
    await registry.update(record.id, old => ({ ...old, runs: old.runs.map(run => ({ ...run, posted: `wk:${record.id}:1` })), seq: old.seq + 1 }))
    const reply = await t.workerTools.call('room_done', { summary: 'finished late' })
    expect(reply).not.toContain('has been told')
    expect(reply).toContain(`your lead was not sent this report: Room already posted this run's outcome (wk:${record.id}:1)`)
    expect(reply).toContain('Your lead reads your summary with room_state (worker money)')
    expect(t.a.messages().some(m => m.type === 'done')).toBe(false)
    expect(registry.reports(record.id)[0]?.done?.summary).toBe('finished late')
  })

  it('does not promise a wake-up when a non-worker finishes', async () => {
    const t = setup()
    const out = await t.leadTools.call('room_done', { summary: 'finished' })
    expect(out).toContain('You remain in the room.')
    expect(out).not.toContain('will be woken')
  })

  it("reports a dead worker by its host's error, not the stderr banner, and says model capacity is transient", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'cap', task: 'x', host: 'codex' })
    // Trimmed from a real `codex exec --json` log whose first line is the stderr banner.
    fs.appendFileSync(t.specs[0].logFile, readFileSync(join(import.meta.dirname, 'fixtures', 'codex-exec', 'model-capacity.jsonl')))
    t.exits[0](1)
    await vi.waitFor(() => expect(workerByTag(dir, 'cap')).toMatchObject({ status: 'failed', exitCode: 1 }), { timeout: 15_000 })
    const capacity = 'codex: Selected model is at capacity. Please try a different model. (transient model capacity: respawn it with dir= its worktree to retry and keep its edits)'
    await vi.waitFor(() => expect(t.a.messages().filter(m => m.type === 'note' && m.to === 'rohanz' && m.priority === 'interrupt').map(m => m.type === 'note' && m.text))
      .toEqual([`worker cap failed: exit 1; ${capacity}`]), { timeout: 15_000 })
    expect(workerByTag(dir, 'cap')?.summary).toBe(capacity)
    expect(await t.leadTools.call('room_state', {})).toContain('· codex: Selected model is at capacity. Please try a different model. (transient model capacity')
    await t.leadTools.shutdown()
  })

  it('credits only an actual passing preview test command, never a text-only preview or an inferred cause', async () => {
    const t = setup()
    const leadSession = fakeSession(t.a, lead)
    let current: Session | null = leadSession
    const tools = createTools({ getSession: () => current, setSession: s => { current = s }, cwd: dir })
    leadSession.lastPreview = { clean: true, complete: true }
    const textOnly = await tools.call('room_done', { summary: 'local tests failed' })
    expect(textOnly).not.toContain('combined preview passed')
    leadSession.lastPreview = { clean: true, complete: true, testsPassed: true, testsCommand: 'npm test' }
    const tested = await tools.call('room_done', { summary: 'local tests failed' })
    expect(tested).toContain('The combined preview passed `npm test`.')
    expect(tested).not.toContain('caused by')
  })
})

describe('review fixes: workers', () => {
  it('a worker is named after the lead\'s owner and told so through ROOM_OWNER (fix 5)', async () => {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x' }); setParticipantBase(team.a, lead.name, base); local.a.setMeta({ repo: 'x' }); setParticipantBase(local.a, lead.name, base)
    const teamLead: Identity = { name: 'rohanz+lead', kind: 'agent', owner: 'rohanz', label: 'lead' }
    let ls: Session | null = fakeSession(team.a, teamLead, false)
    ls!.roomName = 'github.com/rohanz/x'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx'
    const specs: SpawnSpec[] = []
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0, probe: () => undefined,
      join: async () => fakeSession(local.a, teamLead),
      leave: async () => {},
      spawner: spec => { specs.push(spec); return { pid: 99, started: Promise.resolve(), onExit: () => {}, kill: () => true } },
      worktree: async (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    await leadTools.call('room_spawn', { tag: 'money', task: 't', where: 'local' })
    expect(specs[0].env.ROOM_OWNER).toBe('rohanz')
    expect(workerByTag(dir, 'money')!.name).toBe('rohanz+money')
    await leadTools.call('room_leave', { force: true })
  })

  it('a shared-token server reaches the worker as a bare URL plus ROOM_TOKEN, whatever way the lead got the token (fix 10, W1)', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    // A short hex token (e.g. abc) can occur in the Git SHA printed by room_state.
    const token = 'worker-test-secret-token'
    // The lead joined with a token in the URL: only the session knows it, not the environment.
    let ls: Session | null = { ...fakeSession(a, lead, false), roomUrl: 'ws://team.example/local%2Fx', token } as Session
    const specs: SpawnSpec[] = []
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir, probe: () => undefined, spawner: spec => { specs.push(spec); return { pid: 5, started: Promise.resolve(), onExit: () => {}, kill: () => true } }, worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }) })
    await tools.call('room_spawn', { tag: 'w', task: 't' })
    expect(specs[0].env.ROOM_SERVER).toBe('ws://team.example')
    expect(specs[0].env.ROOM_TOKEN).toBe(token)
    // the join reply and room_state never print the token
    expect(await tools.call('room_state', {})).not.toContain(token)
  })

  it('a finished worker whose process is alive can still be stopped; leave and shutdown stop it too (fix 8)', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 't' })
    let ws: Session | null = fakeSession(t.b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    await workerTools.call('room_done', { summary: 'done but still running' })
    // §6 row 8 precedes row 10: a live process reads as running even after its done report.
    expect(workerByTag(dir, 'money')).toMatchObject({ status: 'running', summary: 'done but still running' })
    const discarding = t.leadTools.call('room_collect', { discard: true, tag: 'money' })
    await vi.waitFor(() => expect(t.killed).toHaveLength(1), { timeout: 10_000 })
    t.exits[0](0)
    expect(await discarding).toContain('discarded money')
    expect(t.killed).toHaveLength(1)
    expect(workerByTag(dir, 'money')).toBeUndefined()
    // shutdown with a live process behind a done record signals it as well
    await t.leadTools.call('room_spawn', { tag: 'tiers', task: 't' })
    let ws2: Session | null = fakeSession(t.b, { name: 'rohanz+tiers', kind: 'agent', owner: 'rohanz', label: 'tiers' })
    const tiersTools = createTools({ getSession: () => ws2, setSession: s => { ws2 = s }, cwd: dir })
    await tiersTools.call('room_done', { summary: 'x' })
    await t.leadTools.shutdown()
    expect(t.killed).toHaveLength(2)
  })

  it('a discarded tag remains reserved until retirement, and a stale exit cannot clear its record (fix 9)', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'first' })
    const firstId = workerByTag(dir, 'money')!.id
    // Discard must not report success until its process exits.
    const discarding = t.leadTools.call('room_collect', { discard: true, tag: 'money' })
    await vi.waitFor(async () => expect((await registryForDir(dir)).read(firstId)?.stop?.reason).toBe('discarded'), { timeout: 10_000 })
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'second' })).toContain('tag in use: money')
    await vi.waitFor(() => expect(t.killed).toHaveLength(1), { timeout: 10_000 })
    t.exits[0](1)
    expect(await discarding).toContain('discarded money')
    expect(t.killed).toHaveLength(1)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')).toBeUndefined(), { timeout: 15_000 })
    // Retirement cleanup finished in the lead's only room (§12), releasing the tag; the respawn is refused only
    // by the worktree this file's mocked cleanupWorker leaves behind.
    expect((await registryForDir(dir)).read(firstId)?.phase).toBe('retired')
    await vi.waitFor(() => expect(t.a.retiredWorkers().some(w => w.tag === 'money')).toBe(true), { timeout: 15_000 })
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'second' })).toContain('worktree money is unmanaged')
    t.exits[0](1) // the first process finally dies
    expect((await registryForDir(dir)).read(firstId)).toMatchObject({ id: firstId, tag: 'money' })
    // and while a process is alive the tag cannot be reused
    await t.leadTools.call('room_spawn', { tag: 'x', task: 't' })
    expect(await t.leadTools.call('room_spawn', { tag: 'x', task: 'again' })).toContain('tag in use: x')
  })
})

describe('review fixes: the workers room', () => {
  function setupBridged(wake?: (id: string, text: string) => Promise<void>) {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x' }); setParticipantBase(team.a, lead.name, base); local.a.setMeta({ repo: 'x' }); setParticipantBase(local.a, lead.name, base)
    let ls: Session | null = fakeSession(team.a, lead, false)
    ls!.roomName = 'github.com/rohanz/x'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx'
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, binding: { bound: () => ({ id: 'thread-lead', host: 'codex' as const }), id: () => 'thread-lead', dir: () => undefined, commonDir: () => undefined }, conflictDebounceMs: 0, probe: () => undefined,
      // An idle lead lets this fixture test cross-room wake routing independently of host discovery.
      wakeProbe: { busy: async () => false },
      ...(wake ? { wake: async (target: { id: string }, text: string) => { await wake(target.id, text); return 'queue' as const } } : {}),
      join: async () => fakeSession(local.a, lead),
      leave: async () => {},
      spawner: () => ({ pid: 99, started: Promise.resolve(), onExit: () => {}, kill: () => true }),
      worktree: async (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    let ws: Session | null = fakeSession(local.b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    return { team, local, leadTools, workerTools }
  }

  it("the lead's answer to a worker's question lands in the workers room, and room_wait finds the answer there (fix 6)", async () => {
    const t = setupBridged()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 't', where: 'local' })
    const asked = await t.workerTools.call('room_send', { type: 'question', text: 'which field?', to: 'rohanz' })
    const qid = asked.match(/questionId=(m_\w+)/)![1]
    const sent = await t.leadTools.call('room_send', { type: 'answer', inReplyTo: qid, text: 'price_cents' })
    expect(sent).toContain('(in the workers room)')
    expect(t.local.b.messages().some(m => m.type === 'answer' && m.inReplyTo === qid)).toBe(true)
    expect(t.team.b.messages().some(m => m.type === 'answer')).toBe(false)
    // a plain note addressed to the worker goes there too
    await t.leadTools.call('room_send', { type: 'note', text: 'keep going', to: 'rohanz+money' })
    expect(t.local.b.messages().at(-1)).toMatchObject({ type: 'note', to: 'rohanz+money' })
    // the worker's wait on its question resolves with the answer
    expect(await t.workerTools.call('room_wait', { questionId: qid, timeoutMs: 1000 })).toContain('answered: ')
    await t.leadTools.call('room_leave', { force: true })
  })

  it("questions and done messages from the workers room wake the lead through its host (fix 7)", async () => {
    const woken: string[] = []
    const t = setupBridged(async (_id, text) => { woken.push(text) })
    await t.leadTools.call('room_spawn', { tag: 'money', task: 't', where: 'local' })
    await t.workerTools.call('room_send', { type: 'question', text: 'which field?', to: 'rohanz' })
    await vi.waitFor(() => expect(woken.some(x => x.includes('rohanz+money asked a question'))).toBe(true), { timeout: 15_000 })
    await t.workerTools.call('room_done', { summary: 'all in cents' })
    // The follow-up waits out the five-second window after the first wake.
    await vi.waitFor(() => expect(woken.some(x => x.includes('rohanz+money finished'))).toBe(true), { timeout: 8_000 })
    expect(woken.join('\n')).not.toMatch(/which field\?|all in cents/)
    await t.leadTools.call('room_leave', { force: true })
  }, 15_000)
})

describe('workers review: env, keys, sessions, reservation, signals', () => {
  it('W1: a worker gets exactly its own room variables; the lead\'s ROOM_URL/ROOM_NAME/ROOM_DIR and token never leak', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 't' })
    const env = t.specs[0].env
    expect(Object.keys(env).filter(k => k.startsWith('ROOM_')).sort()).toEqual(['ROOM_DIR', 'ROOM_LAUNCH_NONCE', 'ROOM_LEAD', 'ROOM_LEAD_CLONE', 'ROOM_LOG_FILE', 'ROOM_OWNER', 'ROOM_REGISTRY', 'ROOM_ROOM', 'ROOM_SERVER', 'ROOM_SHARE', 'ROOM_TAG', 'ROOM_WORKER_HOST', 'ROOM_WORKER_ID', 'ROOM_WORKER_MEM_GB', 'ROOM_WORKER_RUN', 'ROOM_WORKER_THREADS'])
    expect(env.ROOM_LEAD_CLONE).toBe(realpathSync(join(dir, '.git')))
    expect(env).toMatchObject({ ROOM_SERVER: 'local', ROOM_ROOM: 'local/x', ROOM_TAG: 'money', ROOM_LEAD: 'rohanz', ROOM_OWNER: 'rohanz', ROOM_WORKER_RUN: '1', ROOM_SHARE: 'full' })
    expect(env.ROOM_DIR).toBe(join(dir, '.room', 'workers', 'money'))
    expect(env.ROOM_LOG_FILE).toBe(join(dir, '.room', 'workers', 'money.mcp.log'))
    // the real spawner strips the lead's own room variables from the inherited environment before applying the spec's
    const merged = workerEnv({ PATH: '/bin', ROOM_URL: 'ws://lead/room', ROOM_NAME: 'rohanz', ROOM_DIR: '/lead', ROOM_TOKEN: 'secret', ROOM_TAG: 'lead', ROOM_MAX_WORKERS: '3' }, env)
    expect(merged.ROOM_URL).toBeUndefined(); expect(merged.ROOM_NAME).toBeUndefined(); expect(merged.ROOM_TOKEN).toBeUndefined()
    expect(merged).toMatchObject({ PATH: '/bin', ROOM_MAX_WORKERS: '3', ROOM_DIR: env.ROOM_DIR, ROOM_TAG: 'money' })
    expect(workerEnv({ ROOM_LEAD_CLONE: '/another-clone' }, {})).not.toHaveProperty('ROOM_LEAD_CLONE')
    t.exits[0](0)
  })

  it('W2/W3: distinct tags route workers to their rooms; local reads and diffs use the workers room', async () => {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x' }); setParticipantBase(team.a, lead.name, base); local.a.setMeta({ repo: 'x' }); setParticipantBase(local.a, lead.name, base)
    let ls: Session | null = fakeSession(team.a, lead, false)
    ls!.roomName = 'github.com/rohanz/x'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx'
    const killed: string[] = []
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0, probe: () => undefined,
      join: async () => fakeSession(local.a, lead),
      leave: async () => {},
      // Like SIGTERM, a signal ends the fake process, so a discard sees it exit.
      spawner: spec => { let exit: ((code: number | null) => void) | undefined
        return { pid: 99, started: Promise.resolve(), onExit: cb => { exit = cb }, kill: () => { killed.push(spec.env.ROOM_ROOM); exit?.(null); return true } } },
      worktree: async (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    await leadTools.call('room_spawn', { tag: 'team-money', task: 'team side' })
    await leadTools.call('room_spawn', { tag: 'money', task: 'local side', where: 'local' })
    expect(await leadTools.call('room_spawn', { tag: 'money', task: 'duplicate', where: 'here' })).toContain('tag in use: money')
    expect(workerByTag(dir, 'team-money')?.task).toBe('team side')
    expect(workerByTag(dir, 'money')?.task).toBe('local side')
    // the local worker edits in the workers room; the team-room lead reads and diffs its version
    publishFixture(local.b, 'rohanz+money', 'app.py', 'x = 100\n')
    // §14: a local worker's preview reads its trusted worktree, so the edit is on disk as well.
    writeFileSync(join(workerByTag(dir, 'money')!.dir, 'app.py'), 'x = 100\n')
    publishFixture(local.b, 'rohanz+tiers', 'tiers.py', 'tier = "gold"\n')
    const read = await leadTools.call('room_read', { path: 'app.py', person: 'rohanz+money' })
    expect(read).toContain('x = 100')
    expect(read).toContain('as rohanz+money sees it')
    expect(await leadTools.call('room_read', { diff: true, path: 'app.py', person: 'rohanz+money' })).toContain('+x = 100')
    expect(await leadTools.call('room_state', { path: 'app.py' })).toContain('uncommitted changes by: rohanz+money')
    const pm = await leadTools.call('room_preview_merge', { person: 'rohanz+money' })
    expect(pm, pm).toContain('no conflicts')
    const includingLead = await leadTools.call('room_preview_merge', { people: ['rohanz', 'rohanz+money'] })
    expect(includingLead).toContain('step 1: merge rohanz+money')
    const byTag = await leadTools.call('room_preview_merge', { people: ['money'] })
    expect(byTag).toContain('step 1: merge rohanz+money')
    expect(byTag).toContain('from rohanz, rohanz+money')
    const all = await leadTools.call('room_preview_merge', { people: ['rohanz+money', 'rohanz+tiers'], run: 'cat app.py tiers.py' })
    expect(all).toContain('x = 100')
    expect(all).toContain('tier = "gold"')
    expect(all).toContain('exit 0')
    expect(all).toMatch(/tests: exit 0 \(no test summary recognised\)$/)
    const failed = await leadTools.call('room_preview_merge', { people: ['rohanz+money', 'rohanz+tiers'], run: "printf 'Tests: 1 failed, 1 total\\n'; exit 3" })
    expect(failed).toMatch(/Tests: 1 failed, 1 total\ntests: FAILED \(exit 3\)$/)
    // dismissing the team-room worker signals only the team-room process; the local one is untouched
    await leadTools.call('room_collect', { discard: true, tag: 'team-money' })
    expect(killed).toEqual(['github.com/rohanz/x'])
    expect(workerByTag(dir, 'money')?.status).toBe('running')
    expect(await leadTools.call('room_leave', {})).toContain('worker(s) still running: money')
    expect(killed).toEqual(['github.com/rohanz/x'])
    expect(workerByTag(dir, 'money')?.status).toBe('running')
    await leadTools.call('room_leave', { force: true })
    expect(killed).toEqual(['github.com/rohanz/x', 'local/x'])
  })

  it('W4: two concurrent spawns of one tag cannot both pass the tag check', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    let ls: Session | null = fakeSession(a, lead)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let entered!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const specs: SpawnSpec[] = []
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, probe: () => undefined,
      spawner: spec => { specs.push(spec); return { pid: 7, started: Promise.resolve(), onExit: () => {}, kill: () => true } },
      worktree: async (repo, tag) => { entered(); await gate; return { dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true } },
    })
    const first = tools.call('room_spawn', { tag: 'money', task: 'one' })
    await preparing // the first spawn holds the reservation before the second races it
    const second = await tools.call('room_spawn', { tag: 'money', task: 'two' })
    expect(second).toContain('tag in use: money')
    release()
    expect(await first).toContain('spawned money')
    expect(specs).toHaveLength(1)
    expect(workerByTag(dir, 'money')?.task).toBe('one')
    // the reservation is released once the spawn has finished (or failed)
    expect(await tools.call('room_spawn', { tag: 'money', task: 'three' })).toContain('tag in use: money')
  })

  it('drops a cancelled spawn after delayed worktree preparation and removes the prepared tree', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    let ls: Session | null = fakeSession(a, lead)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const specs: SpawnSpec[] = []
    let prepared: Awaited<ReturnType<typeof prepareWorktree>> | undefined
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, probe: () => undefined,
      spawner: spec => { specs.push(spec); return { pid: 7, started: Promise.resolve(), onExit: () => {}, kill: () => true } },
      worktree: async (repo, tag) => { entered(); await gate; prepared = await prepareWorktree(repo, tag); return prepared },
    })
    const controller = new AbortController()
    const call = tools.call as (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<string>
    const spawning = call('room_spawn', { tag: 'cancelled-preparation', task: 'never start' }, controller.signal)
    await preparing
    controller.abort()
    release()
    try {
      expect(await spawning).toContain('tool call cancelled')
      expect(specs).toHaveLength(0)
      expect(workerByTag(dir, 'cancelled-preparation')).toBeUndefined()
      expect(existsSync(join(dir, '.room/workers/cancelled-preparation'))).toBe(false)
    } finally {
      if (prepared?.created && existsSync(prepared.dir)) await cleanupPreparedWorktree(dir, prepared)
      await tools.shutdown()
    }
  })

  it.each([true, false])('keeps a fresh worker checkout after cancellation following process start (stop confirmed: %s)', async stopped => {
    const { repo, head } = realRepo()
    const previousDir = dir, previousBase = base
    setFixtureRepo(repo, head)
    const { a } = pair(); a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    let ls: Session | null = fakeSession(a, lead)
    const controller = new AbortController()
    let onExit: ((code: number | null) => void) | undefined
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: repo, now: () => 500, probe: fixtureProbe,
      worktree: async (_repo, tag) => prepareWorktree(repo, tag, 'rohanz', [], undefined, 0, false),
      spawner: spec => {
        writeFileSync(join(spec.cwd, 'partial.txt'), 'keep me')
        fixtureProcess(8123, 'fixture:after-start', 'node')
        return { pid: 8123, started: Promise.resolve(), onExit: cb => { onExit = code => { finishFixtureProcess(8123); cb(code) }; controller.abort() },
          kill: () => { if (stopped) onExit?.(0); return stopped } }
      },
    })
    try {
      const call = tools.call as (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<string>
      const reply = await call('room_spawn', { tag: 'after-start', task: 'write', host: 'codex' }, controller.signal)
      const checkout = join(repo, '.room', 'workers', 'after-start')
      expect(reply).toContain(stopped ? 'stopped after' : 'stop unconfirmed')
      expect(existsSync(checkout)).toBe(true)
      expect(readFileSync(join(checkout, 'partial.txt'), 'utf8')).toBe('keep me')
      // §9: an unconfirmed stop leaves it running ("stopping", §6 row 8).
      expect(workerByTag(dir, 'after-start')?.status).toBe(stopped ? 'dismissed' : 'running')
    } finally { setFixtureRepo(previousDir, previousBase) }
  })

  it('W5: after a lead restart, an unreadable process identity is never signalled', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    await registryForDir(dir)
    // a stand-in for the worker process that outlived the lead: its own process group, so the signal cannot reach the test runner
    const child = spawn('sleep', ['100'], { detached: true, stdio: 'ignore' }); child.unref()
    const exited = new Promise<void>(r => child.once('exit', () => r()))
    // a record from before the restart: no process handle and no recorded start identity, so the
    // registry cannot tie the live pid to it and §6 row 10 reads it as done
    const prepared = await prepareWorktree(dir, 'money', 'rohanz')
    const processStartTime = probeProcess(child.pid!)!.startTime!
    await registerWorkers(fakeSession(a, lead), [{ tag: 'money', name: 'rohanz+money', host: 'claude', hostSessionId: 'e1be43be-03a3-45b8-b267-cd48780e2a0b', task: 'x', dir: prepared.dir, branch: prepared.branch, pid: child.pid!, startedAt: Date.now(), status: 'done', lead: 'rohanz', summary: 'done but alive' }])
    let ls: Session | null = fakeSession(a, lead)
    const probe = () => pidAlive(child.pid!) ? { startTime: processStartTime, executable: 'claude' } : undefined
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir, probe })
    expect(await tools.call('room_leave', {})).toContain('left local/x')
    expect(pidAlive(child.pid!)).toBe(true)
    expect((await registryForDir(dir)).list().find(r => r.tag === 'money')).toBeDefined()
    expect(workerByTag(dir, 'money')?.status).toBe('done')
    process.kill(-child.pid!, 'SIGTERM')
    await exited
  })

  it('W8: dismiss marks a worker dismissed only when the signal was delivered', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    let ls: Session | null = fakeSession(a, lead)
    let deliverable = false
    let exit: (code: number | null) => void = () => {}
    let live = true
    let clock = 0
    const realKill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      // Every OS operation sees this synthetic PID as absent, including the
      // SIGKILL fallback after the fake handle refuses to stop.
      if (pid === 8) {
        const error = new Error('synthetic worker has no OS process') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      }
      return realKill(pid, signal)
    })
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, now: () => clock,
      sleep: async ms => { clock += ms },
      probe: pid => pid === 8 && live ? { startTime: 'test:worker:8', executable: 'claude' } : undefined,
      spawner: () => ({ pid: 8, started: Promise.resolve(), onExit: cb => { exit = code => { live = false; cb(code) } }, kill: () => { if (deliverable) exit(0); return deliverable } }),
      worktree: (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    await tools.call('room_spawn', { tag: 'money', task: 't' })
    expect(workerByTag(dir, 'money')?.processStartTime).toBe('test:worker:8')
    const refused = await tools.call('room_collect', { discard: true, tag: 'money' })
    expect(refused).toContain('worker process has not stopped')
    const registry = await registryForDir(dir)
    const interrupted = registry.reserved('money')!
    expect(interrupted.stop?.reason).toBe('discarded')
    expect(interrupted.phase).toBe('active')
    expect(interrupted.interrupted?.op).toBe('discard')
    await registry.reconcile()
    expect(registry.read(interrupted.id)?.phase).toBe('active')
    expect(existsSync(join(dir, '.room/workers/money'))).toBe(true)
    expect(a.messages().some(m => m.type === 'note' && /could not dismiss worker money/.test((m as { text: string }).text))).toBe(true)
    deliverable = true
    expect(await tools.call('room_collect', { discard: true, tag: 'money' })).toContain('discarded money')
    expect(workerByTag(dir, 'money')).toBeUndefined()
  })

  it('does not replay a parent discard after nested-worker disposal was refused (F-S2)', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'parent', task: 'parent task' })
    const parent = workerByTag(dir, 'parent')!
    await registerWorkers(fakeSession(t.a, lead), [{ tag: 'child', name: `${parent.name}+child`, lead: parent.name,
      host: 'codex', task: 'nested', dir: join(dir, '.room/workers/absent-child'),
      branch: 'room/child', pid: 0, startedAt: Date.now(), status: 'done' }])
    const reply = await t.leadTools.call('room_collect', { tag: 'parent', discard: true, force: true })
    expect(reply).toContain('could not dispose of nested worker child')
    const registry = await registryForDir(dir)
    const record = registry.reserved('parent')!
    expect(record.phase).toBe('active')
    expect(record.interrupted?.op).toBe('discard')
    await registry.reconcile()
    expect(registry.read(record.id)?.phase).toBe('active')
  })
})

describe('review round 3', () => {
  it("a tag held by another lead's running worker is refused, and its record is never touched", async () => {
    const t = setupLead()
    // Complete the initial migration before creating this new worker checkout.
    const registry = await registryForDir(dir)
    expect(registry.reserved('money')).toBeUndefined()
    const prepared = await prepareWorktree(dir, 'money', 'kieran')
    await registerWorkers(fakeSession(t.a, lead), [{ tag: 'money', name: 'kieran+money', host: 'claude', task: 'theirs', dir: prepared.dir, branch: prepared.branch, pid: 4242, startedAt: Date.now(), status: 'running', lead: 'kieran' }])
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'mine' })).toContain('tag in use: money')
    expect(workerByTag(dir, 'money')).toMatchObject({ lead: 'kieran', status: 'running' })
  })
})

describe('worker compute budgets', () => {
  it('recounts concurrent spawns before budgeting and enforces capacity', async () => {
    vi.spyOn(os, 'availableParallelism').mockReturnValue(12)
    vi.spyOn(os, 'totalmem').mockReturnValue(24 * 1024 ** 3)
    const t = setupLead() // maxWorkers = 2, so reserve six threads each
    const replies = await Promise.all(['a', 'b', 'c'].map(tag => t.leadTools.call('room_spawn', { tag, task: 'train' })))
    expect(t.specs).toHaveLength(2)
    expect(t.specs.map(s => s.env.ROOM_WORKER_THREADS)).toEqual(['6', '6'])
    expect(t.specs.map(s => s.env.ROOM_WORKER_MEM_GB)).toEqual(['12', '12'])
    expect(replies.filter(r => r.includes('budget in prompt:'))).toHaveLength(2)
    expect(t.specs.every(s => s.args.some(a => a.includes('Compute budget: 6 threads, ~12 GB')))).toBe(true)
    expect(replies.some(r => r.includes('worker capacity reached'))).toBe(true)
    await t.leadTools.shutdown()
  })

  it.each([
    [12, 8, 0, 3], [12, 8, 1, 3], [12, 8, 3, 3], [12, 8, 4, 2],
    [12, 8, 7, 1], [12, 2, 0, 6], [12, 1, 0, 12], [12, 2, 5, 2],
    [2, 8, 0, 1], [1, 8, 4, 1],
  ])('%i cores, max %i, running %i -> %i threads', (cores, maxWorkers, running, threads) => {
    expect(workerBudget({ cores, maxWorkers, running, memBytes: 17.9 * 1024 ** 3 })).toEqual({
      // Memory uses the same reservation as threads: at least four intended workers, bounded by maxWorkers.
      threads, memGb: Math.max(1, Math.floor(17.9 / Math.max(1, Math.min(maxWorkers, Math.max(running + 1, 4)), running + 1))),
    })
    expect(threads).toBeLessThanOrEqual(cores)
    if (running + 1 <= cores) expect(threads * (running + 1)).toBeLessThanOrEqual(cores)
  })

  it('floors memory to one GB on a small machine', () => {
    expect(workerBudget({ cores: 1, maxWorkers: 8, running: 12, memBytes: 512 * 1024 ** 2 }).memGb).toBe(1)
  })

  it.each(['claude', 'codex'])('passes caps through the %s path while preserving explicit library settings', async host => {
    vi.stubEnv('OMP_NUM_THREADS', '7')
    vi.stubEnv('ROOM_WORKER_THREADS', '5')
    vi.stubEnv('ROOM_WORKER_MEM_GB', '9')
    for (const key of ['OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'NUMEXPR_NUM_THREADS', 'LOKY_MAX_CPU_COUNT', 'RAYON_NUM_THREADS']) vi.stubEnv(key, undefined)
    const t = setupLead()
    const reply = await t.leadTools.call('room_spawn', { tag: 'budget', task: 'train', host, threads: 2 })
    const spec = t.specs[0]
    expect(spec.cmd).toBe(workerPriority({ cmd: host, args: [] }).cmd)
    const env = workerEnv(process.env, spec.env)
    expect(env).toMatchObject({ OMP_NUM_THREADS: '7', ROOM_WORKER_THREADS: '2', ROOM_WORKER_MEM_GB: '9',
      OPENBLAS_NUM_THREADS: '2', MKL_NUM_THREADS: '2', VECLIB_MAXIMUM_THREADS: '2', NUMEXPR_NUM_THREADS: '2', LOKY_MAX_CPU_COUNT: '2', RAYON_NUM_THREADS: '2' })
    const priority = workerPriority({ cmd: host, args: [] })
    expect(reply).toContain(`budget in prompt: 2 threads, ~9 GB · priority ${priority.nice ? 'nice 10' : 'normal'}`)
    expect(spec.args.some(a => a.includes('Compute budget: 2 threads, ~9 GB RAM; scheduling priority:') && a.includes('reasoning effort: host default'))).toBe(true)
    expect(process.env.ROOM_WORKER_THREADS).toBe('5')
    expect(process.env.OPENBLAS_NUM_THREADS).toBeUndefined()
    await t.leadTools.call('room_spawn', { tag: 'inherited', task: 'train', host })
    expect(t.specs[1].env.ROOM_WORKER_THREADS).toBe('5')
    await t.leadTools.shutdown()
  })

  it.each([0, -1, 1.5, '2', null])('rejects invalid threads %s before spawning', async threads => {
    const t = setupLead()
    expect(await t.leadTools.call('room_spawn', { tag: 'bad', task: 'train', threads })).toContain('error: threads must be an integer >= 1')
    expect(t.specs).toHaveLength(0)
  })

  it('rejects supplied directories without an owned Room worktree before intent (S3 re-review)', async () => {
    const t = setupLead()
    const nested = join(dir, 'nested-checkout')
    mkdirSync(nested, { recursive: true })
    execFileSync('git', ['init', '-q', nested])
    const ordinary = join(dir, 'ordinary-directory')
    mkdirSync(ordinary, { recursive: true })
    const external = mkdtempSync(join(tmpdir(), 'room-linked-checkout-'))
    const linked = join(dir, 'linked-checkout')
    symlinkSync(external, linked)
    try {
      for (const supplied of [nested, ordinary, linked]) {
        const reply = await t.leadTools.call('room_spawn', { tag: 'supplied', task: 'work', dir: supplied })
        expect(reply).toMatch(/error:.*(?:Room worktree|worker directory|outside this repo|another repository)/)
        expect(t.specs).toHaveLength(0)
        expect((await registryForDir(dir)).list()).toHaveLength(0)
      }
    } finally {
      rmSync(nested, { recursive: true, force: true })
      rmSync(ordinary, { recursive: true, force: true })
      rmSync(linked, { force: true })
      rmSync(external, { recursive: true, force: true })
    }
  })
})

describe('worker scheduling priority', () => {
  const command = { cmd: 'fake-worker', args: ['task with spaces'] }
  it.each([[undefined, 10], ['0', 0], ['-5', 0], ['50', 19], ['3.9', 3], ['bad', 10], ['', 10]])
    ('normalises ROOM_WORKER_NICE=%s to %i', (value, expected) => {
      const result = workerPriority(command, { PATH: '/usr/bin:/bin', ROOM_WORKER_NICE: value }, 'linux')
      expect(result.nice).toBe(expected)
      if (expected) expect(result.args).toEqual(['-n', String(expected), command.cmd, ...command.args])
      else expect(result).toEqual({ ...command, nice: 0 })
    })

  it('does not wrap on Windows and falls back with one warning when nice is missing', () => {
    const log = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(workerPriority(command, { PATH: '/missing' }, 'win32')).toEqual({ ...command, nice: 0 })
    expect(log).not.toHaveBeenCalled()
    for (let i = 0; i < 2; i++) expect(workerPriority(command, { PATH: '/missing' }, 'linux')).toEqual({ ...command, nice: 0 })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')('tracks the real execed worker pid and can dismiss it', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'room-nice-'))
    const pidFile = join(scratch, 'pid')
    const cmd = workerPriority({ cmd: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`] })
    expect(cmd.nice).toBe(10)
    expect(cmd.args.slice(0, 2)).toEqual(['-n', '10'])
    const child = defaultSpawner({ cmd: cmd.cmd, args: cmd.args, cwd: scratch, env: {}, logFile: join(scratch, 'worker.log') })
    const exited = new Promise<void>((resolve, reject) => { child.onExit(() => resolve()); child.onError?.(reject) })
    try {
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 15_000 })
      expect(Number(readFileSync(pidFile, 'utf8'))).toBe(child.pid)
      expect(pidAlive(child.pid)).toBe(true)
      expect(os.getPriority(child.pid)).toBeGreaterThanOrEqual(10)
      expect(child.kill()).toBe(true)
      await exited
      expect(pidAlive(child.pid)).toBe(false)
    } finally { child.kill(); await exited; rmSync(scratch, { recursive: true, force: true }) }
  })
})

it('passes documented effort and session flags to Claude and Codex', () => {
  expect(workerCommand('claude', undefined, 'task', '', 'medium', { tag: 'money', sessionId: '550e8400-e29b-41d4-a716-446655440000', maxBudgetUsd: '2.50' }).args)
    .toEqual(['-p', 'task', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__room__*,mcp__plugin_room_room__*,Edit,Write,Read,Bash,Glob,Grep', '--effort', 'medium', '--name', 'money', '--session-id', '550e8400-e29b-41d4-a716-446655440000', '--max-budget-usd', '2.50'])
  expect(workerCommand('claude', undefined, 'task').args).not.toContain('--effort')
  expect(workerCommand('claude', undefined, 'task', '', 'minimal').args).toContain('low')
  expect(workerCommand('codex', undefined, 'task', '', 'medium').args).toContain('model_reasoning_effort=medium')
  expect(workerCommand('codex', undefined, 'task').args.some(arg => arg.startsWith('model_reasoning_effort='))).toBe(false)
  expect(workerCommand('claude', 'opus', 'fix', '', 'high', { tag: 'money', sessionId: '550e8400-e29b-41d4-a716-446655440000', resume: true }).args)
    .toEqual(['-p', '--resume', '550e8400-e29b-41d4-a716-446655440000', 'fix', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__room__*,mcp__plugin_room_room__*,Edit,Write,Read,Bash,Glob,Grep', '--model', 'opus', '--effort', 'high', '--name', 'money'])
  expect(workerCommand('codex', 'gpt-6-sol', 'fix', '', 'high', { sessionId: '550e8400-e29b-41d4-a716-446655440000', resume: true }).args)
    .toEqual(['exec', 'resume', '550e8400-e29b-41d4-a716-446655440000', '-c', 'sandbox_mode="workspace-write"', '-c', CODEX_SHELL_FILTER, '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=high', '--json', 'fix'])
  expect(workerEnv({ ROOM_WORKER_HOST: 'claude', ROOM_WORKER_MODEL: 'old', ROOM_WORKER_EFFORT: 'high' }, {})).toEqual({})
})

describe('retirement integration', () => {
  it('archives a done worker only after its dismissed process exits, preserving its summary and files', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'archive me' })
    publishFixture(t.a, 'rohanz+money', 'app.py', 'x = 2\n')
    await reportDone('money', 'implemented money')
    const discarding = t.leadTools.call('room_collect', { discard: true, tag: 'money' })
    await new Promise(resolve => setTimeout(resolve, 1))
    expect(t.a.retiredWorkers()).toEqual([])
    await vi.waitFor(async () => expect((await registryForDir(dir)).list().find(record => record.tag === 'money')?.stop?.reason).toBe('discarded'), { timeout: 10_000 })
    expect(await t.leadTools.call('room_state', {})).toContain('money (claude, discard pending (collecting)')
    t.exits[0](0)
    expect(await discarding).toContain('discarded money')
    expect(t.a.messages().some(m => m.type === 'note' && m.to === lead.name && /dismissed worker money/.test(m.text))).toBe(false)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')).toBeUndefined(), { timeout: 15_000 })
    expect(t.a.retiredWorkers()).toMatchObject([{ name: 'rohanz+money', summary: 'discarded', files: [], outcome: 'dismissed' }])
    expect(manifestPaths(t.a, 'rohanz+money')).toEqual([])
    await t.leadTools.shutdown()
  })

  it('a merge preview retains a done worker with uncommitted work and zero commits', async () => {
    const t = setupLead()
    await registryForDir(dir)
    const prepared = await prepareWorktree(dir, 'finished', 'rohanz')
    writeFileSync(join(prepared.dir, 'uncommitted-retirement-check'), 'dirty')
    await registerWorkers(t.session!, [{ tag: 'finished', name: 'rohanz+finished', host: 'codex', task: 'x', dir: prepared.dir, branch: prepared.branch, pid: -1, startedAt: 1, status: 'done', lead: 'rohanz', exitCode: 0 }])
    await t.leadTools.call('room_preview_merge', {})
    expect(t.a.retiredWorkers()).toEqual([])
    expect(workerByTag(dir, 'finished')).toBeDefined()
    const collected = await t.leadTools.call('room_collect', { discard: true, tag: 'finished' })
    expect(collected).toContain('discarded finished')
    await vi.waitFor(() => expect(t.a.retiredWorkers()).toHaveLength(1), { timeout: 15_000 })
    const retired = t.a.retiredWorkers()[0]
    expect(retired).toMatchObject({ tag: 'finished', outcome: 'dismissed' })
    expect(retired.uncommitted).toBeUndefined()
    expect(await t.leadTools.call('room_state', { all: true })).toContain('discarded')
    expect(existsSync(join(dir, 'uncommitted-retirement-check'))).toBe(false)
    await t.leadTools.shutdown()
  })
})

describe('spawn inputs and effort', () => {
  it.each(['minimal', 'low', 'medium', 'high'])('passes valid Codex effort %s into config and the worker prompt', async effort => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'effort', task: 'reason carefully', host: 'codex', effort })
    expect(t.specs[0].args).toContain(`model_reasoning_effort=${effort}`)
    expect(t.specs[0].args.some(a => a.includes(`reasoning effort: ${effort}`))).toBe(true)
    await t.leadTools.shutdown()
  })

  it.each(['max', '', 'HIGH', 2, null])('rejects invalid effort %s before spawning', async effort => {
    const t = setupLead()
    expect(await t.leadTools.call('room_spawn', { tag: 'effort', task: 'x', effort })).toContain('error: effort must be')
    expect(t.specs).toEqual([])
    await t.leadTools.shutdown()
  })

  it('uses .roomlinks defaults, records links and describes them as read-only in the actual prompt', async () => {
    const t = setupLead()
    const source = 'spawn-linked-input'
    const dest = join(dir, '.room', 'workers', 'linked')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dir, source), 'training data')
    writeFileSync(join(dir, '.roomlinks'), `# shared inputs\n\n${source} # comment\n`)
    try {
      expect(await t.leadTools.call('room_spawn', { tag: 'linked', task: 'read inputs' })).toContain(`inputs ${source}`)
      expect(workerByTag(dir, 'linked')?.link).toEqual([source])
      expect(lstatSync(join(dest, source)).isSymbolicLink()).toBe(true)
      expect(t.specs[0].args.some(a => a.includes(`Read-only inputs linked from the lead's clone: ${source}`))).toBe(true)
      expect(prepareWorkerLinks(dir, dest, [])).toEqual([])
    } finally {
      rmSync(join(dir, '.roomlinks'), { force: true })
      rmSync(join(dir, source), { force: true })
      rmSync(dest, { recursive: true, force: true })
      await t.leadTools.shutdown()
    }
  })

  it('validates the entire link list before mutating and never overwrites a destination', () => {
    const root = mkdtempSync(join(tmpdir(), 'room-links-'))
    const target = join(root, 'worktree')
    mkdirSync(target)
    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, 'data', 'in.txt'), 'input')
    writeFileSync(join(target, 'present'), 'keep')
    try {
      expect(() => prepareWorkerLinks(root, target, ['data', 'missing'])).toThrow()
      expect(existsSync(join(target, 'data'))).toBe(false)
      expect(() => prepareWorkerLinks(root, target, ['data', 'data/in.txt'])).toThrow('overlapping')
      for (const p of ['../escape', '/tmp', '.', '.git', '.room', 'data/../../escape']) expect(() => prepareWorkerLinks(root, target, [p])).toThrow()
      symlinkSync(tmpdir(), join(root, 'outside'))
      expect(() => prepareWorkerLinks(root, target, ['outside'])).toThrow('escapes repo')
      symlinkSync(join(root, 'data'), join(target, 'data'))
      expect(() => prepareWorkerLinks(root, target, ['data/in.txt'])).toThrow('destination')
      expect(() => prepareWorkerLinks(root, target, ['data'])).toThrow('destination')
      rmSync(join(target, 'data'))
      expect(prepareWorkerLinks(root, target, ['data/in.txt'])).toEqual(['data/in.txt'])
      expect(realpathSync(join(target, 'data', 'in.txt'))).toBe(realpathSync(join(root, 'data', 'in.txt')))
      writeFileSync(join(root, 'present'), 'do not replace')
      expect(() => prepareWorkerLinks(root, target, ['present'])).toThrow('destination')
      expect(readFileSync(join(target, 'present'), 'utf8')).toBe('keep')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('guides a Claude lead only on the first spawn, after a silent solo room_state', async () => {
    expect(claudeWakeUnavailable(dir, 'claude', 'claude')).toBe(true)
    expect(claudeWakeUnavailable(dir, 'codex', 'codex')).toBe(false)
    expect(claudeWakeUnavailable(dir, 'claude', 'claude --dangerously-load-development-channels plugin:room@room')).toBe(false)
    expect(claudeWakeUnavailable(dir, 'claude', 'claude --channels plugin:unrelated@other')).toBe(true)
    vi.stubEnv('ROOM_HOST', 'claude')
    vi.stubEnv('SHELL', '/bin/bash')
    const t = setupLead()
    expect(await t.leadTools.call('room_state', {})).not.toContain('For your human:')
    const reply = await t.leadTools.call('room_spawn', { tag: 'warning', task: 'x' })
    expect(reply.split('\n')[0]).toContain('Continue independent work while workers run.')
    expect(reply.split('\n')[1]).toMatch(/^For your human:/)
    expect(reply).toContain('>> ~/.bashrc')
    const second = await t.leadTools.call('room_spawn', { tag: 'another', task: 'y' })
    expect(second).not.toContain('For your human:')
    expect(second).not.toContain('Continue independent work while workers run.')
    await t.leadTools.shutdown()
  })

  it('guides once when another participant is present on room_state', async () => {
    vi.stubEnv('ROOM_HOST', 'claude')
    const t = setupLead()
    const peerDoc = new Y.Doc()
    const peer = new Awareness(peerDoc)
    const sessionId = visiblePeer(t.session!.room, 'teammate', 'agent')
    peer.setLocalState({ user: { name: 'teammate', kind: 'agent' }, sessionId, status: 'working' })
    applyAwarenessUpdate(t.session!.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
    const first = await t.leadTools.call('room_state', {})
    expect(first).toContain('For your human:')
    expect(await t.leadTools.call('room_state', {})).not.toContain('For your human:')
    const spawn = await t.leadTools.call('room_spawn', { tag: 'after-state', task: 'x' })
    expect(spawn.split('\n')[0]).toContain('Continue independent work while workers run.')
    expect(spawn).not.toContain('For your human:')
    peer.destroy()
    peerDoc.destroy()
    await t.leadTools.shutdown()
  })
})

it('reads only the last five non-empty log lines, strips ANSI, and caps output at 600 characters', () => {
  const log = join(dir, 'worker-tail.log')
  try {
    writeFileSync(log, 'old\n' + 'x'.repeat(70_000) + '\n1\n\n2\n3\n\u001b[31m4\u001b[0m\n5\n')
    expect(workerLogTail(log)).toBe('1\n2\n3\n4\n5')
    writeFileSync(log, 'x'.repeat(1000) + '\nlast')
    expect(workerLogTail(log)).toHaveLength(600)
    expect(workerLogTail(log)).toMatch(/last$/)
    expect(workerLogTail(join(dir, 'missing-log'))).toBe('(log unavailable)')
  } finally { rmSync(log, { force: true }) }
})

it('renders Codex JSONL agent and error text without raw event envelopes', () => {
  const log = join(dir, 'worker-jsonl.log')
  try {
    writeFileSync(log, [
      JSON.stringify({ type: 'thread.started', thread_id: '550e8400-e29b-41d4-a716-446655440000' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Checking the failing path.' } }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'The command failed.' } }),
      JSON.stringify({ type: 'error', message: 'Connection lost.' }),
      'process exited with status 1',
    ].join('\n'))
    expect(workerLogTail(log)).toBe('Checking the failing path.\nThe command failed.\nConnection lost.\nprocess exited with status 1')
  } finally { rmSync(log, { force: true }) }
})

describe('worker follow-up sessions', () => {
  it('reports a missing host executable through the start promise', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'room-missing-host-'))
    try {
      const proc = defaultSpawner({ cmd: join(scratch, 'missing-host'), args: [], cwd: scratch, env: {}, logFile: join(scratch, 'worker.log') })
      await expect(proc.started).rejects.toThrow(/ENOENT/)
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  })

  it('preserves Codex JSONL in the process log for recovery', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'room-thread-id-'))
    try {
      const logFile = join(scratch, 'worker.log')
      const id = '550e8400-e29b-41d4-a716-446655440000'
      const proc = defaultSpawner({ cmd: process.execPath, args: ['-e', `process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'${id}'})+'\\n')`], cwd: scratch, env: {}, logFile })
      const exited = new Promise<number | null>(resolve => proc.onExit(resolve))
      expect(await exited).toBe(0)
      expect(readFileSync(logFile, 'utf8')).toContain(`"type":"thread.started","thread_id":"${id}"`)
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  })
  it('records a Claude UUID and resumes a done worker with the same tag, worktree and budget', async () => {
    vi.stubEnv('ROOM_WORKER_NICE', '0')
    vi.stubEnv('ROOM_WORKER_MAX_BUDGET_USD', '3.25')
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'first', host: 'claude', model: 'opus', effort: 'high', threads: 2 })
    const initial = workerByTag(dir, 'money')!
    expect(initial.hostSessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(t.specs[0].args).toContain('--session-id')
    const settings = JSON.parse(t.specs[0].args[t.specs[0].args.indexOf('--settings') + 1])
    expect(settings).toEqual({ hooks: { PreToolUse: [{ matcher: 'PowerShell', hooks: [{
      type: 'command', command: 'node', args: ['--input-type=module', '-e', expect.stringContaining('PowerShell')], timeout: 5,
    }] }] } })
    expect(fs.readdirSync(join(dir, '.room', 'workers')).filter(name => /\.[cm]?js$/.test(name))).toEqual([])
    mkdirSync(initial.dir, { recursive: true })
    await reportDone('money', 'first done')
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')?.exitCode).toBe(0), { timeout: 15_000 })
    const sent = await t.leadTools.call('room_send', { type: 'note', to: 'money', text: 'fix the review finding' })
    expect(sent).toContain("resumed money's retained conversation with your message")
    expect(t.specs[1].env).toMatchObject({ ...t.specs[0].env, ROOM_WORKER_RUN: '2', ROOM_LAUNCH_NONCE: t.specs[1].env.ROOM_LAUNCH_NONCE })
    expect(t.specs[1].env.ROOM_LAUNCH_NONCE).not.toBe(t.specs[0].env.ROOM_LAUNCH_NONCE)
    expect(t.specs[1]).toMatchObject({ cwd: initial.dir, env: { ROOM_TAG: 'money', ROOM_WORKER_THREADS: t.specs[0].env.ROOM_WORKER_THREADS, ROOM_WORKER_MEM_GB: t.specs[0].env.ROOM_WORKER_MEM_GB } })
    expect(JSON.parse(t.specs[1].args[t.specs[1].args.indexOf('--settings') + 1])).toEqual(settings)
    const resumeArgs = t.specs[1].args.slice(2) // Worker-specific --settings is asserted above.
    const resumePrompt = resumeArgs[3]
    expect(resumePrompt).toMatch(/^Room messages for this resumed turn \(each line includes its message ID, sender, and reply metadata\):\n/)
    expect(JSON.parse(resumePrompt.slice(resumePrompt.indexOf('\n') + 1))).toMatchObject({ type: 'note', text: 'fix the review finding', to: 'rohanz+money', from: 'rohanz', id: expect.stringMatching(/^m_/) })
    expect(resumeArgs).toEqual(['-p', '--resume', initial.hostSessionId, resumePrompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__room__*,mcp__plugin_room_room__*,Edit,Write,Read,Bash,Glob,Grep', '--model', 'opus', '--effort', 'high', '--name', 'money', '--max-budget-usd', '3.25'])
    expect(workerByTag(dir, 'money')).toMatchObject({ status: 'running', hostSessionId: initial.hostSessionId, dir: initial.dir })
  })

  it('refuses a finished-worker follow-up before launch while the hub is paused (F-S5)', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'first', host: 'claude' })
    const worker = workerByTag(dir, 'money')!
    mkdirSync(worker.dir, { recursive: true })
    await reportDone('money', 'finished')
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')?.exitCode).toBe(0), { timeout: 15_000 })
    vi.spyOn(t.session!.hub, 'paused').mockReturnValue('hub paused')
    vi.spyOn(t.session!, 'post').mockResolvedValue({ ok: false, reason: 'unreachable', text: 'not sent: hub unreachable', msg: {} } as never)
    const reply = await t.leadTools.call('room_send', { type: 'note', to: 'money', text: 'follow up' })
    expect(reply).toContain('not sent: hub unreachable')
    expect(t.specs).toHaveLength(1)
  })

  it('does not resume a finished worker when the post refuses after a successful hello (F-S5 re-review)', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'first', host: 'claude' })
    const worker = workerByTag(dir, 'money')!
    mkdirSync(worker.dir, { recursive: true })
    await reportDone('money', 'finished')
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')?.exitCode).toBe(0), { timeout: 15_000 })
    vi.spyOn(t.session!, 'post').mockResolvedValue({ ok: false, reason: 'unreachable', text: 'not sent: hub unreachable', msg: {} } as never)
    const reply = await t.leadTools.call('room_send', { type: 'note', to: 'money', text: 'follow up' })
    expect(reply).toContain('not sent: hub unreachable')
    expect(reply).not.toContain('resumed')
    expect(t.specs).toHaveLength(1)
  })

  it('captures the Codex thread ID and resumes a stopped worker with the documented flags', async () => {
    vi.stubEnv('ROOM_WORKER_NICE', '0')
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'first', host: 'codex', model: 'gpt-6-sol', effort: 'high', threads: 2 })
    expect(t.specs[0].args).toContain('--json')
    const registry = await registryForDir(dir), record = registry.list().find(record => record.tag === 'money')!, run = record.runs[0]
    await registry.admit({ id: record.id, run: run.n, nonce: run.nonce, dir: record.dir,
      chain: [], hostSessionId: '550e8400-e29b-41d4-a716-446655440000' })
    expect(registry.read(record.id)?.hostSessionId).toBe('550e8400-e29b-41d4-a716-446655440000')
    const initial = workerByTag(dir, 'money')!
    mkdirSync(initial.dir, { recursive: true })
    t.exits[0](1)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')?.status).toBe('failed'), { timeout: 15_000 })
    const sent = await t.leadTools.call('room_send', { type: 'note', to: 'rohanz+money', text: 'repair the failure' })
    expect(sent).toContain("resumed money's retained conversation with your message")
    const resumePrompt = t.specs[1].args.at(-1)!
    expect(resumePrompt).toMatch(/^Room messages for this resumed turn \(each line includes its message ID, sender, and reply metadata\):\n/)
    expect(JSON.parse(resumePrompt.slice(resumePrompt.indexOf('\n') + 1))).toMatchObject({ type: 'note', text: 'repair the failure', to: 'rohanz+money', from: 'rohanz', id: expect.stringMatching(/^m_/) })
    expect(t.specs[1].args).toEqual(['exec', 'resume', '550e8400-e29b-41d4-a716-446655440000', '-c', 'sandbox_mode="workspace-write"', '-c', CODEX_SHELL_FILTER, '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=high', '--json', resumePrompt])
    expect(t.specs[1].cwd).toBe(initial.dir)
    expect(workerByTag(dir, 'money')).toMatchObject({ status: 'running', exitCode: undefined, hostSessionId: '550e8400-e29b-41d4-a716-446655440000' })
  })

  it('waits for a just-finished worker process to exit before resuming its session', async () => {
    vi.stubEnv('ROOM_WORKER_NICE', '0')
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'quickreply', task: 'first', host: 'claude' })
    const w = workerByTag(dir, 'quickreply')!
    mkdirSync(w.dir, { recursive: true })
    await reportDone('quickreply', 'done')
    // Another observer records the exit (§6 then reads done) before this session's process handle reports it.
    const registry = await registryForDir(dir), id = w.id
    finishFixtureProcess(w.pid)
    await registry.writeExit(id, { run: 1, code: 0, witnessed: true, at: Date.now() })
    expect(workerByTag(dir, 'quickreply')?.status).toBe('done')
    const reply = t.leadTools.call('room_send', { type: 'note', to: 'quickreply', text: 'one more fix' })
    setTimeout(() => t.exits[0](0), 20)
    expect(await reply).toContain("resumed quickreply's retained conversation with your message")
    expect(t.specs).toHaveLength(2)
  })

  it('reserves a fresh port and names it when a resumed worker lost its old port', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'resumeport', task: 'first', host: 'claude' })
    const w = workerByTag(dir, 'resumeport')!
    mkdirSync(w.dir, { recursive: true })
    await reportDone('resumeport', 'first done')
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'resumeport')?.exitCode).toBe(0), { timeout: 15_000 })
    const other = reserveWorkerPort('other-lead/worker', [], process.env.XDG_CONFIG_HOME, w.port)
    try {
      const reply = await t.leadTools.call('room_send', { type: 'note', to: 'resumeport', text: 'one more task' })
      expect(reply).toContain('dev-server PORT is 4401')
      expect(t.specs[1].env.PORT).toBe('4401')
      expect(t.specs[1].args.join(' ')).toContain('Your dev-server port is 4401 (PORT=4401).')
      expect(workerByTag(dir, 'resumeport')?.port).toBe(4401)
    } finally { other.release(); await t.leadTools.shutdown() }
  })

  it('explains why a collected worker or missing worktree cannot resume', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'missingfollowup', task: 'first', host: 'claude' })
    await reportDone('missingfollowup')
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'missingfollowup')?.exitCode).toBe(0), { timeout: 15_000 })
    rmSync(join(dir, '.room', 'workers', 'missingfollowup'), { recursive: true, force: true })
    expect(await t.leadTools.call('room_send', { type: 'note', to: 'missingfollowup', text: 'fix' })).toContain('worktree no longer exists')
    expect(t.specs).toHaveLength(1)
    const finished = workerByTag(dir, 'missingfollowup')!
    t.a.retireWorker(finished.id, { name: finished.name, tag: finished.tag, lead: finished.lead, host: finished.host, task: finished.task, startedAt: finished.startedAt,
      id: finished.id, summary: 'collected', finishedAt: finished.finishedAt!, retiredAt: Date.now(), files: [], fileCount: 0, outcome: 'dismissed' }, ignore)
    const registry = await registryForDir(dir)
    await registry.update(finished.id!, old => ({ ...old, phase: 'retired', seq: old.seq + 1 }))
    expect(await t.leadTools.call('room_send', { type: 'note', to: 'missingfollowup', text: 'fix' })).toContain('collected or discarded')
    expect(t.specs).toHaveLength(1)
  })
})

describe('preview of a finished local worker', () => {
  it('reads its worktree without waiting on its exit: a final publish and an ended lease are not moves', async () => {
    vi.stubEnv('ROOM_HOST', 'claude')
    const { a, b } = pair()
    a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    let ls: Session | null = fakeSession(a, lead)
    const exits: ((code: number | null) => void)[] = []
    const sleeps: number[] = []
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, maxWorkers: 2, probe: fixtureProbe,
      sleep: async ms => { sleeps.push(ms) },
      spawner: () => { const pid = 5300 + exits.length; spawnFixtureProcess(pid)
        const callbacks: ((code: number | null) => void)[] = []
        exits.push(code => { finishFixtureProcess(pid); for (const callback of callbacks) callback(code) })
        return { pid, started: Promise.resolve(), onExit: cb => { callbacks.push(cb) }, kill: () => true } },
      worktree: (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    const flagDir = mkdtempSync(join(tmpdir(), 'room-finished-')), flag = join(flagDir, 'exited')
    let exited = false
    const watch = setInterval(() => {
      if (exited || !existsSync(flag)) return
      exited = true
      // Its process exits during the preview: a last publish, then the hub ends its name lease.
      publishFixture(b, 'rohanz+settled', 'app.py', 'x = 7\n')
      const holder = b.participants.get('rohanz+settled\u0000holder') as Record<string, unknown>
      b.participants.set('rohanz+settled\u0000holder', { ...holder, ended: 'released' })
    }, 2)
    try {
      expect(await leadTools.call('room_spawn', { tag: 'settled', task: 'x = 7' })).toContain('spawned settled')
      const worker = workerByTag(dir, 'settled')!
      writeFileSync(join(worker.dir, 'app.py'), 'x = 7\n')
      publishFixture(b, 'rohanz+settled', 'app.py', 'x = 7\n')
      exits[0](0)
      await vi.waitFor(() => expect(workerByTag(dir, 'settled')?.status).not.toBe('running'))
      const out = await leadTools.call('room_preview_merge', { person: 'rohanz+settled', run: `touch '${flag}' && sleep 0.3 && cat app.py` })
      expect(exited).toBe(true)
      expect(out).toContain('rohanz+settled: trusted local worktree')
      expect(out).toContain('x = 7')
      expect(out).not.toContain('moved during the preview')
      expect(sleeps).toEqual([])
    } finally {
      clearInterval(watch)
      rmSync(flagDir, { recursive: true, force: true })
      await leadTools.call('room_collect', { discard: true, tag: 'settled' })
      await leadTools.shutdown()
      vi.unstubAllEnvs()
    }
  })

  it('a finished worker resumed during the preview returns a disk snapshot, never certified from its old run', async () => {
    vi.stubEnv('ROOM_HOST', 'claude')
    const { a, b } = pair()
    a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    let ls: Session | null = fakeSession(a, lead)
    const exits: ((code: number | null) => void)[] = []
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, maxWorkers: 2, probe: fixtureProbe, sleep: async () => {},
      spawner: () => { const pid = 5400 + exits.length; spawnFixtureProcess(pid)
        const callbacks: ((code: number | null) => void)[] = []
        exits.push(code => { finishFixtureProcess(pid); for (const callback of callbacks) callback(code) })
        return { pid, started: Promise.resolve(), onExit: cb => { callbacks.push(cb) }, kill: () => true } },
      worktree: (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    const flagDir = mkdtempSync(join(tmpdir(), 'room-resumed-')), flag = join(flagDir, 'started')
    let resumed: Promise<string> | undefined
    const watch = setInterval(() => {
      if (resumed || !existsSync(flag)) return
      // While the preview's tests run, the lead sends the finished worker a follow-up and its new run edits.
      resumed = leadTools.call('room_send', { type: 'note', to: 'resumer', text: 'one more change' })
      void resumed.then(() => writeFileSync(join(workerByTag(dir, 'resumer')!.dir, 'app.py'), 'x = 8\n'))
    }, 2)
    try {
      expect(await leadTools.call('room_spawn', { tag: 'resumer', task: 'x = 7' })).toContain('spawned resumer')
      const worker = workerByTag(dir, 'resumer')!
      writeFileSync(join(worker.dir, 'app.py'), 'x = 7\n')
      publishFixture(b, 'rohanz+resumer', 'app.py', 'x = 7\n')
      await reportDone('resumer', 'x = 7 done')
      exits[0](0)
      await vi.waitFor(() => expect(workerByTag(dir, 'resumer')?.status).not.toBe('running'))
      const out = await leadTools.call('room_preview_merge', { person: 'rohanz+resumer', run: `touch '${flag}' && sleep 0.5 && cat app.py` })
      expect(await resumed).toContain('resumed')
      expect(out).toContain('SNAPSHOT result')
      expect(out).toContain('rohanz+resumer moved since this snapshot was built')
      expect(out).toContain('rohanz+resumer (disk worktree snapshot, base ')
      expect(out).toContain('x = 7')
      expect(ls!.lastPreview).toMatchObject({ clean: false, complete: false, testsPassed: false })
    } finally {
      clearInterval(watch)
      rmSync(flagDir, { recursive: true, force: true })
      exits.at(-1)?.(0)
      await leadTools.call('room_collect', { discard: true, tag: 'resumer' })
      await leadTools.shutdown()
      vi.unstubAllEnvs()
    }
  })
})
