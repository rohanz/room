import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { ensureLocalRelay } from '@room/relay'
import { joinSession, type Session } from '../src/session.js'
import { createTools } from '../src/tools.js'
import { resolveConfig } from '../src/config.js'

vi.mock('@room/relay', () => ({ ensureLocalRelay: vi.fn(async () => { throw new Error('relay boundary') }) }))
let dir: string
const dispose: (() => void)[] = []
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) vi.stubEnv(key, undefined)
  vi.mocked(ensureLocalRelay).mockClear()
  dir = mkdtempSync(join(tmpdir(), 'local-naming-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
})
afterEach(() => { dispose.splice(0).forEach(fn => fn()); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs() })

it.each(['anything', 'my room!?', undefined])('normalizes the local relay room for %s without an origin', async room => {
  await expect(joinSession({ dir, server: 'local', name: 'Ada', room })).rejects.toThrow('relay boundary')
  expect(ensureLocalRelay).toHaveBeenCalledWith(expect.any(String), room === undefined ? `local/${basename(dir)}/main` : room === 'anything' ? 'local/anything' : 'local/myroom', expect.any(Object))
})
it('keeps a worker/bridge local name even when its branch differs', async () => {
  await expect(joinSession({ dir, server: 'local', name: 'Ada', room: 'local/lead/main', localBranch: 'worker' })).rejects.toThrow('relay boundary')
  expect(ensureLocalRelay).toHaveBeenCalledWith(expect.any(String), 'local/lead/main', expect.any(Object))
})
it('preserves the local room inherited through worker environment config', async () => {
  vi.stubEnv('ROOM_ROOM', 'local/lead/main')
  vi.stubEnv('ROOM_LEAD', 'Ada')
  const config = await resolveConfig({ dir, args: { server: 'local' } })
  await expect(joinSession({ dir, server: config.server, room: config.room, name: 'Ada', localBranch: 'worker' })).rejects.toThrow('relay boundary')
  expect(ensureLocalRelay).toHaveBeenCalledWith(expect.any(String), 'local/lead/main', expect.any(Object))
})
it.each(['local', 'team'])('reports the actual %s name and preserves team arguments', async where => {
  const doc = new Y.Doc(), room = new RoomDoc(doc), awareness = new Awareness(doc)
  dispose.push(() => { awareness.destroy(); doc.destroy() })
  const name = where === 'local' ? 'local/anything' : 'anything'
  const roomUrl = `ws://127.0.0.1:1/${encodeURIComponent(name)}`
  let session: Session | null = null
  const fake = {
    dir, room, awareness, roomName: name, roomUrl, browserUrl: `http://localhost/?room=${encodeURIComponent(roomUrl)}`,
    pinnedRoom: true, me: { name: 'Ada', kind: 'agent' }, provider: { synced: true, awareness },
    daemon: { touch() {}, async stop() {} }, shareMax: 'full', shareRequested: 'full',
    ...(where === 'local' ? { local: { url: 'ws://127.0.0.1:1' } } : {}),
  } as Session
  const joiner = vi.fn(async () => fake)
  const tools = createTools({ cwd: dir, getSession: () => session, setSession: s => { session = s }, join: joiner, leave: async () => {} })
  const reply = await tools.call('room_join', { where, room: 'anything' })
  expect(joiner).toHaveBeenCalledWith(expect.objectContaining({ room: where === 'local' ? 'local/anything' : 'anything', server: where === 'local' ? 'local' : 'wss://room-rohanz.fly.dev' }))
  if (where === 'local') {
    expect(reply.split('\n')[0]).toMatch(/^joined local\/anything /)
    expect(reply).not.toContain('browser view:')
    expect(await tools.call('room_state', { link: true })).toContain(encodeURIComponent(encodeURIComponent(name)))
    expect((await tools.call('room_state', {})).split('\n')[1]).toContain(name)
  } else {
    expect(reply).toMatch(/^joined anything /m)
    expect(reply).not.toContain('ignored room=')
  }
  await tools.call('room_leave', {})
})

it.each(['', '   ', '!@#$'])('rejects empty sanitized local name %j', async room => {
  await expect(joinSession({ dir, server: 'local', name: 'Ada', room })).rejects.toThrow('local room name must not be empty')
  expect(ensureLocalRelay).not.toHaveBeenCalled()
})

function transitionTools() {
  let session: Session | null = null
  const joiner = vi.fn(async (opts: { room?: string }) => {
    const doc = new Y.Doc(), room = new RoomDoc(doc), awareness = new Awareness(doc)
    dispose.push(() => { awareness.destroy(); doc.destroy() })
    const name = opts.room!, roomUrl = 'ws://127.0.0.1:1/' + encodeURIComponent(name)
    return { dir, room, awareness, roomName: name, roomUrl,
      browserUrl: 'http://localhost/?room=' + encodeURIComponent(roomUrl), pinnedRoom: true,
      me: { name: 'Ada', kind: 'agent' }, provider: { synced: true, awareness },
      daemon: { touch() {}, async stop() {} }, shareMax: 'full', shareRequested: 'full',
      local: { url: 'ws://127.0.0.1:1' },
    } as Session
  })
  const leave = vi.fn(async () => {})
  const tools = createTools({ cwd: dir, getSession: () => session, setSession: s => { session = s }, join: joiner, leave })
  dispose.push(() => { void tools.shutdown() })
  return { tools, joiner, leave, current: () => session! }
}

it('refuses to strand running workers and preserves the session and link', async () => {
  const t = transitionTools()
  await t.tools.call('room_join', { where: 'local', room: 'custom' })
  const cur = t.current()
  cur.room.setWorker({ tag: 'w', name: 'Ada+w', host: 'codex', task: 'x', dir, branch: 'room/w', pid: 0, startedAt: Date.now(), status: 'running', lead: 'Ada' })
  expect(await t.tools.call('room_join', { where: 'local' })).toBe('error: 1 worker(s) are running in local/custom; they would be left behind. Wait for them, room_collect(discard=true) them, or stay in this room.')
  expect(t.current()).toBe(cur)
  expect(t.joiner).toHaveBeenCalledTimes(1)
  expect(t.leave).not.toHaveBeenCalled()
  cur.room.workers.clear()
})

it('moves alone without a browser link, available on explicit request', async () => {
  const t = transitionTools()
  await t.tools.call('room_join', { where: 'local', room: 'custom' })
  const old = t.current()
  const reply = await t.tools.call('room_join', { where: 'local' })
  const name = 'local/' + basename(dir) + '/main'
  expect(reply.split('\n')[0]).toBe('moved from local/custom to ' + name + '; links to the old room no longer show this session.')
  expect(t.leave).toHaveBeenCalledWith(old)
  expect(t.current()).not.toBe(old)
  expect(reply).not.toContain('browser view:')
  expect(await t.tools.call('room_state', { link: true })).toContain('browser view: ' + t.current().browserUrl)
  expect(reply).not.toContain(old.browserUrl)
  expect((await t.tools.call('room_state', {})).split('\n')[1]).toContain(name)
})

it('same-room rejoin is a no-op even with a running worker, preserving scope', async () => {
  const t = transitionTools()
  await t.tools.call('room_join', { where: 'local', room: 'custom' })
  const cur = t.current()
  await t.tools.call('room_scope', { area: 'test', summary: 'keep', paths: [] })
  const scope = cur.room.scope('Ada')
  cur.room.setWorker({ tag: 'w', name: 'Ada+w', host: 'codex', task: 'x', dir, branch: 'room/w', pid: 0, startedAt: Date.now(), status: 'running', lead: 'Ada' })
  const reply = await t.tools.call('room_join', { where: 'local', room: 'local/custom' })
  expect(t.current()).toBe(cur)
  expect(t.joiner).toHaveBeenCalledTimes(1)
  expect(t.leave).not.toHaveBeenCalled()
  expect(cur.room.scope('Ada')).toEqual(scope)
  expect(reply.split('\n')[1]).toContain('local/custom')
  expect(reply).toContain('browser view: ' + cur.browserUrl)
  expect(reply).not.toContain('moved from')
  cur.room.workers.clear()
})
