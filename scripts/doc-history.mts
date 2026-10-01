// Offline reproduction of the 12 h soak's history growth (docs/superpowers/specs/2026-10-02-doc-history.md).
// A hub-core hub over one room document, a member replica synced by updates, and the soak's mix: half the
// posts are addressed questions (receipted, half answered), claims come and go, and the hub's minute
// maintenance trims. Prints struct counts, encoded size, heap and map-iteration cost at checkpoints.
//
//   node --expose-gc --import tsx scripts/doc-history.mts [--posts 20000] [--every 2000]
import * as Y from 'yjs'
import { RoomDoc, trim } from '@room/shared'
import { compactDoc, structCount } from '../packages/shared/src/compact.js'
import { SETTLE_MS, serializedStore, startHub } from '@room/hub-core'

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}
const POSTS = arg('posts', 20_000), EVERY = arg('every', 2_000), COMPACT = arg('compact', 0)
const PEOPLE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const GAP_MS = Math.round(3_600_000 / 700) // the soak's ~700 posts/hour

export function structCounts(doc: Y.Doc): { structs: number; deleted: number; gc: number } {
  let structs = 0, deleted = 0, gc = 0
  for (const list of (doc.store as unknown as { clients: Map<number, Array<{ deleted: boolean; constructor: { name: string } }>> }).clients.values()) {
    for (const s of list) { structs++; if (s.deleted) deleted++; if (s.constructor.name === 'GC') gc++ }
  }
  return { structs, deleted, gc }
}

let mono = 1_000_000, wall = Date.UTC(2026, 9, 1)
let room = new RoomDoc()
let member = new RoomDoc()
const wire = () => {
  room.doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'member') Y.applyUpdate(member.doc, u, 'hub') })
  member.doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'hub') Y.applyUpdate(room.doc, u, 'member') })
}
wire()
let max: number | undefined
let saved: any[] = []
const store = serializedStore({ read: async () => max, write: async v => { max = v } })
const leases = { read: async () => saved, write: async (rows: any[]) => { saved = rows } }
const compactMs: number[] = []
let hub = await startHub({ doc: room, fresh: true, mono: () => mono, wall: () => wall, log: () => {}, store, leases })
const holder = (s: string) => ({ sessionId: s, pid: 1, startTime: 't', executable: 'node' })
const conns = new Map<string, { conn: object; epoch: number }>()
for (const p of PEOPLE) {
  const conn = {}
  hub.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 't', sessionId: p }, { local: true })
  const r = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: p, holder: holder(p) }, { local: true }) as { epoch: number }
  conns.set(p, { conn, epoch: r.epoch })
}
let seed = 7
const rand = (n: number) => { // mulberry32
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return (((t ^ (t >>> 14)) >>> 0) / 2 ** 32 * n) | 0
}
const post = (from: string, msg: Record<string, unknown>) => {
  const c = conns.get(from)!
  return hub.handle(c.conn, { v: 1, id: 'p', op: 'post', lease: { name: from, epoch: c.epoch }, msg: { from, fromKind: 'agent', ...msg } }, { local: true })
}
/** The hub's minute maintenance pass, timed on a throwaway copy so the measurement does not change the run. */
const iterCost = () => {
  const copy = new RoomDoc(new Y.Doc()); Y.applyUpdate(copy.doc, Y.encodeStateAsUpdate(room.doc))
  const t = performance.now()
  for (let i = 0; i < 5; i++) trim(copy, wall)
  const ms = (performance.now() - t) / 5
  copy.doc.destroy()
  return ms
}
const open: string[] = []
const pendingSeen: Array<{ to: string; id: string; ask?: string }> = []
console.log('posts\tstructs\tdeleted\tencKB\theapMB\ttrimMs\tarchiveKeys(live)\treloadStructs')
for (let n = 1; n <= POSTS; n++) {
  const from = PEOPLE[rand(PEOPLE.length)]!
  // Receipts and answers for the previous step's addressed messages, from the member replica.
  for (const r of pendingSeen.splice(0)) {
    member.markSeen(r.to, [r.id], { s: r.to, via: 'reply' }, 'member')
    if (r.ask && rand(2)) post(r.to, { id: `ans-${r.id}`, type: 'answer', to: r.ask, inReplyTo: r.id, text: 'yes' })
  }
  if (rand(2)) {
    let to = PEOPLE[rand(PEOPLE.length)]!; if (to === from) to = PEOPLE[(PEOPLE.indexOf(to) + 1) % PEOPLE.length]!
    const id = `q-${n}`
    post(from, { id, type: 'question', to, text: `question ${n} `.repeat(4) })
    pendingSeen.push({ to, id, ask: from })
  } else post(from, { id: `n-${n}`, type: 'note', text: `note ${n} `.repeat(6) })
  if (rand(6) === 0) {
    member.doc.transact(() => { open.push(member.addClaim({ path: `src/f${rand(40)}.py`, from: 1, to: 20, by: from, byKind: 'agent', note: 'x' } as never).id) }, 'member')
  }
  if (open.length > 6) member.doc.transact(() => { member.removeClaim(open.shift()!) }, 'member')
  mono += GAP_MS; wall += GAP_MS
  for (const [name, c] of conns) hub.handle(c.conn, { v: 1, id: 'r', op: 'renew', name, epoch: c.epoch }, { local: true })
  hub.tick()
  if (n % 500 === 0) for (const p of PEOPLE) member.doc.transact(() => member.pruneSeen(p, () => true), 'member')
  if (COMPACT && structCount(room.doc) > COMPACT) {
    // Prototype of design (a): the hub's document replaced by its compact copy; the member resyncs from scratch.
    const t = performance.now()
    const fresh = compactDoc(room.doc, `g${n}`)
    compactMs.push(performance.now() - t)
    hub.stop(); room.doc.destroy(); member.doc.destroy()
    room = new RoomDoc(fresh); member = new RoomDoc(); wire()
    Y.applyUpdate(member.doc, Y.encodeStateAsUpdate(room.doc), 'hub')
    hub = await startHub({ doc: room, mono: () => mono, wall: () => wall, log: () => {}, store, leases })
    for (const p of PEOPLE) { const c = conns.get(p)!; hub.handle(c.conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 't', sessionId: p }, { local: true }) }
    mono += SETTLE_MS; wall += SETTLE_MS; hub.tick() // the settle window passes while clients reconnect
    for (const [name, c] of conns) hub.handle(c.conn, { v: 1, id: 'r', op: 'renew', name, epoch: c.epoch }, { local: true })
  }
  if (n % EVERY === 0) {
    globalThis.gc?.()
    const { structs, deleted } = structCounts(room.doc)
    const enc = Y.encodeStateAsUpdate(room.doc)
    const reload = new Y.Doc(); Y.applyUpdate(reload, enc)
    console.log([n, structs, deleted, (enc.length / 1024).toFixed(0), (process.memoryUsage().heapUsed / 2 ** 20).toFixed(1),
      iterCost().toFixed(3), `${(room.archive as unknown as { _map: Map<string, unknown> })._map.size}(${room.archive.size})`, structCounts(reload).structs].join('\t'))
  }
}
hub.stop()
if (compactMs.length) console.log(`compactions ${compactMs.length}, ms each: ${compactMs.map(x => x.toFixed(0)).join(',')}`)
{
  const names = new Map<unknown, string>()
  for (const [k, t] of room.doc.share) names.set(t, k)
  const by = new Map<string, number>()
  for (const list of (room.doc.store as any).clients.values()) for (const s of list) {
    let p = s.parent, key = s.parentSub ? `.${s.parentSub.startsWith('q-') || s.parentSub.startsWith('n-') || s.parentSub.startsWith('ans-') || s.parentSub.startsWith('c_') ? '<id>' : s.parentSub}` : ''
    while (p && p._item) p = p._item.parent
    const root = names.get(p) ?? '?'
    const k = root.startsWith('seen:') ? 'seen:*' + key : root + (root === 'meta' || root === 'participants' ? key : '')
    by.set(k, (by.get(k) ?? 0) + 1)
  }
  console.log([...by].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '))
}
console.log('live receipts', PEOPLE.map(p => room.seen(p).size).join(','), 'member', PEOPLE.map(p => member.seen(p).size).join(','))
