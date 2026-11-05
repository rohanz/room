import { snapshot, manifestHeadOf, type ParticipantSnapshot, type ParticipantView, type RoomDoc } from '@room/shared'

/** Follow only fenced publisher links, retaining every link for the preview's move check.
 * The requested participant remains the contributor/lineage identity; text and Git facts
 * belong to the terminal publisher. Cycles and unavailable links remain explicit gaps. */
export function checkoutPublication(room: RoomDoc, name: string, view: readonly ParticipantView[]) {
  const links: ParticipantSnapshot[] = []
  const seen = new Set<string>()
  while (!seen.has(name)) {
    seen.add(name)
    const snap = snapshot(room, name, view)
    if (!snap) return { links, snap: undefined }
    links.push(snap)
    if (!snap.fenceValid || snap.head.coverage.kind !== 'none' || snap.head.coverage.reason !== 'not-publisher') return { links, snap }
    if (!snap.head.publisher) return { links, snap: undefined }
    name = snap.head.publisher
  }
  return { links, snap: undefined }
}

/** A healthy publisher performs a full reconciliation every minute. Allow two intervals.
 * Completed workers are immutable retained output, not a live checkout freshness claim. */
export function stalePublication(room: RoomDoc, snap: ParticipantSnapshot, now: number): boolean {
  const worker = room.acceptedWorkerViewOf(snap.name)
  if (snap.retained || worker && worker.status !== 'running') return false
  return !Number.isFinite(snap.head.scannedAt) || snap.head.scannedAt > now || now - snap.head.scannedAt > 120_000
}

/** Display/routing lookup without materializing overlay text. */
export function checkoutPublisherName(room: RoomDoc, name: string): string | undefined {
  const seen = new Set<string>()
  while (!seen.has(name)) {
    seen.add(name)
    const head = manifestHeadOf(room, name)
    if (!head) return seen.size > 1 ? name : undefined // display the known holder while its first scan arrives
    if (head.coverage.kind !== 'none' || head.coverage.reason !== 'not-publisher') return name
    if (!head.publisher) return undefined
    name = head.publisher
  }
  return undefined
}

/** Address the least-idle connected session in this checkout, even during handoff.
 * Unknown activity never outranks verified recent tool activity. */
export function checkoutContact(room: RoomDoc, requested: string, view: readonly ParticipantView[]): string {
  const publisher = checkoutPublisherName(room, requested)
  if (!publisher) return requested
  const candidates = view.filter(p => p.fresh && !p.holder?.ended && typeof p.idleMin === 'number'
    && Number.isFinite(p.idleMin) && checkoutPublisherName(room, p.name) === publisher)
  return candidates.sort((a, b) => a.idleMin! - b.idleMin! || Number(b.name === requested) - Number(a.name === requested))[0]?.name ?? requested
}
