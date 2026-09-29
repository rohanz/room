// Room moves against a real team server (fake GitHub issuer): each room keeps its own name when Git and GitHub names differ.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCAL, joinSession, leaveSession, setCredential, type Session } from '../src/index.js'
import { createTools } from '../src/tools.js'
import { readChoice } from '../src/choice.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
let proc: ChildProcess, port = 0, dir = ''
const http = () => `http://127.0.0.1:${port}`
const post = (p: string, body: unknown) => fetch(`${http()}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeAll(async () => {
  port = await new Promise<number>((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) }) })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ROOM_') && k !== 'YPERSISTENCE') env[k] = v
  proc = spawn(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'packages/server/src/index.ts')], {
    env: { ...env, HOST: '127.0.0.1', PORT: String(port), GITHUB_CLIENT_ID: 'fake', NODE_ENV: 'test' }, stdio: 'ignore', // in memory
  })
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${http()}/health`)).ok) break } catch { /* starting */ } await new Promise(r => setTimeout(r, 100)) }
  const device = (await (await post('/auth/device', {})).json() as { device: string }).device
  const { session } = await (await post('/auth/poll', { device, fakeLogin: 'rohanz' })).json() as { session: string }
  setCredential(`ws://127.0.0.1:${port}`, { session, login: 'rohanz', at: Date.now() })
  expect((await post('/rooms', { room: 'github.com/rohanz/x', session, schema: 2 })).ok).toBe(true)
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-move-server-')))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Rohan'); git('config', 'user.email', 'r@r')
  git('remote', 'add', 'origin', 'https://github.com/rohanz/x.git')
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\n'); git('add', '.'); git('commit', '-qm', 'init')
}, 60_000)
afterAll(() => { proc?.kill(); if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

it('local, then team, then local again: the Git name locally, the GitHub login on the team server', async () => {
  const server = `ws://127.0.0.1:${port}`
  let session: Session | null = await joinSession({ dir, server: LOCAL })
  const tools = createTools({ cwd: dir, getSession: () => session, setSession: s => { session = s } })
  try {
    expect(session!.me.name).toBe('Rohan')
    const toTeam = await tools.call('room_join', { where: server })
    expect(toTeam).toContain('joined github.com/rohanz/x as rohanz')
    expect(session!.me.name).toBe('rohanz')
    expect((await readChoice(dir))?.where).toBe(server)
    const toLocal = await tools.call('room_join', { where: 'local' })
    expect(toLocal).toContain(`joined local/${path.basename(dir)} as Rohan`)
    expect(session!.me.name).toBe('Rohan')
    expect(await tools.call('room_join', { where: server })).toContain('as rohanz')
  } finally {
    await tools.shutdown()
    if (session) await leaveSession(session).catch(() => {})
  }
}, 90_000)

it('two branches share one repository room with distinct names, and a branch switch keeps its session', async () => {
  const server = `ws://127.0.0.1:${port}`
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-move-server-b-')))
  execFileSync('git', ['clone', '-q', dir, other], { stdio: 'pipe' })
  const git = (...a: string[]) => execFileSync('git', ['-C', other, ...a], { stdio: 'pipe' })
  git('remote', 'set-url', 'origin', 'https://github.com/rohanz/x.git'); git('config', 'user.name', 'Rohan'); git('config', 'user.email', 'r@r')
  git('checkout', '-q', '-b', 'feat')
  const sessions: Session[] = []
  let a: Session | null = null, b: Session | null = null
  try {
    // These are two host sessions; the fixture runs both in one test process.
    a = await joinSession({ dir, server, sessionId: 'branch-main' }); sessions.push(a)
    b = await joinSession({ dir: other, server, sessionId: 'branch-feat' }); sessions.push(b)
    expect(a.roomName).toBe('github.com/rohanz/x')
    expect(b.roomName).toBe('github.com/rohanz/x')
    expect(a.me.name).toBe('rohanz')
    expect(b.me.name).not.toBe('rohanz') // another checkout already holds the bare login
    const name = b.me.name
    const tools = createTools({ cwd: other, getSession: () => b, setSession: s => { b = s; if (s) sessions.push(s) } })
    git('checkout', '-q', 'main')
    const reply = await tools.call('room_state')
    expect(reply).toContain('github.com/rohanz/x')
    expect(b!.roomName).toBe('github.com/rohanz/x')
    expect(b!.me.name).toBe(name)
    expect(b).toBe(sessions[1]) // no branch-follow rejoin
    await tools.shutdown()
  } finally {
    for (const s of new Set(sessions)) await leaveSession(s).catch(() => {})
    fs.rmSync(other, { recursive: true, force: true })
  }
}, 90_000)
