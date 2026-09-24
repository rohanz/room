import { describe, it, expect, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RoomdError } from '@room/roomd'
import { ensureLocalRelay, startRelay } from '@room/relay'
import { AutoJoin } from '../src/auto-join.js'
import { appendRoomLog } from '../src/index.js'
import { LOCAL, NoRoom, type Session } from '../src/session.js'
import { createTools } from '../src/tools.js'
import type { ResolvedConfig } from '../src/config.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-autojoin-')))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'Ada')
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  return dir
}

/** A real room-mcp process over stdio, as a host starts it; its stderr lines are collected. */
async function startMcp(dir: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'room-autojoin-home-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ROOM_')) env[k] = v
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), ROOM_DIR: dir })
  const lines: string[] = []
  const transport = new StdioClientTransport({ command: path.join(ROOT, 'node_modules/.bin/tsx'), args: [path.join(ROOT, 'packages/room-mcp/src/index.ts')], env, cwd: dir, stderr: 'pipe' })
  transport.stderr?.on('data', d => { lines.push(...String(d).split('\n').filter(Boolean)) })
  const client = new Client({ name: 'test-host', version: '1' })
  await client.connect(transport)
  cleanups.push(() => client.close())
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })).content as { text: string }[])[0].text
  const waitFor = async (pattern: RegExp, ms: number) => {
    const deadline = Date.now() + ms
    while (!lines.some(l => pattern.test(l))) {
      if (Date.now() > deadline) throw new Error(`no stderr line matching ${pattern} within ${ms}ms:\n${lines.join('\n')}`)
      await new Promise(r => setTimeout(r, 20))
    }
  }
  return { call, lines, waitFor }
}

/** What a wedged relay owner looks like from outside: /health answers as this clone's relay, websockets never open. */
async function wedgedRelay(commonDir: string, key: string): Promise<{ close(): void }> {
  const clone = crypto.createHash('sha256').update(fs.realpathSync(commonDir)).digest('hex')
  const sockets = new Set<net.Socket>()
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, local: true, clone, ...(req.headers.authorization === `Bearer ${key}` ? { key: true } : {}) }))
  })
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  server.on('upgrade', () => { /* hang: never answer the handshake */ })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  fs.writeFileSync(path.join(commonDir, 'room-local.json'), JSON.stringify({ port, pid: process.pid, room: 'x', startedAt: Date.now(), key }) + '\n', { mode: 0o600 })
  let closed = false
  const close = () => { if (closed) return; closed = true; for (const s of sockets) s.destroy(); server.close() }
  cleanups.push(close)
  return { close }
}

describe('automatic join (real room-mcp processes)', () => {
  it('a session whose first join hits a wedged relay owner joins by itself once that owner is gone', async () => {
    const dir = repo()
    const commonDir = path.join(dir, '.git')
    const wedged = await wedgedRelay(commonDir, crypto.randomBytes(16).toString('hex'))
    const started = Date.now()
    const mcp = await startMcp(dir)
    // A tool call made while the join is still failing waits for the ensure step instead of reporting "not in a room".
    const state = mcp.call('room_state')
    await mcp.waitFor(/could not sync/, 30_000)
    wedged.close() // the old owner exits (what a host restart does to the previous process)
    const closedAt = Date.now()
    await mcp.waitFor(/^room-mcp: ready$/, 20_000)
    const joinedAfter = Date.now() - closedAt
    const reply = await state
    expect(reply).toContain('you: Ada')
    expect(reply).not.toMatch(/not in a room|room_create/)
    expect(joinedAfter).toBeLessThan(10_000)
    const log = fs.readFileSync(path.join(commonDir, 'room-mcp.log'), 'utf8')
    expect(log).toMatch(/join attempt 1 failed \(sync\): could not sync/)
    expect(log).toMatch(/ready/)
    console.log(`joined ${joinedAfter}ms after the wedged owner left (${Date.now() - started}ms after start)`)
  }, 90_000)

  it('after room_join, a session whose relay is lost rejoins the room it chose on the next tool call; room_leave keeps it out', async () => {
    const dir = repo()
    const commonDir = path.join(dir, '.git')
    // The test runs the clone's relay, so the session is a client of it and can lose it.
    const owner = await ensureLocalRelay(commonDir, 'local/x', { watchMs: 60_000, log: () => {} })
    cleanups.push(() => owner.stop())
    const mcp = await startMcp(dir)
    await mcp.waitFor(/^room-mcp: ready$/, 30_000)
    expect(await mcp.call('room_join', { room: 'picked' })).toContain('joined local/picked as Ada')
    // Another clone's relay takes the port (what a host restart overnight can do).
    const port = owner.port
    await owner.stop()
    const foreign = await startRelay(port, { key: 'other-key', commonDir: fs.mkdtempSync(path.join(os.tmpdir(), 'room-autojoin-other-')) })
    cleanups.push(() => foreign.close())
    await mcp.waitFor(/another clone's relay; the session will join afresh/, 20_000)
    const lostAt = mcp.lines.length
    expect(await mcp.call('room_state')).toContain('you: Ada')
    expect(mcp.lines.slice(lostAt).join('\n')).toMatch(/Ada's agent joined local\/picked \(clone /)
    expect(await mcp.call('room_leave')).toMatch(/^left local\/picked/)
    expect(await mcp.call('room_state')).toBe('error: not in the local room; room_join to join it.')
  }, 90_000)
})

describe('AutoJoin (the ensure step)', () => {
  const fakeSession = (name = 's') => ({ name }) as unknown as Session
  const setup = (attempt: (target?: Session) => Promise<Session | undefined>, over: Partial<ConstructorParameters<typeof AutoJoin>[0]> = {}) => {
    let current: Session | null = null
    const reports: string[] = [], logs: string[] = [], discarded: Session[] = []
    const a = new AutoJoin({ attempt, local: true, delaysMs: [10], deadlineMs: 2000, retryAfterMs: 50,
      adopt: async s => { current = s }, discard: async s => { discarded.push(s) }, joined: () => current !== null,
      log: l => logs.push(l), report: l => reports.push(l), ...over })
    return { a, reports, logs, discarded, current: () => current }
  }

  it('concurrent callers share one run, and a joined session is not joined again', async () => {
    let calls = 0
    const t = setup(async () => { calls++; await new Promise(r => setTimeout(r, 30)); return fakeSession() })
    await Promise.all([t.a.ensure(), t.a.ensure(), t.a.ensure()])
    await t.a.ensure()
    expect(calls).toBe(1)
    expect(t.current()).not.toBeNull()
  })

  it('retries transient failures with backoff, then reports once with the step that failed and no team advice', async () => {
    let calls = 0
    const t = setup(async () => { calls++; throw Object.assign(new RoomdError('could not sync with ws://127.0.0.1:1/x within 15000ms', 1), { phase: 'sync' }) }, { deadlineMs: 200, delaysMs: [20, 40] })
    await t.a.ensure()
    expect(calls).toBeGreaterThan(2)
    expect(t.reports).toHaveLength(1)
    expect(t.reports[0]).toMatch(/^Room could not join the local room after \d+ attempts \(sync\): could not sync/)
    expect(t.reports[0]).not.toMatch(/teammate|room_create/)
    expect(t.logs[0]).toMatch(/^join attempt 1 failed \(sync\): could not sync .*; retrying in 0s$/)
    // A tool call right after a failed run does not start another; one after retryAfterMs does, and a second failure is not re-reported.
    const before = calls
    await t.a.ensure()
    expect(calls).toBe(before)
    await new Promise(r => setTimeout(r, 60))
    await t.a.ensure()
    expect(calls).toBeGreaterThan(before)
    expect(t.reports).toHaveLength(1)
    expect(t.a.failure).toMatch(/local room/)
  })

  it('does not retry what a human must fix, and stops for good', async () => {
    let calls = 0
    const t = setup(async () => { calls++; throw new NoRoom('github.com/o/r/main', 'no room for github.com/o/r/main yet', 'wss://x') }, { local: false })
    await t.a.ensure()
    await new Promise(r => setTimeout(r, 60))
    await t.a.ensure()
    expect(calls).toBe(1)
    expect(t.reports[0]).toBe('Room could not join: no room for github.com/o/r/main yet; use room_join.')
  })

  it('a cancel ends a pending run at once, and a session that arrives afterwards is left', async () => {
    let finish!: (s: Session) => void
    const t = setup(() => new Promise(r => { finish = r }))
    const run = t.a.ensure()
    t.a.cancel()
    await run
    const late = fakeSession('late')
    finish(late)
    await new Promise(r => setTimeout(r, 10))
    expect(t.current()).toBeNull()
    expect(t.discarded).toEqual([late])
    await t.a.ensure()
    expect(t.current()).toBeNull()
  })

  it('a room a human joined becomes the one meant: a stopped join resumes for it, and its failures are reported afresh', async () => {
    const targets: (Session | undefined)[] = []
    let fail = false
    const t = setup(async target => { targets.push(target); if (fail) throw new RoomdError('relay gone', 1); return fakeSession('rejoined') }, { local: false, deadlineMs: 50, delaysMs: [1000] })
    t.a.cancel()
    await t.a.ensure()
    expect(targets).toEqual([])
    const chosen = { name: 'chosen', local: {} } as unknown as Session
    t.a.retarget(chosen)
    await t.a.ensure()
    expect(targets).toEqual([chosen])
    expect(t.current()).toMatchObject({ name: 'rejoined' })
    // A retarget after a failed run clears it: the next call joins at once, and a new failure is reported with the chosen room's kind.
    fail = true
    const u = setup(async target => { targets.push(target); throw new RoomdError('relay gone', 1) }, { local: false, deadlineMs: 50, delaysMs: [1000], retryAfterMs: 60_000 })
    await u.a.ensure()
    expect(u.reports).toEqual(['Room could not join: relay gone; use room_join.'])
    u.a.retarget(chosen)
    expect(u.a.failure).toBeUndefined()
    await u.a.ensure()
    expect(u.reports[1]).toMatch(/^Room could not join the local room: relay gone\. Room tries again/)
  })

  it('a join that overruns the total deadline fails with that cause, and its late session is left', async () => {
    let finish!: (s: Session) => void
    const t = setup(() => new Promise(r => { finish = r }), { deadlineMs: 50, delaysMs: [1000] })
    await t.a.ensure()
    expect(t.reports[0]).toMatch(/did not finish within the 0s join deadline/)
    finish(fakeSession('late'))
    await new Promise(r => setTimeout(r, 10))
    expect(t.discarded).toHaveLength(1)
    expect(t.current()).toBeNull()
  })
})

describe('tools and the ensure step', () => {
  const handle = (failure?: string) => {
    const calls: string[] = []
    return { calls, failure, ensure: async () => { calls.push('ensure') }, settle: async () => { calls.push('settle') }, cancel: () => { calls.push('cancel') }, retarget: () => { calls.push('retarget') } }
  }
  it('every room tool ensures the join first; leaving ends the automatic join', async () => {
    const tools = createTools({ getSession: () => null, setSession: () => {}, cwd: os.tmpdir(), config: { server: LOCAL } as ResolvedConfig })
    const h = handle()
    tools.setAutoJoin(h)
    expect(await tools.call('room_state', {})).toBe('error: not in the local room; room_join to join it.')
    expect(h.calls).toEqual(['ensure'])
    await tools.call('room_leave', {})
    expect(h.calls).toEqual(['ensure', 'settle', 'cancel'])
  })
  it('names why the automatic join failed instead of generic advice', async () => {
    const tools = createTools({ getSession: () => null, setSession: () => {}, cwd: os.tmpdir(), config: { server: LOCAL } as ResolvedConfig })
    tools.setAutoJoin(handle('Room could not join the local room (relay): EACCES.'))
    expect(await tools.call('room_spawn', { tag: 'w', task: 't' })).toBe('error: not in a room. Room could not join the local room (relay): EACCES.')
  })
  it('drops a tool call cancelled while its automatic join is queued', async () => {
    let finish!: () => void
    const tools = createTools({ getSession: () => null, setSession: () => {}, cwd: os.tmpdir(), config: { server: LOCAL } as ResolvedConfig })
    const h = handle()
    h.ensure = () => new Promise<void>(resolve => { finish = resolve })
    tools.setAutoJoin(h)
    const controller = new AbortController()
    const call = tools.call('room_state', {}, controller.signal)
    controller.abort()
    finish()
    expect(await call).toBe('error: tool call cancelled')
  })
})

describe('room-mcp.log', () => {
  it('appends lines and rotates to a single .1 file past the cap, so it stays bounded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-log-'))
    const file = path.join(dir, 'room-mcp.log')
    for (let i = 0; i < 50; i++) appendRoomLog(file, `line ${i} ${'x'.repeat(20)}`, 200)
    const current = fs.readFileSync(file, 'utf8'), previous = fs.readFileSync(`${file}.1`, 'utf8')
    expect(current).toContain('line 49')
    expect(fs.statSync(file).size).toBeLessThan(200 + 40)
    expect(fs.statSync(`${file}.1`).size).toBeLessThan(200 + 40)
    expect(previous).not.toContain('line 49')
    expect(fs.readdirSync(dir).sort()).toEqual(['room-mcp.log', 'room-mcp.log.1'])
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})
