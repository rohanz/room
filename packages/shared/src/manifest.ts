import type { RoomDoc, ParticipantRecord } from './doc.js'
import { holderFence, participantRecord } from './doc.js'
import { normalizeCoordinationPath } from './near.js'
import { liveHolder, type ParticipantView } from './views.js'
import type { ShareLevel } from './types.js'

export type Coverage = { kind: 'all' } | { kind: 'none'; reason: 'intent' | 'not-publisher' | 'starting' | 'unprojectable' }
export interface ManifestHead {
  base: string
  fence: string
  coverage: Coverage
  projectedBy?: string
  level: ShareLevel
  textPrefixes?: string[]
  excluded: string[]
  rev: number
  semRev: number
  scannedAt: number
  complete: boolean
  publisher?: string
  projectedFrom?: string
}
export interface ManifestEntry {
  change: 'M' | 'A' | 'D'
  hash?: string
  size?: number
  baseHash?: string
  state: 'shared' | 'held'
  held?: 'scope' | 'binary' | 'worker'
  at: number
  fence: string
}
export interface CoordinationRecord { paths: string[]; workers: string[]; at: number }

export interface ParticipantSnapshot {
  name: string
  head: ManifestHead
  record?: ParticipantRecord
  entries: ReadonlyMap<string, ManifestEntry>
  texts: ReadonlyMap<string, string>
  roomSalt?: string
  fenceValid: boolean
}

export type Version =
  | { kind: 'text'; text: string; entry: ManifestEntry }
  | { kind: 'deleted'; entry: ManifestEntry }
  | { kind: 'base'; text: string | undefined }
  | { kind: 'held'; entry: ManifestEntry; why: string }
  | { kind: 'excluded' }
  | { kind: 'unknown'; why: 'intent' | 'not-publisher' | 'updating' | 'no-record' | 'fetch' | 'no-base-text'; detail: string }

export function manifestKey(name: string, fence: string): string { return `${name}\u0000${fence}` }

/** Enumerate facts from the current writer incarnation, never stale overlay keys. */
export function manifestPaths(room: RoomDoc, name: string): string[] {
  const fence = room.manifestHead.get(name)?.fence
  if (!fence) return []
  return [...room.manifest.get(manifestKey(name, fence))?.entries() ?? []]
    .filter(([, entry]) => entry.fence === fence).map(([path]) => path).sort()
}

export function manifestChangers(room: RoomDoc, path: string): string[] {
  return [...room.manifestHead.keys()].filter(name => manifestPaths(room, name).includes(path)).sort()
}

function fenceValid(head: ManifestHead, record: ParticipantRecord | undefined, view: readonly ParticipantView[]): boolean {
  const expected = head.projectedFrom ? liveHolder(view, head.projectedBy ?? '') : holderFence(record?.holder)
  return !!expected && head.fence === expected
}

/** Copy the current incarnation in one synchronous read, including plain text values. */
export function snapshot(room: RoomDoc, name: string, view: readonly ParticipantView[]): ParticipantSnapshot | undefined {
  const head = room.manifestHead.get(name)
  if (!head) return undefined
  const record = participantRecord(room, name)
  const entries = new Map<string, ManifestEntry>()
  for (const [path, entry] of room.manifest.get(manifestKey(name, head.fence))?.entries() ?? []) {
    if (entry.fence === head.fence) entries.set(path, { ...entry })
  }
  const texts = new Map<string, string>()
  const overlay = room.overlays.get(manifestKey(name, head.fence))
  for (const [path, text] of overlay?.entries() ?? []) texts.set(path, text.toString())
  return { name, head: { ...head, excluded: [...head.excluded] }, record, entries, texts, roomSalt: room.roomSalt, fenceValid: fenceValid(head, record, view) }
}

/** A single-file reader need not materialize every published overlay in the room. */
export function snapshotPath(room: RoomDoc, name: string, view: readonly ParticipantView[], path: string): ParticipantSnapshot | undefined {
  const head = room.manifestHead.get(name)
  if (!head) return undefined
  const record = participantRecord(room, name)
  const key = manifestKey(name, head.fence)
  const entry = room.manifest.get(key)?.get(path)
  const entries = new Map<string, ManifestEntry>()
  if (entry?.fence === head.fence) entries.set(path, { ...entry })
  const texts = new Map<string, string>()
  const value = entry?.fence === head.fence ? room.overlays.get(key)?.get(path) : undefined
  if (value) texts.set(path, value.toString())
  return { name, head: { ...head, excluded: [...head.excluded] }, record, entries, texts, roomSalt: room.roomSalt, fenceValid: fenceValid(head, record, view) }
}

export function snapshotStillCurrent(room: RoomDoc, snap: ParticipantSnapshot, view: readonly ParticipantView[]): boolean {
  const head = room.manifestHead.get(snap.name)
  const record = participantRecord(room, snap.name)
  if (!head || !snap.fenceValid || !fenceValid(snap.head, record, view) || !fenceValid(head, record, view)) return false
  const a = snap.head, b = head
  return a.semRev === b.semRev && a.rev === b.rev && a.fence === b.fence && a.base === b.base &&
    a.complete === b.complete && a.level === b.level && a.projectedBy === b.projectedBy &&
    a.projectedFrom === b.projectedFrom && a.publisher === b.publisher &&
    JSON.stringify(a.coverage) === JSON.stringify(b.coverage) &&
    JSON.stringify(a.excluded) === JSON.stringify(b.excluded) &&
    JSON.stringify(a.textPrefixes) === JSON.stringify(b.textPrefixes) &&
    snap.roomSalt === room.roomSalt &&
    snap.record?.git?.head === record?.git?.head && snap.record?.git?.base === record?.git?.base &&
    snap.record?.git?.fence === record?.git?.fence && snap.record?.git?.rev === record?.git?.rev
}

/** Resolve only from the immutable snapshot; a hashless held entry always remains a gap. */
export async function versionOf(snap: ParticipantSnapshot | undefined, path: string, env: {
  gitAt?: (sha: string, path: string) => Promise<string | undefined>
  known?: (hash: string) => Promise<string | undefined>
  hashText?: (text: string, format: 'sha1' | 'sha256') => Promise<string> | string
  digest?: (roomSalt: string, path: string) => Promise<string> | string
} = {}): Promise<Version> {
  if (!snap) return { kind: 'unknown', why: 'no-record', detail: 'no manifest record' }
  const { head } = snap
  if (!head.complete || !snap.fenceValid) {
    return { kind: 'unknown', why: 'updating', detail: 'manifest is updating' }
  }
  if (head.coverage.kind === 'none' && head.coverage.reason === 'not-publisher')
    return { kind: 'unknown', why: 'not-publisher', detail: `not publisher; ${head.publisher ?? 'another participant'} publishes this worktree` }
  if (head.base !== snap.record?.git?.base || snap.record.git.fence !== head.fence)
    return { kind: 'unknown', why: 'updating', detail: 'manifest is updating' }
  if (head.coverage.kind === 'none') return { kind: 'unknown', why: 'intent', detail: head.coverage.reason }
  const entry = snap.entries.get(path)
  if (entry) {
    if (entry.change === 'D') return { kind: 'deleted', entry }
    const text = entry.state === 'shared' ? snap.texts.get(path) : entry.hash ? await env.known?.(entry.hash) : undefined
    const hashText = env.hashText ?? (async (value: string, format: 'sha1' | 'sha256') => (await import('./manifest-node.js')).gitBlobHash(value, format))
    if (text !== undefined && entry.hash && await hashText(text, entry.hash.length === 64 ? 'sha256' : 'sha1') === entry.hash) return { kind: 'text', text, entry }
    if (entry.state === 'held') return { kind: 'held', entry, why: entry.held ?? 'text not shared' }
    return { kind: 'unknown', why: 'updating', detail: 'shared text is missing or does not match its hash' }
  }
  if (!snap.roomSalt || !/^[a-f0-9]{64}$/i.test(snap.roomSalt))
    return { kind: 'unknown', why: 'updating', detail: 'room salt is missing or invalid; exclusion coverage cannot be certified' }
  const digest = env.digest ?? (async (salt: string, value: string) => (await import('./manifest-node.js')).digestPath(salt, value))
  if (head.excluded.includes(await digest(snap.roomSalt, path))) return { kind: 'excluded' }
  if (!env.gitAt) return { kind: 'unknown', why: 'no-base-text', detail: 'base text not in the room' }
  try { return { kind: 'base', text: await env.gitAt(head.base, path) } }
  catch { return { kind: 'unknown', why: 'fetch', detail: 'base commit is unavailable' } }
}

/** Own-file reads are always from the caller's checkout, even at intent or as a non-publisher. */
export async function localVersionOf(path: string, read: (path: string) => Promise<string | undefined>): Promise<{ kind: 'text'; text: string } | { kind: 'deleted' }> {
  const text = await read(path)
  return text === undefined ? { kind: 'deleted' } : { kind: 'text', text }
}
