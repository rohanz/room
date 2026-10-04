import * as Y from 'yjs'
import { RECEIPTS_BYTES } from './delivery.js'
import { workerMemory } from './worker-memory.js'

/** The snapshot target: `memorySnapshot` sheds droppable data to stay under it. */
export const MAX_MEMORY_BYTES = 5 * 1024 * 1024
/** The local relay's hard ceiling for a snapshot file, on save and on load. Paired with the team server's
 * default document cap (ROOM_DOC_MAX_MB, server/src/index.ts), which repeats the number because the
 * server image ships without @room/shared. */
export const ROOM_DOC_MAX_BYTES = 64 * 1024 * 1024

/** Memory keeps coordination (including migrated claims awaiting an old owner's return).
 * Live file text and graphs are rebuilt by whoever is present. Completed workers'
 * publications are copied separately, within the snapshot budget. */
export const MEMORY_TYPES = {
  bus: 'array', ledger: 'map', retiredWorkers: 'array', workers: 'map',
  scopes: 'map', claims: 'map', unresolved: 'map', aliases: 'map', colors: 'map',
  meta: 'map', mail: 'map', outcomes: 'map', archive: 'map',
} as const

/** Dynamic top-level maps: seen:<encoded participant> holds message-id -> receipt.
 * Only receipts that bus, mail or outcomes reference are kept; never persist arbitrary future maps. */
export const MEMORY_PREFIXES = { 'seen:': 'map' } as const

export function* memoryTypes(doc: Y.Doc, includePublications = false): Generator<[string, 'map' | 'array']> {
  for (const [name, kind] of Object.entries(MEMORY_TYPES)) if (doc.share.has(name)) yield [name, kind]
  if (includePublications) for (const name of ['completedPublications', 'completedPublicationRevisions']) {
    if (doc.share.has(name)) yield [name, 'map']
  }
  for (const name of doc.share.keys()) {
    for (const [prefix, kind] of Object.entries(MEMORY_PREFIXES)) if (name.startsWith(prefix)) yield [name, kind]
  }
}

interface ReceiptEntry { map: string; id: string; value: unknown; size: number; index: number }
type BusValue = { id?: unknown; to?: unknown } | null

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const entrySize = (key: string, value: unknown): number => key.length + JSON.stringify(value).length
/** A legacy number or a `{s, via, at}` receipt. */
function validReceipt(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  const r = value as { s?: unknown; via?: unknown; at?: unknown } | null
  return !!r && typeof r === 'object' && typeof r.s === 'string' && typeof r.via === 'string' && typeof r.at === 'number' && Number.isFinite(r.at)
}

/**
 * Copy values into fresh CRDT types: no live participant text or deleted CRDT history on disk. Receipts keep, in order:
 * those for mail and outcomes, those for addressed bus messages, then broadcasts newest first within
 * RECEIPTS_BYTES. Over `maxBytes` it drops completed publications first, then archive entries oldest first,
 * then broadcast receipts and the oldest bus broadcasts; never publication revision markers, mail,
 * outcomes, addressed receipts or other roots, and logs what it dropped.
 * When those protected roots alone exceed `maxBytes`, it returns the smallest achievable snapshot, which
 * is over `maxBytes`, and says "still over"; the caller decides what to do with it.
 */
export function memorySnapshot(doc: Y.Doc, { maxBytes = MAX_MEMORY_BYTES, log }: { maxBytes?: number; log?: (line: string) => void } = {}): Uint8Array {
  const { publications, copyRevisionsTo } = workerMemory(doc)
  const arrays = new Map<string, unknown[]>(), maps = new Map<string, [string, unknown][]>()
  const seenMaps = new Map<string, [string, unknown][]>()
  for (const [name, kind] of memoryTypes(doc)) {
    // Remote updates initially have abstract types; resolve their schema before toJSON.
    if (kind === 'array') arrays.set(name, JSON.parse(JSON.stringify(doc.getArray(name).toArray())))
    else (name.startsWith('seen:') ? seenMaps : maps).set(name, Object.entries(JSON.parse(JSON.stringify(doc.getMap(name).toJSON()))))
  }

  const bus = (arrays.get('bus') ?? []) as BusValue[]
  const held = new Set<string>([...(maps.get('mail') ?? []), ...(maps.get('outcomes') ?? [])].map(([id]) => id))
  const broadcastIndex = new Map<string, number>()
  bus.forEach((m, index) => {
    if (typeof m?.id !== 'string') return
    if (m.to) held.add(m.id); else broadcastIndex.set(m.id, index)
  })
  const receipts = new Map<string, Map<string, unknown>>()
  const keep = (map: string, id: string, value: unknown) => {
    const kept = receipts.get(map) ?? new Map<string, unknown>()
    kept.set(id, value); receipts.set(map, kept)
  }
  let spent = 0
  const broadcasts: ReceiptEntry[] = []
  for (const [map, entries] of seenMaps) for (const [id, value] of entries) {
    if (!validReceipt(value)) continue
    const size = entrySize(id, value)
    if (held.has(id)) { keep(map, id, value); spent += size }
    else if (broadcastIndex.has(id)) broadcasts.push({ map, id, value, size, index: broadcastIndex.get(id)! })
  }
  broadcasts.sort((a, b) => b.index - a.index || compare(a.map, b.map))
  const keptBroadcasts: ReceiptEntry[] = []
  for (const r of broadcasts) {
    if (spent + r.size > RECEIPTS_BYTES) break
    keep(r.map, r.id, r.value); spent += r.size; keptBroadcasts.push(r)
  }

  const build = (): Uint8Array => {
    const copy = new Y.Doc()
    try {
      copy.transact(() => {
        for (const [name, values] of arrays) if (values.length) copy.getArray(name).push(values)
        for (const [name, entries] of maps) for (const [key, value] of entries) copy.getMap(name).set(key, value)
        for (const [name, kept] of receipts) for (const [key, value] of kept) copy.getMap(name).set(key, value)
        for (const publication of publications) publication.copyTo(copy)
        copyRevisionsTo(copy)
      })
      return Y.encodeStateAsUpdate(copy)
    } finally { copy.destroy() }
  }

  let update = build()
  if (update.byteLength <= maxBytes) return update
  /** Drop items from the front of `list`, oldest first, until the estimate covers the excess; rebuild. */
  const shed = <T>(list: T[], size: (item: T) => number, drop: (items: T[]) => void): number => {
    let dropped = 0
    while (update.byteLength > maxBytes && list.length) {
      let need = update.byteLength - maxBytes, n = 0
      while (n < list.length && need > 0) need -= size(list[n++])
      drop(list.splice(0, n)); dropped += n
      update = build()
    }
    return dropped
  }
  const publicationsDropped = shed(publications, value => value.size, () => {})
  if (publicationsDropped) log?.(`snapshot over ${maxBytes} bytes: dropped ${publicationsDropped} completed worker publications`)
  const archive = (maps.get('archive') ?? []).sort(([a, x], [b, y]) => ((x as unknown[])[2] as number) - ((y as unknown[])[2] as number) || compare(a, b))
  const archiveDropped = shed(archive, ([id, value]) => entrySize(id, value), () => {})
  const receiptsDropped = shed(keptBroadcasts.reverse(), r => r.size, items => { for (const r of items) receipts.get(r.map)!.delete(r.id) })
  const oldest = bus.filter(m => typeof m?.id === 'string' && !m.to)
  const busDropped = shed(oldest, m => JSON.stringify(m).length, items => {
    const gone = new Set(items)
    arrays.set('bus', (arrays.get('bus') as BusValue[]).filter(m => !gone.has(m)))
  })
  log?.(`snapshot over ${maxBytes} bytes: dropped ${archiveDropped} archive entries, ${receiptsDropped} broadcast receipts, ${busDropped} bus broadcasts${update.byteLength > maxBytes ? '; still over' : ''}`)
  return update
}
