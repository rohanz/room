/** Real OS + fake host: no installed Claude, authentication, or model calls. Run on Windows CI too. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { joinSession, leaveSession, boundSession, readSessionRecord, sessionDirectory, type Session } from '../src/session.js'
import { createTools } from '../src/tools.js'
import { launchWorkerProcess } from '../src/worker-launch.js'
import { defaultSpawner, resumeAccepted, stopWorkerWithEscalation, type SpawnedProcess, type SpawnSpec } from '../src/worker-process.js'

const roots: string[] = []
const sessions: Session[] = []
const processes: { proc: SpawnedProcess; exited: Promise<void>; closed: () => boolean }[] = []
const fixture = fileURLToPath(new URL('./fixtures/windows-fake-host.mjs', import.meta.url))
const hook = fileURLToPath(new URL('../../../plugins/room/hooks/session-start.mjs', import.meta.url))
afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (!child.closed()) child.proc.killForce?.()
    await vi.waitFor(() => expect(child.closed(), 'fake host must exit before filesystem cleanup').toBe(true), { timeout: 5000 })
    await child.exited
  }
  for (const session of sessions.splice(0).reverse()) await leaveSession(session)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  vi.unstubAllEnvs()
})

function repo(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room native smoke with spaces ')))
  roots.push(root)
  const dir = path.join(root, 'checkout with spaces')
  fs.mkdirSync(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', timeout: 10_000 })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Windows Smoke')
  git('config', 'user.email', 'smoke@example.invalid')
  fs.writeFileSync(path.join(dir, 'app.txt'), 'fixture\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), '.room/\n')
  git('add', '.')
  git('commit', '-qm', 'smoke fixture')
  return dir
}

function track(proc: SpawnedProcess) {
  let closed = false
  const exited = new Promise<void>(resolve => proc.onExit(() => { closed = true; resolve() }))
  const child = { proc, exited, closed: () => closed }
  processes.push(child)
  return child
}

describe('native OS smoke (fake Claude host)', () => {
  it('starts the local relay and delivers an addressed question and answer between spaced worktrees', async () => {
    const dir = repo()
    const workerDir = path.join(dir, '.room', 'workers', 'message peer')
    execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'room/message-peer', workerDir], { timeout: 10_000 })
    const lead = await joinSession({ dir, server: 'local', name: 'Smoke', log: () => {} })
    sessions.push(lead)
    const worker = await joinSession({ dir: workerDir, server: 'local', room: lead.roomName, name: 'Smoke', tag: 'peer', joinOnly: true, log: () => {} })
    sessions.push(worker)
    expect(lead.local?.owned).toBe(true)
    expect(worker.local?.owned).toBe(false)
    expect(worker.roomUrl).toBe(lead.roomUrl)
    const tools = (s: Session) => createTools({ cwd: s.dir, getSession: () => s, setSession: () => {}, log: () => {} })
    const a = tools(lead), b = tools(worker)
    try {
      await a.call('room_send', { type: 'question', to: worker.me.name, text: 'native smoke question' })
      await vi.waitFor(() => expect(worker.room.messages().some(m => m.type === 'question' && m.text === 'native smoke question')).toBe(true), { timeout: 10_000 })
      const question = worker.room.messages().find(m => m.type === 'question' && m.text === 'native smoke question')!
      await b.call('room_send', { type: 'answer', to: lead.me.name, inReplyTo: question.id, text: 'native smoke answer' })
      await vi.waitFor(() => expect(lead.room.messages().some(m => m.type === 'answer' && m.inReplyTo === question.id && m.text === 'native smoke answer')).toBe(true), { timeout: 10_000 })
    } finally {
      try { await b.shutdown(); sessions.splice(sessions.indexOf(worker), 1) }
      finally { await a.shutdown(); sessions.splice(sessions.indexOf(lead), 1) }
    }
  }, 45_000)

  it('runs SessionStart from another cwd, records the worker identity and binds the new /clear session', () => {
    const dir = repo()
    const common = path.join(dir, '.git')
    for (const [id, source] of [['fake-host-before-clear', 'startup'], ['fake-host-after-clear', 'clear']]) {
      execFileSync(process.execPath, [hook, '--host', 'claude'], {
        cwd: os.tmpdir(), input: JSON.stringify({ cwd: dir, session_id: id, source, model: 'fake-model', effort: { level: 'high' } }),
        env: { ...process.env, ROOM_WORKER_ID: 'w_native_smoke' }, timeout: 15_000,
      })
      const record = readSessionRecord(common, id)
      expect(record).toMatchObject({ session_id: id, host: 'claude', worker_id: 'w_native_smoke', cwd: dir })
      expect(record?.chain.length).toBeGreaterThan(0)
      expect(record?.chain[0].startTime).toBeTruthy()
      expect(fs.existsSync(path.join(sessionDirectory(common, id), 'session.json'))).toBe(true)
    }
    expect(boundSession({ commonDir: common, cwd: dir, host: 'claude', workerId: 'w_native_smoke', env: {} })).toEqual({ id: 'fake-host-after-clear', host: 'claude' })
    expect(boundSession({ commonDir: common, cwd: dir, host: 'claude', workerId: 'other-worker', env: {} })).toBeUndefined()
  }, 35_000)

  it('launches, stops and resumes the same fake host session through a native executable path with spaces', async () => {
    const dir = repo()
    const hostDir = path.join(dir, '.room', 'fake host bin')
    fs.mkdirSync(hostDir, { recursive: true })
    // A real native executable, never a POSIX shebang or .cmd file pretending to be one.
    const executable = path.join(hostDir, process.platform === 'win32' ? 'claude.exe' : 'claude')
    fs.copyFileSync(process.execPath, executable)
    fs.chmodSync(executable, 0o755)
    const script = path.join(hostDir, 'fake host.mjs')
    fs.copyFileSync(fixture, script)
    const specs: SpawnSpec[] = []
    const spawner = (spec: SpawnSpec) => {
      specs.push(spec)
      const proc = defaultSpawner({ ...spec, cmd: executable, args: [script, ...spec.args] })
      track(proc)
      return proc
    }
    const policy = { session: { dir, roomName: 'local/native-smoke' } as Session, id: 'w_native_smoke', tag: 'smoke', dir,
      lead: 'Smoke', owner: 'Smoke', host: 'claude' as const, share: 'intent', run: 1, nonce: 'smoke-nonce', registry: path.join(dir, '.git', 'room', 'registry'),
      budget: { threads: 1, memGb: 1, nice: 10 }, server: 'local', isWorker: false, spawner, log: () => {} }
    const watch = { setHandle: () => {}, watch: (_id: string, proc: SpawnedProcess, cb: (code: number | null) => void) => proc.onExit(cb), aborted: () => false }
    const sid = '550e8400-e29b-41d4-a716-446655440000'
    const fresh = await launchWorkerProcess(policy, { mode: 'fresh', task: 'prompt with spaces & literal "quotes"', links: [], sessionId: sid }, watch, async () => {}, async () => {}, async () => {})
    expect(fresh.processStartTime).toBeTruthy()
    expect(fresh.processExecutable).toBe('claude')
    await vi.waitFor(() => expect(fs.readFileSync(fresh.logFile, 'utf8')).toContain('fake-host-ready'), { timeout: 10_000 })
    const first = processes.at(-1)!
    expect(await stopWorkerWithEscalation({ terminate: () => first.proc.kill(), force: () => first.proc.killForce!(), exited: first.closed })).toBe(true)
    await first.exited
    const start = fs.statSync(fresh.logFile).size
    const resumed = await launchWorkerProcess({ ...policy, run: 2 }, { mode: 'resume', sessionId: sid, followUp: 'follow-up with spaces & literal "quotes"', oldPort: fresh.port }, watch, async () => {}, async () => {}, async () => {})
    expect(resumed.processStartTime).toBeTruthy()
    expect(resumed.processExecutable).toBe('claude')
    await vi.waitFor(() => expect(resumeAccepted(resumed.logFile, 'claude', sid, start)).toBe(true), { timeout: 10_000 })
    const log = fs.readFileSync(resumed.logFile, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    const receipts = log.filter(e => e.type === 'fake-host-ready')
    expect(receipts).toHaveLength(2)
    expect(receipts.map(e => e.session_id)).toEqual([sid, sid])
    expect(receipts[0].prompt).toContain('prompt with spaces & literal "quotes"')
    expect(receipts[1].prompt).toContain('follow-up with spaces & literal "quotes"')
    expect(receipts[0].env).toMatchObject({ ROOM_WORKER_ID: 'w_native_smoke', ROOM_WORKER_RUN: '1', ROOM_ROOM: 'local/native-smoke' })
    expect(receipts[1].env.ROOM_WORKER_RUN).toBe('2')
    expect(receipts.every(e => e.cwd === dir)).toBe(true)
    expect(specs[1].args[specs[1].args.indexOf('--resume') + 1]).toBe(sid)
    const last = processes.at(-1)!
    expect(await stopWorkerWithEscalation({ terminate: () => last.proc.kill(), force: () => last.proc.killForce!(), exited: last.closed })).toBe(true)
    await last.exited
  }, 45_000)
})
