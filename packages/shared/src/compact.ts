import * as Y from 'yjs'
import type { Claim, ClaimAnchor } from './types.js'

// Document compaction (docs/superpowers/specs/2026-10-02-doc-history.md): the room's current values copied
// into a fresh Y.Doc, so the deleted history every earlier operation left behind is gone.

/** The `meta` key naming the document's generation: a new random value at every compaction. */
const GENERATION_KEY = 'generation'

export const docGeneration = (doc: Y.Doc): string | undefined => {
  const value = doc.getMap('meta').get(GENERATION_KEY)
  return typeof value === 'string' && value ? value : undefined
}

/** The websocket URL parameter in which a client states the generation of its replica. */
export const GENERATION_PARAM = 'gen'
/** A replica that holds no server data yet: it merges into any generation. */
export const FRESH_GENERATION = 'fresh'
/** The generation of a document never compacted (every rc and migrated document). */
const UNCOMPACTED = '0'
/** The server's close for a replica of an earlier generation. In the 44xx range, so no provider reconnects by itself. */
export const STALE_REPLICA_CODE = 4409
export const STALE_REPLICA_REASON = "this room's document was compacted when the server restarted; rejoin with a fresh copy"
/** The close (4403, final for every rc client) for a client that states no generation once the room has one. */
export const COMPACTED_UPDATE_REASON = "update Room to 0.17.0 or later (browser: reload the page): this room's document was compacted"

/** Replicas that have received server data, and the watch that records it. */
const received = new WeakMap<Y.Doc, boolean>()
function watchReplica(doc: Y.Doc): void {
  if (received.has(doc)) return
  // Data already integrated names another client in the state vector.
  received.set(doc, [...Y.decodeStateVector(Y.encodeStateVector(doc)).keys()].some(id => id !== doc.clientID))
  if (received.get(doc)) return
  // Every remote update is applied in a transaction that is not local, including one whose structs Yjs can only keep
  // pending (a broadcast before sync step 2, a deletion alone): those emit no 'update' and leave no public trace in
  // the state vector, so the transaction is the signal.
  const onTransaction = (transaction: Y.Transaction) => {
    if (transaction.local) return
    received.set(doc, true)
    doc.off('afterTransaction', onTransaction)
  }
  doc.on('afterTransaction', onTransaction)
}

/**
 * The generation a replica states before syncing: fresh until it holds any server data, then the one that data came
 * from. Watching starts at the first call (roomConnection makes it before the provider connects).
 */
export function replicaGeneration(doc: Y.Doc): string {
  watchReplica(doc)
  return received.get(doc) ? docGeneration(doc) ?? UNCOMPACTED : FRESH_GENERATION
}

/**
 * Provider params whose `gen` is read again at every (re)connect. y-websocket builds each socket's URL from its
 * `url` getter (`get url ()` in y-websocket/src/y-websocket.js), which encodes `this.params` every time; it has no
 * hook before its own reconnects, so `gen` is an enumerable getter rather than a value set before each connect.
 * room-mcp's generation-params test fails if a y-websocket upgrade stops re-reading `params`.
 */
export function generationParams(doc: Y.Doc, base: Record<string, string>): Record<string, string> {
  watchReplica(doc)
  return Object.defineProperty({ ...base }, GENERATION_PARAM, { enumerable: true, get: () => replicaGeneration(doc) })
}

/** Every Room provider's options: schema 2, the replica's generation at each connect, and no BroadcastChannel,
 *  which would exchange state between providers of one room in a process or browser regardless of generation. */
export function roomConnection(doc: Y.Doc): { params: Record<string, string>; disableBc: true } {
  return { params: generationParams(doc, { schema: '2' }), disableBc: true }
}

/**
 * The server's decision for a connection that states `stated` (null: an rc client, which states none) in a room
 * at `current`: merge it, refuse its replica (a later generation exists), or ask an rc client to update.
 */
export function generationGate(stated: string | null, current: string | undefined): 'accept' | 'stale' | 'update' {
  const room = current ?? UNCOMPACTED
  if (stated === null) return room === UNCOMPACTED ? 'accept' : 'update'
  return stated === FRESH_GENERATION || stated === room ? 'accept' : 'stale'
}

type Kind = 'map' | 'array' | 'text'
type Shape = { _map: Map<string, unknown>; _start: { deleted: boolean; content: { constructor: { name: string } }; right: unknown } | null }

/** A root's kind. Roots that arrived by update and were never read are plain AbstractTypes: read their items. */
function kindOf(type: Y.AbstractType<any>): Kind | undefined {
  if (type instanceof Y.Map) return 'map'
  if (type instanceof Y.Array) return 'array'
  if (type instanceof Y.Text) return 'text'
  if (type instanceof Y.XmlFragment) throw new Error('compaction does not copy XML types')
  const shape = type as unknown as Shape
  if (shape._map.size) return 'map'
  for (let item = shape._start; item; item = item.right as Shape['_start']) {
    if (item.deleted) continue
    const content = item.content.constructor.name
    return content === 'ContentString' || content === 'ContentFormat' || content === 'ContentEmbed' ? 'text' : 'array'
  }
  return undefined
}

function copyValue(value: unknown): unknown {
  if (value instanceof Y.Map) {
    const out = new Y.Map<unknown>()
    for (const [key, inner] of value.entries()) out.set(key, copyValue(inner))
    return out
  }
  if (value instanceof Y.Array) return Y.Array.from(value.toArray().map(copyValue) as never[])
  if (value instanceof Y.Text) {
    const out = new Y.Text()
    out.applyDelta(value.toDelta())
    return out
  }
  if (value instanceof Y.AbstractType || value instanceof Y.Doc) throw new Error('compaction does not copy XML types or subdocuments')
  return value
}

/** A claim anchor as absolute indexes in the source document, to re-create against the copy's text. */
function anchorIndexes(doc: Y.Doc, anchor: ClaimAnchor | undefined): { from: number; to: number } | undefined {
  if (!anchor) return undefined
  try {
    const from = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.from), doc)
    const to = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.to), doc)
    return from && to ? { from: from.index, to: to.index } : undefined
  } catch { return undefined }
}

/**
 * The document's current values in a fresh Y.Doc, with `meta.generation` set to `generation`. Every root is
 * copied whatever its name, nested types included; a claim's overlay anchor is re-created at the same text
 * index in the copy (an anchor that no longer resolves is dropped, as `moveClaim` drops an obsolete one).
 */
export function compactDoc(source: Y.Doc, generation: string): Y.Doc {
  const copy = new Y.Doc({ gc: true })
  const anchors = new Map<string, { from: number; to: number } | undefined>()
  const claims = source.share.has('claims') ? source.getMap<Claim>('claims') : undefined
  for (const [id, claim] of claims?.entries() ?? []) if (claim && typeof claim === 'object' && claim.anchor) anchors.set(id, anchorIndexes(source, claim.anchor))
  copy.transact(() => {
    for (const [name, type] of source.share) {
      const kind = kindOf(type)
      if (kind === 'map') {
        const from = source.getMap<unknown>(name), to = copy.getMap<unknown>(name)
        // The old generation is not copied: overwriting it below would leave the copy's first tombstone.
        for (const [key, value] of from.entries()) if (name !== 'meta' || key !== GENERATION_KEY) to.set(key, copyValue(value))
      } else if (kind === 'array') copy.getArray<unknown>(name).push(source.getArray<unknown>(name).toArray().map(copyValue))
      else if (kind === 'text') copy.getText(name).applyDelta(source.getText(name).toDelta())
    }
    copy.getMap('meta').set(GENERATION_KEY, generation)
    if (!anchors.size) return
    const copied = copy.getMap<Claim>('claims')
    for (const [id, at] of anchors) {
      const claim = copied.get(id)!
      const text = copy.getMap<Y.Map<Y.Text>>('overlays').get(claim.by)?.get(claim.path)
      const { anchor: _old, ...rest } = claim
      copied.set(id, at && text ? { ...rest, anchor: {
        from: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, at.from)) as ClaimAnchor['from'],
        to: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, at.to)) as ClaimAnchor['to'],
      } } : rest)
    }
  })
  return copy
}

/** Every struct in the document's store, and the deleted ones (tombstones) among them: what compaction removes. */
export function historyOf(doc: Y.Doc): { structs: number; deleted: number } {
  let structs = 0, deleted = 0
  for (const list of (doc.store as unknown as { clients: Map<number, { deleted: boolean }[]> }).clients.values()) {
    structs += list.length
    for (const struct of list) if (struct.deleted) deleted++
  }
  return { structs, deleted }
}
