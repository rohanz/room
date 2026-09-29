/**
 * Presence ends within a bounded time once the host session has finished, even when the MCP lives on
 * (registry §18, D5). An interactive host ends by stdin EOF, with the bound `session.json` hostPid as the
 * backstop; a session under a shared `codex app-server` cannot see its thread end, so it leaves after the
 * idle lease, and after H1's eight hours releases the claims and scope that kept it present.
 */
import { gitCommonDir } from '@room/roomd'
import { liveness, type ProcessIdentity } from './leases.js'
import { pidAlive } from './worker-process.js'
import { boundSession, readSessionRecord, type Session } from './session.js'
import { WorkerRegistry } from './worker-registry.js'
import type { NoteMsg } from '@room/shared'
import { parentCommand, type ParentCommandReader } from './workspace.js'

export type HostKind = 'shared-app-server' | 'interactive'

/** A Codex MCP under a shared `codex app-server` cannot see its thread end (registry §18); every other host is a stdio child. */
export function hostKind(env: NodeJS.ProcessEnv = process.env, readParent: ParentCommandReader = parentCommand): HostKind {
  if (env.ROOM_HOST !== 'codex' && env.ROOM_WORKER_HOST !== 'codex') return 'interactive'
  try { return readParent().includes('app-server') ? 'shared-app-server' : 'interactive' } catch { return 'interactive' }
}

/** H1 (registry §18): release this session's own claims and scope after eight idle hours, journaled so a crash replays once. */
export async function releaseIdleHeld(s: Session, idleEpoch: string, idleMs: number, monotonicMs: () => number): Promise<boolean> {
  const lease = s.lease
  if (!lease) return false
  const registry = await WorkerRegistry.open(await gitCommonDir(s.dir), { migrate: false, watch: false })
  try {
    const fence = lease.fence()
    if (!fence) {
      if (registry.hasPendingIdleClaims(s.roomName, lease.sessionId, idleEpoch)) throw new Error('idle claim notice pending while the name lease is paused')
      return false
    }
    return await registry.reconcileIdleClaims({
      roomKey: s.roomName, sessionId: lease.sessionId, participant: s.me.name, idleEpoch, epoch: fence,
      host: 'shared-app-server', lastActivityMs: monotonicMs() - idleMs, monotonicMs, doc: s.room,
      ownsParticipant: () => lease.fence() === fence,
      postNotice: async (id, text) => {
        const posted = await s.post<NoteMsg>(s.me, { type: 'note', text, priority: 'notify' }, { id, auto: true })
        if (!posted.ok) throw new Error(posted.text)
        return posted
      },
    })
  } finally { registry.close() }
}

/** False once the bound host session's process (its `session.json` hostPid) is gone; undefined when unbound. */
export async function hostSessionAlive(dir: string): Promise<boolean | undefined> {
  const bound = boundSession({ cwd: dir })
  if (!bound) return undefined
  const record = readSessionRecord(await gitCommonDir(dir), bound.id)
  if (!record?.hostPid) return undefined
  const identity: ProcessIdentity | undefined = record.chain?.find(member => member.pid === record.hostPid)
  return identity ? liveness(identity) !== 'dead' : pidAlive(record.hostPid)
}

const MINUTE = 60_000
/** The idle lease: an unheld, quiet app-server session leaves after this. */
export const IDLE_LEASE_MS = 30 * MINUTE
/** H1: a quiet app-server session's own claims and scope are released after this. */
export const IDLE_CLAIMS_MS = 8 * 60 * MINUTE
export const PRESENCE_TICK_MS = 30_000

export interface PresenceEndOptions {
  hostKind: HostKind
  /** False once the bound host session's process is gone (its `session.json` hostPid); undefined when unbound. */
  hostAlive(): Promise<boolean | undefined> | boolean | undefined
  /** This session holds scope or claims in any of its rooms. */
  holds(): boolean
  /** It leads a non-terminal worker (`projectable(me).write` is not empty). */
  leadsWorkers(): boolean
  /** A `room_wait` is in progress. */
  waiting(): boolean
  /** The host session ended: end presence everywhere and exit. */
  hostEnded(reason: string): void
  /** The idle lease ran out: end presence in every room; the next activity rejoins. */
  leave(idleMs: number): Promise<void>
  /** H1 at eight hours: release this participant's own claims and scope, with one notice per idle epoch. */
  releaseHeld(idleMs: number, idleEpoch: string): Promise<unknown>
  /** Minutes idle changed: publish it in presence (the heartbeat carries it). */
  publishIdle?(idleMin: number): void
  mono?: () => number
  tickMs?: number
  log?: (line: string) => void
}

export class PresenceEnd {
  readonly mono: () => number
  private last: number
  private epoch = 1
  private published?: number
  private left = false
  private ticking?: Promise<void>
  private readonly timer?: ReturnType<typeof setInterval>

  constructor(private readonly options: PresenceEndOptions) {
    this.mono = options.mono ?? (() => performance.now())
    this.last = this.mono()
    if (options.tickMs !== 0) {
      this.timer = setInterval(() => { void this.tick() }, options.tickMs ?? PRESENCE_TICK_MS)
      this.timer.unref?.()
    }
  }

  stop(): void { clearInterval(this.timer) }

  /** A Room tool call handled for this session, or a hook contact for its bound session. Returns the idle time it ended. */
  activity(): number {
    const now = this.mono()
    const idle = now - this.last
    this.last = now
    this.epoch++
    this.left = false
    this.publish()
    return idle
  }

  idleMs(): number { return Math.max(0, this.mono() - this.last) }
  idleMin(): number { return Math.floor(this.idleMs() / MINUTE) }
  /** The idle lease ended this session's presence; the next activity rejoins. */
  get hasLeft(): boolean { return this.left }

  private publish(): void {
    const minutes = this.idleMin()
    if (minutes === this.published) return
    this.published = minutes
    this.options.publishIdle?.(minutes)
  }

  tick(): Promise<void> {
    this.ticking ??= this.run().finally(() => { this.ticking = undefined })
    return this.ticking
  }

  private async run(): Promise<void> {
    this.publish()
    if (await this.options.hostAlive() === false) { this.options.hostEnded('host session ended'); return }
    if (this.options.hostKind !== 'shared-app-server' || this.left) return
    const idle = this.idleMs()
    if (idle >= IDLE_CLAIMS_MS && this.options.holds()) {
      await this.options.releaseHeld(idle, `idle-${this.epoch}`)
    }
    if (idle >= IDLE_LEASE_MS && !this.options.holds() && !this.options.leadsWorkers() && !this.options.waiting()) {
      this.left = true
      this.options.log?.(`idle ${Math.floor(idle / MINUTE)} min with nothing held: leaving presence (idle lease)`)
      await this.options.leave(idle)
    }
  }
}
