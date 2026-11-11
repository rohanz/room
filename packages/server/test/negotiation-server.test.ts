/** Real hosted transport regressions; independent process keeps the production login budget intact. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import WebSocket from 'ws'
import { CURRENT_COMPAT, LEGACY_COMPAT, noticeEvidence, workerNoticeId, decodeFrame, encodeFrame, type BootstrapSelection } from '@room/hub-core'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { RoomDoc } from '@room/shared'
import { devServers } from './dev-server.js'

const legacyFrames = JSON.parse(fs.readFileSync(new URL('./fixtures/legacy-0.17.32-first-frames.json', import.meta.url), 'utf8')) as {
  query: string; syncStep1: string; awareness: string; hello: string
}
const servers = devServers(), persistenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-negotiation-'))
let port: number, base: string
const post = (route: string, body: unknown) => fetch(base + route, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
async function login(fakeLogin: string): Promise<string> {
  const start = await post('/auth/device', {})
  expect(start.status).toBe(200)
  const { device } = await start.json() as { device: string }
  const done = await post('/auth/poll', { device, fakeLogin })
  expect(done.status).toBe(200)
  return ((await done.json()) as { session: string }).session
}
beforeAll(async () => {
  port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const value = (server.address() as { port: number }).port
      server.close(() => resolve(value))
    })
  })
  base = `http://127.0.0.1:${port}`
  const logs: string[] = []
  const child = servers.start({ env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test',
    ROOM_SERVER: '', GITHUB_CLIENT_ID: 'fake', ROOM_TOKEN: '', YPERSISTENCE: persistenceDir }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.on('data', data => logs.push(String(data)))
  child.stderr!.on('data', data => logs.push(String(data)))
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${logs.join('')}`)
    try { if ((await fetch(base + '/health')).ok) return } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`server did not start: ${logs.join('')}`)
}, 15000)
afterAll(async () => { try { await servers.stopAll() } finally { fs.rmSync(persistenceDir, { recursive: true, force: true }) } })

describe('hosted bootstrap and the frozen legacy wire profile', () => {
  it('negotiates before any document frame and attaches only after its selection ACK', async () => {
    const session = await login('negotiated')
    const room = 'github.com/negotiated/project'
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    // The admitted canonical identity, not a schema query, chooses the new route.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?negotiate=1&gen=fresh`, { headers: { authorization: `Bearer ${session}` } })
    const packets: Uint8Array[] = []
    ws.on('message', data => packets.push(new Uint8Array(data as Buffer)))
    try {
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(packets).toHaveLength(0)
      ws.send(encodeFrame({ v: 1, id: 'hello', op: 'compat-hello', sessionId: 'negotiated-session', offer: CURRENT_COMPAT }))
      await expect.poll(() => packets.length).toBe(1)
      const reply = decodeFrame(packets[0]) as BootstrapSelection
      expect(reply).toMatchObject({ ok: true, compat: CURRENT_COMPAT, selection: { bootstrap: 1, hub: 1, schema: 2 } })
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(packets).toHaveLength(1)
      ws.send(encodeFrame({ v: 1, id: 'ack', op: 'compat-ack', selectionId: reply.selectionId }))
      await expect.poll(() => packets.some(p => p[0] === 0)).toBe(true)
    } finally { ws.close() }
  })

  it('refuses an unknown bootstrap before upgrade with the side that must change', async () => {
    const result = await new Promise<{ status: number; body: string }>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/local%2Fbad-bootstrap?schema=2&negotiate=2`)
      ws.on('unexpected-response', (_req, res) => {
        let body = ''; res.on('data', part => { body += part }); res.on('end', () => { resolve({ status: res.statusCode!, body }); ws.terminate() })
      })
      ws.on('error', () => {})
    })
    expect(result.status).toBe(426)
    expect(JSON.parse(result.body)).toMatchObject({ code: expect.any(String), side: 'client', supported: { server: CURRENT_COMPAT } })
  })

  it('names the server side on a newer-only client refusal without sending Yjs', async () => {
    const session = await login('newer-client'), room = 'github.com/newer-client/project'
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?negotiate=1&gen=fresh`, { headers: { authorization: `Bearer ${session}` } })
    const packets: Uint8Array[] = []
    ws.on('message', data => packets.push(new Uint8Array(data as Buffer)))
    const closed = new Promise<number>(resolve => ws.once('close', resolve))
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(encodeFrame({ v: 1, id: 'h', op: 'compat-hello', sessionId: 's', offer: { ...CURRENT_COMPAT, legacy: undefined, hub: { min: 2, max: 2 } } }))
    expect(await closed).toBe(4406)
    expect(packets).toHaveLength(1)
    expect(decodeFrame(packets[0])).toMatchObject({ ok: false, error: { side: 'server' } })
  })

  it('revokes a pending selection on logout without exchanging document data', async () => {
    const session = await login('pending-logout'), room = 'github.com/pending-logout/project'
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?negotiate=1&gen=fresh`, { headers: { authorization: `Bearer ${session}` } })
    const packets: Uint8Array[] = []
    ws.on('message', data => packets.push(new Uint8Array(data as Buffer)))
    const closed = new Promise<number>(resolve => ws.once('close', resolve))
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(encodeFrame({ v: 1, id: 'h', op: 'compat-hello', sessionId: 's', offer: CURRENT_COMPAT }))
    await expect.poll(() => packets.length).toBe(1)
    expect((await post('/auth/logout', { session })).status).toBe(200)
    expect(await closed).toBe(4401)
    expect(packets.every(p => p[0] === 7)).toBe(true)
  })

  it('binds a negotiating viewer ticket to its offer and preserves read-only hub authority', async () => {
    const session = await login('viewer-compat'), room = 'github.com/viewer-compat/project'
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    const { view } = await (await post('/view-token', { room, session, schema: 2 })).json() as { view: string }
    const offer = { ...CURRENT_COMPAT, legacy: undefined, schemas: { read: [2], write: [] } }
    const { ticket } = await (await post('/ws-ticket', { room, view, schema: 2, compat: offer })).json() as { ticket: string }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?negotiate=1&gen=fresh&ticket=${ticket}`)
    const packets: Uint8Array[] = []
    ws.on('message', data => packets.push(new Uint8Array(data as Buffer)))
    try {
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
      ws.send(encodeFrame({ v: 1, id: 'h', op: 'compat-hello', sessionId: 'viewer', offer }))
      await expect.poll(() => packets.length).toBe(1)
      const reply = decodeFrame(packets[0]) as BootstrapSelection
      expect(reply.ok).toBe(true)
      ws.send(encodeFrame({ v: 1, id: 'ack', op: 'compat-ack', selectionId: reply.selectionId }))
      await expect.poll(() => packets.some(p => p[0] === 0)).toBe(true)
      ws.send(encodeFrame({ v: 1, id: 'write', op: 'renew', name: 'viewer-compat', epoch: 1 }))
      await expect.poll(() => packets.filter(p => p[0] === 7).map(decodeFrame).some(p => (p as { re?: string }).re === 'write')).toBe(true)
      expect(packets.filter(p => p[0] === 7).map(decodeFrame).at(-1)).toMatchObject({ re: 'write', ok: false, reason: 'read-only' })
    } finally { ws.close() }
  })

  it('replays the pinned 0.17.32 sync-before-hello frames without any bootstrap exchange', async () => {
    const session = await login('legacy-wire'), room = 'github.com/legacy-wire/project'
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?${legacyFrames.query}`, { headers: { authorization: `Bearer ${session}` } })
    const packets: Uint8Array[] = []
    ws.on('message', data => packets.push(new Uint8Array(data as Buffer)))
    try {
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
      ws.send(Buffer.from(legacyFrames.syncStep1, 'hex'))
      ws.send(Buffer.from(legacyFrames.awareness, 'hex'))
      await expect.poll(() => packets.filter(p => p[0] === 0).length).toBeGreaterThanOrEqual(2)
      expect(packets.some(p => p[0] === 7)).toBe(false)
      // Released probes synchronize before their exact strict proto-1 hello. A starting hub can be retried.
      await expect.poll(async () => {
        const before = packets.length
        ws.send(Buffer.from(legacyFrames.hello, 'hex'))
        await expect.poll(() => packets.length).toBeGreaterThan(before)
        return packets.filter(p => p[0] === 7).map(p => decodeFrame(p) as { ok: boolean }).at(-1)?.ok
      }).toBe(true)
      expect(packets.filter(p => p[0] === 7).map(decodeFrame).at(-1)).toMatchObject({ v: 1, re: 'h', ok: true, proto: 1 })
    } finally { ws.close() }
  })

  it.each([true, false])('hosted ACK binds notice authority only for a selected capable client=%s', async capable => {
    const loginName = capable ? 'notice-capable' : 'notice-baseline'
    const session = await login(loginName), roomName = `github.com/${loginName}/project`
    expect((await post('/rooms', { room: roomName, session, schema: 2 })).status).toBe(201)
    const room = new RoomDoc(), packets: Record<string, any>[] = []
    let synced = false
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(roomName)}?negotiate=1&gen=fresh`, { headers: { authorization: `Bearer ${session}` } })
    ws.on('message', raw => {
      const bytes = new Uint8Array(raw as Buffer)
      if (bytes[0] === 7) packets.push(decodeFrame(bytes) as any)
      else if (bytes[0] === 0) {
        const dec = decoding.createDecoder(bytes), enc = encoding.createEncoder()
        decoding.readVarUint(dec); encoding.writeVarUint(enc, 0)
        const kind = syncProtocol.readSyncMessage(dec, enc, room.doc, ws)
        if (kind === syncProtocol.messageYjsSyncStep2) synced = true
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc))
      }
    })
    try {
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
      ws.send(encodeFrame({ v: 1, id: 'hello', op: 'compat-hello', sessionId: loginName, offer: capable ? CURRENT_COMPAT : LEGACY_COMPAT }))
      await expect.poll(() => packets.length).toBe(1)
      const selected = packets[0]
      expect(selected.selection.capabilities['room.notice-lifecycle']).toBe(capable ? 1 : undefined)
      ws.send(encodeFrame({ v: 1, id: 'ack', op: 'compat-ack', selectionId: selected.selectionId }))
      await expect.poll(() => packets.some(p => p.re === 'ack' && p.ok)).toBe(true)
      // The server's step1 requests our state; request its state too. Hosted updates are gated until this exchange.
      const initial = encoding.createEncoder()
      encoding.writeVarUint(initial, 0); syncProtocol.writeSyncStep1(initial, room.doc)
      ws.send(encoding.toUint8Array(initial))
      await expect.poll(() => synced, { message: 'hosted replica receives sync step2 after bootstrap ACK' }).toBe(true)
      let serial = 0
      const request = async (body: object) => {
        const id = `notice-${++serial}`
        ws.send(encodeFrame({ v: 1, id, ...body } as never))
        await expect.poll(() => packets.find(p => p.re === id)).toBeTruthy()
        return packets.find(p => p.re === id)!
      }
      let grant: Record<string, any> | undefined
      try { await expect.poll(async () => {
        grant = await request({ op: 'acquire', name: loginName, holder: { sessionId: loginName, pid: 1, startTime: '', executable: '', workerId: 'retirement-worker' } })
        return grant.ok
      }, { timeout: 10000 }).toBe(true) } catch (cause) {
        throw new Error(`hosted acquire after bootstrap ACK refused: ${JSON.stringify(grant)}`, { cause })
      }
      const lease = { name: loginName, epoch: grant!.epoch }
      await expect.poll(() => (room.participants.get(`${loginName}\0holder`) as any)?.epoch).toBe(lease.epoch)
      const intent = (id: string, expected: number) => ({
        op: 'notice-lifecycle', generation: selected.incarnation, lease, action: 'register', producer: 'producer', operation: 'register-original',
        expected, evidence: noticeEvidence(room, [loginName, 'B']), episode: 'registration',
        msg: { id, type: 'contract', from: 'room', fromKind: 'agent', to: loginName, path: 'x', symbol: 'api', text: 'unchanged body', priority: 'notify' },
      })
      const originalId = capable ? workerNoticeId('cf:original', ['retirement-worker'])! : 'cf:original'
      const original = intent(originalId, 0)
      if (capable) {
        expect(await request(original)).toMatchObject({ ok: true, managed: true })
        expect(await request({ ...original, operation: 'forbidden-complete', expected: 1, transition: 'complete' })).toMatchObject({ ok: false, reason: 'invalid' })
        expect(room.outcomes.has(originalId)).toBe(false)
        expect(await request({ op: 'notice-lifecycle', generation: selected.incarnation, lease, action: 'retire', producer: 'retirement', expected: 0,
          operation: 'retire-worker', workerId: 'retirement-worker', targets: [{ producer: 'producer', expected: 1, ids: [originalId], episodes: { [originalId]: 'registration' } }] })).toMatchObject({ ok: true, managed: true })
        await expect.poll(() => room.outcomes.has(originalId)).toBe(true)
      } else {
        expect(await request(original)).toMatchObject({ ok: false, reason: 'version' })
        expect(await request({ op: 'post', lease, auto: true, msg: original.msg })).toMatchObject({ ok: true })
        expect(room.outcomes.has(originalId)).toBe(false)
        expect(room.doc.getMap('noticeInventory').size).toBe(0)
      }
    } finally { ws.close(); room.doc.destroy() }
  })

})
