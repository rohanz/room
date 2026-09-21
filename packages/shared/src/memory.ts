import * as Y from 'yjs'

/** Memory is kept; live state is rebuilt by whoever is present. Unknown types are
 * deliberately excluded, including claims, file text, graphs and overlay timestamps. */
export const MEMORY_TYPES = {
  bus: 'array', ledger: 'map', retiredWorkers: 'array', workers: 'map',
  scopes: 'map', colors: 'map', meta: 'map',
} as const

/** Dynamic top-level maps: seen:<encoded participant> holds message-id -> read timestamp.
 * Keep only the newest 2000 ids per participant; never persist arbitrary future maps. */
export const MEMORY_PREFIXES = { 'seen:': { kind: 'map', limit: 2000 } } as const

export function* memoryTypes(doc: Y.Doc): Generator<[string, 'map' | 'array', number?]> {
  for (const [name, kind] of Object.entries(MEMORY_TYPES)) if (doc.share.has(name)) yield [name, kind]
  for (const name of doc.share.keys()) {
    for (const [prefix, rule] of Object.entries(MEMORY_PREFIXES)) {
      if (name.startsWith(prefix)) yield [name, rule.kind, rule.limit]
    }
  }
}

/** Copy values into fresh CRDT types: no live text or deleted CRDT history on disk. */
export function memorySnapshot(doc: Y.Doc): Uint8Array {
  const copy = new Y.Doc()
  try {
    copy.transact(() => {
      for (const [name, kind, limit] of memoryTypes(doc)) {
        // Remote updates initially have abstract types; resolve their schema before toJSON.
        if (kind === 'array') {
          const values = JSON.parse(JSON.stringify(doc.getArray(name).toArray()))
          if (values.length) copy.getArray(name).push(values)
        } else {
          let entries = Object.entries(JSON.parse(JSON.stringify(doc.getMap(name).toJSON())))
          if (limit !== undefined) entries = entries
            .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
          for (const [key, value] of entries) copy.getMap(name).set(key, value)
        }
      }
    })
    return Y.encodeStateAsUpdate(copy)
  } finally { copy.destroy() }
}
