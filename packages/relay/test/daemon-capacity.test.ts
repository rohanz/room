/** Real ceiling, not a reduced test cap. CI/native lead runs with TEST_SCALE=1. */
import { expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as sync from 'y-protocols/sync'
import { CURRENT_COMPAT, DOC_SIZE_CAP_CODE, MSG_HUB, decodeFrame, encodeFrame, insertsNothing, type Reply } from '@room/hub-core'
import { ROOM_DOC_MAX_BYTES } from '@room/shared'
import { authorizedWebSocket } from '../../roomd/src/ws-auth.js'
import { startLocalDaemon } from '../src/daemon.js'
import { loadMemory, localProofHeader } from '../src/index.js'

it.skipIf(process.env.TEST_SCALE !== '1')('repairs protected memory above the real 64 MiB ceiling using deletion-only sync despite unsent client growth', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-capacity-')), room = 'local/capacity'
  const daemon = (await startLocalDaemon({ commonDir: dir, room, finalSaveRetryMs: [1] }))!
  const replica = new Y.Doc(), sockets: InstanceType<ReturnType<typeof authorizedWebSocket>>[] = []
  const offer = { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, 'room.daemon': [1] } }
  const connect = async (doc?: Y.Doc) => {
    const WS = authorizedWebSocket({ key: daemon.info.key, negotiation: { offer, sessionId: `repair-${sockets.length}` } })
    const ws = new WS(`ws://127.0.0.1:${daemon.info.port}/${encodeURIComponent(room)}?schema=2`); sockets.push(ws)
    if (doc) ws.on('message', (raw: ArrayBuffer) => {
      const decoder = decoding.createDecoder(new Uint8Array(raw))
      if (decoding.readVarUint(decoder) === 0) sync.readSyncMessage(decoder, encoding.createEncoder(), doc, ws)
    })
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    return ws
  }
  const frame = (update: Uint8Array) => { const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 0); sync.writeUpdate(encoder, update); return encoding.toUint8Array(encoder) }
  const status = async () => {
    const target = '/daemon/status'
    const response = await fetch(`http://127.0.0.1:${daemon.info.port}${target}`, { headers: { Authorization: localProofHeader(daemon.info.key, 'GET', target, daemon.info.port) } })
    expect(response.ok).toBe(true)
    return await response.json() as { rooms: { storage: { capacity?: string; dirtyGeneration: number; savedGeneration: number; liveCapacity?: boolean } }[] }
  }
  try {
    const live = daemon.relay.hubRoom(room)!.doc.doc
    // Protected roots cannot be shed to the 5 MiB target. Seed before connecting so the
    // initial sync request cannot race large broadcasts into the queued-output limiter.
    live.getMap('mail').set('owed', 'm'.repeat(33 * 1024 * 1024))
    live.getMap('outcomes').set('owed', 'o'.repeat(33 * 1024 * 1024))
    expect(Y.encodeStateAsUpdate(live).byteLength).toBeGreaterThan(ROOM_DOC_MAX_BYTES)
    // Model a surviving replica with the same CRDT identities, rather than requiring a
    // fresh client to download the oversized room before it can exercise bounded repair.
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(live))
    await vi.waitFor(async () => expect((await status()).rooms[0].storage.capacity).toMatch(/ceiling/), { timeout: 15000 })
    const blocked = await status(); expect(blocked.rooms[0].storage.savedGeneration).toBeLessThan(blocked.rooms[0].storage.dirtyGeneration)
    const ws = await connect(replica), replies: Reply[] = []
    ws.on('message', (raw: ArrayBuffer) => {
      const bytes = new Uint8Array(raw)
      if (bytes[0] === MSG_HUB) replies.push(decodeFrame(bytes) as Reply)
    })
    // A newly authenticated connection learns the capacity refusal without inserting a lease.
    ws.send(encodeFrame({ v: 1, id: 'capacity', op: 'acquire', name: 'repair', holder: { sessionId: 'repair-0', pid: process.pid, startTime: 'test', executable: 'test' } }))
    await vi.waitFor(() => expect(replies.find(reply => reply.re === 'capacity')).toMatchObject({ ok: false, reason: 'room-full' }))
    // Empty sync remains admitted, even while growing updates are refused.
    const empty = new Y.Doc()
    ws.send(frame(Y.encodeStateAsUpdate(empty))); empty.destroy()
    replica.getMap('meta').set('unsent-client-growth', 'keep locally')
    const growth = Y.encodeStateAsUpdate(replica, Y.encodeStateVector(live))
    expect(insertsNothing(growth)).toBe(false)
    const rejected = await connect(), refused = new Promise<number>(resolve => rejected.once('close', code => resolve(code)))
    rejected.send(frame(growth)); expect(await refused).toBe(DOC_SIZE_CAP_CODE)
    expect(live.getMap('meta').has('unsent-client-growth')).toBe(false)
    let deletion!: Uint8Array
    const capture = (update: Uint8Array) => { deletion = update }
    replica.on('update', capture)
    replica.transact(() => { replica.getMap('mail').delete('owed'); replica.getMap('outcomes').delete('owed') })
    replica.off('update', capture)
    expect(insertsNothing(deletion)).toBe(true)
    expect(deletion.byteLength).toBeLessThan(4 * 1024 * 1024)
    ws.send(frame(deletion))
    await vi.waitFor(() => { expect(live.getMap('mail').size).toBe(0); expect(live.getMap('outcomes').size).toBe(0) })
    // Independent authenticated read-back establishes that the daemon applied the repair in memory.
    const readback = new Y.Doc(), reader = await connect(readback)
    const read = encoding.createEncoder(); encoding.writeVarUint(read, 0); sync.writeSyncStep1(read, readback); reader.send(encoding.toUint8Array(read))
    await vi.waitFor(() => expect(readback.getMap('meta').get('schemaVersion')).toBe(2))
    expect(readback.getMap('mail').size).toBe(0); expect(readback.getMap('outcomes').size).toBe(0)
    expect(readback.getMap('meta').has('unsent-client-growth')).toBe(false)
    expect(replica.getMap('meta').get('unsent-client-growth')).toBe('keep locally')
    await vi.waitFor(async () => { const stored = (await status()).rooms[0].storage; expect(stored.capacity).toBeUndefined(); expect(stored.dirtyGeneration).toBeGreaterThan(blocked.rooms[0].storage.dirtyGeneration); expect(stored.savedGeneration).toBe(stored.dirtyGeneration); expect(stored.liveCapacity).toBe(false) }, { timeout: 35000 })
    for (const socket of sockets) socket.close()
    readback.destroy()
    await daemon.close()
    const saved = loadMemory(dir, room)
    expect(saved.getMap('mail').size).toBe(0); expect(saved.getMap('outcomes').size).toBe(0); saved.destroy()
    expect(fs.existsSync(path.join(dir, 'room/hub/authority.lock'))).toBe(false)
  } finally {
    for (const socket of sockets) socket.terminate()
    replica.destroy()
    // Only an assertion-failure cleanup: remove the injected protected records before the save-first close.
    const live = daemon.relay.hubRoom(room)?.doc.doc
    if (live) { live.getMap('mail').clear(); live.getMap('outcomes').clear(); await daemon.close() }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 60000)
