import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { CURRENT_COMPAT, SETTLE_MS } from '@room/hub-core'
import * as shared from '@room/shared'
import { docGeneration, roomConnection } from '@room/shared'
import { authorizedWebSocket } from '../../roomd/src/ws-auth.js'
import { memoryFile, RoomMemory } from '../src/memory.js'
import { startLocalDaemon, type StartedLocalDaemon } from '../src/daemon.js'

const dirs: string[] = [], daemons: StartedLocalDaemon[] = [], providers: WebsocketProvider[] = []
const room = 'local/compact'
afterEach(async () => {
  for (const p of providers.splice(0)) { p.destroy(); p.doc.destroy() }
  vi.restoreAllMocks()
  for (const d of daemons.splice(0)) await d.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
async function start(dir: string, now: () => number = () => 0) {
  const d = (await startLocalDaemon({ commonDir: dir, room, now, idleCheckMs: 10, finalSaveRetryMs: [] }))!
  daemons.push(d); return d
}
function common() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-daemon-')); dirs.push(d); return d }
function connect(d: StartedLocalDaemon, gen: string | null, doc = new Y.Doc(), targetRoom = room) {
  const p = new WebsocketProvider(`ws://127.0.0.1:${d.info.port}`, encodeURIComponent(targetRoom), doc, {
    WebSocketPolyfill: authorizedWebSocket({ key: d.info.key, negotiation: { offer: { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, 'room.daemon': [1] }, requiredCapabilities: { 'room.daemon': [1] } }, sessionId: `test-${doc.clientID}` } }) as never,
    ...roomConnection(doc), params: { schema: '2', negotiate: '1', ...(gen === null ? {} : { gen }) },
  })
  providers.push(p); return p
}
it.each(['fresh', 'current', 'stale', 'absent'])('snapshot generation gate: %s', async kind => {
  const dir = common(), memory = new RoomMemory(dir, room)
  expect(memory.save('compacted')).toBeUndefined(); memory.detach(); memory.doc.destroy()
  const d = await start(dir), generation = docGeneration(d.relay.hubRoom(room)!.doc.doc)
  expect(generation).toBeTruthy()
  const p = connect(d, kind === 'current' ? generation! : kind === 'absent' ? null : kind)
  if (kind === 'fresh' || kind === 'current') await vi.waitFor(() => expect(p.synced).toBe(true))
  else {
    let code: number | undefined
    p.on('connection-close', (e: { code: number }) => { code = e.code })
    await vi.waitFor(() => expect(code).toBe(kind === 'absent' ? 4403 : 4409))
    expect(p.synced).toBe(false)
  }
})
it('saves and stops over threshold, refuses the old replica, and serves a small fresh copy without looping', async () => {
  vi.stubEnv('ROOM_COMPACT_MIN_DELETED', '100')
  let now = 0
  const dir = common(), first = await start(dir, () => now)
  const p = connect(first, 'fresh'); await vi.waitFor(() => expect(p.synced).toBe(true))
  const doc = first.relay.hubRoom(room)!.doc.doc
  for (let i = 0; i < 500; i++) { doc.getMap('claims').set(String(i), {}); doc.getMap('claims').delete(String(i)) }
  const size = Y.encodeStateAsUpdate(doc).length
  await vi.waitFor(() => expect(Y.encodeStateAsUpdate(p.doc).length).toBeGreaterThan(size / 2))
  const generation = docGeneration(p.doc) ?? '0'
  const hub = first.relay.hubRoom(room)!.hub!, conn = {}, principal = { local: true } as const
  expect(hub.handle(conn, { v: 1, id: 'hello', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: 'poster' }, principal).ok).toBe(true)
  let epoch: number | undefined
  await vi.waitFor(() => {
    const lease = hub.handle(conn, { v: 1, id: 'acquire', op: 'acquire', name: 'ada',
      holder: { sessionId: 'poster', pid: process.pid, startTime: '', executable: '' } }, principal)
    expect(lease.ok).toBe(true)
    epoch = (lease as { epoch: number }).epoch
  }, { timeout: 10_000 })
  expect(hub.handle(conn, { v: 1, id: 'post', op: 'post', lease: { name: 'ada', epoch },
    msg: { id: 'acknowledged', type: 'note', from: 'ada', text: 'saved before compaction' } }, principal).ok).toBe(true)
  await vi.waitFor(() => expect(p.doc.getArray('bus').toArray()).toEqual(doc.getArray('bus').toArray()))
  now = 60_000
  await Promise.race([first.closed, new Promise((_, reject) => setTimeout(() => reject(new Error('daemon did not compact')), 2000))])
  p.disconnect()
  const second = await start(dir, () => now)
  const stale = connect(second, generation, p.doc)
  let code: number | undefined
  stale.on('connection-close', (e: { code: number }) => { code = e.code })
  await vi.waitFor(() => expect(code).toBe(4409))
  const fresh = connect(second, 'fresh'); await vi.waitFor(() => expect(fresh.synced).toBe(true))
  expect(docGeneration(fresh.doc)).toBeTruthy()
  expect(docGeneration(fresh.doc)).not.toBe(generation)
  expect(fresh.doc.getArray('bus').toArray()).toEqual([expect.objectContaining({ id: 'acknowledged', text: 'saved before compaction' })])
  expect(Y.encodeStateAsUpdate(fresh.doc).length).toBeLessThan(size / 4)
  now += 60_000
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(fresh.wsconnected).toBe(true)
})

it('disables restart for the process if a loaded room is already over threshold', async () => {
  vi.stubEnv('ROOM_COMPACT_MIN_DELETED', '100')
  const measure = vi.spyOn(shared, 'historyOf').mockReturnValue({ structs: 100, deleted: 100 })
  let now = 0
  const logs: string[] = []
  const d = (await startLocalDaemon({ commonDir: common(), room, now: () => now, idleCheckMs: 10, log: line => logs.push(line) }))!
  daemons.push(d)
  measure.mockRestore()
  const doc = d.relay.hubRoom(room)!.doc.doc
  for (let i = 0; i < 200; i++) { doc.getMap('claims').set(String(i), {}); doc.getMap('claims').delete(String(i)) }
  let closed = false
  void d.closed.then(() => { closed = true })
  now = 60_000
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(closed).toBe(false)
  expect(logs.some(line => line.includes('compaction disabled for this process'))).toBe(true)
})

it.each(['off', '0'])('does not scan history with threshold %s', async threshold => {
  vi.stubEnv('ROOM_COMPACT_MIN_DELETED', threshold)
  let now = 0
  const d = await start(common(), () => now)
  const scan = vi.spyOn(d.relay, 'history')
  now = 120_000
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(scan).not.toHaveBeenCalled()
})

it('skips compaction once per process if a snapshot would shed broadcasts', async () => {
  vi.stubEnv('ROOM_COMPACT_MIN_DELETED', '1')
  let now = 0
  const logs: string[] = []
  const d = (await startLocalDaemon({ commonDir: common(), room, now: () => now, idleCheckMs: 10, log: line => logs.push(line) }))!
  daemons.push(d)
  const doc = d.relay.hubRoom(room)!.doc.doc
  const broadcasts = [{ id: 'large', type: 'note', text: 'x'.repeat(6 * 1024 * 1024) }]
  doc.getArray('bus').push(broadcasts)
  doc.getMap('claims').set('gone', {}); doc.getMap('claims').delete('gone')
  const generation = docGeneration(doc)
  let closed = false
  void d.closed.then(() => { closed = true })
  for (const time of [60_000, 120_000]) {
    now = time
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  expect(closed).toBe(false)
  expect(docGeneration(doc)).toBe(generation)
  expect(doc.getArray('bus').toArray()).toEqual(broadcasts)
  expect(logs.filter(line => line.includes('snapshot would shed content'))).toHaveLength(1)
})

it.each(['second room rename', 'directory fsync'])('exits after planned save failure: %s', async failure => {
  vi.stubEnv('ROOM_COMPACT_MIN_DELETED', '1')
  let now = 0
  const dir = common(), first = await start(dir, () => now), other = 'local/other'
  await first.relay.initialize(other)
  const a = connect(first, 'fresh'), b = connect(first, 'fresh', new Y.Doc(), other)
  await vi.waitFor(() => { expect(a.synced).toBe(true); expect(b.synced).toBe(true) })
  // Save the previous generation before posting, then fail only the planned replacement.
  const baseline = new RoomMemory(dir, other)
  expect(baseline.save()).toBeUndefined(); baseline.detach(); baseline.doc.destroy()
  for (const name of [room, other]) {
    const { hub, doc: wrapper } = first.relay.hubRoom(name)!
    const conn = {}, principal = { local: true } as const
    expect(hub!.handle(conn, { v: 1, id: 'hello', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: name }, principal).ok).toBe(true)
    let epoch: number | undefined
    await vi.waitFor(() => {
      const lease = hub!.handle(conn, { v: 1, id: 'acquire', op: 'acquire', name: 'ada', holder: { sessionId: name, pid: process.pid, startTime: '', executable: '' } }, principal)
      expect(lease, JSON.stringify(lease)).toMatchObject({ ok: true }); epoch = (lease as { epoch: number }).epoch
    }, { timeout: SETTLE_MS + 5_000, interval: 100 }) // a hub restored from saved memory settles before granting leases
    expect(hub!.handle(conn, { v: 1, id: 'post', op: 'post', lease: { name: 'ada', epoch }, msg: { id: name, type: 'note', from: 'ada', text: 'acknowledged' } }, principal).ok).toBe(true)
    wrapper.doc.getMap('claims').set('gone', {}); wrapper.doc.getMap('claims').delete('gone')
  }
  await vi.waitFor(() => {
    expect(a.doc.getArray('bus').length).toBe(1)
    expect(b.doc.getArray('bus').length).toBe(1)
  })
  const rename = fs.renameSync.bind(fs), sync = fs.fsyncSync.bind(fs)
  let snapshotInstalled = false, fsyncFailed = false, renameFailed = false
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    // Match by file name: the daemon writes under the canonical common dir (macOS /private/var for /var).
    if (failure === 'second room rename' && path.basename(String(to)) === path.basename(memoryFile(dir, other))) { renameFailed = true; throw new Error('EIO room B rename') }
    const result = rename(from, to)
    if (String(to).endsWith('.ydoc')) snapshotInstalled = true
    return result
  })
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    // One failure: the directory fsync right after the snapshot rename. Later teardown syncs (lock release) succeed.
    if (failure === 'directory fsync' && snapshotInstalled && !fsyncFailed && fs.fstatSync(fd).isDirectory()) { fsyncFailed = true; throw new Error('EIO directory fsync after rename') }
    return sync(fd)
  })
  now = 60_000
  await Promise.race([first.closed, new Promise((_, reject) => setTimeout(() => reject(new Error('failed compaction reopened')), 2000))])
  // The injected failure must actually have happened, or this test checks nothing.
  expect(failure === 'second room rename' ? renameFailed : fsyncFailed).toBe(true)
  a.disconnect(); b.disconnect(); vi.restoreAllMocks()
  // The successor must not compact again here: this test checks that the failed planned save lost nothing.
  vi.stubEnv('ROOM_COMPACT_MIN_DELETED', 'off')
  const second = await start(dir, () => now)
  const stale = connect(second, '0', a.doc)
  let code: number | undefined
  stale.on('connection-close', (event: { code: number }) => { code = event.code })
  await vi.waitFor(() => expect(code).toBe(4409))
  const fresh = connect(second, 'fresh')
  const recovered = connect(second, failure === 'second room rename' ? '0' : 'fresh', failure === 'second room rename' ? b.doc : new Y.Doc(), other)
  await vi.waitFor(() => { expect(fresh.synced).toBe(true); expect(recovered.synced).toBe(true) })
  expect(fresh.doc.getArray('bus').toArray()).toEqual([expect.objectContaining({ id: room })])
  expect(recovered.doc.getArray('bus').toArray()).toEqual([expect.objectContaining({ id: other })])
})
