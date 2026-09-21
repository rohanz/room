import * as Y from 'yjs'

/** Memory is kept; live state is rebuilt by whoever is present. Unknown types are
 * deliberately excluded, including claims, file text, graphs and overlay timestamps. */
export const MEMORY_TYPES = {
  bus: 'array', ledger: 'map', retiredWorkers: 'array', workers: 'map',
  scopes: 'map', colors: 'map', meta: 'map',
} as const

/** Copy values into fresh CRDT types: no live text or deleted CRDT history on disk. */
export function memorySnapshot(doc: Y.Doc): Uint8Array {
  const copy = new Y.Doc()
  try {
    copy.transact(() => {
      for (const [name, kind] of Object.entries(MEMORY_TYPES)) {
        if (!doc.share.has(name)) continue
        // Remote updates initially have abstract types; resolve their schema before toJSON.
        if (kind === 'array') {
          const values = JSON.parse(JSON.stringify(doc.getArray(name).toArray()))
          if (values.length) copy.getArray(name).push(values)
        } else {
          const values = JSON.parse(JSON.stringify(doc.getMap(name).toJSON()))
          for (const [key, value] of Object.entries(values)) copy.getMap(name).set(key, value)
        }
      }
    })
    return Y.encodeStateAsUpdate(copy)
  } finally { copy.destroy() }
}
