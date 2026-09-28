/** Tests: a session's hub seam over an in-process hub-core `Hub` on the session's own doc. */
import { SETTLE_MS, decodeFrame, encodeFrame, serializedStore, startHub, type Hub } from '@room/hub-core'
import type { RoomDoc } from '@room/shared'
import { HubClient, type HubTransport } from '../../src/hub-client.js'
import { createPost, greet, type LeaseSource, type Post } from '../../src/post.js'

const hubs = new WeakMap<RoomDoc, Promise<Hub>>()
const transports = new WeakMap<HubClient, ReturnType<typeof memoryTransport>>()
let seams = 0

/** One hub per doc; `up()` / `down()` simulate the hub becoming reachable or not. */
export function memoryTransport(room: RoomDoc): HubTransport & { up(): void; down(): void } {
  let hub = hubs.get(room)
  if (!hub) {
    let max: number | undefined, settled = 0
    // Tests start with the settle window already over (hub §4.4), so a first acquire is granted at once.
    hub = startHub({ doc: room, mono: () => performance.now() + settled, wall: () => Date.now(), log: () => {}, store: serializedStore({ read: async () => max, write: async v => { max = v } }) })
      .then(h => { settled = SETTLE_MS; return h })
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

/** A name lease for a test poster: acquired on first use, and again if it lapsed. */
export function testLease(hub: HubClient, name = 'test-poster', sessionId = 'test-session'): LeaseSource {
  let acquiring: Promise<number | undefined> | undefined
  const acquire = () => acquiring ??= hub.acquire(name, { sessionId, pid: process.pid, startTime: '', executable: '' })
    .catch(() => undefined).finally(() => { acquiring = undefined })
  void acquire()
  return async () => {
    const epoch = hub.lease(name) ?? await acquire()
    return epoch === undefined ? undefined : { name, epoch }
  }
}

/** The `hub` and `post` fields of a Session whose room has an in-process hub. */
export function hubSeam(room: RoomDoc, sessionId = 'test-session'): { hub: HubClient; post: Post } {
  const transport = memoryTransport(room)
  const hub = new HubClient({ transport, client: 'test', sessionId })
  transports.set(hub, transport)
  greet(hub)
  // Each seam posts under a name lease of its own, so two seams on one room never supersede each other.
  return { hub, post: createPost(room, hub, testLease(hub, `test-poster-${++seams}`, sessionId)) }
}

/** Make a session's hub (un)reachable, as a dropped relay or server connection would. */
export function setHubReachable(s: { hub: HubClient }, up: boolean): void {
  const transport = transports.get(s.hub)
  if (up) transport?.up(); else transport?.down()
}
