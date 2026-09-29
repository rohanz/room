/** Tests: in-memory providers whose type-7 frames reach an in-process hub-core `Hub`, as a relay's would. */
import { EventEmitter } from 'node:events'
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { Awareness } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { MSG_HUB, SETTLE_MS, decodeFrame, encodeFrame, serializedStore, startHub, type HolderIn, type Hub } from '@room/hub-core'
import { RoomDoc } from '@room/shared'

export interface HubRoom {
  /** The hub's doc: the room as the relay holds it. */
  doc: RoomDoc
  hub: Promise<Hub>
  /** A provider for roomd/the probe: its doc syncs with the hub's, and hub frames go to the hub. */
  provider(doc: Y.Doc): WebsocketProvider
  /** Another session holds `name` (a live lease, as from another clone). */
  hold(name: string, sessionId?: string): Promise<number>
  /** That session releases it. */
  release(name: string, epoch: number): Promise<void>
}

export function hubRoom(): HubRoom {
  const doc = new RoomDoc()
  let offset = 0, max: number | undefined
  const hub = startHub({ doc, mono: () => performance.now() + offset, wall: () => Date.now(), log: () => {}, store: serializedStore({ read: async () => max, write: async v => { max = v } }) })
    .then(h => { offset += SETTLE_MS; return h })
  const provider = (local: Y.Doc): WebsocketProvider => {
    Y.applyUpdate(local, Y.encodeStateAsUpdate(doc.doc))
    const toHub = (update: Uint8Array, origin: unknown) => { if (origin !== 'hub') Y.applyUpdate(doc.doc, update, 'peer') }
    const fromHub = (update: Uint8Array, origin: unknown) => { if (origin !== 'peer') Y.applyUpdate(local, update, 'hub') }
    local.on('update', toHub)
    doc.doc.on('update', fromHub)
    const events = new EventEmitter()
    const conn = {}
    const handlers: Array<(...args: unknown[]) => void> = []
    const p = Object.assign(events, {
      synced: true, wsconnected: true, awareness: new Awareness(local), messageHandlers: handlers,
      ws: {
        send(bytes: Uint8Array) {
          const frame = decodeFrame(bytes)
          void hub.then(h => {
            const dec = decoding.createDecoder(encodeFrame(h.handle(conn, frame, { local: true })))
            decoding.readVarUint(dec)
            handlers[MSG_HUB]?.(encoding.createEncoder(), dec, p, true, MSG_HUB)
          })
        },
      },
      destroy() { local.off('update', toHub); doc.doc.off('update', fromHub); void hub.then(h => h.closed(conn)); events.removeAllListeners() },
      disconnect() {}, connect() {},
    })
    return p as unknown as WebsocketProvider
  }
  const hold = async (name: string, sessionId = `other-${name}`): Promise<number> => {
    const h = await hub, conn = {}
    const holder: HolderIn = { sessionId, pid: process.pid, startTime: '', executable: '' }
    h.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId }, { local: true })
    const reply = h.handle(conn, { v: 1, id: 'a', op: 'acquire', name, holder }, { local: true }) as { ok: boolean; epoch: number }
    if (!reply.ok) throw new Error(`could not hold ${name}: ${JSON.stringify(reply)}`)
    return reply.epoch
  }
  const release = async (name: string, epoch: number): Promise<void> => {
    const h = await hub, conn = {}
    h.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: 'other' }, { local: true })
    h.handle(conn, { v: 1, id: 'r', op: 'release', name, epoch }, { local: true })
  }
  return { doc, hub, provider, hold, release }
}
