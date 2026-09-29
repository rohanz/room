import {
  manifestChangers, manifestKey, manifestPaths, normalizeCoordinationPath, snapshot, snapshotMetadata, snapshotStillCurrent, versionOf,
  type ManifestEntry, type ParticipantView, type RoomDoc, type Version,
} from '@room/shared'

const bytes = new TextEncoder()
const hex = (data: ArrayBuffer) => [...new Uint8Array(data)].map(value => value.toString(16).padStart(2, '0')).join('')

/** Git's object header is part of the blob ID, including for an empty file. */
export async function browserBlobHash(text: string, format: 'sha1' | 'sha256' = 'sha1'): Promise<string> {
  const body = bytes.encode(text)
  const header = bytes.encode(`blob ${body.length}\0`)
  const input = new Uint8Array(header.length + body.length)
  input.set(header)
  input.set(body, header.length)
  return hex(await crypto.subtle.digest(format === 'sha1' ? 'SHA-1' : 'SHA-256', input))
}

async function browserPathDigest(salt: string, path: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/i.test(salt)) throw new Error('invalid roomSalt')
  const prefix = Uint8Array.from(salt.match(/../g)!, value => Number.parseInt(value, 16))
  const suffix = bytes.encode(normalizeCoordinationPath(path))
  const input = new Uint8Array(prefix.length + suffix.length)
  input.set(prefix)
  input.set(suffix, prefix.length)
  return hex(await crypto.subtle.digest('SHA-256', input))
}

/** The browser has no git. A missing stored base is a gap, even for an absent manifest entry. */
export async function readWebVersion(room: RoomDoc, name: string, path: string, currentView: () => readonly ParticipantView[]): Promise<Version> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = snapshot(room, name, currentView())
    const result = await versionOf(current, path, {
      gitAt: async (base, relpath) => room.baseText(name, base, relpath),
      hashText: browserBlobHash,
      digest: browserPathDigest,
    })
    if (current && !snapshotStillCurrent(room, current, currentView())) continue
    return result.kind === 'base' && result.text === undefined
      ? { kind: 'unknown', why: 'no-base-text', detail: 'base text not in the room' }
      : result
  }
  return { kind: 'unknown', why: 'updating', detail: `${name}'s changes moved during the read; re-run` }
}

interface WebGap { person: string; path?: string; why: string }
export interface WebCoverage { complete: boolean; gaps: WebGap[]; shared: string[]; held: string[]; unchanged: string[]; declaredDirectories: number }

/** Coverage is a participant property too: intent and unnamed excluded changes stay visible as gaps. */
export function webCoverage(room: RoomDoc, name: string, view: readonly ParticipantView[] = []): WebCoverage {
  const snap = snapshotMetadata(room, name, view)
  const gaps: WebGap[] = []
  const shared: string[] = [], held: string[] = []
  const unchanged: string[] = []
  const add = (why: string, path?: string) => gaps.push({ person: name, path, why })
  if (!snap) add('no manifest record')
  else {
    if (!snap.roomSalt || !/^[a-f0-9]{64}$/i.test(snap.roomSalt)) add('room salt missing or invalid; exclusion coverage cannot be certified')
    if (!snap.head.complete || !snap.fenceValid || (!(snap.head.coverage.kind === 'none' && snap.head.coverage.reason === 'not-publisher') &&
      (snap.head.base !== snap.record?.git?.base || snap.record.git.fence !== snap.head.fence))) add('manifest updating; re-run')
    if (snap.head.coverage.kind === 'none') add(snap.head.coverage.reason === 'not-publisher'
      ? `not publisher; ${snap.head.publisher ?? 'another participant'} publishes this worktree` : snap.head.coverage.reason)
    if (snap.head.excluded.length) add(`${snap.head.excluded.length} changed paths excluded; names not shared`)
    for (const [path, entry] of snap.entries) {
      if (entry.state === 'held') { held.push(path); add(heldReason(entry), path) }
      else shared.push(path)
    }
    if (snap.head.complete && snap.fenceValid && snap.head.coverage.kind === 'all') {
      for (const path of snap.head.textPrefixes ?? []) {
        if (path.endsWith('/') || snap.entries.has(path)) continue
        if (room.baseText(name, snap.head.base, path) !== undefined) unchanged.push(path)
        else add('base text not in the room', path)
      }
    }
  }
  const declaredDirectories = snap?.head.textPrefixes?.filter(path => path.endsWith('/')).length ?? 0
  return { complete: gaps.length === 0, gaps, shared: shared.sort(), held: held.sort(), unchanged: unchanged.sort(), declaredDirectories }
}

function heldReason(entry: ManifestEntry): string {
  if (entry.held === 'scope') return 'outside declared area; text not shared'
  if (entry.held === 'binary') return 'binary text not shared'
  if (entry.held === 'worker') return 'worker text not shared'
  return 'text not shared'
}

export function versionGap(version: Version): string | undefined {
  if (version.kind === 'held') return heldReason(version.entry)
  if (version.kind === 'excluded') return 'changed path excluded; name not shared'
  if (version.kind === 'unknown') return version.detail
  return undefined
}

export function manifestPeople(room: RoomDoc): string[] { return [...room.manifestHead.keys()].sort() }
export function webChangedPaths(room: RoomDoc, name: string): string[] { return manifestPaths(room, name) }
export function webChangerLabels(room: RoomDoc, path: string): string[] {
  return manifestChangers(room, path).map(name => {
    const head = room.manifestHead.get(name)
    const entry = head && room.manifest.get(manifestKey(name, head.fence))?.get(path)
    return entry?.state === 'held' ? `${name} (not shared: ${heldReason(entry)})` : name
  })
}
