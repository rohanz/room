/**
 * Server-instructions rule 1: a room is silent while alone. A message may reach a session unasked (a wake over
 * the host's path, or the before-edit / SessionStart hook inbox) only while someone else is here. Everything
 * else stays owed: room_state and the next Room tool reply show it.
 *  - Company is another participant present now (company.ts), not counting this session's own workers.
 *  - Own workers are company for worker notices only: their own messages, and Room's notices naming them,
 *    which are audible even after the worker exited (its done or failure report is the point).
 *  - A Room notice (from `room`) posted while this session was alone stays quiet when company arrives later.
 *  - The human's own words to their agent are never held back.
 */
import { highestSeq, type Msg } from '@room/shared'
import type { CompanyState } from './company.js'
import type { Session } from './session.js'

export interface SoloGateOptions {
  /** Company now (state.ts `company`); this session's own workers in it are discounted. */
  company: (s: Session) => CompanyState
  /** This session's own workers, by participant name. */
  ownWorkers: (s: Session) => ReadonlySet<string>
  /** Company arrived or left: what is audible changed. */
  onChange?: () => void
}

export class SoloGate {
  /** Per joined room: the highest seq when its current company began; absent while alone. */
  private readonly since = new Map<Session, number>()
  private readonly seen = new WeakSet<Session>()

  constructor(private readonly o: SoloGateOptions) {}

  /** Follow presence, so company begins at its arrival rather than at the next message. */
  watch(s: Session): () => void {
    const changed = () => { if (this.observe(s)) this.o.onChange?.() }
    this.observe(s)
    s.awareness.on('change', changed)
    return () => { s.awareness.off('change', changed); this.since.delete(s) }
  }

  /** Whether a message may wake this session or reach its hooks now; company and workers are read once per call. */
  audible(s: Session): (m: Msg) => boolean {
    const workers = this.o.ownWorkers(s)
    this.observe(s, this.o.company(s), workers)
    const since = this.since.get(s)
    return m => (m.from === s.me.name && m.fromKind === 'human')
      // The worker is the company its notice needs, even once it has exited (its done or failure report).
      || workerNotice(m, workers)
      || (since !== undefined && (m.from !== 'room' || (m.seq ?? 0) > since))
  }

  /** Records a transition; true when company arrived or left. */
  private observe(s: Session, company = this.o.company(s), workers = this.o.ownWorkers(s)): boolean {
    const present = company.others.some(name => !workers.has(name))
    const first = !this.seen.has(s)
    this.seen.add(s)
    if (present === this.since.has(s)) return false
    if (!present) this.since.delete(s)
    // Company already here at the first look: nothing was posted while alone that this session saw.
    else this.since.set(s, first ? 0 : highestSeq(s.room))
    return !first
  }
}

/** A worker's own message, or Room's notice naming one of this session's workers. */
function workerNotice(m: Msg, workers: ReadonlySet<string>): boolean {
  if (workers.has(m.from)) return true
  if (m.from !== 'room' || !('text' in m) || typeof m.text !== 'string') return false
  const text = m.text
  return [...workers].some(name => text.includes(name))
}
