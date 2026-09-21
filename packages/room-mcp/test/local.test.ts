import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { joinSession, leaveSession, resolveServer, DEFAULT_SERVER, type Session } from '../src/session.js'
import { createTools } from '../src/tools.js'

let dir: string
const sessions: Session[] = []
/** Every ROOM_* variable a shell might carry (a worker's ROOM_TAG/ROOM_OWNER, a runner's ROOM_URL): cleared per test, restored after. */
const prevRoomEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ROOM_')))
const clearRoomEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith('ROOM_')) delete process.env[k] }

beforeEach(clearRoomEnv)
beforeAll(() => {
  clearRoomEnv()
  dir = mkdtempSync(join(tmpdir(), 'room-localjoin-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'Ada')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
})
afterEach(async () => {
  for (const s of sessions.splice(0)) { try { await leaveSession(s) } catch { /* ignore */ } }
})
afterAll(() => {
  clearRoomEnv()
  Object.assign(process.env, prevRoomEnv)
})

describe('local mode (no server)', () => {
  it('resolves the server setting: unset/local → local, hosted → the hosted URL, else the URL', () => {
    expect(resolveServer(undefined)).toBe('local')
    expect(resolveServer('local')).toBe('local')
    expect(resolveServer('hosted')).toBe(DEFAULT_SERVER)
    expect(resolveServer('ws://localhost:1234')).toBe('ws://localhost:1234')
  })

  it('accepts a custom name and reports the actual room in the reply, browser and state', async () => {
    let session: Session | null = null
    const tools = createTools({ getSession: () => session, setSession: s => { session = s }, cwd: dir,
      join: async opts => { const s = await joinSession(opts); sessions.push(s); return s },
    })
    const reply = await tools.call('room_join', { where: 'local', room: 'anything' })
    const name = 'local/anything'
    expect(reply.split('\n')[0]).toMatch(/^joined local\/anything /)
    expect(session!.roomName).toBe(name)
    expect(await tools.call('room_state', { link: true })).toContain(encodeURIComponent(encodeURIComponent(name)))
    expect((await tools.call('room_state', {})).split('\n')[1]).toContain(name)
  })

  it('preserves an explicit local worker room across branch overrides', async () => {
    const name = `local/${basename(dir)}/main`
    const s = await joinSession({ dir, server: 'local', room: name, localBranch: 'worker', tag: 'worker', log: () => {} })
    sessions.push(s)
    expect(s.roomName).toBe(name)
  })

  it('joins a local room without any server, names it after the clone, and a tagged second session shares it', async () => {
    const a = await joinSession({ dir, log: () => {} }); sessions.push(a)
    expect(a.local).toBeTruthy()
    expect(a.roomName).toBe(`local/${basename(dir)}/main`)
    expect(a.me).toMatchObject({ name: 'Ada', owner: 'Ada', kind: 'agent' })
    expect(a.roomUrl.startsWith('ws://127.0.0.1:')).toBe(true)
    expect(existsSync(join(dir, '.git', 'room-local.json'))).toBe(true)
    const b = await joinSession({ dir, tag: 'codex', log: () => {} }); sessions.push(b)
    expect(b.local?.owned).toBe(false)
    expect(b.me.name).toBe('Ada+codex')
    expect(b.roomUrl).toBe(a.roomUrl)
    // The tools describe the local room and refuse server-only operations gracefully.
    let s: Session | null = null
    const tools = createTools({ getSession: () => s, setSession: x => { s = x }, cwd: dir, join: async () => a, leave: async () => {} })
    const joined = await tools.call('room_join', {})
    expect(joined).toContain('local room (no server)')
    expect(await tools.call('room_login', {})).toContain('local rooms need no login')
    const st = await tools.call('room_state', { all: true })
    expect(st).toContain('Ada+codex')
    // Closing a local room forgets its saved history and leaves, so it comes last.
    expect(await tools.call('room_close', { confirm: true })).toContain('local room')
  })
})
