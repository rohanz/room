import { base, createTools, dir, fakeSession, lead, ownedLegacyWorker, pair, realRepo, scratchRepos, setupLead } from './workers-fixture.js'
import { setParticipantBase } from '@room/shared/testing'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../src/session.js'
import { prepareWorktree } from '../src/worker-git.js'
import { parsePsLstartUtc, probeProcess, workerProcessOwnership, type SpawnSpec } from '../src/worker-process.js'
import { registryForDir } from '../src/worker-registry.js'
import type { WorkerRecord } from '../src/worker-status.js'
import { finishFixtureProcess, fixtureLiveness, fixtureProcess } from './fixtures/process-liveness.js'
import { workspaceRepo } from './fixtures/workspace-repo.js'
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
    expect(workerProcessOwnership(-1, rec, () => info)).toBe('not-ours')
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
    const before = { ...workerByTag(dir, 'erroring')! }
    const post = t.session.post
    vi.spyOn(t.session, 'post').mockImplementation(((...args: Parameters<typeof post>) => {
      if ((args[1] as { type?: string }).type === 'note') throw new Error('note failed')
      return post(...args)
    }) as typeof post)
    await t.leadTools.shutdown()
    expect(t.killed).toEqual([1])
    // §9: the durable stop is mirrored even though the note failed; §6 row 8 keeps it running.
    expect(workerByTag(dir, 'erroring')).toEqual({ ...before, stopReason: 'lead-session-ended' })
    expect((await registryForDir(dir)).read(before.id!)?.stop?.reason).toBe('lead-session-ended')
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
    expect(workerByTag(dir, 'ghost')?.status).toBe('running') // nothing was signalled, so nothing changed
  })

  it('shutdown reports an unreadable live pid and preserves the running record', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
    await ownedLegacyWorker(a, 'unknown', 'running', process.pid)
    let session: Session | null = fakeSession(a, lead)
    const tools = createTools({ getSession: () => session, setSession: s => { session = s }, cwd: dir, probe: () => ({}), leave: async () => {} })
    await tools.shutdown()
    expect(workerByTag(dir, 'unknown')?.status).toBe('running')
    expect((await registryForDir(dir)).list().find(record => record.tag === 'unknown')?.stop?.reason).toBe('lead-session-ended')
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
    expect(workerByTag(dir, 'finished')?.status).toBe(status)
  })

  it('a registry transition with no mirror at its call site (reconcile, another writer) still reaches the Worker doc', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    const id = workerByTag(dir, 'a')!.id
    expect(workerByTag(dir, 'a')?.status).toBe('running')
    const registry = await registryForDir(dir)
    finishFixtureProcess(workerByTag(dir, 'a')!.pid)
    await registry.writeExit(id, { run: 1, code: 3, witnessed: true, at: Date.now() })
    // §6 row 14: a witnessed nonzero exit is `failed`.
    expect(registry.status(id)?.status).toBe('failed')
    expect(workerByTag(dir, 'a')).toMatchObject({ status: 'failed', exitCode: 3 })
  })

  it('room_leave refuses while workers run, force dismisses them; shutdown dismisses too', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    const refused = await t.leadTools.call('room_leave', {})
    expect(refused).toContain('error: 1 worker(s) still running: a')
    expect(workerByTag(dir, 'a')?.status).toBe('running')
    expect(t.killed).toHaveLength(0)
    const left = await t.leadTools.call('room_leave', { force: true })
    expect(left).toContain('left local/x')
    expect(t.killed).toHaveLength(1)
    // §9 / §6 row 8: stopping until the exit is witnessed.
    expect(workerByTag(dir, 'a')).toMatchObject({ status: 'running', stopReason: 'lead-session-ended' })
    expect(t.a.messages().some(m => m.type === 'note' && /dismissed worker a .*the lead left/.test((m as { text: string }).text))).toBe(true)
    // shutdown path
    const t2 = setupLead()
    await t2.leadTools.call('room_spawn', { tag: 'b', task: 'y' })
    await t2.leadTools.shutdown()
    expect(t2.killed).toHaveLength(1)
    expect(workerByTag(dir, 'b')).toMatchObject({ status: 'running', stopReason: 'lead-session-ended' })
    t2.exits[0](null)
    await vi.waitFor(async () => {
      const registry = await registryForDir(dir)
      const record = registry.list().find(record => record.tag === 'b')!
      expect(registry.exits(record.id)).toMatchObject([{ code: null, witnessed: true }])
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
    expect(workerByTag(dir, 'nope')).toBeUndefined()
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
      expect((await registryForDir(dir)).reserved('far')).toBeUndefined()
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
  it('keeps allowOutside for a team room', async () => {
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
    const tools = createTools({ getSession: () => session, setSession: s => { session = s }, cwd: dir,
      spawner: spec => { specs.push(spec); return { pid: 4242, started: Promise.resolve(), onExit: () => {}, kill: () => true } },
      probe: () => undefined })
    expect(await tools.call('room_spawn', { tag: 'far', task: 'x', dir: other })).toContain('pass allowOutside=true')
    expect(await tools.call('room_spawn', { tag: 'far', task: 'x', dir: other, allowOutside: true })).toContain('spawned far')
    expect(specs[0].cwd).toBe(other)
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
      expect((await registryForDir(dir)).reserved('far')).toBeUndefined()
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
    expect(registry.reserved('existing')).toBeUndefined()
    expect(registry.occupancy()).toBe(0)
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
    const current = registry.reserved('money')!
    expect(current.id).not.toBe(abandoned.id)
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')?.status).toBe('done'), { timeout: 15_000 })
    expect(await t.leadTools.call('room_collect', { tag: 'money', discard: true })).toContain('discarded money')
  })
  it('does not relaunch a preexisting Room checkout as a new supplied-dir worker', async () => {
    // The one-time migration scan must see the checkout. Other tests open and close the
    // shared fixture registry, so use a fresh repository for this startup assertion.
    const { repo, head } = realRepo()
    const prepared = await prepareWorktree(repo, 'same', 'rohanz')
    const t = setupLead(repo, head)
    writeFileSync(join(repo, 'lead-only.txt'), 'lead edit')
    try {
      const registry = await registryForDir(repo)
      await vi.waitFor(() => expect(registry.reserved('same')).toMatchObject({
        tag: 'same', phase: 'active', runs: [{ launch: { outcome: 'imported' } }],
      }), { timeout: 15_000 })
      const reply = await t.leadTools.call('room_spawn', { tag: 'same', task: 'inspect', dir: prepared.dir, host: 'codex', model: 'worker-model' })
      expect(reply).toContain('tag in use: same')
      expect(t.specs).toHaveLength(0)
    } finally { rmSync(join(repo, 'lead-only.txt'), { force: true }) }
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
