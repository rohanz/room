import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { createTools } from '../src/tools.js'
import { getCredential } from '../src/credentials.js'
import { DEFAULT_SERVER, NotLoggedIn, type JoinOptions, type Session } from '../src/session.js'

let dir: string
const dispose: (() => void | Promise<void>)[] = []

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) vi.stubEnv(key, undefined)
  dir = mkdtempSync(join(tmpdir(), 'room-join-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Ada'])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'ada@example.com'])
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-qm', 'init'])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:example/repo.git'])
})

afterEach(async () => {
  for (const fn of dispose.splice(0).reverse()) await fn()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

function session(roomName: string, options: { local?: boolean; share?: 'full' | 'declared' | 'intent'; pinned?: boolean } = {}): Session {
  const doc = new Y.Doc(), room = new RoomDoc(doc), awareness = new Awareness(doc)
  dispose.push(() => { awareness.destroy(); doc.destroy() })
  const share = options.share ?? 'full'
  const roomUrl = `${options.local ? 'ws://local' : 'ws://team'}/${encodeURIComponent(roomName)}`
  const daemon = { share, touch() {}, async stop() {}, async setShare(level: typeof share) { daemon.share = level }, skipped: () => ({ share: [], size: [], budget: [], ignore: [] }) }
  return {
    dir, room, awareness, roomName, roomUrl, browserUrl: 'http://example/view',
    me: { name: 'Ada+privacy', owner: 'Ada', label: 'privacy', kind: 'agent' },
    provider: { synced: true, awareness }, daemon, shareMax: 'full', shareRequested: share,
    ...(options.local ? { local: { url: 'ws://local' } } : {}),
    ...(options.pinned ? { pinnedRoom: true } : {}),
  } as Session
}

function branchTools(current: Session) {
  let active: Session | null = current
  const joiner = vi.fn(async (opts: JoinOptions) => session(opts.room ?? 'github.com/example/repo/main', { share: opts.share as 'full' | 'declared' | 'intent', pinned: true }))
  const leave = vi.fn(async () => {})
  const tools = createTools({
    cwd: dir,
    config: { credentialsPath: join(dir, 'credentials.json') } as never,
    getSession: () => active,
    setSession: s => { active = s },
    join: joiner,
    leave,
  })
  dispose.push(() => tools.shutdown())
  return { tools, joiner, leave, active: () => active }
}

it('compares the complete slash-containing branch before deciding to move', async () => {
  execFileSync('git', ['-C', dir, 'switch', '-qc', 'feature/x'])
  const current = session('github.com/a/b/feature/x', { share: 'intent' })
  const t = branchTools(current)
  await t.tools.call('room_state', {})
  expect(t.joiner).not.toHaveBeenCalled()
  expect(t.active()).toBe(current)
})

it('follows a slash-containing branch without widening sharing or dropping identity and credentials', async () => {
  execFileSync('git', ['-C', dir, 'switch', '-qc', 'feature/x'])
  const current = session('github.com/a/b/main', { share: 'intent' })
  current.token = 'private-token'
  const t = branchTools(current)
  const out = await t.tools.call('room_state', {})
  expect(out).toContain('joined github.com/a/b/feature/x')
  expect(t.joiner).toHaveBeenCalledWith(expect.objectContaining({
    room: 'github.com/a/b/feature/x', share: 'intent', name: 'Ada', tag: 'privacy',
    credentialsPath: join(dir, 'credentials.json'), token: 'private-token',
  }))
  expect(t.active()?.pinnedRoom).toBeUndefined()
  expect(t.leave).toHaveBeenCalledWith(current)
})

it('says once and stays when an automatic branch move would strand a running worker', async () => {
  execFileSync('git', ['-C', dir, 'switch', '-qc', 'feature/x'])
  const current = session('github.com/a/b/main', { share: 'intent' })
  current.room.setWorker({ tag: 'w', name: 'Ada+privacy+w', host: 'codex', task: 'x', dir, branch: 'room/w', pid: process.pid, startedAt: Date.now(), status: 'running', lead: current.me.name })
  const t = branchTools(current)
  const first = await t.tools.call('room_state', {})
  const second = await t.tools.call('room_state', {})
  expect(first).toContain('1 worker(s) are running')
  expect(first).toContain('staying in github.com/a/b/main')
  expect(second).not.toContain('worker(s) are running')
  expect(t.joiner).not.toHaveBeenCalled()
  expect(t.leave).not.toHaveBeenCalled()
  expect(t.active()).toBe(current)
})

it('room_create never returns local state through the same-room fast path', async () => {
  const current = session(`local/${dir.split('/').pop()}/main`, { local: true })
  const t = branchTools(current)
  const out = await t.tools.call('room_create', { confirm: true })
  expect(out).toContain('opened and joined')
  expect(t.active()).not.toBe(current)
  expect(t.joiner).toHaveBeenCalledWith(expect.objectContaining({ server: DEFAULT_SERVER, create: true, confirm: true }))
})

it('carries a requested custom destination through login and back to join', async () => {
  const server = 'ws://custom.example'
  vi.stubEnv('ROOM_CREDENTIALS', join(dir, 'credentials.json'))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/auth/config') return Response.json({ github: 'device' })
    if (path === '/auth/start') return Response.json({ user_code: 'CODE', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0, device: 'dev' })
    if (path === '/auth/poll') return Response.json({ session: 's'.repeat(64), login: 'Ada', expiresIn: 900 })
    throw new Error(`unexpected ${path}`)
  }))
  let active: Session | null = session(`local/${dir.split('/').pop()}/main`, { local: true })
  const joiner = vi.fn(async (opts: JoinOptions) => {
    if (!getCredential(server)) throw new NotLoggedIn(server)
    return session(opts.room!)
  })
  const tools = createTools({ cwd: dir, getSession: () => active, setSession: s => { active = s }, join: joiner, leave: async () => {} })
  dispose.push(() => tools.shutdown())

  const refused = await tools.call('room_join', { where: server, room: 'git/example/repo/main' })
  expect(refused).toContain(`room_login server="${server}"`)
  expect(await tools.call('room_login', { server })).toContain('CODE')
  expect(await tools.call('room_login', { server, wait: 5 })).toContain('logged in')
  expect(await tools.call('room_join', { where: server, room: 'git/example/repo/main' })).toContain('joined git/example/repo/main')
  expect(joiner.mock.calls.map(([opts]) => opts.server)).toEqual([server, server])
})
