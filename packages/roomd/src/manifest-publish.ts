import * as Y from 'yjs'
import { setImmediate } from 'node:timers/promises'
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

/** Prepare every comparison and digest before the atomic Y transaction. */
function* manifestPlanSteps(input: ManifestPublication, facts: readonly ManifestFact[]) {
  const { room, name, fence } = input
  const salt = room.ensureRoomSalt()
  const key = manifestKey(name, fence)
  const previous = room.manifestHead.get(name)
  const old = room.manifest.get(key)
  const entries = new Map<string, ManifestEntry>()
  const excluded: string[] = []
  if (input.level !== 'intent' && !input.publisher) {
    for (const fact of facts) {
      yield
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
  const priorEntries = new Map<string, ManifestEntry>()
  for (const [p, e] of old?.entries() ?? []) { yield; priorEntries.set(p, e) }
  let entryChanged = entries.size !== priorEntries.size
  for (const [p, e] of entries) {
    yield
    if (contentIdentity(e) !== contentIdentity(priorEntries.get(p) ?? {} as ManifestEntry)) entryChanged = true
  }
  const exclusionChanged = JSON.stringify(excluded) !== JSON.stringify(previous?.excluded ?? [])
  const rev = (previous?.rev ?? 0) + (entryChanged || exclusionChanged ? 1 : 0)
  const oldManifestKeys = [...room.manifest.keys()].filter(other => {
    const split = other.lastIndexOf('\u0000')
    return other.slice(0, split) === name && olderEpoch(other.slice(split + 1), fence)
  })
  const oldOverlayKeys = [...room.overlays.keys()].filter(other => {
    const split = other.lastIndexOf('\u0000')
    return other.slice(0, split) === name && olderEpoch(other.slice(split + 1), fence)
  })
  const deletes: string[] = []
  for (const p of priorEntries.keys()) { yield; if (!entries.has(p)) deletes.push(p) }
  const sets: [string, ManifestEntry][] = []
  for (const [p, e] of entries) { yield; if (JSON.stringify(priorEntries.get(p)) !== JSON.stringify(e)) sets.push([p, e]) }
  const scannedAt = input.scannedAt ?? Date.now()
  const makeHead = (complete: boolean): ManifestHead => {
    const head: ManifestHead = {
      base: input.base, fence, coverage: input.publisher ? { kind: 'none', reason: 'not-publisher' } : input.level === 'intent' ? { kind: 'none', reason: 'intent' } : !complete ? { kind: 'none', reason: 'starting' } : { kind: 'all' },
      level: input.level, ...(input.level === 'declared' ? { textPrefixes: [...input.prefixes] } : {}), excluded,
      rev, semRev: 0, scannedAt, complete,
      ...(input.publisher ? { publisher: input.publisher } : {}),
    }
    head.semRev = (previous?.semRev ?? 0) + (rev !== previous?.rev || !previous || headIdentity(head) !== headIdentity(previous) ? 1 : 0)
    return head
  }
  const heads = { complete: makeHead(true), incomplete: makeHead(false) }
  return { heads, commit(complete: boolean): ManifestHead {
    const head = complete ? heads.complete : heads.incomplete
    // The holder deletes its own participant's older incarnations (manifest §4.1). Epochs only grow, so a
    // stepped-down writer that has not noticed yet can never delete its successor's.
    for (const other of oldManifestKeys) room.manifest.delete(other)
    // Text is keyed by the same incarnation. An old map may outlive its manifest after a
    // prior partial cleanup, so enumerate overlays independently on every publication.
    for (const other of oldOverlayKeys) room.overlays.delete(other)
    let map = room.manifest.get(key)
    if (!map) { map = new Y.Map<ManifestEntry>(); room.manifest.set(key, map) }
    for (const p of deletes) map.delete(p)
    for (const [p, e] of sets) map.set(p, e)
    room.manifestHead.set(name, head)
    return head
  } }
}

export function prepareManifestPublication(input: ManifestPublication, facts: readonly ManifestFact[]) {
  const steps = manifestPlanSteps(input, facts)
  for (;;) { const result = steps.next(); if (result.done) return result.value }
}

export async function prepareManifestPublicationYielding(input: ManifestPublication, facts: readonly ManifestFact[]) {
  const steps = manifestPlanSteps(input, facts)
  let count = 0
  for (;;) {
    if (count++ % 32 === 0) await setImmediate()
    const result = steps.next()
    if (result.done) return result.value
  }
}

/** Whole-snapshot writer; old overlay publication remains untouched during rollout step 1. */
export function publishManifest(input: ManifestPublication, facts: readonly ManifestFact[]): ManifestHead {
  const prepared = prepareManifestPublication(input, facts)
  let head: ManifestHead | undefined
  input.room.doc.transact(() => { head = prepared.commit(input.complete) })
  return head!
}

/** A HEAD transition has started (reporooms §B2 step 1): my complete head stops certifying until publishManifest completes it again. */
export function markManifestIncomplete(room: RoomDoc, name: string, fence: string): void {
  const head = room.manifestHead.get(name)
  if (!head?.complete || head.fence !== fence) return
  room.doc.transact(() => {
    room.manifestHead.set(name, { ...head, complete: false, coverage: { kind: 'none', reason: 'starting' }, semRev: head.semRev + 1 })
  })
}
