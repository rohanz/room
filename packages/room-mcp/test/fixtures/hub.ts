/** Tests: a session's hub seam over an in-process hub-core `Hub` on the session's own doc. */
import { decodeFrame, encodeFrame, serializedStore, startHub, type Hub } from '@room/hub-core'
import type { RoomDoc } from '@room/shared'
import { HubClient, type HubTransport } from '../../src/hub-client.js'
import { createPost, greet, type Post } from '../../src/post.js'

const hubs = new WeakMap<RoomDoc, Promise<Hub>>()
const transports = new WeakMap<HubClient, ReturnType<typeof memoryTransport>>()

/** One hub per doc; `up()` / `down()` simulate the hub becoming reachable or not. */
export function memoryTransport(room: RoomDoc): HubTransport & { up(): void; down(): void } {
  let hub = hubs.get(room)
  if (!hub) {
    let max: number | undefined
    hub = startHub({ doc: room, mono: () => performance.now(), wall: () => Date.now(), log: () => {}, store: serializedStore({ read: async () => max, write: async v => { max = v } }) })
    hubs.set(room, hub)
  }
  const ready = hub
  const conn = {}
  const frames = new Set<(bytes: Uint8Array) => void>()
  const reconnects = new Set<() => void>()
  let connected = true
  return {
    connected: () => connected,
    send(bytes) {
      if (!connected) throw new Error('hub unreachable')
      const frame = decodeFrame(bytes)
      void ready.then(h => { const reply = encodeFrame(h.handle(conn, frame, { local: true })); for (const fn of frames) fn(reply) })
    },
    onFrame(fn) { frames.add(fn); return () => frames.delete(fn) },
    onReconnect(fn) { reconnects.add(fn); return () => reconnects.delete(fn) },
    up() { connected = true; for (const fn of reconnects) fn() },
    down() { connected = false },
  }
}

/** The `hub` and `post` fields of a Session whose room has an in-process hub. */
export function hubSeam(room: RoomDoc, sessionId = 'test-session'): { hub: HubClient; post: Post } {
  const transport = memoryTransport(room)
  const hub = new HubClient({ transport, client: 'test', sessionId })
  transports.set(hub, transport)
  greet(hub)
  return { hub, post: createPost(room, hub) }
}

/** Make a session's hub (un)reachable, as a dropped relay or server connection would. */
export function setHubReachable(s: { hub: HubClient }, up: boolean): void {
  const transport = transports.get(s.hub)
  if (up) transport?.up(); else transport?.down()
}
