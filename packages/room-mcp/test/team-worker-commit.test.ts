// rc11 all-Codex rehearsal R1, end to end against a real team server: a worker that commits before room_done.
// The lead's clone is single-branch (no origin/HEAD), so the worker's room/<tag> branch has no remote ref.
// Only the host process is stubbed: lead and worker are real sessions with real daemons, joined over the server.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { joinSession, leaveSession, setCredential, type Session } from '../src/index.js'
import { createTools } from '../src/tools.js'
import type { SpawnSpec } from '../src/worker-process.js'
import { workerByTag } from './registry-fixture.js'

vi.setConfig({ testTimeout: 120_000 })

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
let proc: ChildProcess, port = 0
const http = () => `http://127.0.0.1:${port}`
const post = (p: string, body: unknown) => fetch(`${http()}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim()

beforeAll(async () => {
  port = await new Promise<number>((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) }) })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ROOM_') && k !== 'YPERSISTENCE') env[k] = v
  proc = spawn(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'packages/server/src/index.ts')], {
    env: { ...env, HOST: '127.0.0.1', PORT: String(port), GITHUB_CLIENT_ID: 'fake', NODE_ENV: 'test' }, stdio: 'ignore',
  })
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${http()}/health`)).ok) break } catch { /* starting */ } await new Promise(r => setTimeout(r, 100)) }
  const device = (await (await post('/auth/device', {})).json() as { device: string }).device
  const { session } = await (await post('/auth/poll', { device, fakeLogin: 'ana' })).json() as { session: string }
  setCredential(`ws://127.0.0.1:${port}`, { session, login: 'ana', at: Date.now() })
  expect((await post('/rooms', { room: 'github.com/acme/werk', session, schema: 2 })).ok).toBe(true)
}, 60_000)
afterAll(() => { proc?.kill() })

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  vi.unstubAllEnvs()
})

async function world() {
  vi.stubEnv('ROOM_AUTO_FETCH', '0')
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-team-commit-')))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'lead')
  fs.mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'r17'); git(dir, 'config', 'user.name', 'Ana'); git(dir, 'config', 'user.email', 'ana@example.test')
  git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/werk.git')
  fs.writeFileSync(path.join(dir, 'app.py'), 'one = 1\ntwo = 2\nthree = 3\n')
  fs.writeFileSync(path.join(dir, 'CHANGES.rst'), 'Version 3.2.0\n-------------\n\nUnreleased\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base')
  // `git clone --single-branch`: origin/r17 only, no origin/HEAD.
  git(dir, 'update-ref', 'refs/remotes/origin/r17', 'HEAD')
  git(dir, 'config', 'branch.r17.remote', 'origin'); git(dir, 'config', 'branch.r17.merge', 'refs/heads/r17')
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.room/\n')
  const server = `ws://127.0.0.1:${port}`
  const sessions = new Set<Session>()
  let lead: Session | null = await joinSession({ dir, server, sessionId: 'lead-host' })
  sessions.add(lead)
  cleanups.push(async () => { for (const s of sessions) await leaveSession(s).catch(() => {}) })
  const specs = new Map<string, SpawnSpec>()
  const exits = new Map<string, (code: number | null) => void>()
  let pid = 4_100_000 // above any real pid: nothing is ever alive or signalled
  const leadTools = createTools({
    cwd: dir, getSession: () => lead, setSession: s => { lead = s; if (s) sessions.add(s) }, probe: () => undefined, listCwdProcesses: () => [],
    spawner: spec => {
      specs.set(spec.env.ROOM_TAG, spec)
      return { pid: pid++, started: Promise.resolve(), onExit: cb => { exits.set(spec.env.ROOM_TAG, cb) }, kill: () => true }
    },
  })
  cleanups.push(() => leadTools.shutdown())
  const call = (tool: string, args: Record<string, unknown> = {}) => leadTools.call(tool, args) as Promise<string>

  /** The worker's own MCP: a real session joined from its worktree with the environment Room launched it with. */
  async function workerSession(tag: string) {
    const spec = specs.get(tag)!
    const saved = new Map<string, string | undefined>()
    for (const [k, v] of Object.entries(spec.env)) if (k.startsWith('ROOM_')) { saved.set(k, process.env[k]); process.env[k] = v }
    let ws: Session | null
    try { ws = await joinSession({ dir: spec.cwd, server, sessionId: `${tag}-host` }) }
    finally { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
    sessions.add(ws)
    const tools = createTools({ cwd: spec.cwd, getSession: () => ws, setSession: s => { ws = s; if (s) sessions.add(s) } })
    cleanups.push(() => tools.shutdown())
    return {
      session: () => ws!,
      call: async (tool: string, args: Record<string, unknown> = {}) => {
        const id = process.env.ROOM_WORKER_ID
        process.env.ROOM_WORKER_ID = spec.env.ROOM_WORKER_ID
        try { return await tools.call(tool, args) as string } finally { if (id === undefined) delete process.env.ROOM_WORKER_ID; else process.env.ROOM_WORKER_ID = id }
      },
      leave: async () => { await tools.shutdown(); if (ws) { await leaveSession(ws).catch(() => {}); sessions.delete(ws) } },
    }
  }
  return { dir, call, specs, exits, workerSession }
}

it.each([
  ['still running after room_done', false],
  ['exited after room_done', true],
] as const)('a worker that committed before room_done: %s', async (_, exited) => {
  const t = await world()
  expect(await t.call('room_spawn', { tag: 'w1', task: 'Fix two', carry: false })).toContain('spawned w1')
  const w = workerByTag(t.dir, 'w1')!
  const worker = await t.workerSession('w1')
  // Work, commit (as a "PR per issue" brief asks), then one more uncommitted edit.
  fs.writeFileSync(path.join(w.dir, 'app.py'), 'one = 1\ntwo = "TWO"\nthree = 3\n')
  fs.writeFileSync(path.join(w.dir, 'CHANGES.rst'), 'Version 3.2.0\n-------------\n\n- Fix two.\n\nUnreleased\n')
  git(w.dir, 'commit', '-qam', 'Fix two')
  fs.writeFileSync(path.join(w.dir, 'notes.txt'), 'uncommitted\n')
  expect(await worker.call('room_done', { summary: 'committed Fix two' })).toContain('marked done')
  if (exited) {
    await worker.leave()
    t.exits.get('w1')!(0)
    await vi.waitFor(() => expect(workerByTag(t.dir, 'w1')).toMatchObject({ status: 'done', exitCode: 0 }), { timeout: 15_000 })
  }
  const preview = await t.call('room_preview_merge', { people: ['ana+w1'], run: 'grep -q TWO app.py && grep -q "Fix two" CHANGES.rst && test -f notes.txt' })
  expect(preview).not.toContain('updating after a commit')
  expect(preview).not.toContain('no changes from')
  expect(preview).not.toContain('PARTIAL')
  expect(preview).toMatch(/only ana\+w1 changed these files since its start: .*CHANGES\.rst.*app\.py.*notes\.txt/)
  expect(preview).toMatch(/in the merged tree \(3 file\(s\) applied over [0-9a-f]+\): exit 0/)
  expect(preview).not.toMatch(/partial tree|your own tree only/)
  // Collect brings the committed and the uncommitted work in; a still-running worker is waited for briefly.
  if (!exited) setTimeout(() => { void worker.leave().then(() => t.exits.get('w1')!(0)) }, 500)
  const collected = await t.call('room_collect', { tag: 'w1' })
  expect(collected).toContain('Changes from')
  expect(fs.readFileSync(path.join(t.dir, 'app.py'), 'utf8')).toContain('"TWO"')
  expect(fs.readFileSync(path.join(t.dir, 'CHANGES.rst'), 'utf8')).toContain('- Fix two.')
  expect(fs.readFileSync(path.join(t.dir, 'notes.txt'), 'utf8')).toBe('uncommitted\n')
})
