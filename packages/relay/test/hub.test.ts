import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { RoomDoc } from '@room/shared'
import { SETTLE_MS, startHub, MSG_HUB, encodeFrame, decodeFrame, type Reply, type Push } from '@room/hub-core'
import { contractSuite, fakeClock, holder, waitFor, type MakeEnv } from '../../hub-core/test/contract.js'
import { AuthorityLock, localProofHeader, memoryFile, startRelay, type StartedRelay } from '../src/index.js'
import { incarnationFile, relayLeaseFile } from '../src/hub.js'
import { authorizedWebSocket } from '../../roomd/src/ws-auth.js'

const makeCommonDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'room-relay-hub-'))
const KEY = 'hub-test-key'
const ROOM = 'local/contract'
const roomUrl = (port: number, room = ROOM) => `ws://127.0.0.1:${port}/${encodeURIComponent(room)}?schema=2`
const authed = (url: string, key: string) => {
  return secureSocketClient(url, key)
}

async function secureSocketClient(url: string, key: string) {
  const WS = authorizedWebSocket({ key })
  const ws = new WS(url)
  ws.binaryType = 'arraybuffer'
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  ws.send(Uint8Array.of(0, 0))
  const pending = new Map<string, (reply: Reply) => void>()
  const pushes: Push[] = []
  ws.on('message', (data: ArrayBuffer) => {
    const buf = new Uint8Array(data)
    if (buf[0] !== MSG_HUB) return
    const frame = decodeFrame(buf) as Reply | Push
    if ('push' in frame) pushes.push(frame)
    else pending.get(frame.re)?.(frame)
  })
  let n = 0
  const send = (body: Record<string, unknown>) => new Promise<Reply>(resolve => {
    const id = `r${++n}`
    pending.set(id, reply => { pending.delete(id); resolve(reply) })
    ws.send(encodeFrame({ v: 1, id, ...body } as never))
  })
  return { ws, send, pushes, hello: () => send({ op: 'hello', proto: 1, schema: 2, client: 'contract', sessionId: 'c' }),
    close: () => new Promise<void>(resolve => { if (ws.readyState === ws.CLOSED) return resolve(); ws.once('close', resolve); ws.close() }) }
}

/** The contract over a real relay: the hub runs under the clone's authority lock, on the test clock. */
const relayEnv: MakeEnv = async clock => {
  const commonDir = await makeCommonDir()
  const open = async (port: number, seed?: Uint8Array) => {
    const relay = await startRelay(port, { key: KEY, commonDir, hub: { lock: AuthorityLock.take(commonDir)!, mono: clock.mono, wall: clock.wall }, ...(seed ? { seed: { room: ROOM, update: seed } } : {}) })
    // The room's doc and hub exist from its first connection.
    const probe = await authed(roomUrl(relay.port), KEY)
    await waitFor(() => relay.hubRoom(ROOM)?.hub)
    await probe.close()
    return relay
  }
  let relay: StartedRelay = await open(0)
  const port = relay.port
  const current = () => relay.hubRoom(ROOM)!
  return {
    clock,
    doc: () => current().doc,
    incarnation: () => current().hub!.incarnation,
    connect: () => authed(roomUrl(port), KEY),
    async tick() { current().hub!.tick() },
    async restart(state) {
      await current().hub!.flushLeases()
      const update = state ?? Y.encodeStateAsUpdate(current().doc.doc)
      await relay.close()
      fs.rmSync(memoryFile(commonDir, ROOM), { force: true })
      relay = await open(port, update)
    },
    async close() { await relay.close(); fs.rmSync(commonDir, { recursive: true, force: true }) },
  }
}

contractSuite('local relay', relayEnv)

describe('relay hub wiring', () => {
  it('a successor reads leases from the shared clone directory', async () => {
    const common = await makeCommonDir()
    try {
      const clock = fakeClock(), room = 'local/takeover'
      const first = await startHub({ doc: new RoomDoc(), fresh: true, store: incarnationFile(common), leases: relayLeaseFile(common, room),
        mono: clock.mono, wall: clock.wall, log: () => {} })
      const conn = {}, principal = { local: true } as const
      first.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: 's' }, principal)
      const epoch = (first.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('s') }, principal) as { epoch: number }).epoch
      await first.flushLeases(); first.stop()
      const second = await startHub({ doc: new RoomDoc(), store: incarnationFile(common), leases: relayLeaseFile(common, room),
        mono: clock.mono, wall: clock.wall, log: () => {} })
      const survivor = {}
      second.handle(survivor, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: 's' }, principal)
      expect(second.handle(survivor, { v: 1, id: 'r', op: 'renew', name: 'ada', epoch }, principal)).toMatchObject({ ok: true })
      const file = path.join(common, 'room', 'hub-leases', `${(await import('node:crypto')).createHash('sha256').update(room).digest('hex')}.json`)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    } finally { fs.rmSync(common, { recursive: true, force: true }) }
  })
  it('recovers an rc1-poisoned incarnation file before serving a clean room', async () => {
    const common = await makeCommonDir()
    const file = path.join(common, 'room', 'hub', 'incarnation.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ max: 2 ** 32 + 1 }))
    try {
      const clock = fakeClock()
      const hub = await startHub({ doc: new RoomDoc(), store: incarnationFile(common), mono: clock.mono, wall: clock.wall, log: () => {} })
      expect(hub.incarnation).toBeLessThan(2 ** 32)
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).max).toBe(hub.incarnation)
      hub.stop()
    } finally { fs.rmSync(common, { recursive: true, force: true }) }
  }) // the hub settles for SETTLE_MS (5 s, real clock) before its first lease

  it('a relay that loses its lock answers not-authority and tells its holders', async () => {
    const common = await makeCommonDir()
    const clock = fakeClock()
    const lock = AuthorityLock.take(common)!
    expect(AuthorityLock.take(common)).toBeUndefined()
    const relay = await startRelay(0, { key: KEY, commonDir: common, hub: { lock, mono: clock.mono, wall: clock.wall } })
    try {
      const c = await authed(roomUrl(relay.port), KEY)
      await waitFor(() => relay.hubRoom(ROOM)?.hub)
      clock.advance(SETTLE_MS)
      expect(await c.hello()).toMatchObject({ ok: true })
      const { epoch } = await c.send({ op: 'acquire', name: 'ada', holder: holder('s1') }) as { epoch: number }
      // Someone replaced the lock (a successor recovered it while this relay stalled).
      fs.writeFileSync(lock.file, JSON.stringify({ pid: 1, startTime: '', executable: '', sessionId: 'x', nonce: 'someone-else' }))
      expect(await c.send({ op: 'renew', name: 'ada', epoch })).toMatchObject({ ok: false, reason: 'not-authority' })
      await waitFor(() => c.pushes.length)
      expect(c.pushes[0]).toMatchObject({ push: 'lease-lost', name: 'ada', epoch, reason: 'not-authority' })
      await c.close()
    } finally { await relay.close() }
    // Closing never removes a lock that is not its own.
    expect(JSON.parse(fs.readFileSync(lock.file, 'utf8')).nonce).toBe('someone-else')
  })

  it("ends a dead local holder's lease at once", async () => {
    const common = await makeCommonDir()
    const clock = fakeClock()
    const relay = await startRelay(0, { key: KEY, commonDir: common, hub: { lock: AuthorityLock.take(common)!, mono: clock.mono, wall: clock.wall } })
    try {
      const gone = spawnSync(process.execPath, ['-e', '']).pid!
      const c = await authed(roomUrl(relay.port), KEY)
      await waitFor(() => relay.hubRoom(ROOM)?.hub)
      clock.advance(SETTLE_MS)
      await c.hello()
      expect(await c.send({ op: 'acquire', name: 'ada', holder: holder('s-dead', { pid: gone }) })).toMatchObject({ ok: true })
      expect(await c.send({ op: 'acquire', name: 'ada', holder: holder('s2') })).toMatchObject({ ok: true })
      expect(relay.hubRoom(ROOM)!.doc.participants.get('ada\u0000holder')).toMatchObject({ sessionId: 's2' })
      await c.close()
    } finally { await relay.close() }
  })
})
