import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { joinSession, leaveSession, resolveServer, DEFAULT_SERVER, type Session } from '../src/session.js'
import { createTools } from '../src/tools.js'

let dir: string
const sessions: Session[] = []
/** Every ROOM_* variable a shell might carry (a worker's ROOM_TAG/ROOM_OWNER, a runner's ROOM_URL): cleared per test, restored after. */
const prevRoomEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ROOM_')))
const clearRoomEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith('ROOM_')) delete process.env[k] }

/** A one-commit repository on main whose user is Ada. */
function repo(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  const git = (...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'Ada')
  writeFileSync(join(d, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  return d
}

beforeEach(clearRoomEnv)
beforeAll(() => {
  clearRoomEnv()
  dir = repo('room-localjoin-')
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

  it('preserves an explicit local room for a worker', async () => {
    const name = `local/${basename(dir)}`
    const s = await joinSession({ dir, server: 'local', room: name, tag: 'worker', log: () => {} })
    sessions.push(s)
    expect(s.roomName).toBe(name)
  })

  it('a dispatched worker joins its lead\'s relay from a worktree of the clone, and never starts a relay in another repository', async () => {
    const room = `local/${basename(dir)}`
    const lead = await joinSession({ dir, server: 'local', room, name: 'Ada', log: () => {} }); sessions.push(lead)
    const other = repo('room-localjoin-other-')
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString()
    // The older launcher had no ROOM_LEAD_CLONE, so it can join only an existing relay.
    await expect(joinSession({ dir: other, room, server: 'local', name: 'Ada', tag: 'w', joinOnly: true, log: () => {} })).rejects.toThrow(`your lead's room ${room} has no relay running for ${other}`)
    expect(existsSync(join(other, '.git', 'room', 'relay.json'))).toBe(false)
    const wt = join(mkdtempSync(join(tmpdir(), 'room-localjoin-wt-')), 'w')
    git(dir, 'worktree', 'add', '-q', '-b', 'room/w', wt)
    const worker = await joinSession({ dir: wt, room, server: 'local', name: 'Ada', tag: 'w', joinOnly: true, log: () => {} }); sessions.push(worker)
    expect(worker.local?.owned).toBe(false)
    expect(worker.roomUrl).toBe(lead.roomUrl)
    expect(worker.browserUrl.startsWith(`${lead.local!.httpUrl}/#room=${encodeURIComponent(lead.roomUrl)}&`)).toBe(true)
  })

  it('a worker in its lead\'s clone starts the relay when the lead\'s relay is gone', async () => {
    const clone = repo('room-localjoin-dead-')
    const room = `local/${basename(clone)}`
    // The lead crashed before this worker joined; the canonical common dir proves authority.
    const wt = join(mkdtempSync(join(tmpdir(), 'room-localjoin-wt-')), 'w')
    execFileSync('git', ['-C', clone, 'worktree', 'add', '-q', '-b', 'room/w', wt], { stdio: 'pipe' })
    const worker = await joinSession({ dir: wt, room, server: 'local', name: 'Ada', tag: 'w', leadClone: realpathSync(join(clone, '.git')), log: () => {} }); sessions.push(worker)
    expect(worker.local?.owned).toBe(true)
    expect(worker.roomName).toBe(room)
  })

  it('a worker in another repository than its lead\'s is refused for good, and never touches that repository\'s relay', async () => {
    const other = repo('room-localjoin-elsewhere-')
    const room = `local/${basename(dir)}`
    const theirs = await joinSession({ dir: other, server: 'local', name: 'Bo', log: () => {} }); sessions.push(theirs)
    const lines: string[] = []
    const joined = joinSession({ dir: other, room, server: 'local', name: 'Ada', tag: 'w', leadClone: realpathSync(join(dir, '.git')), log: line => lines.push(line) })
    joined.then(s => sessions.push(s), () => {})
    await expect(joined).rejects.toMatchObject({ code: 2, message: `this worker is in ${other}, another repository than its lead's (${realpathSync(join(dir, '.git'))}); it cannot join the lead's local room. Start a lead in ${other} instead.` })
    expect(lines.filter(l => /relay/.test(l))).toEqual([])
    expect([...theirs.awareness.getStates().values()].map(state => state.user?.name)).toEqual(['Bo'])
  })

  it('joins a local room without any server, names it after the clone, and a tagged second session shares it', async () => {
    const a = await joinSession({ dir, log: () => {} }); sessions.push(a)
    expect(a.local).toBeTruthy()
    expect(a.roomName).toBe(`local/${basename(dir)}`)
    expect(a.me).toMatchObject({ name: 'Ada', owner: 'Ada', kind: 'agent' })
    expect(a.roomUrl.startsWith('ws://127.0.0.1:')).toBe(true)
    expect(existsSync(join(dir, '.git', 'room', 'relay.json'))).toBe(true)
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
