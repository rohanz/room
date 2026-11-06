import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { cloneId } from '@room/relay'
import { privateStateDirectory } from '@room/local-state/private-state'
import { probeProcessNow } from '@room/local-state/process'
import { inspectDaemonCutover, requireDaemonRuntime, daemonCutoverRows, resolveDaemonCutover, cutoverResolveCommand } from '../src/daemon-cutover.js'
import * as cutover from '../src/daemon-cutover.js'
import * as doctor from '../src/doctor.js'
import { LOCAL, joinSession, writeSessionRecord } from '../src/session.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { createTools } from '../src/tools.js'
import { seedRegistryWorker } from './registry-fixture.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)) }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-cutover-')); roots.push(root)
  const clone = path.join(root, 'clone'), linked = path.join(root, 'linked worktree')
  fs.mkdirSync(clone)
  const git = (...args: string[]) => execFileSync('git', ['-C', clone, ...args], { stdio: 'ignore' })
  git('init'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-m', 'fixture')
  git('worktree', 'add', '-b', 'linked', linked)
  privateStateDirectory(path.join(clone, '.git', 'room'))
  return { root, clone, linked, common: path.join(clone, '.git') }
}
const identity = (pid: number) => ({ pid, startTime: `start-${pid}`, executable: 'node' })
const probe = (pid: number) => pid === 100 || pid === 200 ? identity(pid) : undefined
const noHealth = async () => undefined
const inspectOptions = { probe, authenticate: noHealth }
function owner(common: string, pid = 100, runtime?: string) {
  write(path.join(common, 'room/relay.json'), { schema: 2, pid, port: 4402, key: 'private-test-key', ...(runtime ? { runtime } : {}) })
  write(path.join(common, 'room/hub/authority.lock'), { ...identity(pid), nonce: 'authority', sessionId: 'owner' })
}

describe('drained daemon cutover', () => {
  it('remembers exact drained bytes, but judges changed/new records and old-owner takeover', async () => {
    const { common } = fixture()
    owner(common, 300)
    const file = path.join(common, 'room/sessions/old/mcp.json')
    write(file, identity(400))
    await requireDaemonRuntime(common, inspectOptions)
    const uncertain = { ...inspectOptions, probe: (pid: number) => pid === 400 ? {} : probe(pid) }
    const state = await inspectDaemonCutover(common, uncertain)
    expect(state.blocked).toBe(false)
    expect(state.clients[0].skipped).toBe(true)
    expect(daemonCutoverRows(state).join('\n')).toContain('INFO  cutover mcp records: 1 not blocking (1 previously drained)')
    await requireDaemonRuntime(common, uncertain)
    write(file, { ...identity(400), changed: true })
    expect((await inspectDaemonCutover(common, uncertain)).blocked).toBe(true)
    write(file, identity(400))
    write(path.join(common, 'room/sessions/new/mcp.json'), identity(200))
    expect((await inspectDaemonCutover(common, uncertain)).blocked).toBe(true)
    fs.rmSync(path.join(common, 'room/sessions/new'), { recursive: true })
    owner(common, 100)
    expect((await inspectDaemonCutover(common, uncertain)).blocked).toBe(true)
    owner(common, 300)
    const drain = path.join(common, 'room/daemon-cutover.json')
    const old = JSON.parse(fs.readFileSync(drain, 'utf8'))
    delete old.drainedClients
    write(drain, old)
    expect((await inspectDaemonCutover(common, uncertain)).blocked).toBe(true)
  })
  it('re-judges a drained worker when its run report changes, and never skips a live process', async () => {
    const { common } = fixture()
    owner(common, 300)
    const worker = path.join(common, 'room/registry/workers/w1.json')
    write(worker, { id: 'w1', host: 'claude', phase: 'active', runs: [{ n: 1, mode: 'fresh', launch: { outcome: 'launched', pid: 400, process: identity(400) } }] })
    await requireDaemonRuntime(common, inspectOptions)
    const report = path.join(common, 'room/registry/runs/w1/1.report.json')
    write(report, { hostProcess: identity(200) })
    const state = await inspectDaemonCutover(common, inspectOptions)
    expect(state.clients.find(c => c.kind === 'worker')).toMatchObject({ liveness: 'alive' })
    expect(state.clients.find(c => c.kind === 'worker')?.skipped).toBeUndefined()
    // The worker record and report are unchanged since a second drain, but the process now reads alive: it blocks.
    fs.rmSync(report)
    await requireDaemonRuntime(common, inspectOptions)
    const revived = await inspectDaemonCutover(common, { ...inspectOptions, probe: (pid: number) => pid === 400 ? identity(400) : probe(pid) })
    expect(revived.clients.find(c => c.kind === 'worker')).toMatchObject({ liveness: 'alive' })
    expect(revived.blocked).toBe(true)
  })
  it('shows cutover rows in scope diagnostics after the join gate refuses', async () => {
    const { common, clone } = fixture()
    write(path.join(common, 'room/sessions/old/mcp.json'), { pid: process.ppid })
    await expect(joinSession({ dir: clone, server: LOCAL, name: 'Ada' })).rejects.toThrow('drain required')
    const report = vi.spyOn(doctor, 'runDoctor').mockResolvedValue('WARN  fixture')
    const tools = createTools({ cwd: clone, getSession: () => null, setSession: () => {} })
    try { expect(await tools.call('room_state', { check: true })).toContain('FAIL  local daemon cutover: drain required') }
    finally { report.mockRestore(); await tools.shutdown() }
  })
  it.skipIf(process.platform === 'win32')('repairs the 0.17.33 directory tree on use and completes cutover', async () => {
    const { common } = fixture(), room = path.join(common, 'room'), session = path.join(room, 'sessions', 'old-session')
    fs.mkdirSync(session, { recursive: true })
    const dirs = [room, path.dirname(session), session]
    for (const dir of dirs) fs.chmodSync(dir, 0o755)
    await requireDaemonRuntime(common, inspectOptions)
    // Session publication validates and repairs its ancestors even when all already exist.
    privateStateDirectory(session)
    expect(dirs.map(dir => fs.statSync(dir).mode & 0o777)).toEqual([0o700, 0o700, 0o700])
    expect(fs.existsSync(path.join(room, 'daemon-cutover.json'))).toBe(true)
  })
  it('initializes private Room state before the first drain record and preserves it on reuse', async () => {
    const { common } = fixture()
    const room = path.join(common, 'room')
    fs.rmSync(room, { recursive: true })
    await requireDaemonRuntime(common, inspectOptions)
    const file = path.join(room, 'daemon-cutover.json')
    const before = fs.readFileSync(file, 'utf8')
    // The daemon uses this same initializer on the directory preflight created.
    expect(() => privateStateDirectory(room)).not.toThrow()
    await requireDaemonRuntime(common, inspectOptions)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
  it('inventories the common directory from linked worktrees, both hosts, nested sessions, bridges and stale worker records without mutation', async () => {
    const { common, clone, linked } = fixture()
    owner(common)
    for (const [sid, host, pid, cwd] of [['lead', 'claude', 100, clone], ['nested-bridge', 'codex', 200, linked], ['stale', 'claude', 300, linked]] as const) {
      write(path.join(common, 'room/sessions', sid, 'session.json'), { session_id: sid, host, cwd, hostPid: pid, chain: [identity(pid)] })
      write(path.join(common, 'room/sessions', sid, 'mcp.json'), { ...identity(pid), port: 123, build: '0.17.32' })
    }
    write(path.join(common, 'room/registry/workers/old-worker.json'), { id: 'old-worker', tag: 'old-worker', name: 'worker', host: 'codex', dir: linked, phase: 'active', runs: [{ n: 1, launch: { outcome: 'launched', pid: 300, process: identity(300) } }] })
    const before = fs.readFileSync(path.join(common, 'room/hub/authority.lock'), 'utf8')
    const state = await inspectDaemonCutover(common, inspectOptions)
    expect(state.worktrees).toEqual([clone, linked].map(v => fs.realpathSync(v)))
    expect(state.clients.filter(c => c.liveness === 'alive').map(c => c.host)).toContain('codex')
    expect(state.clients.find(c => c.kind === 'worker')).toMatchObject({ label: 'worker', liveness: 'dead' })
    expect(state.manual.join(' ')).toMatch(/viewers.*nested hosts.*bridges/)
    expect(state.blocked).toBe(true)
    expect(fs.readFileSync(path.join(common, 'room/hub/authority.lock'), 'utf8')).toBe(before)
    expect(fs.existsSync(path.join(common, 'room/daemon-cutover.json'))).toBe(false)
  })
  it('refuses a live legacy owner even without lead, naming pid, port and drain/save/exit remedy', async () => {
    const { common } = fixture(); owner(common)
    await expect(requireDaemonRuntime(common, inspectOptions)).rejects.toThrow(/pid 100, port 4402/)
    await expect(requireDaemonRuntime(common, inspectOptions)).rejects.toThrow(/Drain\/save\/exit/)
    expect(fs.existsSync(path.join(common, 'room/daemon-cutover.json'))).toBe(false)
  })
  it('does not trust a daemon stamp without authenticated runtime proof or reclaim unknown birth identity', async () => {
    const { common } = fixture(); owner(common, 100, 'daemon')
    const state = await inspectDaemonCutover(common, { probe: () => ({}), authenticate: noHealth })
    expect(state.owner?.liveness).toBe('unknown')
    expect(state.blocked).toBe(true)
    expect(daemonCutoverRows(state).join('\n')).toMatch(/Cannot authenticate daemon/)
  })
  it('names an unknown owner and its observed pid/port when listener health cannot identify it', async () => {
    const { common } = fixture(); owner(common)
    fs.rmSync(path.join(common, 'room/hub/authority.lock'))
    // A nonce proof alone does not establish a listener's clone/process/runtime identity.
    const options = { probe, authenticate: async () => ({ proven: true, health: { clone: cloneId(common), schema: 2, hub: 1 } }) }
    const state = await inspectDaemonCutover(common, options)
    expect(state.owner).toMatchObject({ pid: 100, port: 4402, liveness: 'unknown' })
    expect(state.blocked).toBe(true)
    expect(daemonCutoverRows(state)[0]).toContain('unknown owner: pid 100, port 4402')
    await expect(requireDaemonRuntime(common, options)).rejects.toThrow(/unknown owner: pid 100, port 4402/)
    expect(fs.existsSync(path.join(common, 'room/daemon-cutover.json'))).toBe(false)
  })
  it('completes cutover when sessions/ holds clone-wide files such as the idle-episode counter', async () => {
    // Regression (0.17.34-0.17.37): every sessions/ entry was read as a session directory, so the durable
    // idle-episode counter at sessions/idle-episode.json failed with ENOTDIR and blocked every real clone.
    const { common } = fixture(), room = path.join(common, 'room')
    write(path.join(room, 'sessions', 'idle-episode.json'), { max: 3 })
    write(path.join(room, 'sessions', 'old-session', 'session.json'), { session_id: 'old-session' })
    const state = await inspectDaemonCutover(common, inspectOptions)
    expect(state.issues.filter(issue => /idle-episode/.test(issue))).toEqual([])
    expect(state.clients.map(client => client.source)).not.toContain(path.join(room, 'sessions', 'idle-episode.json', 'session.json'))
    await requireDaemonRuntime(common, inspectOptions)
    expect(fs.existsSync(path.join(room, 'daemon-cutover.json'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(room, 'sessions', 'idle-episode.json'), 'utf8'))).toEqual({ max: 3 })
  })
  it.skipIf(process.platform === 'win32')('blocks on a symlinked session entry without following it, and writes no drain record', async () => {
    const { root, common } = fixture(), room = path.join(common, 'room')
    // The link target holds live legacy MCP evidence; following it would be needed to see the client.
    const elsewhere = path.join(root, 'elsewhere-session')
    write(path.join(elsewhere, 'mcp.json'), { ...identity(200) })
    write(path.join(elsewhere, 'session.json'), { session_id: 'linked', hostPid: 200, chain: [identity(200)] })
    fs.mkdirSync(path.join(room, 'sessions'), { recursive: true })
    fs.symlinkSync(elsewhere, path.join(room, 'sessions', 'linked'))
    const state = await inspectDaemonCutover(common, inspectOptions)
    expect(state.blocked).toBe(true)
    expect(state.issues).toContainEqual(expect.stringMatching(/sessions\/linked is a symlink/))
    await expect(requireDaemonRuntime(common, inspectOptions)).rejects.toThrow()
    expect(fs.existsSync(path.join(room, 'daemon-cutover.json'))).toBe(false)
  })
  it('records an unreadable session entry as a blocking issue and keeps inspecting', async () => {
    const { common } = fixture(), room = path.join(common, 'room')
    write(path.join(room, 'sessions', 'broken', 'session.json'), { session_id: 'broken' })
    write(path.join(room, 'sessions', 'fine', 'session.json'), { session_id: 'fine' })
    const real = fs.lstatSync
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target).endsWith(path.join('sessions', 'broken'))) throw Object.assign(new Error('injected'), { code: 'EACCES' })
      return (real as (...args: unknown[]) => fs.Stats)(target, ...rest)
    }) as typeof fs.lstatSync)
    try {
      const state = await inspectDaemonCutover(common, inspectOptions)
      expect(state.blocked).toBe(true)
      expect(state.issues).toContainEqual(expect.stringMatching(/sessions\/broken: EACCES/))
      expect(state.clients.some(client => client.label === 'fine')).toBe(true)
    } finally { spy.mockRestore() }
  })
  it('accepts a proven daemon and daemon-capable recorded clients', async () => {
    const { common } = fixture(); owner(common, 100, 'daemon')
    write(path.join(common, 'room/sessions/new/mcp.json'), { ...identity(200), runtime: 'daemon-client' })
    write(path.join(common, 'room/sessions/new/session.json'), { session_id: 'new', hostPid: 200, chain: [identity(200)] })
    const state = await inspectDaemonCutover(common, { probe, authenticate: async () => ({ proven: true, health: { clone: cloneId(common), pid: 100, runtime: 'daemon', release: 'D' } }) })
    expect(state.blocked).toBe(false)
    expect(state.owner).toMatchObject({ runtime: 'daemon', release: 'D' })
  })
  it('allows restart after save-first idle exit when the discovery PID is reused', async () => {
    const { common } = fixture()
    owner(common, 100, 'daemon')
    const file = path.join(common, 'room/relay.json')
    write(file, { ...JSON.parse(fs.readFileSync(file, 'utf8')), lead: identity(100) })
    // Idle shutdown saves the hub and releases authority, retaining discovery for restart.
    fs.rmSync(path.join(common, 'room/hub/authority.lock'))
    const authenticate = vi.fn(noHealth)
    const options = { probe: () => ({ ...identity(100), startTime: 'unrelated-process' }), authenticate }
    const state = await inspectDaemonCutover(common, options)
    expect(state.owner).toMatchObject({ liveness: 'dead', identity: identity(100) })
    expect(state.blocked).toBe(false)
    expect(authenticate).not.toHaveBeenCalled()
    await expect(requireDaemonRuntime(common, options)).resolves.toBeUndefined()
  })
  it.each([
    { pid: 200, startTime: 'start-200', executable: 'node' },
    { pid: 100, startTime: '', executable: 'node' },
    { pid: 100, startTime: 'start-100' },
  ])('refuses invalid discovery lead identity %j without deleting evidence', async lead => {
    const { common } = fixture(); owner(common, 100, 'daemon')
    const file = path.join(common, 'room/relay.json')
    write(file, { ...JSON.parse(fs.readFileSync(file, 'utf8')), lead })
    const before = fs.readFileSync(file, 'utf8')
    expect((await inspectDaemonCutover(common, inspectOptions)).issues.join(' ')).toMatch(/discovery.*identity/)
    await expect(requireDaemonRuntime(common, inspectOptions)).rejects.toThrow(/discovery/)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
  it('compares discovery birth identity with authority even when the PID matches', async () => {
    const { common } = fixture(); owner(common, 100, 'daemon')
    const file = path.join(common, 'room/relay.json')
    write(file, { ...JSON.parse(fs.readFileSync(file, 'utf8')), lead: { ...identity(100), startTime: 'previous-process' } })
    const state = await inspectDaemonCutover(common, inspectOptions)
    expect(state.blocked).toBe(true)
    expect(state.issues.join(' ')).toMatch(/disagrees with authority/)
  })
  it('does not let a dead daemon-client marker exempt a live legacy host', async () => {
    const { common } = fixture()
    write(path.join(common, 'room/sessions/old/mcp.json'), { ...identity(300), runtime: 'daemon-client' })
    write(path.join(common, 'room/sessions/old/session.json'), { session_id: 'old', host: 'claude', hostPid: 200, chain: [{ ...identity(200), executable: 'claude' }] })
    const state = await inspectDaemonCutover(common, { ...inspectOptions, probe: pid => pid === 200 ? { ...identity(pid), executable: 'claude' } : undefined })
    expect(state.blocked).toBe(true)
    expect(state.clients.find(c => c.kind === 'session')).toMatchObject({ pid: 200, runtime: 'legacy', liveness: 'alive' })
  })
  it('fails closed on malformed records without deleting them', async () => {
    const { common } = fixture()
    const file = path.join(common, 'room/sessions/bad/mcp.json'); write(file, {})
    fs.writeFileSync(file, '{')
    const state = await inspectDaemonCutover(common, inspectOptions)
    expect(state.blocked).toBe(true)
    expect(state.issues.join(' ')).toContain(file)
    expect(fs.readFileSync(file, 'utf8')).toBe('{')
  })
  it.each([
    { outcome: 'launched' },
    { outcome: 'launched', pid: '200', process: { pid: '200' } },
    { outcome: 'launched', pid: -1, process: { pid: null } },
    { outcome: 'ambiguous' },
    { outcome: 'imported', process: { pid: '200' } },
  ])('blocks worker process claims without a parsed identity: %j', async launch => {
    const { common } = fixture()
    const file = path.join(common, 'room/registry/workers/unknown.json')
    write(file, { id: 'unknown', name: 'unknown worker', phase: 'active', runs: [{ n: 1, launch }] })
    const before = fs.readFileSync(file, 'utf8')
    const state = await inspectDaemonCutover(common, inspectOptions)
    expect(state.blocked).toBe(true)
    expect(state.clients.find(c => c.kind === 'worker')).toMatchObject({ liveness: 'unknown' })
    expect(state.clients.find(c => c.kind === 'worker')?.bindingOnly).not.toBe(true)
    expect(daemonCutoverRows(state).join('\n')).toContain(fs.realpathSync(file))
    await expect(requireDaemonRuntime(common, inspectOptions)).rejects.toThrow(/process identity.*missing or malformed/)
    expect(fs.existsSync(path.join(common, 'room/daemon-cutover.json'))).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
  it.each(['room/sessions/invalid/session.json', 'room-session.json'])('blocks a non-numeric hostPid in %s', async location => {
    const { common } = fixture()
    const file = path.join(common, location)
    write(file, { session_id: 'invalid', hostPid: '200' })
    const state = await inspectDaemonCutover(common, inspectOptions)
    expect(state.blocked).toBe(true)
    expect(state.clients[0]).toMatchObject({ liveness: 'unknown' })
    expect(state.clients[0].bindingOnly).not.toBe(true)
    await expect(requireDaemonRuntime(common, inspectOptions)).rejects.toThrow(/process identity.*missing or malformed/)
    expect(daemonCutoverRows(state).join('\n')).toContain(fs.realpathSync(file))
    expect(fs.existsSync(path.join(common, 'room/daemon-cutover.json'))).toBe(false)
  })
  it('keeps legacy clients blocking after owner exit, but ignores provably stale birth records and records a completed drain', async () => {
    const { common } = fixture(); owner(common, 300)
    write(path.join(common, 'room/sessions/old/mcp.json'), identity(200))
    await expect(requireDaemonRuntime(common, inspectOptions)).rejects.toThrow(/cutover mcp/)
    await requireDaemonRuntime(common, { ...inspectOptions, probe: pid => pid === 200 ? { ...identity(pid), startTime: 'reused-pid' } : undefined })
    const record = JSON.parse(fs.readFileSync(path.join(common, 'room/daemon-cutover.json'), 'utf8'))
    expect(record).toMatchObject({ v: 1, clone: cloneId(common), deadOwner: identity(300) })
    expect(JSON.stringify(record)).not.toContain('private-test-key')
    owner(common, 100) // old binary took over after daemon crash: a past drain is no exemption
    await expect(requireDaemonRuntime(common, inspectOptions)).rejects.toThrow(/pid 100, port 4402/)
  })
  it('inventories binding-only files without treating them as live processes, and records the disregarded bindings', async () => {
    const { common } = fixture()
    const file = path.join(common, 'room-session.json')
    write(path.join(common, 'room/registry/workers/imported.json'), { id: 'imported', phase: 'active', runs: [{ n: 1, launch: { outcome: 'imported' } }] })
    write(file, { worker_id: 'retired-worker', host: 'codex', session_id: 'old' })
    const state = await inspectDaemonCutover(common, inspectOptions)
    expect(state.blocked).toBe(false)
    expect(daemonCutoverRows(state).join(' ')).toContain('binding only')
    await requireDaemonRuntime(common, inspectOptions)
    const record = JSON.parse(fs.readFileSync(path.join(common, 'room/daemon-cutover.json'), 'utf8'))
    expect(record.disregardedBindings).toEqual(['room/registry/workers/imported.json', 'room-session.json'])
  })
  it.each(['unbound', 'moved'] as const)('recognises the admitted current worker while its binding is %s, before the marker is published there', async binding => {
    const { common, linked } = fixture()
    const workerId = 'w_current'
    // Arbitration published before the final binding existed. Its next poll has not run yet.
    write(path.join(common, 'room/sessions/previous/mcp.json'), { ...identity(100), runtime: 'daemon-client' })
    if (binding === 'moved') write(path.join(common, 'room/sessions/current/session.json'), {
      session_id: 'current-thread', worker_id: workerId, host: 'codex', cwd: linked, hostPid: 200, chain: [identity(200)],
    })
    write(path.join(common, 'room/registry/workers/current.json'), { id: workerId, name: 'Ada+current', host: 'codex', dir: linked,
      phase: 'active', runs: [{ n: 1, launch: { outcome: 'launched', pid: 200, process: identity(200) } }] })
    write(path.join(common, 'room-session.json'), { worker_id: workerId, host: 'codex', hostPid: 200 })
    const options = { ...inspectOptions, currentPid: 100, currentWorkerId: workerId }
    const before = await inspectDaemonCutover(common, options)
    expect(before.blocked).toBe(false)
    expect(before.clients.find(c => c.kind === 'worker')).toMatchObject({ runtime: 'daemon-client', liveness: 'alive' })
    await expect(requireDaemonRuntime(common, options)).resolves.toBeUndefined()
    // The delayed marker changes no cutover decision.
    write(path.join(common, 'room/sessions/current/mcp.json'), { ...identity(100), runtime: 'daemon-client' })
    expect((await inspectDaemonCutover(common, options)).blocked).toBe(false)
    // Another process cannot infer this worker's runtime from an absent marker.
    fs.rmSync(path.join(common, 'room/sessions/current/mcp.json'))
    expect((await inspectDaemonCutover(common, { ...inspectOptions, currentPid: 400 })).blocked).toBe(true)
  })
  it('recognises this process at its current session binding without hiding a foreign MCP or legacy owner', async () => {
    const { common } = fixture()
    write(path.join(common, 'room/sessions/current/session.json'), { session_id: 'current-thread', hostPid: 200, chain: [identity(200)] })
    const options = { ...inspectOptions, currentPid: 100, currentSessionId: 'current-thread' }
    write(path.join(common, 'room-session.json'), { session_id: 'current-thread', hostPid: 200 })
    expect((await inspectDaemonCutover(common, options)).blocked).toBe(false)
    write(path.join(common, 'room/sessions/current/mcp.json'), identity(200))
    await expect(requireDaemonRuntime(common, options)).rejects.toThrow(/cutover mcp.*legacy/)
    fs.rmSync(path.join(common, 'room/sessions/current/mcp.json'))
    owner(common, 200)
    await expect(requireDaemonRuntime(common, options)).rejects.toThrow(/pid 200, port 4402/)
  })
  it.each([['pending', { pending: true }], ['unreadable', {}]] as const)('never blocks itself when its own identity probe is %s', async (_label, self) => {
    const { common } = fixture()
    // This process (pid 100) is the current session's MCP and the admitted worker's MCP; its own probe is uncertain.
    write(path.join(common, 'room/sessions/current/session.json'), { session_id: 'current-thread', worker_id: 'w_current', host: 'codex', hostPid: 200, chain: [identity(200)] })
    write(path.join(common, 'room/sessions/current/mcp.json'), { pid: 100, runtime: 'daemon-client' }) // incomplete self marker
    write(path.join(common, 'room/registry/workers/current.json'), { id: 'w_current', name: 'Ada+current', host: 'codex',
      phase: 'active', runs: [{ n: 1, launch: { outcome: 'launched', pid: 200, process: identity(200) } }] })
    const options = { ...inspectOptions, currentPid: 100, currentSessionId: 'current-thread', currentWorkerId: 'w_current',
      probe: (pid: number) => pid === 100 ? self : probe(pid) }
    expect((await inspectDaemonCutover(common, options)).blocked).toBe(false)
    await expect(requireDaemonRuntime(common, options)).resolves.toBeUndefined()
  })
  it('does not exempt other live legacy workers when the current worker is admitted', async () => {
    const { common } = fixture()
    write(path.join(common, 'room/registry/workers/legacy.json'), { id: 'w_legacy', name: 'Ada+legacy', host: 'codex',
      phase: 'active', runs: [{ n: 1, launch: { outcome: 'launched', pid: 200, process: identity(200) } }] })
    await expect(requireDaemonRuntime(common, { ...inspectOptions, currentPid: 100, currentWorkerId: 'w_current' }))
      .rejects.toThrow(/cutover worker: Ada\+legacy.*alive, legacy/)
  })
  it('passes fresh binding and admitted worker evidence to both the local join gate and diagnostics (no sockets)', async () => {
    const { common, clone } = fixture()
    const { registry, record } = await seedRegistryWorker(clone, 'current', { dir: clone, host: 'codex' })
    const run = record.runs[0]
    const gate = vi.spyOn(cutover, 'requireDaemonRuntime').mockRejectedValue(new Error('gate reached before socket startup'))
    const inspection = vi.spyOn(cutover, 'inspectDaemonCutover')
    const report = vi.spyOn(doctor, 'runDoctor').mockResolvedValue('PASS  doctor fixture')
    const tools = createTools({ cwd: clone, getSession: () => null, setSession: () => {} })
    try {
      for (const [key, value] of Object.entries({ ROOM_WORKER_ID: record.id, ROOM_WORKER_HOST: 'codex', ROOM_REGISTRY: registry.root,
        ROOM_WORKER_RUN: String(run.n), ROOM_LAUNCH_NONCE: run.nonce, ROOM_ROOM: record.room })) vi.stubEnv(key, value)
      // No binding yet: this worker must still be recognised through its verified launch.
      await expect(joinSession({ dir: clone, server: LOCAL, name: 'Ada' })).rejects.toThrow('gate reached')
      expect(gate).toHaveBeenLastCalledWith(common, { currentSessionId: undefined, currentWorkerId: record.id })
      // The hook record can arrive between startup and a subsequent join; no arbitration poll runs.
      writeSessionRecord(common, { session_id: 'late-thread', worker_id: record.id, host: 'codex', cwd: clone, at: Date.now(), chain: [] })
      await expect(joinSession({ dir: clone, server: LOCAL, name: 'Ada' })).rejects.toThrow('gate reached')
      expect(gate).toHaveBeenLastCalledWith(common, { currentSessionId: 'late-thread', currentWorkerId: record.id })
      expect(await tools.call('room_state', { check: true })).not.toContain('drain required')
      expect(inspection).toHaveBeenLastCalledWith(common, { currentSessionId: 'late-thread', currentWorkerId: record.id })
      // Environment alone cannot grant this evidence: a superseded nonce never reaches the gate.
      gate.mockClear()
      vi.stubEnv('ROOM_LAUNCH_NONCE', 'superseded')
      await expect(joinSession({ dir: clone, server: LOCAL, name: 'Ada' })).rejects.toThrow(/superseded/)
      expect(gate).not.toHaveBeenCalled()
      expect(await tools.call('room_state', { check: true })).toContain('FAIL  local daemon client identity:')
    } finally {
      gate.mockRestore()
      inspection.mockRestore()
      report.mockRestore()
      await tools.shutdown()
      vi.unstubAllEnvs()
      await closeRegistryForDir(clone)
    }
  })
  it('verifies the real owner birth identity after its process exits (no sockets)', async () => {
    const { common } = fixture()
    const child: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      const observed = probeProcessNow(child.pid!)!
      expect(observed).toBeDefined()
      write(path.join(common, 'room/relay.json'), { schema: 2, pid: child.pid, port: 4402, key: 'private-test-key' })
      write(path.join(common, 'room/hub/authority.lock'), { pid: child.pid, startTime: observed.startTime, executable: observed.executable })
      await expect(requireDaemonRuntime(common, { authenticate: noHealth })).rejects.toThrow(`pid ${child.pid}, port 4402`)
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited
      const state = await inspectDaemonCutover(common, { authenticate: noHealth })
      expect(state.owner?.liveness).toBe('dead')
      await expect(requireDaemonRuntime(common, { authenticate: noHealth })).resolves.toBeUndefined()
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill() }
  })
})

describe('historical host and ambiguous launch evidence', () => {
  it.each([false, true])('uses nearest background host, live=%s', async live => {
    const { common } = fixture()
    const chain = [{ ...identity(49716), executable: 'claude bg-spare' }, { ...identity(49656), executable: 'claude bg-pty-host' }, { ...identity(41119), executable: 'claude' }]
    write(path.join(common, 'room/sessions/bg/session.json'), { host: 'claude', hostPid: 41119, chain })
    const state = await inspectDaemonCutover(common, { probe: pid => chain.find(p => p.pid === pid && (pid === 41119 || live)) })
    expect(state.blocked).toBe(live)
    expect(state.clients[0]).toMatchObject({ pid: 49716, liveness: live ? 'alive' : 'dead' })
  })
  it('uses the first host even with an old macOS version-numbered name', async () => {
    const { common } = fixture()
    write(path.join(common, 'room/sessions/mac/session.json'), { host: 'claude', hostPid: 41119,
      chain: [{ ...identity(2662), executable: '2.1.318' }, { ...identity(91999), executable: 'claude' }, { ...identity(41119), executable: 'claude' }] })
    const state = await inspectDaemonCutover(common, { probe: pid => pid === 91999 ? { ...identity(pid), executable: 'claude' } : undefined })
    expect(state.clients[0]).toMatchObject({ pid: 2662, liveness: 'dead' })
    expect(state.blocked).toBe(false)
  })
  it('does not let a reused pid make a fully identified dead worker unknown', async () => {
    const { common } = fixture()
    owner(common, 300)
    write(path.join(common, 'room/registry/workers/w2.json'), { id: 'w2', host: 'claude', phase: 'active',
      runs: [{ n: 1, mode: 'fresh', launch: { outcome: 'launched', pid: 200, process: { ...identity(200), startTime: 'earlier-birth' } } }] })
    // pid 200 now belongs to a different, live process (probe returns another start time).
    const state = await inspectDaemonCutover(common, inspectOptions)
    expect(state.clients.find(c => c.kind === 'worker')).toMatchObject({ liveness: 'dead' })
    expect(state.blocked).toBe(false)
  })
  it('keeps identityless ambiguous launches blocking and prints human checks', async () => {
    const { common } = fixture()
    write(path.join(common, 'room/registry/workers/w.json'), { id: 'w', dir: '/worker', hostSessionId: 'session-id', logFile: '/worker.log',
      runs: [{ n: 1, launch: { outcome: 'ambiguous' } }] })
    const state = await inspectDaemonCutover(common, inspectOptions)
    expect(state.blocked).toBe(true)
    expect(daemonCutoverRows(state).join('\n')).toMatch(/FIX.*working directory.*session-id.*worker.log.*Record "room\/registry\/workers\/w.json".*cutover-resolve.*'--record' 'room\/registry\/workers\/w.json'/)
  })
})
describe('cutover rows', () => {
  it('recognizes a running Codex worker on the daemon by its MCP marker, matched to the launched host', async () => {
    const { common } = fixture()
    owner(common, 300, 'daemon')
    const host = { ...identity(100), executable: 'codex' }
    write(path.join(common, 'room/registry/workers/w.json'), { id: 'w', host: 'codex', phase: 'active',
      runs: [{ n: 1, mode: 'fresh', launch: { outcome: 'launched', pid: 100, process: host } }] })
    const live = (pid: number) => pid === 100 ? host : pid === 200 ? identity(200) : undefined
    const options = { ...inspectOptions, probe: live }
    // No marker: a live worker host with no evidence of the daemon is a legacy client and blocks.
    expect((await inspectDaemonCutover(common, options)).blocked).toBe(true)
    // The worker's MCP (pid 200, a child of host 100) publishes a daemon-client marker naming its worker and host.
    const marker = path.join(common, 'room/sessions/thread/mcp.json')
    write(marker, { ...identity(200), runtime: 'daemon-client', worker: { id: 'w', host } })
    const upgraded = await inspectDaemonCutover(common, options)
    expect(upgraded.clients.find(c => c.kind === 'worker')).toMatchObject({ runtime: 'daemon-client' })
    expect(upgraded.blocked).toBe(false)
    // A marker whose recorded host is another process does not vouch for this worker.
    write(marker, { ...identity(200), runtime: 'daemon-client', worker: { id: 'w', host: { ...host, startTime: 'other-birth' } } })
    expect((await inspectDaemonCutover(common, options)).blocked).toBe(true)
    // A dead marker vouches for nothing.
    write(marker, { ...identity(400), runtime: 'daemon-client', worker: { id: 'w', host } })
    expect((await inspectDaemonCutover(common, options)).blocked).toBe(true)
    // Nor does a stale marker whose pid is now the inspecting process's own: its writer's birth differs.
    write(marker, { pid: 500, startTime: 'crashed-writer', executable: 'node', runtime: 'daemon-client', worker: { id: 'w', host } })
    const reused = { ...options, currentPid: 500, probe: (pid: number) => pid === 500 ? identity(500) : live(pid) }
    expect((await inspectDaemonCutover(common, reused)).blocked).toBe(true)
    // ...even beside a session record naming the worker, the path a hook-written worker session takes.
    write(path.join(common, 'room/sessions/thread/session.json'), { session_id: 'thread', host: 'claude', worker_id: 'w' })
    expect((await inspectDaemonCutover(common, reused)).blocked).toBe(true)
  })
  it('lists blocking and operator-resolved records, and counts the rest by kind', async () => {
    const { common } = fixture()
    for (let i = 0; i < 300; i++) write(path.join(common, `room/sessions/s${i}/mcp.json`), identity(1000 + i))
    write(path.join(common, 'room/sessions/live/mcp.json'), identity(100))
    write(path.join(common, 'room/registry/workers/w.json'), { id: 'w', runs: [{ n: 1, launch: { outcome: 'ambiguous' } }] })
    await resolveDaemonCutover(common, 'room/registry/workers/w.json', true, 'checked', { ...inspectOptions, probe: (pid: number) => pid === 100 ? undefined : probe(pid) })
    const rows = daemonCutoverRows(await inspectDaemonCutover(common, inspectOptions))
    expect(rows.filter(row => row.startsWith('FAIL  cutover mcp: live'))).toHaveLength(1)
    expect(rows.filter(row => /^INFO  cutover worker: w.*resolved by operator/.test(row))).toHaveLength(1)
    expect(rows).toContain('INFO  cutover mcp records: 300 not blocking (300 dead)')
    expect(rows.length).toBeLessThan(12)
  })
})
describe('operator resolution', () => {
  it('quotes the printed command for POSIX shells and PowerShell', () => {
    const args = ['/plugin dir/room-mcp.mjs', 'cutover-resolve', '--dir', "/Users/o'brien/repo", '--record', 'room/registry/workers/w.json']
    expect(cutoverResolveCommand(args, 'darwin')).toBe(`node '/plugin dir/room-mcp.mjs' 'cutover-resolve' '--dir' '/Users/o'\\''brien/repo' '--record' 'room/registry/workers/w.json'`)
    expect(cutoverResolveCommand(args, 'win32')).toBe(`& node '/plugin dir/room-mcp.mjs' 'cutover-resolve' '--dir' '/Users/o''brien/repo' '--record' 'room/registry/workers/w.json'`)
  })
  it('blocks a session whose chain names two hook shells in front of the host', async () => {
    const { common } = fixture()
    write(path.join(common, 'room/sessions/s/session.json'), { session_id: 's', host: 'claude', hostPid: 100,
      chain: [identity(301), { ...identity(302), executable: 'zsh' }, { ...identity(100), executable: 'claude' }].map((m, i) => i === 0 ? { ...m, executable: 'sh' } : m) })
    const state = await inspectDaemonCutover(common, inspectOptions)
    expect(state.clients.find(c => c.kind === 'session')).toMatchObject({ liveness: 'unknown' })
    expect(state.blocked).toBe(true)
  })
  it('treats a record that vanishes or grows while being read as unreadable evidence', async () => {
    const { common } = fixture()
    const file = path.join(common, 'room/sessions/s/mcp.json')
    write(file, identity(300))
    const open = vi.spyOn(fs, 'openSync').mockImplementationOnce(() => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) })
    try { expect((await inspectDaemonCutover(common, inspectOptions)).issues.join('\n')).toMatch(/sessions\/s\/mcp\.json: ENOENT/) }
    finally { open.mockRestore() }
    write(file, { ...identity(300), padding: 'x'.repeat(3 * 1024 * 1024) })
    const real = fs.lstatSync, lstat = vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike) => {
      const stat = real(target)
      return String(target).endsWith(path.join('sessions', 's', 'mcp.json')) ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: 10 }) : stat
    }) as typeof fs.lstatSync)
    const realF = fs.fstatSync, fstat = vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const stat = realF(fd)
      return stat.size > 1024 * 1024 ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: 10 }) : stat
    }) as typeof fs.fstatSync)
    // Both size checks see 10 bytes; the file grew to 3 MB after them. The bounded read must still refuse it.
    try { expect((await inspectDaemonCutover(common, inspectOptions)).issues.join('\n')).toMatch(/sessions\/s\/mcp\.json exceeds/) }
    finally { lstat.mockRestore(); fstat.mockRestore() }
  })
  it.skipIf(process.platform === 'win32')('refuses linked inventory folders instead of reading them as empty', async () => {
    const { common, root } = fixture()
    const elsewhere = path.join(root, 'elsewhere')
    fs.mkdirSync(path.join(elsewhere, 's'), { recursive: true })
    fs.writeFileSync(path.join(elsewhere, 's', 'mcp.json'), JSON.stringify(identity(100)))
    fs.symlinkSync(elsewhere, path.join(common, 'room/sessions'))
    const linked = await inspectDaemonCutover(common, inspectOptions)
    expect(linked.blocked).toBe(true)
    expect(linked.issues.join('\n')).toMatch(/room\/sessions must be a directory, not a symlink/)
    fs.rmSync(path.join(common, 'room/sessions'))
    fs.mkdirSync(path.join(common, 'room/registry'), { recursive: true })
    fs.symlinkSync(path.join(root, 'missing'), path.join(common, 'room/registry/workers'))
    const dangling = await inspectDaemonCutover(common, inspectOptions)
    expect(dangling.blocked).toBe(true)
    expect(dangling.issues.join('\n')).toMatch(/registry\/workers must be a directory, not a symlink/)
  })
  it.skipIf(process.platform === 'win32')('refuses linked inventory records: a link is never read or taken as absent', async () => {
    const { common, root } = fixture()
    const planted = path.join(root, 'planted.json')
    fs.writeFileSync(planted, JSON.stringify({ ...identity(100), runtime: 'daemon-client' }))
    fs.mkdirSync(path.join(common, 'room/sessions/s'), { recursive: true })
    fs.symlinkSync(planted, path.join(common, 'room/sessions/s/mcp.json'))
    const linked = await inspectDaemonCutover(common, inspectOptions)
    expect(linked.blocked).toBe(true)
    expect(linked.issues.join('\n')).toContain('mcp.json must be a regular file, not a symlink')
    fs.rmSync(path.join(common, 'room/sessions/s'), { recursive: true })
    write(path.join(common, 'room/registry/workers/w.json'), { id: 'w', runs: [{ n: 1, launch: { outcome: 'launched', process: identity(300) } }] })
    fs.mkdirSync(path.join(common, 'room/registry/runs/w'), { recursive: true })
    fs.symlinkSync(path.join(root, 'missing.json'), path.join(common, 'room/registry/runs/w/1.report.json'))
    const dangling = await inspectDaemonCutover(common, inspectOptions)
    expect(dangling.blocked).toBe(true)
    expect(dangling.issues.join('\n')).toContain('1.report.json must be a regular file, not a symlink')
  })
  it.skipIf(process.platform === 'win32')('refuses linked or foreign waiver files instead of trusting them', async () => {
    const { common, root } = fixture()
    const source = 'room/registry/workers/w.json'
    write(path.join(common, source), { id: 'w', runs: [{ n: 1, launch: { outcome: 'ambiguous' } }] })
    await resolveDaemonCutover(common, source, true, undefined, inspectOptions)
    const file = path.join(common, 'room/daemon-cutover-resolutions.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ v: 1, clone: cloneId(common) })
    expect((await inspectDaemonCutover(common, inspectOptions)).blocked).toBe(false)
    // Copied into another clone, the same resolutions do not waive anything there.
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    write(file, { ...saved, clone: 'another-clone' })
    const foreign = await inspectDaemonCutover(common, inspectOptions)
    expect(foreign.blocked).toBe(true)
    expect(foreign.issues.join('\n')).toContain('must name this clone')
    // A link to a waiver file elsewhere is refused, not followed.
    const outside = path.join(root, 'planted.json')
    fs.writeFileSync(outside, JSON.stringify(saved), { mode: 0o600 })
    fs.rmSync(file); fs.symlinkSync(outside, file)
    const linked = await inspectDaemonCutover(common, inspectOptions)
    expect(linked.blocked).toBe(true)
    expect(linked.issues.join('\n')).toContain('regular file, not a symlink')
    fs.rmSync(file)
    const drain = path.join(common, 'room/daemon-cutover.json')
    fs.writeFileSync(outside, JSON.stringify({ v: 1, clone: cloneId(common), at: 1 }), { mode: 0o600 })
    fs.symlinkSync(outside, drain)
    expect((await inspectDaemonCutover(common, inspectOptions)).issues.join('\n')).toContain('regular file, not a symlink')
  })
  it('requires confirmation, a blocking source, and non-live evidence', async () => {
    const { common } = fixture()
    const source = 'room/sessions/s/mcp.json'
    write(path.join(common, source), identity(100))
    await expect(resolveDaemonCutover(common, source, false, undefined, inspectOptions)).rejects.toThrow('--confirm-not-running')
    await expect(resolveDaemonCutover(common, 'missing', true, undefined, inspectOptions)).rejects.toThrow('not currently blocking')
    await expect(resolveDaemonCutover(common, source, true, undefined, inspectOptions)).rejects.toThrow('live process')
    write(path.join(common, source), identity(300))
    await expect(resolveDaemonCutover(common, source, true, undefined, inspectOptions)).rejects.toThrow('not currently blocking')
  })
  it('skips exact fingerprints, re-judges records and reports, and never skips alive', async () => {
    const { common } = fixture()
    const source = 'room/registry/workers/w.json', file = path.join(common, source)
    const worker = { id: 'w', runs: [{ n: 1, launch: { outcome: 'ambiguous' } }] }
    write(file, worker)
    await resolveDaemonCutover(common, source, true, 'checked transcript and log', inspectOptions)
    let state = await inspectDaemonCutover(common, inspectOptions)
    expect(state.blocked).toBe(false)
    expect(daemonCutoverRows(state).join('\n')).toContain('resolved by operator at')
    await expect(resolveDaemonCutover(common, source, true, undefined, inspectOptions)).rejects.toThrow('not currently blocking')
    write(file, { ...worker, changed: true })
    expect((await inspectDaemonCutover(common, inspectOptions)).blocked).toBe(true)
    write(file, worker)
    const report = path.join(common, 'room/registry/runs/w/1.report.json')
    write(report, { hostProcess: identity(300) })
    const uncertain = { ...inspectOptions, probe: () => ({}) }
    expect((await inspectDaemonCutover(common, uncertain)).blocked).toBe(true)
    await resolveDaemonCutover(common, source, true, undefined, uncertain)
    expect((await inspectDaemonCutover(common, uncertain)).blocked).toBe(false)
    state = await inspectDaemonCutover(common, { ...inspectOptions, probe: identity })
    expect(state.blocked).toBe(true)
    expect(state.clients[0].skipped).toBeUndefined()
    expect(fs.statSync(path.join(common, 'room/daemon-cutover-resolutions.json')).mode & 0o777).toBe(0o600)
  })
})

it.each([
  [300, 200, 300, 'alive'],
  [100, 300, 300, 'alive'],
  [300, 300, 100, 'unknown'],
  [300, 400, 300, 'unknown'],
  [300, 300, 300, 'dead'],
])('judges every worker identity (%s, %s, %s -> %s)', async (launchPid, reportPid, pid, expected) => {
  const { common } = fixture()
  write(path.join(common, 'room/registry/workers/w.json'), { id: 'w', runs: [{ n: 1,
    launch: { outcome: 'launched', process: identity(Number(launchPid)), pid } }] })
  write(path.join(common, 'room/registry/runs/w/1.report.json'), { hostProcess: identity(Number(reportPid)) })
  const state = await inspectDaemonCutover(common, { ...inspectOptions, probe: pid => pid === 400 ? {} : probe(pid) })
  expect(state.clients[0].liveness).toBe(expected)
})
