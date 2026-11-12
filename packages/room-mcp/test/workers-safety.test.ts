import { exitedPid } from '../../relay/test/exited-pid.js'
import { requireWorkerInventory } from '../src/worker-store.js'
import { base, createTools, dir, fakeSession, lead, ownedLegacyWorker, pair, realRepo, scratchRepos, setupLead } from './workers-fixture.js'
import { finishSignalShutdown } from '../src/index.js'
import { setParticipantBase } from '@room/shared/testing'
import * as workerBaseline from '@room/roomd/baseline'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../src/session.js'
import { prepareWorktree } from '../src/worker-git.js'
import { parsePsLstartUtc, probeProcess, workerProcessOwnership, type SpawnSpec } from '../src/worker-process.js'
import { Rooms } from '../src/registry.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import type { WorkerRecord } from '../src/worker-status.js'
import { finishFixtureProcess, fixtureLiveness, fixtureProcess } from './fixtures/process-liveness.js'
import { workspaceRepo } from './fixtures/workspace-repo.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { registerWorkers, workerByTag } from './registry-fixture.js'

describe('worker safety', () => {
  it('keeps the test runner live even when the host process probe fails', () => {
    const self = { pid: process.pid, startTime: 'host:runner', executable: 'node' }
    expect(fixtureLiveness(self, () => 'dead')).toBe('alive')
    fixtureProcess(process.pid, 'fixture:worker', 'claude')
    expect(fixtureLiveness(self, () => 'dead')).toBe('alive')
    expect(fixtureLiveness({ pid: process.pid, startTime: 'fixture:worker', executable: 'claude' }, () => 'dead')).toBe('alive')
    finishFixtureProcess(process.pid)
    expect(fixtureLiveness({ pid: process.pid, startTime: 'fixture:worker', executable: 'claude' }, () => 'dead')).toBe('dead')
  })

  it('uses exact OS start identity, host executable, and liveness after a lead restart', () => {
    const rec = { host: 'claude' as const, processStartTime: 'linux:boot-a:12345', hostSessionId: 'session-1' }
    const info = { startTime: rec.processStartTime, executable: '/usr/local/bin/claude' }
    expect(workerProcessOwnership(process.pid, rec, () => info)).toBe('ours')
    expect(workerProcessOwnership(process.pid, rec, () => ({ ...info, startTime: 'linux:boot-a:12346' }))).toBe('not-ours')
    expect(workerProcessOwnership(process.pid, rec, () => ({ ...info, startTime: 'linux:boot-b:12345' }))).toBe('not-ours')
    expect(workerProcessOwnership(process.pid, rec, () => ({ ...info, executable: '/usr/bin/vim' }))).toBe('not-ours')
    expect(workerProcessOwnership(process.pid, { ...rec, processStartTime: undefined }, () => info)).toBe('unknown')
    expect(workerProcessOwnership(process.pid, rec, () => ({}))).toBe('unknown')
    expect(workerProcessOwnership(process.pid, rec, () => undefined)).toBe('not-ours')
    expect(workerProcessOwnership(exitedPid(), rec)).toBe('not-ours')
    expect(workerProcessOwnership(-1, rec, () => info)).toBe('unknown')
  })

  it('ignores prompt and session text even when they contain the worker session id', () => {
    const rec = { host: 'codex' as const, processStartTime: 'linux:boot-a:12345', hostSessionId: 'session-1' }
    expect(workerProcessOwnership(process.pid, rec, () => ({ startTime: rec.processStartTime, executable: 'codex',
      command: 'codex exec --json "please mention session-1"', args: ['codex', 'exec', '--json', 'session-1'] }))).toBe('ours')
    expect(workerProcessOwnership(process.pid, rec, () => ({ startTime: 'linux:boot-a:12346', executable: 'codex',
      command: 'codex exec resume session-1' }))).toBe('not-ours')
    expect(workerProcessOwnership(process.pid, rec, () => ({ startTime: rec.processStartTime, executable: 'node' }))).toBe('ours')
  })

  it('reads Linux stat field 22 with an injected boot id and executable reader', () => {
    const stat = `42 (worker with ) in name) S ${Array(18).fill('0').join(' ')} 987654 0`
    const unreadable = (file: string): never => { throw new Error(`EACCES ${file}`) }
    // comm and cmdline unreadable: the executable names it (the naming rule is in process-name.test.ts).
    expect(probeProcess(42, { platform: 'linux', readFile: file => file.endsWith('/stat') ? stat : file.endsWith('/boot_id') ? 'boot-123\n' : unreadable(file),
      readLink: () => '/usr/local/bin/codex', exec: () => { throw new Error('unexpected') } }))
      .toEqual({ startTime: 'linux:boot-123:987654', executable: 'codex' })
  })

  it('reads macOS lstart to the second with an injected boot-time guard', () => {
    const line = 'Mon Sep 21 12:34:56 2026'
    expect(parsePsLstartUtc(line)).toBe(Date.UTC(2026, 8, 21, 12, 34, 56) / 1000)
    expect(probeProcess(42, { platform: 'darwin', readFile: () => { throw new Error('unexpected') }, readLink: () => '',
      exec: (file, args) => file === 'sysctl' ? '{ sec = 1234567, usec = 0 }' : args[1] === 'lstart=' ? line : '/opt/homebrew/bin/node' }))
      .toEqual({ startTime: `darwin:1234567:${Date.UTC(2026, 8, 21, 12, 34, 56) / 1000}`, executable: 'node' })
  })

  it('keeps the worker record and disk stop reason untouched if shutdown dismissal errors', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'erroring', task: 'x' })
    const before = { ...(await workerByTag(dir, 'erroring'))! }
    const post = t.session.post
    vi.spyOn(t.session, 'post').mockImplementation(((...args: Parameters<typeof post>) => {
      if ((args[1] as { type?: string }).type === 'note') throw new Error('note failed')
      return post(...args)
    }) as typeof post)
    await t.leadTools.shutdown()
    expect(t.killed).toEqual([1])
    // §9: the durable stop is mirrored even though the note failed; §6 row 8 keeps it running.
    expect((await workerByTag(dir, 'erroring'))).toEqual({ ...before, stopReason: 'lead-session-ended' })
    expect((await (await registryForDir(dir)).read(before.id!))?.stop?.reason).toBe('lead-session-ended')
  })

  it('dismissing a worker whose process is unknown and old leaves the pid alone and keeps its status', async () => {
    const { a, b } = pair()
    a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    // a worker record left by a lead that has since restarted: pid 1 is alive but not ours
    await registerWorkers(fakeSession(a, lead), [{ tag: 'ghost', name: 'rohanz+ghost', host: 'claude', task: 'x', dir, branch: 'room/ghost', pid: 1, startedAt: Date.now(), status: 'running', lead: 'rohanz' }])
    let ls: Session | null = fakeSession(b, lead)
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir })
    const out = await tools.call('room_collect', { discard: true, tag: 'ghost' })
    expect(out).toContain('no local worker capability')
    expect((await workerByTag(dir, 'ghost'))?.status).toBe('running') // nothing was signalled, so nothing changed
  })

  it('shutdown reports an unreadable live pid and preserves the running record', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    await ownedLegacyWorker(a, 'unknown', 'running', process.pid)
    let session: Session | null = fakeSession(a, lead)
    const tools = createTools({ getSession: () => session, setSession: s => { session = s }, cwd: dir, probe: () => ({}), leave: async () => {} })
    await tools.shutdown()
    expect((await workerByTag(dir, 'unknown'))?.status).toBe('running')
    expect((requireWorkerInventory(await (await registryForDir(dir)).list())).find(record => record.tag === 'unknown')?.stop?.reason).toBe('lead-session-ended')
    expect(a.messages().some(m => m.type === 'note' && m.to === 'rohanz' && m.text === `could not verify unknown's process (pid ${process.pid}); left running, not stopped`)).toBe(true)
  })

  it.each(['done', 'failed', 'dismissed'] as const)('shutdown leaves a terminal %s worker without verified live identity alone', async status => {
    const { a } = pair()
    a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    await ownedLegacyWorker(a, 'finished', status, process.pid)
    let session: Session | null = fakeSession(a, lead)
    const tools = createTools({ getSession: () => session, setSession: s => { session = s }, cwd: dir, probe: () => ({}), leave: async () => {} })
    await tools.shutdown()
    expect(a.messages().some(m => m.type === 'note' && m.text.includes('dismissed worker finished'))).toBe(false)
    expect((await workerByTag(dir, 'finished'))?.status).toBe(status)
  })

  it('a registry transition with no mirror at its call site (reconcile, another writer) still reaches the Worker doc', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    const id = (await workerByTag(dir, 'a'))!.id
    expect((await workerByTag(dir, 'a'))?.status).toBe('running')
    const registry = await registryForDir(dir)
    finishFixtureProcess((await workerByTag(dir, 'a'))!.pid)
    await registry.writeExit(id, { run: 1, code: 3, witnessed: true, at: Date.now() })
    // §6 row 14: a witnessed nonzero exit is `failed`.
    expect((await registry.status(id))?.status).toBe('failed')
    expect((await workerByTag(dir, 'a'))).toMatchObject({ status: 'failed', exitCode: 3 })
  })

  it.each([false, true])('waits for durable stop before signalling, with bounded process exit (stalled: %s)', async stalled => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'slow-stop', task: 'x' })
    const registry = await registryForDir(dir), beginStop = registry.beginStop.bind(registry)
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const stopping = new Promise<void>(resolve => { entered = resolve })
    vi.spyOn(registry, 'beginStop').mockImplementation(async (...args) => { entered(); await gate; return beginStop(...args) })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let returned = false
    let cleanup!: Promise<void>
    const log = vi.fn(), exit = vi.fn()
    const shutdown = finishSignalShutdown('SIGTERM', progress => {
      cleanup = t.leadTools.shutdown('SIGTERM', progress)
      return cleanup
    }, log, () => { returned = true; exit() })
    try {
      await stopping
      await vi.advanceTimersByTimeAsync(1801)
      expect(returned).toBe(false)
      expect(t.killed).toEqual([])
      if (stalled) {
        await vi.advanceTimersByTimeAsync(2199)
        await shutdown
        expect(exit).toHaveBeenCalledOnce()
        expect(t.killed).toEqual([])
        expect((await workerByTag(dir, 'slow-stop'))).toMatchObject({ status: 'running' })
        expect((await workerByTag(dir, 'slow-stop'))?.stopReason).toBeUndefined()
        expect(log).toHaveBeenCalledWith(expect.stringContaining('pending: worker slow-stop: writing durable stop intent; host not yet signalled'))
        expect(log).not.toHaveBeenCalledWith('stopped: SIGTERM')
      }
      release()
      await cleanup
      await shutdown
      expect(t.killed).toEqual([1])
      expect(exit).toHaveBeenCalledOnce()
      expect((await workerByTag(dir, 'slow-stop'))).toMatchObject({ status: 'running', stopReason: 'lead-session-ended' })
    } finally { release(); vi.useRealTimers(); await cleanup; await shutdown }
  })

  it('bounds notification delivery only after signalling and still releases the stop operation', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'slow-note', task: 'x' })
    const post = t.session.post.bind(t.session)
    let entered!: () => void, release!: () => void
    const sending = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(t.session, 'post').mockImplementation(async (...args) => {
      if ((args[1] as { type?: string }).type === 'note') { entered(); await gate }
      return post(...args)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const shutdown = t.leadTools.shutdown()
    try {
      await sending
      expect(t.killed).toEqual([1])
      await vi.advanceTimersByTimeAsync(1800)
      await shutdown
      expect((await workerByTag(dir, 'slow-note'))).toMatchObject({ status: 'running', stopReason: 'lead-session-ended' })
      const registry = await registryForDir(dir), worker = (await workerByTag(dir, 'slow-note'))!
      expect(await registry.beginOperation(worker.id!, 'stop')).toBe(true)
      await registry.finishOperation(worker.id!)
    } finally { release(); vi.useRealTimers(); await shutdown }
  })

  it('room_leave refuses while workers run, force dismisses them; shutdown dismisses too', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    const refused = await t.leadTools.call('room_leave', {})
    expect(refused).toContain('error: 1 worker(s) still running: a')
    expect((await workerByTag(dir, 'a'))?.status).toBe('running')
    expect(t.killed).toHaveLength(0)
    const left = await t.leadTools.call('room_leave', { force: true })
    expect(left).toContain('left local/x')
    expect(t.killed).toHaveLength(1)
    // §9 / §6 row 8: stopping until the exit is witnessed.
    expect((await workerByTag(dir, 'a'))).toMatchObject({ status: 'running', stopReason: 'lead-session-ended' })
    expect(t.a.messages().some(m => m.type === 'note' && /dismissed worker a .*the lead left/.test((m as { text: string }).text))).toBe(true)
    // shutdown path
    const t2 = setupLead()
    await t2.leadTools.call('room_spawn', { tag: 'b', task: 'y' })
    await t2.leadTools.shutdown()
    expect(t2.killed).toHaveLength(1)
    expect((await workerByTag(dir, 'b'))).toMatchObject({ status: 'running', stopReason: 'lead-session-ended' })
    t2.exits[0](null)
    await vi.waitFor(async () => {
      const registry = await registryForDir(dir)
      const record = (requireWorkerInventory(await registry.list())).find(record => record.tag === 'b')!
      expect((await registry.exits(record.id))).toMatchObject([{ code: null, witnessed: true }])
    }, { timeout: 15_000 })
    expect(t2.a.messages().some(m => m.type === 'note' && m.text.includes('died'))).toBe(false)
    const session = fakeSession(t2.a, lead)
    const next = createTools({ getSession: () => session, setSession: () => {}, cwd: dir })
    // Worker facts are this clone's registry, so the next session sees both stopped workers, a and b.
    expect(await next.call('room_state', {})).toContain('workers (2):')
    expect(await next.call('room_state', {})).toContain('stopped when your last session ended; its partial work is in its worktree')
    expect(await next.call('room_state', { all: true })).toContain('stopped when your last session ended; its partial work is in its worktree')
    await next.shutdown()
  }, 30_000)

  it('an asynchronous start failure leaves no worker record or launch message', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    let ls: Session | null = fakeSession(a, lead)
    let failStart!: (error: Error) => void
    let launchAttempted = false
    const started = new Promise<void>((_, reject) => { failStart = reject })
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir,
      spawner: () => { launchAttempted = true; return { pid: -1, started, onExit: () => {}, kill: () => { throw new Error('must not signal') } } },
      worktree: (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    const spawning = tools.call('room_spawn', { tag: 'nope', task: 'x', host: 'codex' })
    await vi.waitFor(() => expect(launchAttempted).toBe(true), { timeout: 10_000 })
    // The launcher's write-ahead record exists (registry §3); the room shows at most a starting worker, never a running one.
    expect([undefined, 'starting']).toContain(a.workerViewOf('rohanz+nope')?.status)
    failStart(new Error('spawn codex ENOENT'))
    expect(await spawning).toContain('could not start codex: spawn codex ENOENT')
    expect((await workerByTag(dir, 'nope'))).toBeUndefined()
    expect(a.workerViewOf('rohanz+nope')).toBeUndefined()
    expect(a.messages()).toHaveLength(0)
  })
  it('refuses plain and nested other repositories in a local room, but permits a sibling worktree of this clone', async () => {
    const t = setupLead()
    const plain = mkdtempSync(join(tmpdir(), 'room-plain-'))
    scratchRepos.push(plain)
    const nested = join(dir, 'nested-other-repo')
    execFileSync('git', ['init', '-q', nested])
    try {
      for (const candidate of [plain, nested, plain]) {
        const reply = await t.leadTools.call('room_spawn', { tag: 'far', task: 'x', dir: candidate, allowOutside: true })
        expect(reply).toContain('another repository; a worker there cannot join this local room')
      }
      expect(t.specs).toHaveLength(0)
      expect((await (await registryForDir(dir)).reserved('far'))).toBeUndefined()
      const sibling = join(mkdtempSync(join(tmpdir(), 'room-sibling-')), 'checkout')
      scratchRepos.push(join(sibling, '..'))
      execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'sibling', sibling])
      const reply = await t.leadTools.call('room_spawn', { tag: 'near', task: 'x', dir: sibling, allowOutside: true })
      expect(reply).toContain('spawned near')
      expect(t.specs[0].cwd).toBe(sibling)
    } finally { rmSync(nested, { recursive: true, force: true }) }
  })

  it('warns after creating a worker worktree when the project watcher excludes .room', async () => {
    const t = setupLead()
    writeFileSync(join(dir, 'vite.config.ts'), "export default { server: { watch: { ignored: ['**/.room/**'] } } }")
    const reply = await t.leadTools.call('room_spawn', { tag: 'watch', task: 'x' })
    expect(reply).toContain('warning: vite.config.ts appears to ignore .room')
  })
  it('stops a running outside worker in a team room without inspecting its cwd', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    const other = mkdtempSync(join(tmpdir(), 'room-team-outside-'))
    scratchRepos.push(other)
    execFileSync('git', ['-C', other, 'init', '-q', '-b', 'main'])
    writeFileSync(join(other, 'f.txt'), 'x\n')
    execFileSync('git', ['-C', other, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'])
    execFileSync('git', ['-C', other, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    let session: Session | null = { ...fakeSession(a, lead, false), roomName: 'github.com/o/x', roomUrl: 'ws://team.example/github.com%2Fo%2Fx' } as Session
    const specs: SpawnSpec[] = []
    const kill = vi.fn(() => true)
    const listCwdProcesses = vi.fn(() => { throw new Error('must not inspect outside cwd') })
    const tools = createTools({ getSession: () => session, setSession: s => { session = s }, cwd: dir,
      spawner: spec => { specs.push(spec); return { pid: 4242, started: Promise.resolve(), onExit: () => {}, kill } },
      probe: () => undefined, listCwdProcesses })
    expect(await tools.call('room_spawn', { tag: 'far', task: 'x', dir: other })).toContain('pass allowOutside=true')
    expect(await tools.call('room_spawn', { tag: 'far', task: 'x', dir: other, allowOutside: true })).toContain('spawned far')
    expect(specs[0].cwd).toBe(other)
    await tools.shutdown()
    expect(kill).toHaveBeenCalledOnce()
    expect(listCwdProcesses).not.toHaveBeenCalled()
    expect(existsSync(join(other, 'f.txt'))).toBe(true)
  })
  it('discards an outside worker by stopping the real launched process and keeping its checkout', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    const other = mkdtempSync(join(tmpdir(), 'room-outside-process-'))
    scratchRepos.push(other)
    execFileSync('git', ['-C', other, 'init', '-q', '-b', 'existing'])
    writeFileSync(join(other, 'f.txt'), 'outside changes\n')
    execFileSync('git', ['-C', other, 'add', '.'])
    execFileSync('git', ['-C', other, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'existing'])
    const head = execFileSync('git', ['-C', other, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    let session: Session | null = { ...fakeSession(a, lead, false), roomName: 'github.com/o/x', roomUrl: 'ws://team.example/github.com%2Fo%2Fx' } as Session
    let child: ChildProcess | undefined
    const tools = createTools({ getSession: () => session, setSession: s => { session = s }, cwd: dir,
      probe: probeProcess, listCwdProcesses: () => { throw new Error('must not inspect outside cwd') },
      spawner: spec => {
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: spec.cwd, stdio: 'ignore' })
        const launched = child
        return { pid: launched.pid!, started: new Promise<void>((resolve, reject) => { launched.once('spawn', resolve); launched.once('error', reject) }),
          onExit: cb => { launched.once('close', (code, signal) => { void cb(code, signal) }) }, kill: () => launched.kill('SIGTERM'),
          isRunning: () => launched.exitCode === null && launched.signalCode === null }
      } })
    try {
      expect(await tools.call('room_spawn', { tag: 'real-outside', task: 'x', dir: other, allowOutside: true })).toContain('spawned real-outside')
      const result = await tools.call('room_collect', { tag: 'real-outside', discard: true })
      expect(result).toContain(`stopped real-outside; kept ${other}`)
      expect(child?.signalCode).toBe('SIGTERM')
      expect(await workerByTag(dir, 'real-outside')).toBeUndefined()
      expect(readFileSync(join(other, 'f.txt'), 'utf8')).toBe('outside changes\n')
      expect(execFileSync('git', ['-C', other, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(head)
      expect(execFileSync('git', ['-C', other, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('existing')
    } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await tools.shutdown() }
  })

  it('room_spawn where=local from a team room refuses another repository before launch', async () => {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x' }); local.a.setMeta({ repo: 'x' })
    let session: Session | null = { ...fakeSession(team.a, lead, false), roomName: 'github.com/rohanz/x',
      roomUrl: 'wss://team.example/github.com%2Frohanz%2Fx' } as Session
    const joins: string[] = [], specs: SpawnSpec[] = []
    const tools = createTools({ getSession: () => session, setSession: s => { session = s }, cwd: dir,
      join: async options => { joins.push(options.server ?? ''); return fakeSession(local.a, lead) }, leave: async () => {},
      spawner: spec => { specs.push(spec); return { pid: 99, started: Promise.resolve(), onExit: () => {}, kill: () => true } } })
    const outside = mkdtempSync(join(tmpdir(), 'room-team-to-local-outside-'))
    scratchRepos.push(outside)
    execFileSync('git', ['-C', outside, 'init', '-q', '-b', 'main'])
    writeFileSync(join(outside, 'f.txt'), 'x\n')
    execFileSync('git', ['-C', outside, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'])
    execFileSync('git', ['-C', outside, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    try {
      const reply = await tools.call('room_spawn', { tag: 'far', task: 'x', dir: outside, allowOutside: true, where: 'local' })
      expect(reply).toContain('another repository; a worker there cannot join this local room')
      expect(joins).toEqual(['local'])
      expect(specs).toEqual([])
      expect((await (await registryForDir(dir)).reserved('far'))).toBeUndefined()
    } finally { await tools.shutdown() }
  })
  it('refuses a supplied lead checkout before writing intent or starting a worker (S3)', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    let ls: Session | null = fakeSession(a, lead)
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir,
      spawner: () => { throw new Error('should not spawn') } })
    const reply = await tools.call('room_spawn', { tag: 'existing', task: 'x', dir, host: 'codex' })
    expect(reply).toContain('not an owned Room worktree')
    expect(existsSync(dir)).toBe(true)
    const registry = await registryForDir(dir)
    expect((await registry.reserved('existing'))).toBeUndefined()
    expect((await registry.occupancy())).toBe(0)
  })
  it('refuses a retry subdirectory and names the recorded checkout root', async () => {
    const { repo, head } = realRepo(), t = setupLead(repo, head)
    expect(await t.leadTools.call('room_spawn', { tag: 'owner', task: 'x' })).toContain('spawned owner')
    const registry = await registryForDir(repo), owner = (await registry.reserved('owner'))!
    const subdir = join(owner.dir, 'src')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(subdir)
    expect(await t.leadTools.call('room_spawn', { tag: 'retry', task: 'x', dir: subdir }))
      .toContain(`dir must name the recorded worker checkout root ${realpathSync(owner.dir)}`)
    expect(await registry.reserved('retry')).toBeUndefined()
    expect(t.specs).toHaveLength(1)
  })

  it('journals creation only after its own Git worktree add succeeds', async () => {
    const { repo, git } = realRepo()
    const prepared = await prepareWorktree(repo, 'witnessed', 'rohanz', { carry: false, onStep: async (step, facts) => {
      if (facts.created || facts.branchCreated) {
        expect(existsSync(join(repo, '.room/workers/witnessed/.git'))).toBe(true)
        expect(git('-C', join(repo, '.room/workers/witnessed'), 'branch', '--show-current')).toBe('room/witnessed')
      }
      if (step === 'plan') expect(facts.created).not.toBe(true)
    } })
    expect(prepared.created).toBe(true)
  })

  it('does not remove a checkout that appears after preparation is planned but before Git add', async () => {
    const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
    const command = registry.command.bind(registry), orphan = join(repo, '.room/workers/raced-plan')
    const spawn = vi.fn(() => { throw new Error('must not launch') })
    const tools = createTools({ getSession: () => t.session, setSession: () => {}, cwd: repo, spawner: spawn })
    vi.spyOn(registry, 'command').mockImplementation(async (...args) => {
      const result = await command(...args)
      if (args[1].type === 'prepare-step' && args[1].step === 'plan') {
        git('worktree', 'add', '-q', '-b', 'room/raced-plan', orphan)
        writeFileSync(join(orphan, 'precious.txt'), 'keep this')
      }
      return result
    })
    expect(await tools.call('room_spawn', { tag: 'raced-plan', task: 'x' })).toContain('error:')
    expect(readFileSync(join(orphan, 'precious.txt'), 'utf8')).toBe('keep this')
    expect((await registry.reserved('raced-plan'))?.prep.created).not.toBe(true)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not reuse creation authority after removing a checkout for a snapshot retry', async () => {
    const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
    const orphan = join(repo, '.room/workers/retry-race'), command = registry.command.bind(registry)
    let committed = false, replaced = false
    vi.spyOn(registry, 'command').mockImplementation(async (...args) => {
      const result = await command(...args)
      if (!committed && args[1].type === 'prepare-step' && args[1].step === 'worktree' && args[1].facts.created) {
        committed = true
        writeFileSync(join(repo, 'modified.txt'), 'new lead commit')
        git('add', 'modified.txt'); git('commit', '-qm', 'lead moved during carry')
      }
      return result
    })
    const gitRead = workerBaseline.boundedGitSync
    vi.spyOn(workerBaseline, 'boundedGitSync').mockImplementation((...args) => {
      const result = gitRead(...args)
      if (!replaced && args[1].includes('worktree') && args[1].includes('remove') && args[1].includes(orphan)) {
        replaced = true
        git('worktree', 'add', '-q', '-b', 'user-replacement', orphan)
        writeFileSync(join(orphan, 'precious.txt'), 'replacement work')
      }
      return result
    })
    const spawn = vi.fn(() => { throw new Error('must not launch') })
    const tools = createTools({ getSession: () => t.session, setSession: () => {}, cwd: repo, spawner: spawn })
    expect(await tools.call('room_spawn', { tag: 'retry-race', task: 'x' })).toContain('error:')
    expect(replaced).toBe(true)
    expect(existsSync(join(orphan, 'precious.txt'))).toBe(true)
    expect(readFileSync(join(orphan, 'precious.txt'), 'utf8')).toBe('replacement work')
    expect((await registry.reserved('retry-race'))?.prep.created).not.toBe(true)
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([false, true])('keeps the existing outside non-Git directory rule (Room namespace: %s)', async roomPath => {
    const { repo, head } = realRepo(), { repo: other } = realRepo(), t = setupLead(repo, head)
    const target = roomPath ? join(other, '.room/workers/unrecorded') : join(other, 'user-folder')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(target, { recursive: true })
    // Remove Git metadata so this is definitely not inside any worktree.
    rmSync(join(other, '.git'), { recursive: true, force: true })
    writeFileSync(join(target, 'precious.txt'), 'user work')
    delete t.session!.local
    const reply = await t.leadTools.call('room_spawn', { tag: 'plain', task: 'x', dir: target, allowOutside: true })
    if (roomPath) {
      expect(reply).toContain('Room has no live record')
      expect(t.specs).toHaveLength(0)
    } else {
      expect(reply).toContain('spawned plain')
      const registry = await registryForDir(repo), record = (await registry.reserved('plain'))!
      expect(record).toMatchObject({ outside: true, capabilities: { collect: 'none' }, prep: { created: false } })
      t.exits[0](0)
      await vi.waitFor(async () => expect((await workerByTag(repo, 'plain'))?.status).toBe('done'))
      expect(await t.leadTools.call('room_collect', { tag: 'plain', discard: true })).toContain(`kept ${target}`)
    }
    expect(readFileSync(join(target, 'precious.txt'), 'utf8')).toBe('user work')
  })

  it('keeps an outside user checkout on an unborn branch non-owning', async () => {
    const { repo, head } = realRepo(), other = realRepo(), t = setupLead(repo, head)
    other.git('checkout', '--orphan', 'user-unborn')
    delete t.session!.local
    expect(await t.leadTools.call('room_spawn', { tag: 'unborn', task: 'x', dir: other.repo, allowOutside: true }))
      .toContain('spawned unborn')
    expect(await (await registryForDir(repo)).reserved('unborn')).toMatchObject({ outside: true, capabilities: { collect: 'none' } })
  })

  it('refuses an outside Room worker directory that inherits an ordinary parent checkout', async () => {
    const { repo, head } = realRepo(), other = realRepo(), t = setupLead(repo, head)
    const target = join(other.repo, '.room/workers/unrecorded')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'precious.txt'), 'keep me')
    delete t.session!.local
    expect(await t.leadTools.call('room_spawn', { tag: 'parent-checkout', task: 'x', dir: target, allowOutside: true }))
      .toContain('Room has no live record')
    expect(t.specs).toHaveLength(0)
    expect(readFileSync(join(target, 'precious.txt'), 'utf8')).toBe('keep me')
  })

  it.each(['lead on room branch', 'moved inside checkout'] as const)('keeps the existing inside-directory refusal text (%s)', async kind => {
    const { repo, head, git } = realRepo(), t = setupLead(repo, head)
    let target = repo
    if (kind === 'lead on room branch') git('checkout', '-q', '-b', 'room/user-lead')
    else { target = join(repo, 'moved'); git('worktree', 'add', '-q', '-b', 'room/moved', target) }
    expect(await t.leadTools.call('room_spawn', { tag: 'inside', task: 'x', dir: target }))
      .toBe(`error: ${target} is not an owned Room worktree for inside; supply its .room/workers/inside checkout or omit dir`)
    expect(t.specs).toHaveLength(0)
  })

  it('collects the new worker after an abandoned record reused its tag (F-M4)', async () => {
    const t = setupLead()
    const registry = await registryForDir(dir)
    const abandoned: WorkerRecord = {
      v: 1, id: 'w_000_abandoned', tag: 'money', name: 'rohanz+money', mode: 'here', room: t.session!.roomName,
      lead: { participant: 'rohanz', room: t.session!.roomName, instance: registry.instance },
      host: 'codex', budget: { threads: 1, memGb: 1, nice: 10 }, share: 'intent', task: 'old',
      dir: join(dir, '.room/workers/money'), outside: false, branch: 'room/money', prep: { step: 'plan' },
      capabilities: { resume: true, signal: true, collect: 'delta' }, phase: 'intent',
      runs: [{ n: 1, mode: 'fresh', intentAt: 1, nonce: 'old', busFrontier: 0, promptMsgIds: [], launcher: registry.instance, logStart: 0 }],
      createdAt: 1, seq: 1,
    }
    await registry.writeIntent(abandoned)
    await registry.abandonPreparation(abandoned.id)
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'new', host: 'codex' })).toContain('spawned money')
    const current = (await registry.reserved('money'))!
    expect(current.id).not.toBe(abandoned.id)
    t.exits[0](0)
    await vi.waitFor(async () => expect((await workerByTag(dir, 'money'))?.status).toBe('done'), { timeout: 15_000 })
    expect(await t.leadTools.call('room_collect', { tag: 'money', discard: true })).toContain('discarded money')
  })
  it.each(['bare', 'same', 'other'] as const)('does not relaunch a preexisting Room checkout (%s)', async mode => {
    const { repo, head, git } = realRepo()
    const prepared = await prepareWorktree(repo, 'same', 'rohanz')
    const t = setupLead(repo, head)
    writeFileSync(join(repo, 'lead-only.txt'), 'lead edit')
    writeFileSync(join(prepared.dir, 'modified.txt'), 'orphan tracked edit\n')
    writeFileSync(join(prepared.dir, 'orphan-only.txt'), 'orphan untracked edit\n')
    const registry = await registryForDir(repo)
    expect(await registry.reserved('same')).toBeUndefined()
    const before = git('show-ref')
    const reply = await t.leadTools.call('room_spawn', { tag: mode === 'other' ? 'other' : 'same', task: 'inspect',
      ...(mode !== 'bare' ? { dir: prepared.dir } : {}), host: 'codex', model: 'worker-model' })
    if (mode === 'bare') expect(reply).toContain(`${join('.room', 'workers', 'same')} already exists and Room has no record of creating it`)
    else {
      expect(reply).toContain(`worktree ${realpathSync(prepared.dir)}`)
      expect(reply).toContain('branch room/same')
      expect(reply).toContain('Room has no live record')
      expect(reply).toContain('git worktree remove')
      expect(reply).toContain('git branch -D')
      expect(reply).toContain('choose another tag')
    }
    expect(t.specs).toHaveLength(0)
    expect(await registry.reserved('same')).toBeUndefined()
    expect(requireWorkerInventory(await registry.list())).toEqual([])
    expect(existsSync(join(registry.root, 'tags', 'same.json'))).toBe(false)
    expect(existsSync(join(repo, '.room/workers/same.log'))).toBe(false)
    expect(existsSync(join(prepared.dir, 'lead-only.txt'))).toBe(false)
    expect(readFileSync(join(prepared.dir, 'modified.txt'), 'utf8')).toBe('orphan tracked edit\n')
    expect(readFileSync(join(prepared.dir, 'orphan-only.txt'), 'utf8')).toBe('orphan untracked edit\n')
    expect(git('show-ref')).toBe(before)
  })
  it('refuses before writing intent when the supplied Git worktree cannot be inspected', async () => {
    const { repo, head } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
    const readGit = workerBaseline.boundedGitSync
    vi.spyOn(workerBaseline, 'boundedGitSync').mockImplementation((dir, args, options) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') throw new Error('cannot read Git worktree inventory')
      return readGit(dir, args, options)
    })
    expect(await t.leadTools.call('room_spawn', { tag: 'uncertain', task: 'x', dir: repo })).toContain('cannot read Git worktree inventory')
    expect(t.specs).toHaveLength(0)
    expect(requireWorkerInventory(await registry.list())).toEqual([])
    expect(existsSync(join(registry.root, 'tags', 'uncertain.json'))).toBe(false)
    expect(existsSync(join(repo, '.room/workers/uncertain'))).toBe(false)
  })

  it.each(['path', 'branch'] as const)('refuses an unrecorded checkout occupying only the canonical %s', async occupied => {
    const { repo, head, git } = realRepo()
    const target = join(repo, occupied === 'path' ? '.room/workers/same' : 'moved-worker')
    git('worktree', 'add', '-q', '-b', occupied === 'path' ? 'different-branch' : 'room/same', target)
    const t = setupLead(repo, head), registry = await registryForDir(repo)
    const refs = git('show-ref')
    expect(await t.leadTools.call('room_spawn', { tag: 'same', task: 'x' })).toContain('Room has no record of creating it')
    expect(t.specs).toHaveLength(0)
    expect(requireWorkerInventory(await registry.list())).toEqual([])
    expect(existsSync(join(registry.root, 'tags', 'same.json'))).toBe(false)
    expect(git('show-ref')).toBe(refs)
    expect(existsSync(target)).toBe(true)
  })

  it('leaves an unrecorded checkout and its files alone during collect, discard, state, reconciliation and hourly retention', async () => {
    const { repo, head, git } = realRepo()
    const prepared = await prepareWorktree(repo, 'same', 'rohanz')
    writeFileSync(join(prepared.dir, 'modified.txt'), 'orphan tracked edit\n')
    writeFileSync(join(prepared.dir, 'orphan-only.txt'), 'orphan untracked edit\n')
    const t = setupLead(repo, head), registry = await registryForDir(repo)
    const refs = git('show-ref')
    expect(await t.leadTools.call('room_state', {})).not.toContain('workers (1):')
    // Even a surviving room archive cannot grant local ownership of this checkout.
    t.a.doc.getArray('retiredWorkers').push([{ id: 'w_missing', tag: 'same', name: 'rohanz+same', lead: 'rohanz',
      host: 'codex', task: 'old', summary: 'old', outcome: 'done', finishedAt: 1, retiredAt: 1,
      keptWorktree: prepared.dir }])
    for (const args of [{ tag: 'same' }, { tag: 'same', mode: 'copy', paths: ['modified.txt'] },
      { tag: 'same', discard: true }, { tag: 'same', discard: true, force: true }]) {
      expect(await t.leadTools.call('room_collect', args)).toMatch(/no (?:worker same owned by you|local registry record)/)
    }
    expect(await t.leadTools.call('room_state', {})).toContain('same (done, kept: worktree at')
    await registry.reconcile()
    expect(await registry.pruneRetired(0)).toEqual([])
    const rooms = new Rooms({ primary: () => t.session, setPrimary: () => {}, attach: () => ({ stop() {} }),
      probe: () => undefined, listCwdProcesses: () => [] })
    rooms.track(t.session!)
    try { await rooms.autoRetire() } finally { rooms.remove(t.session!) }
    expect(requireWorkerInventory(await registry.list())).toEqual([])
    expect(t.a.retiredWorkers()[0].keptWorktree).toBe(prepared.dir)
    expect(readFileSync(join(prepared.dir, 'modified.txt'), 'utf8')).toBe('orphan tracked edit\n')
    expect(readFileSync(join(prepared.dir, 'orphan-only.txt'), 'utf8')).toBe('orphan untracked edit\n')
    expect(readFileSync(join(repo, 'modified.txt'), 'utf8')).toBe('before\n')
    expect(existsSync(join(repo, 'orphan-only.txt'))).toBe(false)
    expect(git('show-ref')).toBe(refs)
  })

  it('leaves a checkout intact when retention prunes an ended record without a kept-worktree marker', async () => {
    const { repo, head } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
    expect(await t.leadTools.call('room_spawn', { tag: 'pruned', task: 'old' })).toContain('spawned pruned')
    t.exits[0](0)
    await vi.waitFor(async () => expect((await workerByTag(repo, 'pruned'))?.status).toBe('done'))
    const record = (await registry.reserved('pruned'))!
    // Fault injection: retention can remove an ended record lacking a kept marker.
    // It owns only those facts and never removes the surviving checkout itself.
    await mutateWorkerFixture(registry, record.id, old => ({ ...old, phase: 'abandoned', seq: old.seq + 1 }))
    writeFileSync(join(record.dir, 'orphan-only.txt'), 'retain me')
    expect((await registry.pruneRetired(0)).map(record => record.id)).toEqual([record.id])
    expect(await registry.reserved('pruned')).toBeUndefined()
    expect(readFileSync(join(record.dir, 'orphan-only.txt'), 'utf8')).toBe('retain me')
    expect(await t.leadTools.call('room_spawn', { tag: 'pruned', task: 'x', dir: record.dir })).toContain('Room has no live record')
    expect(t.specs).toHaveLength(1)
  })

  it('does not recover ownership after the registry directory is deleted and reopened', async () => {
    const { repo, head } = realRepo(), t = setupLead(repo, head)
    expect(await t.leadTools.call('room_spawn', { tag: 'lost', task: 'x' })).toContain('spawned lost')
    t.exits[0](0)
    const root = (await registryForDir(repo)).root
    await vi.waitFor(async () => expect((await workerByTag(repo, 'lost'))?.status).toBe('done'))
    await closeRegistryForDir(repo)
    rmSync(root, { recursive: true, force: true })
    const registry = await registryForDir(repo)
    expect(await registry.reserved('lost')).toBeUndefined()
    expect(await t.leadTools.call('room_spawn', { tag: 'lost', task: 'x', dir: join(repo, '.room/workers/lost') }))
      .toContain('Room has no live record')
    expect(t.specs).toHaveLength(1)
    expect(requireWorkerInventory(await registry.list())).toEqual([])
  })
  it('gives a new worktree its own workspace packages in node_modules, or tells the lead and the worker it could not', async () => {
    const linked = workspaceRepo()
    scratchRepos.push(linked.repo)
    const t = setupLead(linked.repo, linked.head)
    expect(await t.leadTools.call('room_spawn', { tag: 'deps', task: 'change a' })).toContain('node_modules: links to your install, with workspace packages @fx/a, @fx/b')
    const worker = join(linked.repo, '.room', 'workers', 'deps')
    expect(realpathSync(join(worker, 'node_modules', '@fx', 'a'))).toBe(join(worker, 'packages', 'a'))
    expect(t.specs[0].args.join(' ')).toContain("node_modules here links the lead's installed packages")
    const bare = workspaceRepo({ lockfile: false })
    scratchRepos.push(bare.repo)
    const u = setupLead(bare.repo, bare.head)
    const warning = "cross-package tests in this worktree would run the lead's code for @fx/a, @fx/b"
    expect(await u.leadTools.call('room_spawn', { tag: 'nodeps', task: 'change a' })).toContain(`warning: ${warning}`)
    expect(u.specs[0].args.join(' ')).toContain(warning)
  })
})
