/**
 * Participant-name leases (registry §15, hub §2.3, §4, §7). Within one clone the O_EXCL file under
 * `<common>/room/names/` decides; across clones and machines the room's hub grants the name with an
 * epoch, the fence every record written under the name carries.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { HolderIn } from '@room/hub-core'
import { manifestPaths, type RoomDoc } from '@room/shared'
import { compareAndRelease, createExclusive, liveness, recover, replace, type InstanceToken, type Liveness } from './leases.js'
import { HubError, type HubClient } from './hub-client.js'
import { probeProcess, type ProcessProbe } from './worker-process.js'
import { readChoice, rememberTag, worktreePath } from './choice.js'

export interface NameLease {
  roomKey: string
  name: string
  holder: InstanceToken
  /** The host the session runs under (claude, codex). */
  host: string
  /** Realpath of the checkout the session works in. */
  worktree: string
  /** Set on a lead's reservation of its worker's name; the admitted worker takes it over. */
  workerId?: string
  at: number
}

export function nameLeaseFile(commonDir: string, roomKey: string, name: string): string {
  return path.join(commonDir, 'room', 'names', `${createHash('sha256').update(`${roomKey}\0${name}`).digest('hex')}.json`)
}

function readLease(file: string): NameLease | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as NameLease }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
}

const busy = (e: unknown) => e instanceof Error && /lease guard busy/.test(e.message)
const GUARD_WAIT_MS = 30_000

/** Guarded mutations stay synchronous; a live guard is waited out, yielding between attempts (registry §Leases). */
async function guarded<T>(fn: () => T): Promise<T> {
  const deadline = performance.now() + GUARD_WAIT_MS
  for (;;) {
    try { return fn() }
    catch (e) {
      if (!busy(e) || performance.now() > deadline) throw e
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}

export type LocalTake = { ok: true } | { ok: false; holder: InstanceToken; liveness: Liveness; worktree?: string }

export interface TakeOptions {
  /** `room_join takeover=true`: overrides a holder whose identity is `unknown`, never an `alive` one. */
  takeover?: boolean
  /** An admitted worker's ROOM_WORKER_ID: it may take over its lead's reservation of its name. */
  workerId?: string
  probe?: ProcessProbe
}

/** Registry §15's table: create, recover from a dead holder, or take over within one session. */
export async function takeLocalName(file: string, lease: NameLease, options: TakeOptions = {}): Promise<LocalTake> {
  for (;;) {
    if (createExclusive(file, lease)) return { ok: true }
    let current: NameLease | undefined
    try { current = readLease(file) }
    catch { return { ok: false, holder: { pid: 0, startTime: '', executable: '', sessionId: '', nonce: '' }, liveness: 'unknown' } }
    if (!current) continue
    const holder = current.holder
    const state = liveness(holder, options.probe)
    const same = (c: Record<string, any>) => c.holder?.nonce === holder.nonce
    if (state === 'dead') { await guarded(() => recover(file, same, options.probe)); continue }
    const takeOver = holder.sessionId === lease.holder.sessionId
      || (!!options.workerId && current.workerId === options.workerId)
      || (!!options.takeover && state === 'unknown')
    if (!takeOver) return { ok: false, holder, liveness: state, worktree: current.worktree }
    // The predecessor sees another nonce on its next check and stands down (MF12).
    if (await guarded(() => replace(file, same, lease))) return { ok: true }
  }
}

/** The local lease is still this instance's (nonce included): a same-session successor may have replaced it. */
export function ownsLocalName(file: string, token: InstanceToken): boolean {
  try { return readLease(file)?.holder?.nonce === token.nonce } catch { return false }
}

export async function releaseLocalName(file: string, token: InstanceToken): Promise<void> {
  try { await guarded(() => compareAndRelease(file, token)) } catch { /* a dead holder's lease is recovered by the next taker */ }
}

/** This MCP process's instance token for a host session: the holder of its name and publisher leases. */
export function processToken(sessionId: string, probe: ProcessProbe = probeProcess): InstanceToken {
  const own = probe(process.pid)
  return { pid: process.pid, startTime: own?.startTime ?? '', executable: own?.executable ?? '', sessionId, nonce: randomUUID() }
}

export interface Candidate { name: string; tag: string }
export interface AcquireOptions {
  commonDir: string
  roomKey: string
  candidates: Iterable<Candidate>
  /** An explicit tag: refused rather than renamed when it is held. */
  explicit?: boolean
  token: InstanceToken
  holder: HolderIn
  host: string
  worktree: string
  /** The hub; undefined when it did not answer hello (the name is then held locally and paused, hub §7). */
  hub?: HubClient
  /** ROOM_NAME_EPOCH: the lead's reservation this worker takes over (hub §2.3). */
  supersedes?: number
  workerId?: string
  takeover?: boolean
  /** A reason to pass over a candidate this session could take (it holds another clone's work). */
  skip?: (candidate: Candidate) => string | undefined
  probe?: ProcessProbe
}

export interface Acquired extends Candidate {
  file: string
  /** Undefined while the hub is unreachable: the session starts paused. */
  epoch?: number
  /** Why earlier candidates were passed over, by name. */
  passed: Map<string, string>
  /** A live earlier process of this worktree holds that name locally (a previous MCP still shutting down). */
  ownWorktree: Set<string>
}

export class NameRefused extends Error {}

/** The candidate loop (registry §15): the local lease, then the hub lease; `held` moves to the next candidate. */
export async function acquireName(options: AcquireOptions): Promise<Acquired> {
  const passed = new Map<string, string>()
  const ownWorktree = new Set<string>()
  for (const candidate of options.candidates) {
    const file = nameLeaseFile(options.commonDir, options.roomKey, candidate.name)
    const lease: NameLease = { roomKey: options.roomKey, name: candidate.name, holder: options.token, host: options.host, worktree: options.worktree, ...(options.workerId ? { workerId: options.workerId } : {}), at: Date.now() }
    const local = await takeLocalName(file, lease, { takeover: options.takeover, workerId: options.workerId, probe: options.probe })
    if (!local.ok) {
      if (options.explicit) {
        throw new NameRefused(local.liveness === 'unknown'
          ? `${candidate.name} is held by process ${local.holder.pid} on this machine, whose identity cannot be read; if it is gone, room_join takeover=true`
          : `${candidate.name} is held by another session in this clone (pid ${local.holder.pid})`)
      }
      passed.set(candidate.name, 'held by another session')
      if (local.worktree === options.worktree) ownWorktree.add(candidate.name)
      continue
    }
    const reason = options.explicit ? undefined : options.skip?.(candidate)
    if (reason) { await releaseLocalName(file, options.token); passed.set(candidate.name, reason); continue }
    if (!options.hub) return { ...candidate, file, passed, ownWorktree }
    try {
      const epoch = await options.hub.acquire(candidate.name, options.holder, options.supersedes)
      return { ...candidate, file, epoch, passed, ownWorktree }
    } catch (e) {
      if (e instanceof HubError && (e.reason === 'held' || e.reason === 'not-yours')) {
        await releaseLocalName(file, options.token)
        if (options.explicit || e.reason === 'not-yours') throw new NameRefused(e.reason === 'held' ? `${candidate.name} is held by another session` : e.message)
        passed.set(candidate.name, 'held by another session')
        continue
      }
      // Unreachable, timed out or still starting: keep the local lease and start paused (hub §7).
      return { ...candidate, file, passed, ownWorktree }
    }
  }
  throw new NameRefused('no name candidate is free')
}

export interface ChooseNameOptions {
  dir: string
  commonDir: string
  roomKey: string
  /** The bare name: the verified login or the configured owner. */
  owner: string
  /** ROOM_TAG or a join's tag: exactly this name, refused when held. */
  explicitTag?: string
  host: string
  /** The room as synced, to pass over names that hold another clone's uncommitted work. */
  doc: RoomDoc
  hub?: HubClient
  token: InstanceToken
  holder: HolderIn
  supersedes?: number
  workerId?: string
  takeover?: boolean
  log?: (line: string) => void
}

export interface ChosenName extends Acquired { label?: string; note?: string }

/**
 * The join's name (registry §15): the remembered tag of this worktree, then the bare name, `+<host>`,
 * `+<host>-N`. Each candidate needs the local lease and then the hub's; presence decides nothing.
 */
export async function chooseName(o: ChooseNameOptions): Promise<ChosenName> {
  const worktree = await worktreePath(o.dir)
  const remembered = o.explicitTag === undefined ? (await readChoice(o.dir))?.tags?.[worktree] : undefined
  const nameOf = (tag: string) => tag ? `${o.owner}+${tag}` : o.owner
  function* candidates(): Generator<Candidate> {
    if (o.explicitTag !== undefined) { yield { name: nameOf(o.explicitTag), tag: o.explicitTag }; return }
    if (remembered !== undefined) yield { name: nameOf(remembered), tag: remembered }
    for (let n = 0; ; n++) {
      const tag = n === 0 ? '' : n === 1 ? o.host : `${o.host}-${n}`
      if (tag !== remembered) yield { name: nameOf(tag), tag }
    }
  }
  const holdsWork = (name: string) => manifestPaths(o.doc, name).length > 0
  const chosen = await acquireName({
    commonDir: o.commonDir, roomKey: o.roomKey, candidates: candidates(), explicit: o.explicitTag !== undefined,
    token: o.token, holder: o.holder, host: o.host, worktree, hub: o.hub, supersedes: o.supersedes, workerId: o.workerId, takeover: o.takeover,
    skip: c => c.tag !== remembered && holdsWork(c.name) ? 'holds uncommitted work from another clone' : undefined,
  })
  const label = chosen.tag || undefined
  if (o.explicitTag !== undefined) return { ...chosen, label }
  const rememberedName = remembered === undefined ? undefined : nameOf(remembered)
  const heldElsewhere = (name: string) => chosen.passed.get(name) === 'held by another session'
  const rememberedHeld = rememberedName !== undefined && heldElsewhere(rememberedName)
  let note: string | undefined
  if (rememberedHeld || (chosen.name !== o.owner && chosen.name !== rememberedName)) {
    note = `joined as ${chosen.name} (${rememberedHeld ? `remembered name ${rememberedName} is in use by another session`
      : heldElsewhere(o.owner) ? `${o.owner} is in use by another session` : `${o.owner} still holds uncommitted work from another clone`})`
    o.log?.(note)
  }
  // A previous process of this worktree that still holds its name keeps the remembered tag for its return.
  if (chosen.tag !== remembered && !chosen.ownWorktree.has(rememberedName ?? o.owner)) await rememberTag(o.dir, chosen.tag)
  return { ...chosen, label, ...(note ? { note } : {}) }
}

const PAUSE_TAIL = 'Your files are unaffected; messages and claims resume when it is back.'
export const NAME_TICK_MS = 5_000

export type LeaseState = 'held' | 'lapsed' | 'taken' | 'superseded' | 'ended'

export interface ParticipantLeaseOptions {
  name: string
  file: string
  token: InstanceToken
  holder: HolderIn
  hub: HubClient
  epoch?: number
  /** The host session this lease was granted for still owns this MCP binding. */
  hostCurrent?: () => boolean
  /** Called with the new fence after a (re-)grant, and with undefined when the lease stops being valid. */
  onChange?: (fence: string | undefined) => void
  log?: (line: string) => void
  tickMs?: number
}

/**
 * A joined session's hold on its name (registry §15, hub §4.3, §7). The fence is the hub epoch while the
 * lease is valid by the client's clock and the local file is still this instance's; otherwise the session
 * is paused, and it re-acquires (a new epoch, so a full republish) or learns that another session holds it.
 */
export class ParticipantLease {
  readonly name: string
  private epochValue?: number
  private stateValue: LeaseState
  private reacquiring?: Promise<void>
  private readonly timer: ReturnType<typeof setInterval>
  private announced?: string

  constructor(private readonly options: ParticipantLeaseOptions) {
    this.name = options.name
    this.epochValue = options.epoch
    this.stateValue = options.epoch === undefined ? 'lapsed' : 'held'
    this.timer = setInterval(() => this.check(), options.tickMs ?? NAME_TICK_MS)
    this.timer.unref?.()
    this.announced = this.fence()
  }

  get state(): LeaseState { return this.stateValue }
  /** The host session this lease holds the name for. */
  get sessionId(): string { return this.options.holder.sessionId }
  get epoch(): number | undefined { return this.epochValue }

  /** The fence records carry, while every fenced write may go ahead. */
  fence(): string | undefined {
    if (this.stateValue !== 'held' || this.epochValue === undefined || this.options.hostCurrent?.() === false) return undefined
    return this.options.hub.lease(this.name) === this.epochValue && ownsLocalName(this.options.file, this.options.token) ? String(this.epochValue) : undefined
  }

  /** The lease a post carries (hub §2.3), while it is good. */
  held(): { name: string; epoch: number } | undefined {
    return this.fence() !== undefined ? { name: this.name, epoch: this.epochValue! } : undefined
  }

  /** The paused line for tool replies and state.json, or undefined while the lease is good. */
  paused(): string | undefined {
    this.check()
    if (this.stateValue === 'held' && this.options.hostCurrent?.() === false) return `[room] host session changed; ${this.name} is rebinding. Coordination is paused.`
    switch (this.stateValue) {
      case 'held': return undefined
      case 'taken': return `[room] another session now holds ${this.name}; rejoin to take a new name. Coordination is paused; your files are unaffected.`
      case 'superseded': return `[room] a newer Room process of this session took over ${this.name}; this one has stood down.`
      case 'ended': return `[room] ${this.name} left the room.`
      case 'lapsed': return this.options.hub.reachable()
        ? `[room] the name lease on ${this.name} lapsed; coordination paused while it is re-acquired. ${PAUSE_TAIL}`
        : this.options.hub.paused() ?? `[room] hub unreachable; coordination paused. ${PAUSE_TAIL}`
    }
  }

  /** On every tick and tool call: the local token (nonce), then the hub lease by its clock. */
  check(): void {
    if (this.stateValue === 'held') {
      if (!ownsLocalName(this.options.file, this.options.token)) this.stateValue = 'superseded'
      else if (this.options.hub.lease(this.name) !== this.epochValue) this.stateValue = 'lapsed'
    }
    if (this.stateValue === 'lapsed') {
      if (!ownsLocalName(this.options.file, this.options.token)) this.stateValue = 'superseded'
      else this.reacquire()
    }
    this.announce()
  }

  private announce(): void {
    const fence = this.fence()
    if (fence === this.announced) return
    this.announced = fence
    this.options.log?.(fence ? `name lease on ${this.name} held at epoch ${fence}` : `name lease on ${this.name} ${this.stateValue}; coordination paused`)
    this.options.onChange?.(fence)
  }

  private reacquire(): void {
    if (this.reacquiring) return
    this.reacquiring = (async () => {
      try {
        const epoch = await this.options.hub.acquire(this.name, this.options.holder)
        if (this.stateValue !== 'lapsed') { await this.options.hub.release(this.name).catch(() => {}); return }
        this.epochValue = epoch
        this.stateValue = 'held'
      } catch (e) {
        if (e instanceof HubError && (e.reason === 'held' || e.reason === 'not-yours') && this.stateValue === 'lapsed') {
          this.stateValue = 'taken'
          await releaseLocalName(this.options.file, this.options.token)
        }
        // Otherwise the hub is unreachable or starting: the next tick retries.
      } finally {
        this.reacquiring = undefined
        this.announce()
      }
    })()
  }

  /** End the hold (leave, idle lease, exit): the hub lease first, while the connection is up, then the file. */
  async end(): Promise<void> {
    if (this.stateValue === 'ended') return
    const held = this.stateValue === 'held' || this.stateValue === 'lapsed'
    this.stateValue = 'ended'
    clearInterval(this.timer)
    await this.reacquiring
    this.announce()
    if (!held) return
    try { await this.options.hub.release(this.name) } catch { /* the hub ends it at its TTL, or at once for a dead local holder */ }
    await releaseLocalName(this.options.file, this.options.token)
  }
}
