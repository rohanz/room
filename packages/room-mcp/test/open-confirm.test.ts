import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTools, DEFS } from '../src/tools.js'
import { deriveRoomName } from '../src/session.js'
vi.mock('@room/roomd', async original => ({
  ...await original<typeof import('@room/roomd')>(),
  startRoomd: vi.fn(async () => { throw new Error('reached daemon') }),
}))
// The join's probe connection syncs at once and finds no hub, so the join goes on (paused) to the daemon.
vi.mock('y-websocket', async () => {
  const { EventEmitter } = await import('node:events')
  const { Awareness } = await import('y-protocols/awareness')
  return { WebsocketProvider: class extends EventEmitter { synced = true; awareness: InstanceType<typeof Awareness>; constructor(_u: string, _r: string, doc: import('yjs').Doc) { super(); this.awareness = new Awareness(doc) } destroy() {} } }
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
function server(open: boolean) {
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
    const path = new URL(url).pathname
    if (path === '/auth/config') return Response.json({ mode: 'token', providers: [] })
    if (path === '/view-token') return open ? Response.json({}) : new Response('not opened', { status: 404 })
    if (path === '/rooms' && opts?.method === 'POST') { posts.push(path); open = true; return Response.json({}) }
    throw new Error(`unexpected ${path}`)
  }))
  vi.stubEnv('ROOM_TAG', 'test')
  return { posts, tools: createTools({ cwd: process.cwd(), getSession: () => null, setSession: () => {} }) }
}
const args = { where: 'team', room: 'o/r/main', name: 'test' }
describe('opening requires user consent', () => {
  it('asks the Claude host to confirm create and close on every call', () => {
    for (const name of ['room_create', 'room_close']) {
      expect(DEFS.find(d => d.name === name)?._meta).toEqual({ 'anthropic/requiresUserInteraction': true })
    }
  })
  it('offers an unopened team repo without opening it', async () => {
    const { tools, posts } = server(false)
    expect(await tools.call('room_join', args)).toBe('No room for o/r on wss://room-rohanz.fly.dev yet. Ask the user whether to open one (anyone with push access can; after that every branch of the repo has a room and sessions join automatically). Call room_create with confirm=true only after they say yes.')
    expect(posts).toEqual([])
  })
  it.each([undefined, false])('refuses creating without true confirmation (%s)', async confirm => {
    const { tools, posts } = server(false)
    expect(await tools.call('room_create', { ...args, confirm })).toBe('error: room_create opens this repo for everyone with push access; call with confirm=true only after the user has agreed')
    expect(posts).toEqual([])
  })
  it('opens with confirmation and proceeds to join', async () => {
    const { tools, posts } = server(false)
    expect(await tools.call('room_create', { ...args, confirm: true })).toBe('error: reached daemon')
    expect(posts).toEqual(['/rooms'])
  })
  it('joins an already-open repo without confirmation or a create request', async () => {
    const { tools, posts } = server(true)
    expect(await tools.call('room_create', args)).toBe('error: reached daemon')
    expect(posts).toEqual([])
  })
})

describe('closing without a joined session', () => {
  it('closes the derived team repo with the caller\'s auth after confirmation', async () => {
    vi.stubEnv('ROOM_SERVER', 'ws://room.test:1234')
    vi.stubEnv('ROOM_TOKEN', 'close-secret')
    // A clone with a fixed non-GitHub origin: the result must not depend on the repository running the tests.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-close-'))
    execFileSync('git', ['init', '-q', '-b', 'main', dir])
    execFileSync('git', ['-C', dir, '-c', 'user.name=Room Test', '-c', 'user.email=room@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'])
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://git.example.com/team/app.git'])
    const roomName = (await deriveRoomName(dir)).roomName!
    const closes: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
      if (new URL(url).pathname === '/auth/config') return Response.json({ providers: [] })
      if (new URL(url).pathname === '/rooms' && opts?.method === 'DELETE') {
        closes.push(JSON.parse(String(opts.body)) as Record<string, unknown>)
        return Response.json({ closed: [roomName] })
      }
      throw new Error(`unexpected ${url}`)
    }))
    const tools = createTools({ cwd: dir, getSession: () => null, setSession: () => {} })
    expect(await tools.call('room_close', {})).toContain('confirm=true')
    expect(closes).toEqual([])
    expect(await tools.call('room_close', { confirm: true })).toContain(`closed ${roomName.slice(0, roomName.lastIndexOf('/'))} for everyone without joining`)
    expect(closes).toEqual([{ room: roomName, token: 'close-secret' }])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports nothing to close in an unjoined local room', async () => {
    vi.stubEnv('ROOM_SERVER', 'local')
    const tools = createTools({ cwd: process.cwd(), getSession: () => null, setSession: () => {} })
    expect(await tools.call('room_close', { confirm: true })).toBe('error: not in a local room; nothing to close without joining')
  })

  it('gives login guidance before closing a team room', async () => {
    vi.stubEnv('ROOM_SERVER', 'ws://room-login.test:1234')
    vi.stubEnv('ROOM_ROOM', 'github.com/o/r/main')
    vi.stubEnv('ROOM_TOKEN', '')
    const close = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (new URL(url).pathname === '/auth/config') return Response.json({ github: 'device' })
      close()
      throw new Error(`unexpected ${url}`)
    }))
    const tools = createTools({ cwd: process.cwd(), getSession: () => null, setSession: () => {} })
    expect(await tools.call('room_close', { confirm: true })).toContain('Call room_login server="ws://room-login.test:1234"')
    expect(close).not.toHaveBeenCalled()
  })
})

