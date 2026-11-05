import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { cloneId, privateStateDirectory } from '@room/relay'
import { probeProcessNow } from '@room/relay/process'
import { inspectDaemonCutover, requireDaemonRuntime, daemonCutoverRows } from '../src/daemon-cutover.js'
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
    write(path.join(common, 'room/sessions/old/session.json'), { session_id: 'old', hostPid: 200, chain: [identity(200)] })
    const state = await inspectDaemonCutover(common, inspectOptions)
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
    write(file, { session_id: 'invalid', hostPid: '200', chain: [identity(200)] })
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
