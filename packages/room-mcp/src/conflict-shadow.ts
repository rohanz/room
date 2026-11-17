/** Opt-in diagnostics only. Static import is inert: declarations/constants/weak maps only;
 * no top-level I/O or fallible environment parsing. Hooks never await diagnostics. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { privateStateDirectory } from '@room/relay'
import { commonGitDirFromDotGit } from '@room/roomd'
import { git, withGitReadDeadline } from '@room/roomd/git'
import { manifestHeadOf, manifestKey, participantRecord, participantsView, snapshot, snapshotStillCurrent, type ParticipantSnapshot } from '@room/shared'
import { liveness } from './leases.js'
import { probeOwnProcess } from './worker-process.js'
import { openWorkerReader, type WorkerReader } from './worker-registry.js'
import { requireWorkerInventory } from './worker-store.js'
import { verifyWorkerCheckout } from './worker-preparation.js'
import type { WorkerRecord } from './worker-status.js'
import type { Session } from './session.js'
import type { ConflictSlot } from './conflict-set.js'
import { ShadowGraph, type ShadowEntry } from './shadow-graph.js'
import { captureShadow, type ShadowCapture } from './shadow-snapshot.js'

const CAP = 200 * 1024 * 1024, INTERVAL = 5000, PASS_MS = 10_000
const identity = (name: string) => createHash('sha256').update(name).digest('hex').slice(0, 24)
type Actor = { name: string; id: string; dir: string; expected: string; base: string; carried: NonNullable<WorkerRecord['carriedUntracked']>;
  node: string; tree: string; anchor: string; entries: Map<string, ShadowEntry>; gaps: Set<string>; covered: Set<string>; events: string[]; scanned?: number; capture?: ShadowCapture; publication?: ParticipantSnapshot; publicationId?: string; disabled?: string; ending?: boolean }
type ShadowOwners = string | (() => readonly string[])
export type ShadowReservation = { owners?: ShadowOwners; waiting?: boolean; generation: number; order: number; ambiguous: boolean; kind: ShadowEvent['kind']; expires: number; make?: () => ShadowEvent }
type Anchor = { node: string; tree: string; entries: Map<string, ShadowEntry>; gaps: Set<string>; events: string[] }
export type ShadowEvent = ({ kind: 'spawn'; record: WorkerRecord; supplied: boolean; carry?: boolean; carryFailed?: boolean; preparedHead?: string }
  | { kind: 'collection'; workers: { id: string; name: string; head: string; source?: string; paths: string[] }[];
      initial: Map<string, string | null>; merged: Map<string, string | null>; modes: Map<string, number> }
  | { kind: 'refresh'; id: string; previous: string; base: string; target: string; carried: NonNullable<WorkerRecord['carriedUntracked']> }
  | { kind: 'remove'; id: string; name: string }
  | { kind: 'unsupported'; id: string; reason: string }) & { generation?: number }
const hookFailures = new WeakSet<Session>()
const families = new WeakMap<Session, ConflictShadow>()
const fallbackLog = (line: string) => { process.stderr.write(`[room] ${line}\n`) }
/** Even an exception constructing a hook's payload cannot escape to the lifecycle operation. */
function hookFailed(s: Session, log: (line: string) => void = fallbackLog): void {
  if (!hookFailures.has(s)) { hookFailures.add(s); queueMicrotask(() => { try { log('conflict shadow: hook failed (swallowed)') } catch { /* isolated */ } }) }
}
export function enqueueShadow(s: Session, event?: () => ShadowEvent, log: (line: string) => void = fallbackLog, reservation?: ShadowReservation): void {
  if (process.env.ROOM_CONFLICT_SHADOW !== '1' || process.env.ROOM_WORKER_ID !== undefined) return
  try {
    if (!s.local || s.room.workerViewOf(s.me.name)) return
    let shadow = families.get(s)
    if (!shadow) { shadow = new ConflictShadow(s, log); families.set(s, shadow) }
    shadow.enqueue(event, reservation)
  } catch { hookFailed(s, log) }
}
/** Constant-time boundary facts only. Never initialize here: enabling mid-operation cannot recover its history. */
export function shadowPreparation(s: Session): number | undefined {
  try { return process.env.ROOM_CONFLICT_SHADOW === '1' && process.env.ROOM_WORKER_ID === undefined ? families.get(s)?.preparation() : undefined } catch { hookFailed(s); return undefined }
}
export function reserveShadow(s: Session, kind: ShadowEvent['kind'], preparation?: number, owners?: ShadowOwners): ShadowReservation | undefined {
  try { return process.env.ROOM_CONFLICT_SHADOW === '1' && process.env.ROOM_WORKER_ID === undefined ? families.get(s)?.reserve(kind, preparation, owners) : undefined } catch { hookFailed(s); return undefined }
}
export function releaseShadow(s: Session, ticket?: ShadowReservation): void {
  try { if (ticket) families.get(s)?.release(ticket) } catch { /* a refused/no-op operation cannot fail through diagnostics */ }
}
export function stopShadow(s: Session): void { try { families.get(s)?.stop() } catch { /* leave never waits */ } }
/** Tests may await diagnostics explicitly; lifecycle and publication paths never do. */
export async function shadowIdle(s: Session): Promise<void> { await families.get(s)?.idle() }

export class ConflictShadow {
  readonly graph: ShadowGraph
  private queue = new Map<number, ShadowReservation>()
  private issued = 0
  private applied = 0
  private mutations = 0
  private mutating = 0
  private anchors = new Map<number, Anchor>()
  private actors = new Map<string, Actor>()
  private heads = new Map<string, Anchor & { head: string }>()
  private spawns = new Map<string, { generation: number; anchor: Anchor }>()
  private generation = 0
  private leadHead?: string
  private carriedState?: string
  private failures = new Set<string>()
  private pending = new Map<string, { input: string; today: string; since: number; recorded?: boolean }>()
  private identities = new Map<string, string>()
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private cleanup?: Promise<void>
  private removal?: Promise<void>
  private journal?: Awaited<ReturnType<typeof fs.open>>
  private initialized = false
  private closed = false
  private cancellation = new AbortController()
  private halted = false
  private lastSummary = 0
  private registry?: WorkerReader
  private onSlots = (event: { changes: { keys: Map<string, { oldValue: ConflictSlot }> }; target: { get(key: string): ConflictSlot | undefined } }) => {
    try {
      const status = (s?: ConflictSlot) => s && [s.kind, s.owner, s.other, s.path, s.status, s.settled, s.fence]
      if (!this.pending.size || [...event.changes.keys].every(([key, change]) => JSON.stringify(status(change.oldValue)) === JSON.stringify(status(event.target.get(key))))) return
      const groups = new Map<string, ConflictSlot[]>()
      for (const slot of this.s.room.doc.getMap<ConflictSlot>('conflicts').values()) {
        const a = this.actors.get(slot.owner), b = this.actors.get(slot.other)
        if (slot.kind !== 'merge' || !a || !b) continue
        const key = this.pairPath(a, b, slot.path), at = groups.get(key) ?? []
        at.push(slot); groups.set(key, at)
      }
      const actors = new Map([...this.actors.values()].map(a => [a.id, a]))
      for (const [key, episode] of this.pending) {
        const [one, two, p] = JSON.parse(key), a = actors.get(one), b = actors.get(two)
        if (!a || !b || this.answer(a, b, p, [...groups.get(key) ?? [], ...groups.get(this.pairPath(a, b, '*')) ?? []]) !== episode.today) this.pending.delete(key)
      }
    } catch { this.pending.clear(); queueMicrotask(() => this.once('slot hook failed (swallowed)')) }
  }
  private onDoc = () => {
    try { this.observePublications(); this.enqueue() }
    catch { this.pending.clear(); queueMicrotask(() => this.once('publication hook failed (swallowed)')) }
  }
  constructor(private s: Session, private log: (line: string) => void, private now = Date.now) {
    const common = commonGitDirFromDotGit(s.dir)
    this.graph = new ShadowGraph(path.join(common, 'room/shadow', randomUUID()), s.dir)
    s.room.doc.on('afterTransaction', this.onDoc)
    s.room.doc.getMap<ConflictSlot>('conflicts').observe(this.onSlots)
  }
  private once(key: string): void {
    if (this.failures.has(key)) return
    this.failures.add(key)
    try { this.log(`conflict shadow: ${key}`) } catch { /* a broken logger is isolated too */ }
  }
  private halt(reason: string): void {
    if (this.halted) return
    this.halted = true; this.queue.clear(); this.mutating = 0; this.pending.clear()
    this.removal = Promise.resolve().then(async () => {
      this.once(`family stopped for this session: ${reason} (swallowed)`)
      this.graph.abort()
      await Promise.all([...this.actors.values()].map(a => this.remove(a)))
      this.anchors.clear(); this.heads.clear(); this.spawns.clear()
    })
  }
  private ownerIds(ticket: ShadowReservation): readonly string[] {
    const ids = typeof ticket.owners === 'function' ? ticket.owners() : ticket.owners ? [ticket.owners] : []
    return ticket.kind === 'remove' ? ids : ids.map(identity)
  }
  private cancel(ticket: ShadowReservation): void {
    if (!ticket.make && ticket.kind !== 'spawn' && ticket.kind !== 'remove') this.mutating--
    delete ticket.owners
    ticket.make = () => ({ kind: 'unsupported', id: '', reason: 'no-op' })
  }
  private async remove(a: Pick<Actor, 'name' | 'id'>): Promise<void> {
    if (this.actors.get(a.name)?.id === a.id) { this.actors.delete(a.name); this.identities.delete(a.name) }
    this.forget(a.id)
    // A shared event stays whole. Its missing owner is handled by lost() before it can apply.
    for (const ticket of this.queue.values()) {
      const ids = this.ownerIds(ticket)
      if (ids.length === 1 && ids[0] === a.id && ticket.kind !== 'collection' && ticket.kind !== 'unsupported') this.cancel(ticket)
    }
    try { await this.graph.pin(a.id) } catch { this.once('participant cleanup failed (swallowed)') }
  }
  private retire(records: WorkerRecord[]): void {
    for (const a of this.actors.values()) if (a.name !== this.s.me.name && !a.ending && !records.some(r => identity(r.id) === a.id && !['discarding', 'retiring', 'retired', 'abandoned'].includes(r.phase))) {
      a.ending = true
      const name = a.name, id = a.id, ticket = this.reserve('remove', undefined, id)
      if (ticket) ticket.make = () => ({ kind: 'remove', name, id })
    }
  }
  private async lost(ticket: ShadowReservation, reason: string): Promise<boolean> {
    const ids = this.ownerIds(ticket)
    for (const id of ids) {
      const a = [...this.actors.values()].find(a => a.id === id)
      if (a) this.once(`unmodelled history: ${ticket.kind} ${reason} (${a.name})`)
    }
    if (!ids.length || ticket.kind === 'collection' || ticket.kind === 'unsupported') {
      this.halt(`${ticket.kind} ${reason}; lead history lost`)
      await this.removal
      return false
    }
    for (const id of ids) {
      const a = [...this.actors.values()].find(a => a.id === id)
      await this.remove(a ?? { name: '', id })
    }
    this.cancel(ticket)
    return true
  }
  private async unmodelled(a: Actor, reason: string): Promise<void> {
    a.disabled = reason
    this.once(`unmodelled history: ${reason} (${a.name})`)
    if (a.name === this.s.me.name) {
      this.halt(`${reason}; lead history lost`)
      await this.removal
    } else await this.remove(a)
  }
  preparation(): number | undefined { return !this.closed && !this.halted && !this.mutating ? this.mutations : undefined }
  reserve(kind: ShadowEvent['kind'], preparation?: number, owners?: ShadowOwners): ShadowReservation | undefined {
    if (this.closed || this.halted) return
    if (this.queue.size >= 32) { this.halt('event queue exhausted; lead history lost'); return }
    if (this.applied === this.issued) this.remember(this.applied)
    const ticket = { owners, generation: this.issued, order: ++this.issued, ambiguous: kind !== 'remove' && (this.mutating > 0 || kind === 'spawn' && preparation !== this.mutations),
      kind, expires: performance.now() + PASS_MS }
    if (kind !== 'spawn' && kind !== 'remove') { this.mutations++; this.mutating++ }
    this.queue.set(ticket.order, ticket); this.enqueue()
    return ticket
  }
  release(ticket: ShadowReservation): void {
    if (this.queue.get(ticket.order) !== ticket || ticket.make) return
    this.cancel(ticket); this.enqueue()
  }
  private remember(generation: number): void {
    const a = this.actors.get(this.s.me.name)
    if (a) this.anchors.set(generation, { node: a.node, tree: a.tree, entries: a.entries, gaps: a.gaps, events: a.events })
    if (this.anchors.size > 32) this.anchors.delete(this.anchors.keys().next().value!)
  }
  enqueue(event?: () => ShadowEvent, reservation?: ShadowReservation): void {
    if (this.closed || this.halted) return
    if (event) {
      // A missing boundary stamp is never reconstructed from hook arrival time.
      const ticket = reservation ?? this.reserve('unsupported')
      if (!ticket || this.queue.get(ticket.order) !== ticket) { this.halt('missing generation; lead history lost'); return }
      if (!reservation) ticket.ambiguous = true
      ticket.make = event
      if (ticket.kind !== 'spawn' && ticket.kind !== 'remove') this.mutating--
    }
    if (!this.timer && !this.running) {
      this.timer = setTimeout(() => { this.timer = undefined; this.start() }, event ? 0 : INTERVAL)
      this.timer.unref?.()
    }
  }
  /** A hung promise is bounded too, not just Git subprocesses; cancellation quarantines late continuations. */
  private async budget<T>(work: () => Promise<T>, cleanup = false): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined, cancel: (() => void) | undefined
    const expired = new Error('over budget: private pass')
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(expired), Math.max(1, Math.min(PASS_MS, this.graph.deadline - performance.now())))
        timer.unref?.()
        if (!cleanup) {
          cancel = () => reject(new Error('shadow stopped'))
          this.cancellation.signal.addEventListener('abort', cancel, { once: true })
          if (this.cancellation.signal.aborted) cancel()
        }
      })])
    } catch (error) {
      if (error === expired && !cleanup && !this.closed) { this.halt('over budget: private pass deadline exceeded'); this.stop() }
      throw error
    } finally {
      clearTimeout(timer)
      if (cancel) this.cancellation.signal.removeEventListener('abort', cancel)
    }
  }
  private clean(): Promise<void> {
    if (!this.cleanup) {
      this.graph.deadline = performance.now() + PASS_MS
      this.cleanup = this.budget(() => fs.rm(this.graph.root, { recursive: true, force: true }), true)
        .catch(() => this.once('cleanup failed (swallowed)'))
    }
    return this.cleanup
  }
  private start(): void {
    if (this.running || this.closed) return
    this.graph.deadline = performance.now() + PASS_MS
    this.running = withGitReadDeadline(this.graph.deadline, () => this.budget(async () => {
      try {
        if (!this.initialized) { if (this.halted) return; await this.init() }
        const registry = this.registry!, records = requireWorkerInventory(await registry.list())
        this.retire(records)
        if (!this.halted) {
          if (await this.graph.storageBudget() >= CAP - 32 * 1024 * 1024) { this.halt('200 MB session ceiling; lead history unavailable'); return }
          while (this.queue.size) {
            const ticket = this.queue.get(this.applied + 1)!
            const ids = this.ownerIds(ticket)
            if (ids.length && ids.some(id => ![...this.actors.values()].some(a => a.id === id)
              && (ticket.kind !== 'spawn' || !records.some(r => identity(r.id) === id && !['discarding', 'retiring', 'retired', 'abandoned'].includes(r.phase))))) {
              if (ticket.kind === 'remove') this.cancel(ticket)
              else if (!await this.lost(ticket, 'participant no longer modelled')) return
            }
            if (!ticket.make) {
              if (performance.now() < ticket.expires) return
              if (!await this.lost(ticket, 'unfilled reservation expired')) return
            } else try {
              const event = await ticket.make()
              if (event.kind === 'unsupported' && event.reason === 'no-op') { /* released or participant removed */ }
              else if (ticket.ambiguous) {
                if (!await this.lost(ticket, 'missing generation or overlapping mutation')) return
              } else {
                ticket.waiting = false
                if (await this.event({ ...event, generation: ticket.generation }) === false) {
                  if (performance.now() >= ticket.expires) await this.lost(ticket, 'collection completion expired')
                  else ticket.waiting = true
                  return
                }
              }
            } catch { if (this.closed || !await this.lost(ticket, 'event failed')) return }
            this.applied = ticket.order; this.queue.delete(ticket.order); this.remember(this.applied)
          }
          await this.pass()
        }
      } catch { if (!this.closed) this.halt('private pass failed; lead history unavailable') }
    }), this.cancellation.signal).catch(() => { if (!this.closed) this.once('pass failed (swallowed)') }).finally(() => {
      this.running = undefined
      if (this.closed) void this.clean()
      else this.enqueue()
    })
  }
  async idle(): Promise<void> {
    do {
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
      this.start(); await this.running; await this.removal
    } while (!this.closed && !this.halted && this.queue.get(this.applied + 1)?.make && !this.queue.get(this.applied + 1)?.waiting)
  }
  stop(): void {
    if (this.closed) return
    this.closed = true; this.queue.clear(); this.anchors.clear(); this.pending.clear(); this.mutating = 0
    this.cancellation.abort(); this.graph.abort()
    for (const a of [...this.actors.values()]) void this.remove(a)
    this.heads.clear(); this.spawns.clear()
    const journal = this.journal; this.journal = undefined
    try { void journal?.close().catch(() => this.once('journal close failed (swallowed)')) } catch { this.once('journal close failed (swallowed)') }
    clearTimeout(this.timer)
    this.s.room.doc.getMap<ConflictSlot>('conflicts').unobserve(this.onSlots)
    this.s.room.doc.off('afterTransaction', this.onDoc); this.registry?.close()
    // No wait on leave. A dead process's directory is also reclaimed at next join.
    if (!this.running) void this.clean()
  }
  private async init(): Promise<void> {
    const parent = path.dirname(this.graph.root)
    privateStateDirectory(parent)
    if (await fs.realpath(parent) !== parent) throw new Error('unsafe shadow state')
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue
      const dir = path.join(parent, entry.name)
      try {
        const owner = JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8'))
        if (Number.isInteger(owner.pid) && owner.pid > 0 && liveness(owner) === 'dead') await fs.rm(dir, { recursive: true, force: true })
      } catch { this.once('stale state unverifiable; preserved') }
    }
    privateStateDirectory(this.graph.root, { exclusive: true })
    await fs.writeFile(path.join(this.graph.root, 'owner.json'), JSON.stringify({ ...probeOwnProcess(), pid: process.pid }), { mode: 0o600 })
    await this.graph.init()
    if (this.closed) return
    this.registry = await openWorkerReader(this.s.dir)
    if (this.closed) { this.registry.close(); return }
    this.initialized = true
  }
  private async newEvent(actor: Actor, kind: string, entries: Map<string, ShadowEntry>, parents = [actor.node], history = actor.events, boundary?: number): Promise<void> {
    const tree = await this.graph.tree(entries, actor.id, actor.dir)
    if (boundary !== undefined && this.issued !== boundary) throw new Error('publication moved')
    if (kind === 'observation' && tree === actor.tree) { actor.entries = entries; return }
    if (actor.name === this.s.me.name) this.nextGeneration()
    const node = await this.graph.event(kind, tree, parents)
    await this.graph.pin(actor.id, node)
    if (boundary !== undefined && this.issued !== boundary) throw new Error('publication moved')
    actor.node = node; actor.tree = tree; actor.entries = entries
    for (const p of entries.keys()) actor.covered.add(p)
    actor.events = [...new Set([...history, `${kind}:${node}`])]
    actor.capture = undefined; actor.publication = undefined
  }
  private nextGeneration(): void { this.generation++; this.spawns.clear(); this.mutations++ }
  private async headAnchor(head: string, dir: string): Promise<Anchor> {
    const captured = await captureShadow(this.graph, dir, head, [], true)
    const tree = await this.graph.tree(captured.entries, `head-${head}`, dir), key = `${head}:${tree}`
    const existing = this.heads.get(key)
    if (existing) return existing
    const parents = new Set<string>(), history = new Set<string>()
    for (const previous of this.heads.values()) {
      const bases = (await this.graph.run(['merge-base', '--all', head, previous.head])).split('\n')
      for (const base of bases) {
        const known = [...this.heads.values()].find(a => a.head === base)
        if (!known) throw new Error('unmodelled history: HEAD ancestry')
        parents.add(known.node); for (const event of known.events) history.add(event)
      }
    }
    const node = await this.graph.event('head', tree, [...parents])
    const anchor = { head, node, tree, entries: new Map(captured.entries), gaps: new Set(captured.gaps), events: [...history, `head:${node}`] }
    this.heads.set(key, anchor)
    return anchor
  }
  private cover(actor: Actor, captured: ShadowCapture): void {
    if ([...captured.gaps].some(p => actor.covered.has(p))) throw new Error('unmodelled history: coverage changed')
    actor.gaps = new Set([...actor.gaps, ...captured.gaps])
    captured.gaps = actor.gaps
    for (const p of actor.gaps) captured.entries.delete(p)
  }
  private async event(event: ShadowEvent): Promise<void | false> {
    if (this.closed) return
    if (event.kind === 'remove') { await this.remove(event); return }
    if (event.kind === 'unsupported') {
      const actor = [...this.actors.values()].find(a => a.id === identity(event.id))
      // Partial delivery changes the lead's relationship to every remaining worker.
      const target = event.reason === 'partial collection' ? this.actors.get(this.s.me.name) : actor
      if (target) await this.unmodelled(target, event.reason)
      this.once(`unmodelled history: ${event.reason}`); return
    }
    if (event.kind === 'spawn') {
      const r = event.record
      if (event.carryFailed || event.supplied || r.sharedWith || r.outside || r.share !== 'full' || !r.base || r.skippedCarry?.some(p => p.reason !== 'linked input')) {
        this.once(`unmodelled history: borrowed checkout, incomplete carry or sharing (${r.name})`); return
      }
      const current = await this.registry!.read(r.id)
      if (!current || ['retired', 'abandoned'].includes(current.phase)) return
      if (current.name !== r.name || current.lead.participant !== this.s.me.name || current.room !== this.s.roomName) throw new Error('family ownership moved')
      verifyWorkerCheckout(commonGitDirFromDotGit(this.s.dir), current)
      const captured = await captureShadow(this.graph, r.dir, r.base, r.carriedUntracked, true)
      if (captured.head !== r.base) { this.once(`unmodelled history: worker HEAD moved (${r.name})`); return }
      const carry = event.carry ?? !!(r.carriedBase || r.carriedUntracked?.length)
      const preparedHead = event.preparedHead ?? r.prep.witness?.branchOid ?? (r.carriedBase
        ? await this.graph.run(['rev-parse', `${r.carriedBase}^`]) : r.base)
      const head = await this.headAnchor(preparedHead, r.dir)
      const lead = this.actors.get(this.s.me.name)
      const source = event.generation === undefined ? undefined : this.anchors.get(event.generation)
      if (event.generation === undefined || lead && !source) { this.once(`unmodelled history: missing generation (${r.name})`); return }
      if (lead?.disabled) throw new Error('unmodelled lead history')
      if (lead) this.cover(lead, captured)
      const tree = await this.graph.tree(captured.entries, identity(r.id), r.dir)
      const tracked = await this.graph.run(['rev-parse', `${r.base}^{tree}`])
      const key = JSON.stringify([preparedHead, carry, tracked, [...r.carriedUntracked ?? []].sort((a,b) => a.path.localeCompare(b.path))])
      if (lead && (this.leadHead !== preparedHead || carry && (lead.tree !== tree || this.carriedState !== undefined && this.carriedState !== key))) this.nextGeneration()
      this.leadHead = preparedHead
      const cached = this.spawns.get(key)
      let anchor = cached?.generation === this.generation ? cached.anchor : undefined
      if (!anchor) {
        // HEAD-only workers branch solely from real HEAD ancestry, never from carried WIP.
        const parent = carry && source ? source : head
        const node = await this.graph.event('spawn', tree, [parent.node, head.node])
        anchor = { node, tree, entries: new Map(captured.entries), gaps: new Set(captured.gaps), events: [...parent.events, `spawn:${node}`] }
      }
      const make = (name: string, id: string, dir: string, source: Anchor, base = r.base!, carried = r.carriedUntracked ?? []): Actor => ({ name, id, dir, expected: base, base, carried,
        node: source.node, tree: source.tree, anchor: source.node, entries: new Map(source.entries), gaps: new Set(source.gaps), covered: new Set(source.entries.keys()), events: [...source.events] })
      if (!lead) {
        const ours = make(this.s.me.name, identity('lead'), this.s.dir, carry ? anchor : head, preparedHead, [])
        this.actors.set(ours.name, ours)
      } else if (carry && lead.node !== anchor.node) {
        lead.node = anchor.node; lead.tree = tree; lead.entries = new Map(captured.entries); lead.events = [...anchor.events]
        lead.capture = undefined; lead.publication = undefined; await this.graph.pin(lead.id, lead.node)
      }
      if (carry) this.carriedState = key
      this.spawns.set(key, { generation: this.generation, anchor })
      const actor = make(r.name, identity(r.id), r.dir, anchor)
      this.actors.set(r.name, actor); this.observePublications(); await this.graph.pin(actor.id, actor.node)
      return
    }
    const lead = this.actors.get(this.s.me.name)
    if (!lead) return
    if (lead.disabled) throw new Error('unmodelled lead history')
    if (event.generation !== this.applied || !this.anchors.has(event.generation)) throw new Error('unmodelled generation')
    if (event.kind === 'collection') {
      const records = await Promise.all(event.workers.map(w => this.registry!.read(w.id)))
      if (records.some(r => r?.phase === 'collecting')) return false
      const ended = new Set(event.workers.filter((_, i) => !records[i] || ['discarding', 'retiring', 'retired', 'abandoned'].includes(records[i]!.phase)).map(w => w.id))
      const laterLeadMutation = () => [...this.queue.values()].some(t => t.order > this.applied + 1 && (t.kind === 'collection' || t.kind === 'unsupported'))
      if (ended.size && laterLeadMutation()) throw new Error('final collection generation unavailable')
      const observed = await captureShadow(this.graph, lead.dir, lead.base, lead.carried)
      this.cover(lead, observed)
      const before = new Map(lead.entries)
      for (const [p, text] of event.initial) if (!lead.gaps.has(p)) await this.patch(before, p, text)
      await this.newEvent(lead, 'pre-collection', before)
      const parents = [lead.node], history = [...lead.events]
      for (const worker of event.workers) {
        const a = this.actors.get(worker.name)
        // Final collection is the lead's own edit; an ended worker has no next observation.
        if (ended.has(worker.id)) { await this.remove(a ?? { name: worker.name, id: identity(worker.id) }); continue }
        if (!a || a.disabled || a.expected !== worker.head) throw new Error('unmodelled delivery')
        const coverage = await captureShadow(this.graph, a.dir, a.base, a.carried)
        if (coverage.head !== a.expected) throw new Error('unmodelled delivery HEAD')
        this.cover(a, coverage)
        for (const p of worker.paths) if (a.gaps.has(p)) lead.gaps.add(p)
        const source = worker.source ? await this.graph.entries(worker.source) : undefined
        const delivered = await this.graph.entries(a.anchor)
        for (const p of worker.paths) {
          if (a.gaps.has(p) || lead.gaps.has(p)) continue
          const value = source?.get(p)
          if ((value?.size ?? 0) > 512 * 1024) { a.gaps.add(p); lead.gaps.add(p); continue }
          if (source) { if (value) delivered.set(p, value); else delivered.delete(p) }
          else await this.patch(delivered, p, event.merged.get(p) ?? null, event.modes.get(p))
        }
        await this.newEvent(a, 'delivery', delivered)
        a.anchor = a.node; parents.push(a.node); history.push(...a.events)
      }
      const merged = new Map(lead.entries)
      for (const [p, text] of event.merged) if (!lead.gaps.has(p)) await this.patch(merged, p, text, event.modes.get(p))
      if (ended.size && (laterLeadMutation() || !await observed.current())) throw new Error('lead moved after final collection')
      await this.newEvent(lead, ended.size === event.workers.length ? 'observation' : 'collection', ended.size ? observed.entries : merged, parents, history)
      lead.anchor = lead.node
      return
    }
    const a = [...this.actors.values()].find(a => a.id === identity(event.id))
    const previous = (await this.graph.run(['log', '-1', '--format=%s', event.previous])) === 'room: kept collection baseline'
      ? await this.graph.run(['rev-parse', `${event.previous}^`]) : event.previous
    if (!a || a.disabled || a.expected !== previous) { if (a) await this.unmodelled(a, 'refresh from unmodelled HEAD'); return }
    const target = await captureShadow(this.graph, this.s.dir, event.target, [], true)
    this.cover(lead, target)
    await this.newEvent(lead, 'refresh-target', target.entries)
    const received = await captureShadow(this.graph, a.dir, event.base, event.carried, true)
    if (received.head !== event.base) throw new Error('unmodelled history after refresh')
    this.cover(a, received)
    await this.newEvent(a, 'refresh', received.entries, [lead.node], lead.events)
    a.anchor = a.node; a.base = a.expected = event.base; a.carried = event.carried; a.gaps = received.gaps
  }
  private async patch(entries: Map<string, ShadowEntry>, p: string, value: string | null, mode?: number): Promise<void> {
    if (value === null) entries.delete(p)
    else if (Buffer.byteLength(value, 'latin1') > 512 * 1024) throw new Error('delivery coverage gap')
    else {
      // Collection transports bytes as latin1; hash raw bytes, never reinterpret them as UTF-8.
      const bytes = Buffer.from(value, 'latin1')
      const oid = (await this.graph.command(['hash-object', '-w', '--stdin', '--no-filters'], bytes)).output
      entries.set(p, { mode: mode === undefined ? entries.get(p)?.mode ?? '100644' : mode & 0o111 ? '100755' : '100644', oid })
    }
  }
  private publicationIdentity(name: string): string {
    const head = manifestHeadOf(this.s.room, name), holder = participantRecord(this.s.room, name)?.holder
    return JSON.stringify([holder?.sessionId, holder?.epoch, holder?.ended, head?.rev, head?.semRev, head?.fence, head?.base,
      head?.complete, head?.level, head?.coverage])
  }
  /** Record only bounded metadata facts on publication arrival; no disk/Git work runs on this callback. */
  private observePublications(): void {
    for (const a of this.actors.values()) {
      const identity = this.publicationIdentity(a.name)
      if (this.identities.get(a.name) !== identity) { this.forget(a.id); this.identities.set(a.name, identity) }
    }
  }
  private currentAnswer(a: Actor, b: Actor, path: string, slots: ConflictSlot[]): boolean {
    // This is a movement/fence guard, never evidence that today's evaluator read these publications.
    for (const actor of [a, b]) {
      const pub = actor.publication
      if (!pub || this.publicationIdentity(actor.name) !== actor.publicationId) return false
      const entry = this.s.room.manifest.get(manifestKey(actor.name, pub.head.fence))?.get(path)
      const fact = (e: typeof entry) => e ? [e.fence, e.change, e.state, e.hash, e.baseHash, e.held] : null
      if (JSON.stringify(fact(entry)) !== JSON.stringify(fact(pub.entries.get(path)))) return false
    }
    const map = this.s.room.doc.getMap<ConflictSlot>('conflicts')
    const current = [...map.values()].filter(s => s.kind === 'merge' && (s.path === path || s.path === '*') &&
      (s.owner === a.name && s.other === b.name || s.owner === b.name && s.other === a.name))
    return this.answer(a, b, path, current) === this.answer(a, b, path, slots)
  }
  private pairPath(a: Actor, b: Actor, p: string): string { return JSON.stringify([...([a.id, b.id].sort()), p]) }
  private answer(a: Actor, b: Actor, p: string, slots: ConflictSlot[]): string | undefined {
    const pair = slots.filter(s => s.kind === 'merge' && (s.owner === a.name && s.other === b.name || s.owner === b.name && s.other === a.name))
    const at = pair.filter(s => s.path === p)
    if (pair.some(s => s.path === '*' && s.status === 'unknown') || at.some(s => s.status === 'unknown' || s.settled === 'none'
      || s.fence !== manifestHeadOf(this.s.room, s.owner)?.fence)) return
    return at.some(s => s.settled === 'conflict') ? 'conflict' : at.some(s => s.settled === 'possible') ? 'possible' : at.length ? 'clean' : 'none-after-60s'
  }
  private stableDisagreement(a: Actor, b: Actor, p: string, today: string, shadow: string, input: string) {
    const key = this.pairPath(a, b, p)
    // Every class is only a heuristic: identical pair/path/statuses/publications/observations for 60s.
    // Unknown, movement or agreement discards the episode; never infer provenance from checkedAt.
    if (shadow === 'clean' ? today === 'clean' || today === 'none-after-60s' : today === 'conflict' || today === 'possible') {
      this.pending.delete(key); return null
    }
    input = identity(JSON.stringify([input, today, shadow]))
    let stable = this.pending.get(key)
    if (!stable || stable.input !== input) { stable = { input, today, since: this.now() }; this.pending.set(key, stable); return }
    return !stable.recorded && this.now() - stable.since >= 60_000 ? stable : undefined
  }
  private publication(a: Actor): ParticipantSnapshot | undefined {
    const snap = snapshot(this.s.room, a.name, participantsView(this.s.room, this.s.awareness, this.now()))
    return snap?.fenceValid && snap.head.complete && snap.head.level === 'full' && snap.head.coverage.kind === 'all' ? snap : undefined
  }
  private async readHead(dir: string): Promise<string> { return (await git(dir, ['rev-parse', 'HEAD'])).trim() }
  private async validateHistory(a: Actor, records: WorkerRecord[], common: string): Promise<void> {
    const lead = this.actors.get(this.s.me.name), r = records.find(r => identity(r.id) === a.id)
    if (records.some(r => r.lead.participant === a.name && a !== lead && !['retired', 'abandoned'].includes(r.phase))
      || records.some(r => r.dir === this.s.dir && !['retired', 'abandoned'].includes(r.phase))) throw new Error('nested lead')
    if (r) {
      if (r.name !== a.name || r.lead.participant !== this.s.me.name || r.room !== this.s.roomName || r.outside) throw new Error('borrowed checkout')
      verifyWorkerCheckout(common, r)
      if (r.sharedWith || records.some(other => other.id !== r.id && other.dir === r.dir && !['retired', 'abandoned'].includes(other.phase))) throw new Error('borrowed checkout')
      if ((await git(a.dir, ['rev-parse', 'HEAD'])).trim() !== a.expected) throw new Error('worker HEAD moved')
    }
  }
  private forget(id: string, peer?: string): void {
    for (const key of this.pending.keys()) {
      const [a, b] = JSON.parse(key) as string[]
      if (peer ? a === id && b === peer || a === peer && b === id : a === id || b === id) this.pending.delete(key)
    }
  }
  private async pass(): Promise<void> {
    if (this.queue.size) return
    const boundary = this.issued, started = performance.now(), registry = this.registry!
    const records = requireWorkerInventory(await registry.list())
    const lead = this.actors.get(this.s.me.name)
    if (!lead) {
      if (this.now() - this.lastSummary >= 30_000) { this.lastSummary = this.now(); try { this.log('conflict shadow: pairs=0 agreements=0 disagreements=0 skipped=no modelled spawn anchor') } catch { /* swallowed */ } }
      return
    }
    this.retire(records)
    if (this.queue.size) return
    this.observePublications()
    const reasons = new Set<string>()
    for (const a of [...this.actors.values()]) {
      if (a.disabled) { await this.unmodelled(a, a.disabled); reasons.add(a.disabled); continue }
      try {
        await this.validateHistory(a, records, registry.commonDir)
        const pub = await this.publication(a)
        if (!pub) { this.forget(a.id); reasons.add('publication unavailable'); a.capture = undefined; continue }
        if (a.scanned !== undefined && this.now() - a.scanned < INTERVAL) continue
        a.scanned = this.now()
        const publicationId = this.publicationIdentity(a.name)
        const beforeHead = await this.readHead(a.dir)
        const captured = await captureShadow(this.graph, a.dir, a.base, a.carried)
        const afterHead = await this.readHead(a.dir)
        if (beforeHead !== afterHead || captured.head !== beforeHead || a !== lead && (beforeHead !== a.expected || afterHead !== a.expected)) throw new Error('worker HEAD moved')
        if (a === lead && this.leadHead !== captured.head) { this.leadHead = captured.head; this.nextGeneration() }
        this.cover(a, captured)
        const publishedBase = await this.graph.entries(pub.head.base)
        if (a !== lead) for (const e of a.carried) publishedBase.set(e.path, { mode: '100644', oid: e.sha })
        for (const p of new Set([...captured.entries.keys(), ...publishedBase.keys()]))
          if (!a.gaps.has(p) && !pub.entries.has(p) && captured.entries.get(p)?.oid !== publishedBase.get(p)?.oid) throw new Error('publication moved')
        // Published changed versions must be byte-identical to the covered observation.
        for (const [p, entry] of pub.entries) {
          if (a.gaps.has(p)) continue
          const actual = captured.entries.get(p)
          if (entry.state !== 'shared' || (entry.change === 'D' ? !!actual : entry.hash !== actual?.oid)) throw new Error('publication moved')
        }
        if (!snapshotStillCurrent(this.s.room, pub, participantsView(this.s.room, this.s.awareness, this.now()))) throw new Error('publication moved')
        await this.newEvent(a, 'observation', captured.entries, [a.node], a.events, boundary)
        a.publicationId = publicationId
        a.capture = captured; a.publication = pub; a.gaps = new Set([...a.gaps, ...captured.gaps])
        // Unchanged trees do not create commits; still pace repeated scans.
        // The event clock remains tied to changed inputs, not a periodic rescan.
      } catch (error) {
        if (this.closed) return
        a.capture = undefined; this.forget(a.id)
        const reason = error instanceof Error && error.message.startsWith('over budget') ? 'over budget' : error instanceof Error && /^(nested lead|borrowed checkout|worker HEAD moved|unmodelled history:)/.test(error.message) ? error.message : 'snapshot unavailable or moving'
        if (reason === 'snapshot unavailable or moving') this.once(`observation unavailable (${a.name})`)
        if (reason === 'over budget') this.once('skipped: over budget (file count or snapshot)')
        if (reason !== 'snapshot unavailable or moving' && reason !== 'over budget') await this.unmodelled(a, reason)
        reasons.add(reason)
      }
    }
    let pairs = 0, agreements = 0, disagreements = 0
    const rows: string[] = [], recorded: { input: string; since: number; recorded?: boolean }[] = [], proofs: (() => boolean)[] = []
    let rowBytes = 0
    const actors = [...this.actors.values()]
    for (let i = 0; i < actors.length; i++) for (const b of actors.slice(i + 1)) {
      if (this.closed || this.issued !== boundary) return
      const a = actors[i]
      if (this.actors.get(a.name) !== a || this.actors.get(b.name) !== b || a.disabled || b.disabled || !a.capture || !b.capture || !a.publication || !b.publication) continue
      if (performance.now() >= this.graph.deadline) throw new Error('over budget')
      const current = () => [a, b].every(x => x.publication && snapshotStillCurrent(this.s.room, x.publication,
        participantsView(this.s.room, this.s.awareness, this.now())))
      if (!current()) { this.forget(a.id, b.id); reasons.add('publication moved'); continue }
      const slots = [...this.s.room.doc.getMap<ConflictSlot>('conflicts').values()].filter(s => s.kind === 'merge' && (s.owner === a.name && s.other === b.name || s.owner === b.name && s.other === a.name))
      let result: Awaited<ReturnType<ShadowGraph['compare']>>
      try { result = await this.graph.compare(a.node, b.node) }
      catch (error) { if (this.closed) return; if (error instanceof Error && error.message.startsWith('over budget')) throw error; await this.unmodelled(a, 'graph unavailable'); if (this.actors.has(b.name)) await this.unmodelled(b, 'graph unavailable'); continue }
      if (!current() || !await a.capture.current() || !await b.capture.current()) { this.forget(a.id, b.id); reasons.add('inputs moved'); continue }
      pairs++
      const paths = new Set([...result.paths, ...slots.map(s => s.path)])
      const input = identity(JSON.stringify([a.id, b.id, a.node, b.node, a.publicationId, b.publicationId, a.capture.fingerprint, b.capture.fingerprint]))
      for (const p of paths) {
        if (p === '*' || a.gaps.has(p) || b.gaps.has(p)) { reasons.add('coverage gap'); continue }
        const shadow = result.paths.includes(p) ? 'conflict' : 'clean'
        if (!this.currentAnswer(a, b, p, slots)) { this.forget(a.id, b.id); reasons.add('publication or slot moved'); continue }
        const today = this.answer(a, b, p, slots)
        if (!today) { this.pending.delete(this.pairPath(a, b, p)); reasons.add('unsettled slot'); continue }
        const stable = this.stableDisagreement(a, b, p, today, shadow, input)
        if (stable) {
          const row = JSON.stringify({ time: new Date(this.now()).toISOString(), participants: [a.name, b.name], path: p, today, shadow,
            observation: '60-second-stable-heuristic', stableForMs: this.now() - stable.since,
            snapshots: [a.node, b.node], bases: result.bases, events: [a.events, b.events] }) + '\n'
          rowBytes += Buffer.byteLength(row)
          if (rowBytes > 4 * 1024 * 1024) { this.once('skipped: over budget (diagnostic pass)'); return }
          rows.push(row); proofs.push(() => !this.closed && this.issued === boundary && current() && this.currentAnswer(a, b, p, slots) && this.pending.get(this.pairPath(a, b, p)) === stable)
          recorded.push(stable)
        } else if (stable === null) agreements++
        else reasons.add(this.pending.get(this.pairPath(a, b, p))?.recorded ? 'already recorded' : 'waiting for 60-second stability')
      }
    }
    if (performance.now() >= this.graph.deadline) throw new Error('over budget')
    if (rows.length) {
      for (const a of actors) if (a.capture && !await a.capture.current()) this.forget(a.id)
      const file = path.join(path.dirname(this.graph.root), 'disagreements.jsonl')
      const bytes = (await fs.stat(file).catch(() => ({ size: 0 }))).size
      if (bytes + Buffer.byteLength(rows.join('')) > CAP) { this.halt('200 MB shared journal ceiling'); return }
      // The shared cap is approximate: concurrent writers may each append one bounded record past it.
      const handle = await fs.open(file, 'a', 0o600)
      if (this.closed) { await handle.close(); return }
      this.journal = handle
      try {
        // One append syscall per JSON line; concurrent families cannot interleave chunks of a line.
        for (let i = 0; i < rows.length; i++) {
          if (!proofs[i]()) continue
          const data = Buffer.from(rows[i])
          if ((await handle.stat()).size + data.length > CAP) { this.halt('200 MB shared journal ceiling'); break }
          if (!proofs[i]()) continue // No awaited step may separate the final metadata guard from the append.
          if ((await handle.write(data)).bytesWritten !== data.length) throw new Error('incomplete diagnostic append')
          recorded[i].recorded = true; disagreements++
        }
      } finally {
        try { await handle.close() } catch { this.once('journal close failed (swallowed)'); this.stop() }
        this.journal = undefined
      }
    }
    if (this.now() - this.lastSummary >= 30_000) {
      this.lastSummary = this.now()
      try { this.log(`conflict shadow: pairs=${pairs} agreements=${agreements} disagreements=${disagreements} skipped=${[...reasons].join(',') || 'none'} passMs=${Math.round(performance.now() - started)}`) } catch { /* swallowed */ }
    }
  }
}
