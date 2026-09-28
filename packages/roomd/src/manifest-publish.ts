import * as Y from 'yjs'
import { containsPath, digestPath, manifestKey, type ManifestEntry, type ManifestHead, type RoomDoc, type ShareLevel } from '@room/shared'

export interface ManifestFact {
  path: string
  change: 'M' | 'A' | 'D'
  hash?: string
  size?: number
  baseHash?: string
  text?: string
  binary?: boolean
  excluded?: boolean
  at?: number
}
export interface ManifestPublication {
  room: RoomDoc
  name: string
  fence: string
  base: string
  level: ShareLevel
  prefixes: readonly string[]
  complete: boolean
  publisher?: string
  scannedAt?: number
}

const authorized = (i: ManifestPublication, p: string) => i.level === 'full' || (i.level === 'declared' && i.prefixes.some(prefix => containsPath(prefix, p)))
const contentIdentity = (e: ManifestEntry) => JSON.stringify({ change: e.change, state: e.state, held: e.held, hash: e.hash, size: e.size, baseHash: e.baseHash, fence: e.fence })
const headIdentity = (h: ManifestHead) => JSON.stringify({ base: h.base, fence: h.fence, coverage: h.coverage, level: h.level, complete: h.complete, publisher: h.publisher, textPrefixes: h.textPrefixes })
const epochOf = (fence: string) => /^\d+$/.test(fence) ? Number(fence) : undefined
function olderEpoch(fence: string, than: string): boolean {
  const a = epochOf(fence), b = epochOf(than)
  return a !== undefined && b !== undefined && a < b
}

/** Whole-snapshot writer; old overlay publication remains untouched during rollout step 1. */
export function publishManifest(input: ManifestPublication, facts: readonly ManifestFact[]): ManifestHead {
  const { room, name, fence } = input
  const salt = room.ensureRoomSalt()
  const key = manifestKey(name, fence)
  const previous = room.manifestHead.get(name)
  const old = room.manifest.get(key)
  const entries = new Map<string, ManifestEntry>()
  const excluded: string[] = []
  if (input.level !== 'intent' && !input.publisher) {
    for (const fact of facts) {
      if (fact.excluded) { excluded.push(digestPath(salt, fact.path)); continue }
      const permit = authorized(input, fact.path)
      const prior = old?.get(fact.path)
      const at = fact.at ?? (prior && prior.hash === (permit ? fact.hash : undefined) && prior.change === fact.change ? prior.at : Date.now())
      const entry: ManifestEntry = { change: fact.change, state: fact.change === 'D' || (permit && !fact.binary && fact.text !== undefined) ? 'shared' : 'held', at, fence }
      if (fact.change !== 'D' && entry.state === 'held') entry.held = permit ? 'binary' : 'scope'
      if (permit) {
        if (fact.hash) entry.hash = fact.hash
        if (fact.size !== undefined) entry.size = fact.size
        if (fact.baseHash) entry.baseHash = fact.baseHash
      }
      entries.set(fact.path, entry)
    }
  }
  excluded.sort()
  const priorEntries = new Map(old?.entries() ?? [])
  const entryChanged = entries.size !== priorEntries.size || [...entries].some(([p, e]) => contentIdentity(e) !== contentIdentity(priorEntries.get(p) ?? {} as ManifestEntry))
  const exclusionChanged = JSON.stringify(excluded) !== JSON.stringify(previous?.excluded ?? [])
  const rev = (previous?.rev ?? 0) + (entryChanged || exclusionChanged ? 1 : 0)
  const head: ManifestHead = {
    base: input.base, fence, coverage: input.publisher ? { kind: 'none', reason: 'not-publisher' } : input.level === 'intent' ? { kind: 'none', reason: 'intent' } : !input.complete ? { kind: 'none', reason: 'starting' } : { kind: 'all' },
    level: input.level, ...(input.level === 'declared' ? { textPrefixes: [...input.prefixes] } : {}), excluded,
    rev, semRev: 0, scannedAt: input.scannedAt ?? Date.now(), complete: input.complete,
    ...(input.publisher ? { publisher: input.publisher } : {}),
  }
  head.semRev = (previous?.semRev ?? 0) + (rev !== previous?.rev || !previous || headIdentity(head) !== headIdentity(previous) ? 1 : 0)
  room.doc.transact(() => {
    // The holder deletes its own participant's older incarnations (manifest §4.1). Epochs only grow, so a
    // stepped-down writer that has not noticed yet can never delete its successor's.
    for (const other of [...room.manifest.keys()]) {
      const split = other.lastIndexOf('\u0000')
      if (other.slice(0, split) === name && olderEpoch(other.slice(split + 1), fence)) room.manifest.delete(other)
    }
    let map = room.manifest.get(key)
    if (!map) { map = new Y.Map<ManifestEntry>(); room.manifest.set(key, map) }
    for (const p of [...map.keys()]) if (!entries.has(p)) map.delete(p)
    for (const [p, e] of entries) if (JSON.stringify(map.get(p)) !== JSON.stringify(e)) map.set(p, e)
    room.manifestHead.set(name, head)
  })
  return head
}

/** A HEAD transition has started (reporooms §B2 step 1): my complete head stops certifying until publishManifest completes it again. */
export function markManifestIncomplete(room: RoomDoc, name: string, fence: string): void {
  const head = room.manifestHead.get(name)
  if (!head?.complete || head.fence !== fence) return
  room.doc.transact(() => {
    room.manifestHead.set(name, { ...head, complete: false, coverage: { kind: 'none', reason: 'starting' }, semRev: head.semRev + 1 })
  })
}
