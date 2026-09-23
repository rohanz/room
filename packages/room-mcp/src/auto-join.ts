/**
 * Being in the room this session is meant to be in: one step, used at startup and before every
 * room tool call. It is single-flight (concurrent callers share one run), retries transient
 * failures with backoff inside a total deadline, and reports a failure once with its cause. The room
 * meant is the startup choice until the human joins one (room_join, room_create), then that one; it
 * stops for good when the human leaves (room_leave, room_close) or the process shuts down.
 */
import type { Session } from './session.js'
import { NoRoom, NotLoggedIn } from './session.js'
import { RoomdError } from '@room/roomd'

export interface AutoJoinOptions {
  /** One join attempt, of the room a human joined (target) or else the startup choice: the session, or undefined when there is nothing to join (no retry). */
  attempt(target?: Session): Promise<Session | undefined>
  /** Make a joined session the current one. */
  adopt(s: Session): Promise<void>
  /** Leave a session that finished after the run gave up or was cancelled. */
  discard(s: Session): Promise<void>
  /** Is the session this process is meant to hold present and usable? */
  joined(): boolean
  log(line: string): void
  /** Called once per failure streak with the line to show the agent. */
  report(line: string): void
  /** The startup choice is a local room (no server): failures never suggest team rooms. */
  local: boolean
  /** Waits between attempts; the last one repeats. */
  delaysMs?: number[]
  /** Total time one run may take, attempts and waits included. */
  deadlineMs?: number
  /** After a failed run, a tool call starts a new one at most this often. */
  retryAfterMs?: number
  now?: () => number
}

export const JOIN_DELAYS_MS = [1000, 2000, 5000, 10_000, 20_000]
export const JOIN_DEADLINE_MS = 120_000
export const JOIN_RETRY_AFTER_MS = 30_000

/** Where a join failed: set by the step that threw (relay, sync, git, seed, watch). */
export function phaseOf(e: unknown): string | undefined {
  const p = (e as { phase?: unknown } | null)?.phase
  return typeof p === 'string' ? p : undefined
}
const causeOf = (e: unknown) => `${phaseOf(e) ? `(${phaseOf(e)}): ` : ''}${e instanceof Error ? e.message : String(e)}`

/** Failures a human must act on (open the repo, log in, fix the clone) are not retried. */
export function retryable(e: unknown): boolean {
  if (e instanceof NoRoom || e instanceof NotLoggedIn) return false
  return !(e instanceof RoomdError) || e.code === 1
}

/** The one line the agent sees when the automatic join gave up. */
export function joinFailureLine(e: unknown, local: boolean, attempts: number): string {
  if (e instanceof NotLoggedIn) return 'Room is not connected: not logged in; use room_login.'
  const phase = phaseOf(e)
  const head = `Room could not join${local ? ' the local room' : ''}${attempts > 1 ? ` after ${attempts} attempts` : ''}${phase ? ` (${phase})` : ''}: ${e instanceof Error ? e.message : String(e)}`
  return local ? `${head}. Room tries again on the next Room tool call (at most every ${JOIN_RETRY_AFTER_MS / 1000} s); room_join to retry now.` : `${head}; use room_join.`
}

export class AutoJoin {
  private inflight: Promise<void> | null = null
  private cancelled = false
  private wake: (() => void) | null = null
  private endedAt = 0
  /** Why the last run failed, while no session is present; undefined after a join. */
  failure: string | undefined
  private permanent = false
  private target: Session | undefined
  private readonly delays: number[]
  private readonly deadlineMs: number
  private readonly retryAfterMs: number
  private readonly now: () => number

  constructor(private readonly o: AutoJoinOptions) {
    this.delays = o.delaysMs ?? JOIN_DELAYS_MS
    this.deadlineMs = o.deadlineMs ?? JOIN_DEADLINE_MS
    this.retryAfterMs = o.retryAfterMs ?? JOIN_RETRY_AFTER_MS
    this.now = o.now ?? Date.now
  }

  /** Join unless joined, cancelled, or a failed run ended too recently; concurrent callers share one run. */
  ensure(): Promise<void> {
    if (this.inflight) return this.inflight
    if (this.cancelled || this.permanent || this.o.joined()) return Promise.resolve()
    if (this.failure && this.now() - this.endedAt < this.retryAfterMs) return Promise.resolve()
    this.inflight = this.run().finally(() => { this.inflight = null; this.endedAt = this.now() })
    return this.inflight
  }

  /** The run in progress, if any. */
  settle(): Promise<void> { return this.inflight ?? Promise.resolve() }

  /** A human joined s: from now on s's room is the one meant, and a stopped automatic join resumes for it. */
  retarget(s: Session): void {
    this.target = s
    this.cancelled = false
    this.permanent = false
    this.failure = undefined
  }

  /** Stop joining for good: a late session is left, a pending wait ends now. */
  cancel(): void {
    this.cancelled = true
    this.wake?.()
  }

  private async run(): Promise<void> {
    const deadline = this.now() + this.deadlineMs
    let last: unknown
    let attempts = 0
    for (;;) {
      attempts++
      try {
        const s = await this.bounded(this.o.attempt(this.target), deadline)
        if (s === 'gave-up') return
        if (!s) { this.permanent = true; return }
        this.failure = undefined
        await this.o.adopt(s)
        return
      } catch (e) {
        last = e
        if (this.cancelled) return
        if (!retryable(e)) { this.permanent = true; break }
        const wait = this.delays[Math.min(attempts - 1, this.delays.length - 1)]
        if (this.now() + wait >= deadline) break
        this.o.log(`join attempt ${attempts} failed ${causeOf(e)}; retrying in ${Math.round(wait / 1000)}s`)
        await this.sleep(wait)
        if (this.cancelled) return
      }
    }
    this.o.log(`join attempt ${attempts} failed ${causeOf(last)}; giving up for now`)
    const first = this.failure === undefined
    this.failure = joinFailureLine(last, this.target ? !!this.target.local : this.o.local, attempts)
    if (first) this.o.report(this.failure)
  }

  /** The attempt, unless the deadline or a cancel comes first; a session that arrives later is left. */
  private bounded(attempt: Promise<Session | undefined>, deadline: number): Promise<Session | undefined | 'gave-up'> {
    return new Promise((resolve, reject) => {
      let open = true
      const timer = setTimeout(() => finish(() => reject(new RoomdError(`did not finish within the ${Math.round(this.deadlineMs / 1000)}s join deadline`, 1))), Math.max(0, deadline - this.now()))
      const finish = (f: () => void) => { if (!open) return; open = false; clearTimeout(timer); this.wake = null; f() }
      this.wake = () => finish(() => resolve('gave-up'))
      attempt.then(
        s => { if (open) finish(() => resolve(this.cancelled && s ? (void this.o.discard(s), 'gave-up') : s)); else if (s) void this.o.discard(s) },
        e => finish(() => reject(e)),
      )
    })
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.wake = null; resolve() }, ms)
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve() }
    })
  }
}
