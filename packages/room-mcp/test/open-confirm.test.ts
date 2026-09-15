import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTools } from '../src/tools.js'
vi.mock('@room/roomd', async original => ({
  ...await original<typeof import('@room/roomd')>(),
  startRoomd: vi.fn(async () => { throw new Error('reached daemon') }),
}))
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
