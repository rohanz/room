import { createHash } from 'node:crypto'
import type { RoomDoc, ParticipantRecord } from './doc.js'
import { participantRecord } from './doc.js'
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

/** Path digests contain no path bytes and use the room's decoded 32-byte salt. */
export function digestPath(roomSalt: string, path: string): string {
  if (!/^[a-f0-9]{64}$/i.test(roomSalt)) throw new Error('invalid roomSalt')
  return createHash('sha256').update(Buffer.from(roomSalt, 'hex')).update(normalizeCoordinationPath(path), 'utf8').digest('hex')
}

export function gitBlobHash(text: string, format: 'sha1' | 'sha256' = 'sha1'): string {
  const bytes = Buffer.from(text)
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

function fenceValid(head: ManifestHead, record: ParticipantRecord | undefined, view: readonly ParticipantView[]): boolean {
  const expected = head.projectedFrom ? liveHolder(view, head.projectedBy ?? '') : record?.holder?.sessionId
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
  // Step 1 keeps text in the legacy participant-keyed overlay until readers cut over.
  const overlay = room.overlays.get(name)
  for (const [path, text] of overlay?.entries() ?? []) texts.set(path, text.toString())
  return { name, head: { ...head, excluded: [...head.excluded] }, record, entries, texts, roomSalt: room.roomSalt, fenceValid: fenceValid(head, record, view) }
}

export function snapshotStillCurrent(room: RoomDoc, snap: ParticipantSnapshot, view: readonly ParticipantView[]): boolean {
  const head = room.manifestHead.get(snap.name)
  return !!head && head.semRev === snap.head.semRev && fenceValid(head, participantRecord(room, snap.name), view)
}

/** Resolve only from the immutable snapshot; a hashless held entry always remains a gap. */
export async function versionOf(snap: ParticipantSnapshot | undefined, path: string, env: {
  gitAt?: (sha: string, path: string) => Promise<string | undefined>
  known?: (hash: string) => Promise<string | undefined>
} = {}): Promise<Version> {
  if (!snap) return { kind: 'unknown', why: 'no-record', detail: 'no manifest record' }
  const { head } = snap
  if (!head.complete || !snap.fenceValid || head.base !== snap.record?.git?.base || snap.record.git.fence !== head.fence) {
    return { kind: 'unknown', why: 'updating', detail: 'manifest is updating' }
  }
  if (head.coverage.kind === 'none') return { kind: 'unknown', why: head.coverage.reason === 'not-publisher' ? 'not-publisher' : 'intent', detail: head.coverage.reason }
  const entry = snap.entries.get(path)
  if (entry) {
    if (entry.change === 'D') return { kind: 'deleted', entry }
    const text = entry.state === 'shared' ? snap.texts.get(path) : entry.hash ? await env.known?.(entry.hash) : undefined
    if (text !== undefined && entry.hash && gitBlobHash(text, entry.hash.length === 64 ? 'sha256' : 'sha1') === entry.hash) return { kind: 'text', text, entry }
    if (entry.state === 'held') return { kind: 'held', entry, why: entry.held ?? 'text not shared' }
    return { kind: 'unknown', why: 'updating', detail: 'shared text is missing or does not match its hash' }
  }
  if (snap.roomSalt && head.excluded.includes(digestPath(snap.roomSalt, path))) return { kind: 'excluded' }
  if (!env.gitAt) return { kind: 'unknown', why: 'no-base-text', detail: 'base text not in the room' }
  try { return { kind: 'base', text: await env.gitAt(head.base, path) } }
  catch { return { kind: 'unknown', why: 'fetch', detail: 'base commit is unavailable' } }
}

/** Own-file reads are always from the caller's checkout, even at intent or as a non-publisher. */
export async function localVersionOf(path: string, read: (path: string) => Promise<string | undefined>): Promise<{ kind: 'text'; text: string } | { kind: 'deleted' }> {
  const text = await read(path)
  return text === undefined ? { kind: 'deleted' } : { kind: 'text', text }
}
