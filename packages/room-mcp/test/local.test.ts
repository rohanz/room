import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, onTestFinished, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import http from 'node:http'
import { deterministicPort } from '../../relay/src/index.js'
import { joinSession, leaveSession, resolveServer, captureCapClose, watchClosed, type Session } from '../src/session.js'
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
  it('shows an old canonical relay in join, state, and doctor (socket integration)', async () => {
    const clone = repo('room-old-relay-')
    const port = deterministicPort(join(clone, '.git'))
    const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, local: true })) })
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
    let session: Session | null = null
    const tools = createTools({ getSession: () => session, setSession: s => { session = s }, cwd: clone,
      join: async opts => { const s = await joinSession(opts); sessions.push(s); return s },
    })
    try {
      const reply = await tools.call('room_join', { where: 'local' })
      expect(reply).toContain("an older Room session still holds this room's relay")
      expect(await tools.call('room_state', {})).toContain("an older Room session still holds this room's relay")
      expect(await tools.call('room_state', { check: true })).toContain('WARN  canonical relay: an older Room session')
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  }, 60_000) // a join, a state and a doctor run take 9 to 13 s, and past 20 s when the run is starting its heaviest files
  it('resolves the server setting: unset/local → local, hosted → the hosted URL, else the URL', () => {
    expect(resolveServer(undefined)).toBe('local')
    expect(resolveServer('local')).toBe('local')
    expect(() => resolveServer('hosted')).toThrow('No team server configured')
    expect(resolveServer('ws://localhost:1234')).toBe('ws://localhost:1234')
  })

  it('accepts a custom name and reports the actual room in the reply, browser and state', async () => {
    // A checkout that has not built packages/web has no viewer file to link to; a configured web view always has one.
    vi.stubEnv('ROOM_WEB', 'http://localhost:5173')
    onTestFinished(() => { vi.unstubAllEnvs() })
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

  it('a local session refused for the size cap (4413) pauses publication, reconnects after a minute and clears once it holds', async () => {
    const s = await joinSession({ dir, server: 'local', room: 'local/sizecap', log: () => {} })
    sessions.push(s)
    const p = s.provider as unknown as { emit: (ev: string, args: unknown[]) => void; shouldConnect: boolean; wsconnected: boolean; synced: boolean }
    await vi.waitFor(() => expect(p.wsconnected && p.synced).toBe(true))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // What y-websocket emits for the relay's refusal; on its own it would never reconnect after a 44xx close.
      p.emit('connection-close', [{ code: 4413, reason: 'room is over its size cap (64 MB)' }, p])
      expect(s.rejected?.reason).toBe('room is over its size cap (64 MB)')
      expect(p.shouldConnect).toBe(false)
      vi.advanceTimersByTime(60_000)
      expect(p.shouldConnect).toBe(true)
    } finally { vi.useRealTimers() }
    // Back in, its publication is re-sent and the rejection clears.
    await vi.waitFor(() => expect(s.rejected).toBeUndefined(), { timeout: 15_000 })
    expect(p.wsconnected && p.synced).toBe(true)
  }, 30_000)

  it('a size-cap close during startup, before the session handler exists, is applied when it is installed', () => {
    // Startup publishes before watchClosed runs; y-websocket will not reconnect after a 44xx on its own.
    const listeners = new Map<string, Set<(e: unknown) => void>>()
    const p = { on: (ev: string, fn: (e: unknown) => void) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev)!.add(fn) },
      off: (ev: string, fn: (e: unknown) => void) => { listeners.get(ev)?.delete(fn) }, disconnect: vi.fn(), connect: vi.fn() }
    const take = captureCapClose(p)
    for (const fn of listeners.get('connection-close') ?? []) fn({ code: 4413, reason: 'room is over its size cap (64 MB)' })
    const setPublicationRejected = vi.fn()
    const s = { provider: p, roomName: 'local/x', roomUrl: 'ws://127.0.0.1:1/local%2Fx', daemon: { setPublicationRejected } } as unknown as Session
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      watchClosed(s, () => {}, take())
      expect(s.rejected?.reason).toBe('room is over its size cap (64 MB)')
      expect(setPublicationRejected).toHaveBeenCalledWith(true)
      vi.advanceTimersByTime(60_000)
      expect(p.connect).toHaveBeenCalled()
    } finally { vi.useRealTimers() }
    // The capture stops listening once taken; only the session handler remains.
    expect(listeners.get('connection-close')?.size).toBe(1)
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
    if (worker.browserUrl.startsWith('file:')) {
      expect(worker.browserUrl).toMatch(/^file:\/\/.+\/viewer\.html#room=/)
      expect(new URLSearchParams(new URL(worker.browserUrl).hash.slice(1)).get('room')).toBe(lead.roomUrl)
    } else expect(worker.browserUrl).toContain('not built')
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
