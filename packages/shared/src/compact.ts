import * as Y from 'yjs'
import type { Claim, ClaimAnchor } from './types.js'

// Document compaction (docs/superpowers/specs/2026-10-02-doc-history.md): the room's current values copied
// into a fresh Y.Doc, so the deleted history every earlier operation left behind is gone.

/** The `meta` key naming the document's generation: a new random value at every compaction. */
export const GENERATION_KEY = 'generation'

export const docGeneration = (doc: Y.Doc): string | undefined => {
  const value = doc.getMap('meta').get(GENERATION_KEY)
  return typeof value === 'string' && value ? value : undefined
}

type Kind = 'map' | 'array' | 'text'
type Shape = { _map: Map<string, unknown>; _start: { deleted: boolean; content: { constructor: { name: string } }; right: unknown } | null }

/** A root's kind. Roots that arrived by update and were never read are plain AbstractTypes: read their items. */
function kindOf(type: Y.AbstractType<unknown>): Kind | undefined {
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
  if (value instanceof Y.Array) return Y.Array.from(value.toArray().map(copyValue))
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
        for (const [key, value] of from.entries()) to.set(key, copyValue(value))
      } else if (kind === 'array') copy.getArray<unknown>(name).push(source.getArray<unknown>(name).toArray().map(copyValue))
      else if (kind === 'text') copy.getText(name).applyDelta(source.getText(name).toDelta())
    }
    copy.getMap('meta').set(GENERATION_KEY, generation)
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

/** Every struct in the document's store, tombstones included: what compaction removes. */
export function structCount(doc: Y.Doc): number {
  let n = 0
  for (const list of (doc.store as unknown as { clients: Map<number, unknown[]> }).clients.values()) n += list.length
  return n
}
