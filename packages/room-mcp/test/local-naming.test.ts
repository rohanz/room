import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { ensureLocalRelay } from '@room/relay'
import { NoLocalRelay } from '@room/relay'
import { realGitCommonDir } from '@room/roomd'
import { joinSession, type Session } from '../src/session.js'
import { createTools } from '../src/tools.js'
import { resolveConfig } from '../src/config.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'
import { registerWorkers } from './registry-fixture.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { chooseName, processToken } from '../src/names.js'

vi.mock('@room/relay', async importOriginal => ({ ...(await importOriginal() as object), ensureLocalRelay: vi.fn(async () => { throw new Error('relay boundary') }) }))
let dir: string
const dispose: (() => void)[] = []
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) vi.stubEnv(key, undefined)
  vi.mocked(ensureLocalRelay).mockClear()
  dir = mkdtempSync(join(tmpdir(), 'local-naming-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Ada', '-c', 'user.email=a@a', 'commit', '-q', '--allow-empty', '-m', 'init'])
})
afterEach(async () => { dispose.splice(0).forEach(fn => fn()); await closeRegistryForDir(dir); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it.each(['anything', 'my room!?', undefined])('normalizes the local relay room for %s without an origin', async room => {
  await expect(joinSession({ dir, server: 'local', name: 'Ada', room })).rejects.toThrow('relay boundary')
  expect(ensureLocalRelay).toHaveBeenCalledWith(expect.any(String), room === undefined ? `local/${basename(dir)}` : room === 'anything' ? 'local/anything' : 'local/myroom', expect.any(Object))
})
it('keeps an explicit local repository name on every branch', async () => {
  await expect(joinSession({ dir, server: 'local', name: 'Ada', room: 'local/lead' })).rejects.toThrow('relay boundary')
  expect(ensureLocalRelay).toHaveBeenCalledWith(expect.any(String), 'local/lead', expect.any(Object))
})
it('preserves the local room inherited through worker environment config', async () => {
  vi.stubEnv('ROOM_ROOM', 'local/lead')
  vi.stubEnv('ROOM_LEAD', 'Ada')
  const config = await resolveConfig({ dir, args: { server: 'local' } })
  await expect(joinSession({ dir, server: config.server, room: config.room, name: 'Ada' })).rejects.toThrow('relay boundary')
  expect(ensureLocalRelay).toHaveBeenCalledWith(expect.any(String), 'local/lead', expect.any(Object))
})

it('refuses a local worker from another repository before starting any relay', async () => {
  const other = mkdtempSync(join(tmpdir(), 'local-worker-other-'))
  dispose.push(() => rmSync(other, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', '-b', 'main', other])
  execFileSync('git', ['-C', other, '-c', 'user.name=Ada', '-c', 'user.email=a@a', 'commit', '-q', '--allow-empty', '-m', 'init'])
  await expect(joinSession({ dir, server: 'local', name: 'Ada', leadClone: await realGitCommonDir(other) })).rejects.toThrow('another repository than its lead')
  expect(ensureLocalRelay).not.toHaveBeenCalled()
})

it('a local worker without a named lead clone only joins an existing relay', async () => {
  vi.mocked(ensureLocalRelay).mockRejectedValueOnce(new NoLocalRelay('local/lead'))
  await expect(joinSession({ dir, server: 'local', name: 'Ada', joinOnly: true })).rejects.toThrow('cannot start one')
  expect(ensureLocalRelay).toHaveBeenCalledWith(expect.any(String), `local/${basename(dir)}`, expect.objectContaining({ joinOnly: true }))
})

it('keeps distinct Codex labels for several sessions in one checkout', async () => {
  const doc = new Y.Doc(), room = new RoomDoc(doc)
  dispose.push(() => doc.destroy())
  const commonDir = await realGitCommonDir(dir)
  const take = (sessionId: string) => {
    const token = processToken(sessionId)
    return chooseName({ dir, commonDir, roomKey: 'local/name-test', owner: 'Ada', host: 'codex', doc: room, token,
      holder: { sessionId, pid: token.pid, startTime: token.startTime, executable: token.executable } })
  }
  expect((await take('codex-one')).name).toBe('Ada')
  expect((await take('codex-two')).name).toBe('Ada+codex')
  expect((await take('codex-three')).name).toBe('Ada+codex-2')
})
it.each(['local', 'team'])('reports the actual %s name and preserves team arguments', async where => {
  if (where === 'team') vi.stubGlobal('fetch', vi.fn(async (url: string) => new URL(url).pathname === '/auth/config'
    ? Response.json({}) : Response.json({ view: 'v', hub: 1 })))
  const doc = new Y.Doc(), room = new RoomDoc(doc), awareness = new Awareness(doc)
  dispose.push(() => { awareness.destroy(); doc.destroy() })
  const name = where === 'local' ? 'local/anything' : 'anything'
  const roomUrl = `ws://127.0.0.1:1/${encodeURIComponent(name)}`
  let session: Session | null = null
  const fake = {
    dir, room, awareness, roomName: name, roomUrl, browserUrl: `http://localhost/?room=${encodeURIComponent(roomUrl)}`,
    me: { name: 'Ada', kind: 'agent' }, ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true, awareness },
    daemon: { touch() {}, async stop() {} }, shareMax: 'full', shareRequested: 'full',
    ...(where === 'local' ? { local: { url: 'ws://127.0.0.1:1' } } : {}),
  } as Session
  const joiner = vi.fn(async () => fake)
  const tools = createTools({ cwd: dir, getSession: () => session, setSession: s => { session = s }, join: joiner, leave: async () => {} })
  const reply = await tools.call('room_join', { where: where === 'local' ? where : 'wss://team.example', room: 'anything' })
  expect(joiner).toHaveBeenCalledWith(expect.objectContaining({ room: where === 'local' ? 'local/anything' : 'anything', server: where === 'local' ? 'local' : 'wss://team.example' }))
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

it.each([{ name: 'A\u0000B' }, { name: 'A\nB' }, { name: 'Ada', tag: 'bad\u0000tag' }])('rejects control characters in participant identity before relay setup', async identity => {
  await expect(joinSession({ dir, server: 'local', room: 'demo', ...identity })).rejects.toThrow(/control character/i)
  expect(ensureLocalRelay).not.toHaveBeenCalled()
})

function transitionTools() {
  let session: Session | null = null
  const joiner = vi.fn(async (opts: { room?: string }) => {
    const doc = new Y.Doc(), room = new RoomDoc(doc), awareness = new Awareness(doc)
    dispose.push(() => { awareness.destroy(); doc.destroy() })
    const name = opts.room!, roomUrl = 'ws://127.0.0.1:1/' + encodeURIComponent(name)
    return { dir, room, awareness, roomName: name, roomUrl,
      browserUrl: 'http://localhost/?room=' + encodeURIComponent(roomUrl),
      me: { name: 'Ada', kind: 'agent' }, ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true, awareness },
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
  await registerWorkers(cur, [{ tag: 'w', name: 'Ada+w', host: 'codex', task: 'x', dir, branch: 'room/w', pid: 0, startedAt: Date.now(), status: 'running', lead: 'Ada' }])
  expect(await t.tools.call('room_join', { where: 'local' })).toBe("You have 1 worker(s) (w). Collect or discard them first (room_collect, or room_collect discard=true), then move rooms. You're still in this machine's local room (local/custom), which works for agents on this computer.")
  expect(t.current()).toBe(cur)
  expect(t.joiner).toHaveBeenCalledTimes(1)
  expect(t.leave).not.toHaveBeenCalled()
})

it('moves alone without a browser link, available on explicit request', async () => {
  const t = transitionTools()
  await t.tools.call('room_join', { where: 'local', room: 'custom' })
  const old = t.current()
  const reply = await t.tools.call('room_join', { where: 'local' })
  const name = 'local/' + basename(dir)
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
  await registerWorkers(cur, [{ tag: 'w', name: 'Ada+w', host: 'codex', task: 'x', dir, branch: 'room/w', pid: 0, startedAt: Date.now(), status: 'running', lead: 'Ada' }])
  const reply = await t.tools.call('room_join', { where: 'local', room: 'local/custom' })
  expect(t.current()).toBe(cur)
  expect(t.joiner).toHaveBeenCalledTimes(1)
  expect(t.leave).not.toHaveBeenCalled()
  expect(cur.room.scope('Ada')).toEqual(scope)
  expect(reply.split('\n')[1]).toContain('local/custom')
  expect(reply).not.toContain('browser view:')
  expect(await t.tools.call('room_state', { link: true })).toContain('browser view: ' + cur.browserUrl)
  expect(reply).not.toContain('moved from')
})
