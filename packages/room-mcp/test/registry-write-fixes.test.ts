import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchWorkerProcess, WorkerLaunchError } from '../src/worker-launch.js'
import { WorkerRegistry } from '../src/worker-registry.js'
import type { WorkerRecord } from '../src/worker-status.js'
import type { Session } from '../src/session.js'

const signal = vi.hoisted(() => ({ handler: undefined as undefined | ((pid: number, worker: unknown) => boolean) }))
vi.mock('../src/port-reservations.js', () => ({
  reserveWorkerPort: () => ({ port: 4409, release: () => {} }),
  bindWorkerPortReservation: () => {},
}))
vi.mock('../src/worker-process.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/worker-process.js')>()
  return { ...original, signalWorker: (pid: number, _signal: string, _dir: string, _list: unknown, worker: unknown) => signal.handler?.(pid, worker) ?? false }
})

const roots: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
const token = { pid: process.pid, startTime: 'lead', executable: 'node', sessionId: 'lead', nonce: 'lead' }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-write-fix-'))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Lead'); git('config', 'user.email', 'lead@example.test')
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const dir = path.join(root, '.room/workers/tests')
  const record = (id: string): WorkerRecord => ({
    v: 1, id, tag: 'tests', name: 'lead+tests', mode: 'local', room: 'local/repo',
    lead: { participant: 'lead', room: 'local/repo', instance: token }, host: 'codex',
    budget: { threads: 1, memGb: 1, nice: 10 }, share: 'intent', task: 'tests',
    dir, outside: false, branch: 'room/tests', prep: { step: 'plan' },
    capabilities: { resume: true, signal: true, collect: 'delta' }, phase: 'intent',
    runs: [{ n: 1, mode: 'fresh', intentAt: 1, nonce: 'nonce', busFrontier: [], promptMsgIds: [], launcher: token, logStart: 0 }],
    createdAt: 1, seq: 1,
  })
  return { root, dir, git, record }
}
const open = (root: string) => WorkerRegistry.open(root, { identity: token, migrate: false, watch: false })

describe('reviewed worker write failures', () => {
  for (const mode of ['fresh', 'resume'] as const) it(`owns and stops a ${mode} child when the launch fact write fails (M8)`, async () => {
    const { root } = fixture()
    let onExit: ((code: number | null) => void) | undefined
    let handles = 0, kills = 0
    const proc = { pid: 4242, started: Promise.resolve(), onExit: (cb: (code: number | null) => void) => { onExit = cb },
      kill: () => { kills++; onExit?.(null); return true }, killForce: () => false }
    const session = { dir: root, roomName: 'local/repo' } as Session
    const run = launchWorkerProcess({ session, id: 'w_launch', tag: 'tests', dir: root, lead: 'lead', owner: 'lead',
      host: 'codex', share: 'intent', run: 1, nonce: 'nonce', registry: root,
      budget: { threads: 1, memGb: 1, nice: 10 }, server: 'local', isWorker: false,
      spawner: () => proc, log: () => {} },
    mode === 'fresh' ? { mode, task: 'test', links: [] } : { mode, sessionId: 'thread', followUp: 'test' },
    { setHandle: () => { handles++ }, watch: (_id, child, cb) => child.onExit(cb), aborted: () => false },
    async () => { throw new Error('launch fact disk full') }, async () => {}, async () => {})
    await expect(run).rejects.toMatchObject({ delivered: true, stopped: true, message: 'launch fact disk full' } satisfies Partial<WorkerLaunchError>)
    expect(handles).toBe(1)
    expect(kills).toBe(1)
  })

  it('resolves a reused tag through its current reservation (F-M4)', async () => {
    const { root, dir, git, record } = fixture()
    const store = await open(root)
    await store.writeIntent(record('w_01'))
    await store.abandonPreparation('w_01')
    await store.writeIntent(record('w_02'))
    git('worktree', 'add', '-qb', 'room/tests', dir)
    await store.update('w_02', old => ({ ...old, phase: 'active', prep: { step: 'prepared', created: true }, seq: old.seq + 1 }))
    expect((await store.trusted({ participant: 'lead', room: 'local/repo', dir: root }, 'tests'))?.record.id).toBe('w_02')
  })

  it('abandons an external directory without undoing resources it did not create (F-M5)', async () => {
    const { root, record } = fixture()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'room-outside-'))
    roots.push(outside)
    const store = await open(root)
    await store.writeIntent({ ...record('w_03'), dir: outside, outside: true,
      prep: { step: 'prepared', worktreeExisted: true, created: false }, phase: 'prepared' })
    await store.abandonPreparation('w_03')
    expect(store.read('w_03')?.phase).toBe('abandoned')
    expect(fs.existsSync(outside)).toBe(true)
    expect(store.occupancy()).toBe(0)
  })

  it('announces a saved done report on exit after its first post failed (F-S3)', async () => {
    const { root, record } = fixture()
    const store = await open(root)
    await store.writeIntent(record('w_04'))
    await store.update('w_04', old => ({ ...old, phase: 'active', runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: 4242 } }], seq: old.seq + 1 }))
    await store.writeReport('w_04', { run: 1, nonce: 'nonce', chain: [], joinedAt: 2,
      done: { at: 3, summary: 'finished', changed: [] } })
    await store.writeExit('w_04', { run: 1, code: 0, at: 4, witnessed: true })
    const ids: string[] = []
    expect(await store.postObservedFailure('w_04', 1, async message => { ids.push(message.id) })).toBe(true)
    expect(ids).toEqual(['wk:w_04:1'])
    expect(store.read('w_04')?.runs[0].posted).toBe('wk:w_04:1')
  })

  it('signals a live worker while replaying its durable discard plan (M9)', async () => {
    const { root, dir, git, record } = fixture()
    git('worktree', 'add', '-qb', 'room/tests', dir)
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, stdio: 'ignore' })
    children.push(child)
    let live = true
    const store = await WorkerRegistry.open(root, { identity: token, migrate: false, watch: false,
      liveness: () => live ? 'alive' : 'dead' })
    signal.handler = (pid, worker) => {
      if (pid !== child.pid || (worker as { processStartTime?: string }).processStartTime !== 'child-born') return false
      live = false
      child.kill('SIGTERM')
      return true
    }
    await store.writeIntent(record('w_05'))
    await store.update('w_05', old => ({ ...old, phase: 'active', prep: { step: 'prepared', created: true },
      runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: child.pid!, process: {
        pid: child.pid!, startTime: 'child-born', executable: process.execPath } } }], seq: old.seq + 1 }))
    await store.beginDiscard('w_05', true, [])
    await store.replayDiscard('w_05')
    expect(live).toBe(false)
    expect(store.read('w_05')?.discard?.steps.stop).toBe(true)
  })

  it('stops the admitted host and MCP before publishing a discard patch (N2)', async () => {
    const { root, dir, git, record } = fixture()
    git('worktree', 'add', '-qb', 'room/tests', dir)
    fs.writeFileSync(path.join(dir, 'base.txt'), 'worker edit\n')
    const mcp = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, stdio: 'ignore' })
    const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, stdio: 'ignore' })
    children.push(mcp, host)
    const identity = (child: ChildProcess) => ({ pid: child.pid!, startTime: `born-${child.pid}`, executable: process.execPath })
    const chain = [identity(mcp), identity(host)] // admission order: MCP first, host second
    const alive = new Set(chain.map(p => p.pid))
    for (const child of [mcp, host]) child.once('exit', () => alive.delete(child.pid!))
    const signals: number[] = []
    signal.handler = (pid) => {
      signals.push(pid)
      const child = pid === host.pid ? host : pid === mcp.pid ? mcp : undefined
      return child?.kill('SIGTERM') ?? false
    }
    const store = await WorkerRegistry.open(root, { identity: token, migrate: false, watch: false,
      liveness: p => alive.has(p.pid) ? 'alive' : 'dead' })
    await store.writeIntent(record('w_chain'))
    await store.update('w_chain', old => ({ ...old, phase: 'active', prep: { step: 'prepared', created: true },
      runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: host.pid! } }], seq: old.seq + 1 }))
    await store.writeReport('w_chain', { run: 1, nonce: 'nonce', chain, joinedAt: 2 })
    await store.beginDiscard('w_chain', true, [])
    const original = store.recordDiscardPatch.bind(store)
    let aliveAtPatch = true
    vi.spyOn(store, 'recordDiscardPatch').mockImplementation(async (id, bytes) => {
      aliveAtPatch = alive.has(host.pid!) || alive.has(mcp.pid!)
      return original(id, bytes)
    })
    await store.replayDiscard('w_chain')
    expect(signals[0]).toBe(host.pid)
    expect(signals).toContain(mcp.pid)
    expect(aliveAtPatch).toBe(false)
    expect(store.read('w_chain')?.discard?.steps.stop).toBe(true)
  })

  it('keeps the worktree and stop step pending when the admitted host cannot be verified (N2)', async () => {
    const { root, dir, git, record } = fixture()
    git('worktree', 'add', '-qb', 'room/tests', dir)
    const store = await WorkerRegistry.open(root, { identity: token, migrate: false, watch: false,
      liveness: p => p.pid === 4243 ? 'unknown' : 'dead' })
    await store.writeIntent(record('w_uncertain'))
    await store.update('w_uncertain', old => ({ ...old, phase: 'active', prep: { step: 'prepared', created: true },
      runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: 4243 } }], seq: old.seq + 1 }))
    await store.writeReport('w_uncertain', { run: 1, nonce: 'nonce', chain: [
      { pid: 4242, startTime: 'mcp', executable: process.execPath },
      { pid: 4243, startTime: 'host', executable: process.execPath },
    ], joinedAt: 2 })
    await store.beginDiscard('w_uncertain', true, [])
    await store.replayDiscard('w_uncertain')
    expect(store.read('w_uncertain')?.discard?.steps.stop).not.toBe(true)
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('cleans a scratch patch left by a killed writer before discard replay', async () => {
    const { root, dir, git, record } = fixture()
    git('worktree', 'add', '-qb', 'room/tests', dir)
    const store = await open(root)
    await store.writeIntent(record('w_06'))
    await store.update('w_06', old => ({ ...old, phase: 'active', prep: { step: 'prepared', created: true },
      runs: [{ ...old.runs[0], launch: { outcome: 'never', error: 'host missing' } }], seq: old.seq + 1 }))
    await store.beginDiscard('w_06', true, [])
    const scratch = path.join(root, 'room/registry/patches/w_06.0123456789abcdef.tmp')
    fs.mkdirSync(path.dirname(scratch), { recursive: true })
    fs.writeFileSync(scratch, 'abandoned scratch')
    await store.replayDiscard('w_06')
    expect(fs.existsSync(scratch)).toBe(false)
  })
})
