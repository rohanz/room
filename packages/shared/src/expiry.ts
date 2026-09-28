/**
 * The one destructive-expiry authority (reporooms, "Participants view", S5): the trim leader measures
 * each participant's continuous absence on its own monotonic clock, one leadership tenure (epoch) at a
 * time, and expires a participant once the measured total reaches ROOM_STALE_DAYS.
 */
import type * as Y from 'yjs'
import { participantRecord, type RoomDoc } from './doc.js'
import { ROOM_STALE_MS, type ParticipantView } from './views.js'

/** For messages only; ROOM_STALE_MS in views.ts is the rule. */
export const ROOM_STALE_DAYS = ROOM_STALE_MS / (24 * 60 * 60 * 1000)

type Observed = { observedMs: number; epoch: string }
/** A run of this tenure's own measurements: absence since `t0` (this leader's clock) on top of `base`. */
interface Segment { t0: number; base: number; expect?: Observed }

const same = (a?: Observed, b?: Observed) => a === b || (!!a && !!b && a.observedMs === b.observedMs && a.epoch === b.epoch)

export class ExpiryTenure {
  private readonly segments = new Map<string, Segment>()

  /** `clock` is monotonic and local; nothing another machine wrote is ever compared with it. */
  constructor(readonly epoch: string, private readonly clock: () => number) {}

  /**
   * One leader tick. A participant is measured only when it has a `holder` (a lease-holding session that
   * could be fresh) and is not a worker. A segment adds time only while `expiry[name]` still holds what
   * this tenure last saw there, so a concurrent leader's write restarts the measurement instead of being
   * counted twice. Returns the names it expired.
   */
  observe(room: RoomDoc, view: readonly ParticipantView[], origin?: unknown): string[] {
    const now = this.clock()
    const expired: string[] = []
    const measured = new Set<string>()
    room.doc.transact(() => {
      for (const participant of view) {
        const { name } = participant
        const holder = participantRecord(room, name)?.holder
        if (!holder || holder.workerId || room.workerOf(name)) continue
        measured.add(name)
        const current = room.expiry.get(name)
        if (participant.fresh) {
          this.segments.delete(name)
          if (current) room.expiry.delete(name)
          continue
        }
        const segment = this.segments.get(name)
        if (!segment || !same(current, segment.expect)) {
          this.segments.set(name, { t0: now, base: current?.observedMs ?? 0, expect: current })
          continue
        }
        const next = { observedMs: segment.base + Math.max(0, now - segment.t0), epoch: this.epoch }
        room.expiry.set(name, next)
        segment.expect = next
        if (next.observedMs >= ROOM_STALE_MS) expired.push(name)
      }
      for (const name of expired) expireParticipant(room, name, origin)
    }, origin)
    for (const name of this.segments.keys()) if (!measured.has(name) || expired.includes(name)) this.segments.delete(name)
    return expired
  }
}

/**
 * Remove everything a participant owns, in one transaction: participant fields, manifest and head,
 * overlay text, claims (with release notices), scope, graph and owned conflict slots. Owed mail is
 * the ledger's and stays.
 */
export function expireParticipant(room: RoomDoc, name: string, origin?: unknown): void {
  const prefix = `${name}\u0000`
  const dropOwned = (map: Y.Map<unknown>) => { for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key) }
  room.doc.transact(() => {
    dropOwned(room.participants)
    dropOwned(room.doc.getMap('manifest'))
    room.doc.getMap('manifestHead').delete(name)
    dropOwned(room.doc.getMap('conflicts'))
    room.clearWorkerCoordination(name, `expired after ${ROOM_STALE_DAYS} days offline`)
    room.bases.delete(name)
    room.expiry.delete(name)
  }, origin)
}
