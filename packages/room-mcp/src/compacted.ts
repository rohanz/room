/**
 * Replacing a session whose replica the server refused (ws close 4409; docs/superpowers/specs/2026-10-02-doc-history.md
 * §5): the room's document was compacted when the server restarted, so this replica must never merge again. The
 * replacement is the host-rebind path run inside the auto-join's retries: every joined session is dropped, the room
 * is joined afresh under the same name and session id, the participant's claims and scope stay (they are in the
 * compacted room), and the workers room is re-attached.
 */
import { joinSession, whenStale, type JoinOptions, type Session } from './session.js'
import { rejoinOptions } from './tools/join.js'

export interface StaleReplacementOptions {
  joinedSessions(): Session[]
  drop(s: Session, reason: string): Promise<void>
  attachWorkersRoom(s: Session, lead: Session): void
  credentialsPath?: string
  log(line: string): void
  join?: (opts: JoinOptions) => Promise<Session>
}

export class StaleReplacement {
  private pending: { primary: Session; secondaries: Session[] } | undefined
  constructor(private readonly o: StaleReplacementOptions) {}

  /** A replacement is owed: its join has not been adopted yet. */
  get active(): boolean { return !!this.pending }

  /** Before a join attempt: a stale current session and its secondaries are dropped, once. True while a replacement is owed. */
  async begin(current: Session | null): Promise<boolean> {
    if (!this.pending && current?.stale) {
      const joined = this.o.joinedSessions()
      const all = joined.includes(current) ? joined : [current, ...joined]
      this.pending = { primary: all[0]!, secondaries: all.slice(1) }
      this.o.log(`${current.roomName}: rejoining with a fresh copy of the room under the same name`)
      for (const old of [...all].reverse()) await this.o.drop(old, current.stale.reason)
    }
    return !!this.pending
  }

  /** The replacement's join: the stale primary's room and name, under its session id. */
  join(): Promise<Session> {
    const { primary } = this.pending!
    return (this.o.join ?? joinSession)({ ...rejoinOptions(primary, this.o.credentialsPath), sessionId: primary.lease?.sessionId, log: this.o.log })
  }

  /** Adopt the fresh session without clearing its own claims, as a host rebind does, then rejoin the secondaries. */
  async finish(fresh: Session, adopt: (s: Session, clearStale: boolean) => Promise<void>): Promise<void> {
    const { primary, secondaries } = this.pending!
    this.pending = undefined
    const removed = removeOwnMirrors(fresh)
    if (removed) this.o.log(`${fresh.roomName}: removed ${removed} mirrored worker claim(s); the workers bridge mirrors them again`)
    await adopt(fresh, false)
    for (const old of secondaries) {
      try { this.o.attachWorkersRoom(await (this.o.join ?? joinSession)({ ...rejoinOptions(old, this.o.credentialsPath), sessionId: primary.lease?.sessionId, log: this.o.log }), fresh) }
      catch (error) { this.o.log(`could not rejoin ${old.roomName} after the replacement: ${error instanceof Error ? error.message : String(error)}; it is joined again when a worker needs it`) }
    }
  }

  /** A human chose a room (room_join, room_create): no replacement is owed any more. */
  forget(): void { this.pending = undefined }
}

/**
 * The workers bridge kept its map from local claims to team mirrors in memory only, and its removals went into the
 * refused replica: the new bridge mirrors every local claim again, so the persisted mirrors (this participant's,
 * with `mirrorOf`) go first.
 */
export function removeOwnMirrors(s: Session): number {
  const mirrors = s.room.openClaims().filter(c => c.by === s.me.name && !!c.mirrorOf)
  if (mirrors.length) s.room.doc.transact(() => { for (const c of mirrors) s.room.removeClaim(c.id, s.me) }, s.me)
  return mirrors.length
}

/**
 * Once `s` is refused, run the auto-join that replaces it. A session can already be stale when it is adopted (the
 * server compacted between its sync and the join's return): the join in flight is its own, so the replacement is
 * started after that join settles, if `s` is still the current session.
 */
export function rejoinWhenStale(s: Session, current: () => Session | null, autoJoin: { settle(): Promise<void>; retarget(s: Session): void; ensure(): Promise<void> }): void {
  whenStale(s, () => {
    void autoJoin.settle().then(() => {
      if (current() !== s || !s.stale) return
      autoJoin.retarget(s)
      void autoJoin.ensure()
    })
  })
}
