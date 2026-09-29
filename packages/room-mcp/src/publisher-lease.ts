/**
 * The per-worktree publisher lease (registry §16): one MCP instance publishes a checkout, in every room it
 * attaches, and only its daemons write that checkout's base facts (`git`) and post `pushed` (D5). Another
 * session in the checkout publishes nothing and shows who does; it takes over only from a dead holder or
 * after the holder released the file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { compareAndRelease, createExclusive, liveness, recover, replace, type InstanceToken } from './leases.js'
import type { ProcessProbe } from './worker-process.js'

export interface PublisherLeaseFile {
  worktree: string
  holder: InstanceToken
  /** roomKey → the participant publishing this worktree there. */
  attachments: Record<string, string>
}

export function publisherLeaseFile(commonDir: string, worktree: string): string {
  return path.join(commonDir, 'room', 'publishers', `${createHash('sha256').update(worktree).digest('hex')}.json`)
}

const GUARD_WAIT_MS = 30_000
async function guarded<T>(fn: () => T): Promise<T> {
  const deadline = performance.now() + GUARD_WAIT_MS
  for (;;) {
    try { return fn() }
    catch (e) {
      if (!(e instanceof Error && /lease guard busy/.test(e.message)) || performance.now() > deadline) throw e
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}

export class PublisherLease {
  readonly file: string
  private readonly attached = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private held = false
  private work: Promise<unknown> = Promise.resolve()

  constructor(readonly commonDir: string, readonly worktree: string, private readonly token: InstanceToken, private readonly probe?: ProcessProbe) {
    this.file = publisherLeaseFile(commonDir, worktree)
  }

  private read(): PublisherLeaseFile | undefined {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) as PublisherLeaseFile }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof SyntaxError) return undefined; throw e }
  }

  private mine(c: Record<string, any>): boolean { return c.holder?.nonce === this.token.nonce }

  private content(): PublisherLeaseFile {
    return { worktree: this.worktree, holder: this.token, attachments: Object.fromEntries(this.attached) }
  }

  /** Mutations run one at a time; each re-reads the file under its guard. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.work.then(fn, fn)
    this.work = next.catch(() => {})
    return next
  }

  /** This instance holds the lease (nonce included), as of the file now. */
  holds(): boolean {
    const now = this.read()
    const holds = !!now && this.mine(now)
    if (holds !== this.held) { this.held = holds; this.emit() }
    return holds
  }

  /** Who publishes this checkout in `roomKey` when it is not this instance: the holder's attachment there. */
  publisher(roomKey: string): string | undefined {
    const now = this.read()
    if (!now || this.mine(now)) return undefined
    return now.attachments?.[roomKey] ?? Object.values(now.attachments ?? {})[0]
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { for (const listener of this.listeners) listener() }

  /** Add `roomKey` → participant; takes the lease when it is free or its holder is dead. */
  attach(roomKey: string, participant: string): Promise<boolean> {
    return this.serial(async () => {
      this.attached.set(roomKey, participant)
      return this.take()
    })
  }

  /**
   * Remove `roomKey`. Its daemon has already withdrawn there (`publisher: false`), so another session can
   * publish; the last detach releases the file.
   */
  detach(roomKey: string): Promise<void> {
    return this.serial(async () => {
      if (!this.attached.delete(roomKey)) return
      if (!this.holds()) return
      if (this.attached.size) await guarded(() => replace(this.file, c => this.mine(c), this.content()))
      else await guarded(() => compareAndRelease(this.file, this.token))
      this.holds()
    })
  }

  /** The reconcile tick of an attached session that does not publish: one of them wins a released or dead lease. */
  tick(): Promise<boolean> {
    return this.serial(async () => this.attached.size ? this.take() : false)
  }

  private async take(): Promise<boolean> {
    const current = this.read()
    if (current && this.mine(current)) {
      const want = this.content()
      if (JSON.stringify(current.attachments) !== JSON.stringify(want.attachments)) await guarded(() => replace(this.file, c => this.mine(c), want))
      return this.holds()
    }
    if (current && liveness(current.holder, this.probe) === 'dead') {
      const nonce = current.holder.nonce
      await guarded(() => recover(this.file, c => c.holder?.nonce === nonce, this.probe))
    }
    if (!fs.existsSync(this.file)) createExclusive(this.file, this.content())
    return this.holds()
  }
}

const leases = new Map<string, PublisherLease>()
/** One lease object per worktree and host session in a process: a lead's team and workers-room sessions share it. */
export function publisherLease(commonDir: string, worktree: string, token: InstanceToken): PublisherLease {
  const key = `${worktree}\0${token.sessionId}`
  let lease = leases.get(key)
  if (!lease) { lease = new PublisherLease(commonDir, worktree, token); leases.set(key, lease) }
  return lease
}

export interface PublisherAttachment {
  /** Leave this room: withdraw first when another session in the checkout names this one, then detach (§16, §18). */
  detach(): Promise<void>
}

export const PUBLISHER_TICK_MS = 5_000

/**
 * Attach one room's session to its worktree's lease and keep its sharing policy's `publisher` in step:
 * the holder publishes; the others publish nothing, name the holder, and try to take over on each tick.
 */
export async function attachPublisher(o: {
  lease: PublisherLease
  roomKey: string
  participant: string
  setPublisher(publisher: boolean, publisherName?: string): void
  /** Another fresh session in this checkout names this participant as its publisher. */
  named(): boolean
  tickMs?: number
  log?: (line: string) => void
}): Promise<PublisherAttachment> {
  let was: boolean | undefined
  const sync = () => {
    const holds = o.lease.holds()
    o.setPublisher(holds, holds ? undefined : o.lease.publisher(o.roomKey))
    if (holds !== was && was !== undefined) o.log?.(holds ? 'publishing this checkout (publisher lease)' : `this checkout is published by ${o.lease.publisher(o.roomKey) ?? 'another session'}`)
    was = holds
  }
  await o.lease.attach(o.roomKey, o.participant)
  sync()
  const unsubscribe = o.lease.onChange(sync)
  const timer = setInterval(() => { void o.lease.tick().then(sync, error => o.log?.(`warn: publisher lease: ${error instanceof Error ? error.message : String(error)}`)) }, o.tickMs ?? PUBLISHER_TICK_MS)
  timer.unref?.()
  return {
    async detach() {
      clearInterval(timer)
      unsubscribe()
      if (o.lease.holds() && o.named()) o.setPublisher(false, undefined)
      await o.lease.detach(o.roomKey)
    },
  }
}
