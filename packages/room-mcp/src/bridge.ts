/**
 * A lead in two rooms: the team room (server) it belongs to, and a local workers room on this
 * machine where its spawned workers live. The bridge keeps the team room honest about what the
 * lead is doing without exposing the workers to the server:
 *  - the lead's team scope becomes the union of its workers' scope paths;
 *  - workers' claims are mirrored into the team room under the lead's name ("[tag] intent");
 *  - team messages that touch a worker's paths are re-posted into the local room as interrupts
 *    addressed to that worker.
 * Workers' questions to the lead and their done messages stay local; the lead reads both rooms.
 */
import { formatMsg, msgPaths, scopeCovers } from '@room/shared'
import type { Claim, Msg, NoteMsg, ReleaseMsg, ScopeMsg, Worker } from '@room/shared'
import type { Session } from './session.js'

const RELAY_TYPES = new Set<Msg['type']>(['claim', 'release', 'changed', 'conflict', 'plan', 'base', 'scope'])
/** Team messages that stop a worker: everything else arrives at notify, read on its next action. */
const INTERRUPT_TYPES = new Set<Msg['type']>(['plan', 'conflict', 'base'])
const RELAY_DEDUPE_MS = 60_000
const RELAYED_MAX = 2000

export interface BridgeOptions {
  log?: (line: string) => void
  /** Debounce for scope recomputation; default 300 ms (0 = synchronous, for tests). */
  debounceMs?: number
}

export class Bridge {
  /** local claim id -> mirrored team claim id */
  private mirrored = new Map<string, string>()
  private relayed: string[] = []
  /** worker|path|type -> last relay time, so a chatty team room does not become a stream of notices. */
  private recent = new Map<string, number>()
  private unobserve: (() => void)[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastScopeKey = ''
  private stopped = false

  constructor(public team: Session, public local: Session, private o: BridgeOptions = {}) {}

  /** Workers of this lead, by their local participant name. */
  workers(): Worker[] {
    return Array.from(this.local.room.workers.values()).filter(w => w.lead === this.local.me.name)
  }
  private workerNames(): Set<string> { return new Set(this.workers().map(w => w.name)) }
  private tagOf(name: string): string | undefined { return this.workers().find(w => w.name === name)?.tag }

  /** Every path a worker has declared or changed. */
  workerPaths(): string[] {
    const out = new Set<string>()
    for (const w of this.workers()) {
      for (const p of this.local.room.scope(w.name)?.paths ?? []) out.add(p)
      for (const p of this.local.room.changedPaths(w.name)) out.add(p)
    }
    return Array.from(out).sort()
  }

  start(): void {
    const l = this.local.room, t = this.team.room
    const onLocalScopes = () => this.scheduleScope()
    const onWorkers = () => this.scheduleScope()
    const onLocalClaims = (ev: { changes: { keys: Map<string, { action: string }> } }) => {
      for (const [id, ch] of ev.changes.keys) {
        if (ch.action === 'add') this.mirrorClaim(id)
        else if (ch.action === 'delete') this.unmirrorClaim(id)
      }
    }
    const onLocalOverlays = () => this.scheduleScope()
    const onTeamBus = (ev: { changes: { delta: { insert?: unknown }[] }; transaction: { local: boolean } }) => {
      if (ev.transaction.local) return
      for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) this.relayDown(m)
    }
    l.scopes.observe(onLocalScopes); l.workers.observe(onWorkers); l.claims.observe(onLocalClaims); l.overlays.observe(onLocalOverlays)
    t.bus.observe(onTeamBus)
    this.unobserve.push(
      () => l.scopes.unobserve(onLocalScopes), () => l.workers.unobserve(onWorkers), () => l.claims.unobserve(onLocalClaims),
      () => l.overlays.unobserve(onLocalOverlays), () => t.bus.unobserve(onTeamBus),
    )
    for (const c of l.openClaims()) this.mirrorClaim(c.id)
    this.scheduleScope()
  }

  /** Remove mirrored claims and stop observing. The team scope is left as it stands (the lead clears it on leave). */
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    for (const u of this.unobserve) u()
    this.unobserve = []
    for (const teamId of this.mirrored.values()) this.team.room.removeClaim(teamId)
    this.mirrored.clear()
  }

  private scheduleScope(): void {
    if (this.stopped) return
    const ms = this.o.debounceMs ?? 300
    if (ms === 0) { this.syncScope(); return }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.syncScope() }, ms)
    this.timer.unref?.()
  }

  /** The lead's team scope = union of its workers' declared and changed paths. */
  syncScope(): void {
    if (this.stopped) return
    const ws = this.workers()
    const paths = this.workerPaths()
    const key = JSON.stringify([ws.map(w => w.tag), paths])
    if (key === this.lastScopeKey) return
    this.lastScopeKey = key
    const me = this.team.me
    if (!paths.length) { if (this.team.room.scope(me.name)) this.team.room.clearScope(me.name); return }
    const areas = ws.map(w => this.local.room.scope(w.name)?.area).filter((a): a is string => !!a)
    const area = areas[0] ?? 'workers'
    const summary = `lead of ${ws.length} worker${ws.length === 1 ? '' : 's'}: ${ws.map(w => `${w.tag} (${w.task.slice(0, 40)})`).join('; ')}`
    const prev = this.team.room.scope(me.name)
    this.team.room.setScope({ by: me.name, byKind: me.kind, area, summary, paths, ...(prev?.areas ? { areas: prev.areas } : {}) })
    this.team.room.post<ScopeMsg>(me, { type: 'scope', area, summary, paths })
    this.o.log?.(`bridge: team scope now covers ${paths.length} path(s) from ${ws.length} worker(s)`)
  }

  private mirrorClaim(localId: string): void {
    if (this.mirrored.has(localId)) return
    const c = this.local.room.claims.get(localId)
    if (!c) return
    const tag = this.tagOf(c.by)
    if (!tag) return
    const me = this.team.me
    const { id: _id, at: _at, anchor: _anchor, ...rest } = c as Claim & { anchor?: unknown }
    const t = this.team.room.addClaim({ ...rest, by: me.name, byKind: me.kind, intent: `[${tag}] ${c.intent}` })
    this.mirrored.set(localId, t.id)
    this.o.log?.(`bridge: mirrored ${c.by}'s claim ${c.path}:${c.from}-${c.to} into the team room as ${t.id}`)
  }

  /** The local claim is gone: drop the mirror and tell the team what became of the plans it showed them. */
  private unmirrorClaim(localId: string): void {
    const teamId = this.mirrored.get(localId)
    if (!teamId) return
    this.mirrored.delete(localId)
    const mirrored = this.team.room.claims.get(teamId)
    this.team.room.removeClaim(teamId)
    if (!mirrored) return
    const local = [...this.local.room.messages()].reverse().find((m): m is ReleaseMsg => m.type === 'release' && m.claimId === localId)
    const tag = mirrored.intent.match(/^\[([^\]]+)\]/)?.[1]
    this.team.room.post<ReleaseMsg>(this.team.me, {
      type: 'release', claimId: teamId, path: mirrored.path,
      summary: `${tag ? `[${tag}] ` : ''}${local?.summary ?? 'released'}`,
      ...(local?.unfulfilled?.length ? { unfulfilled: local.unfulfilled } : {}),
    })
  }

  /** A team message about a worker's paths is re-posted to that worker locally: plans, conflicts and base
   *  moves as interrupts, the rest at notify. One per worker, path and type per minute. */
  private relayDown(m: Msg): void {
    if (this.relayed.includes(m.id) || !RELAY_TYPES.has(m.type)) return
    if (m.from === this.team.me.name) return
    const paths = msgPaths(m)
    if (!paths.length) return
    const now = Date.now()
    const hit = this.workers().filter(w => {
      const sc = this.local.room.scope(w.name)
      const changed = this.local.room.changedPaths(w.name)
      return paths.some(p => (sc && scopeCovers(sc, p)) || changed.includes(p))
    })
    if (!hit.length) return
    this.relayed.push(m.id)
    if (this.relayed.length > RELAYED_MAX) this.relayed.splice(0, this.relayed.length - RELAYED_MAX)
    const priority = INTERRUPT_TYPES.has(m.type) ? 'interrupt' : 'notify'
    const delivered: string[] = []
    for (const w of hit) {
      const key = `${w.name}|${paths.slice().sort().join(',')}|${m.type}`
      const last = this.recent.get(key) ?? 0
      if (priority !== 'interrupt' && now - last < RELAY_DEDUPE_MS) continue
      this.recent.set(key, now)
      this.local.room.post<NoteMsg>(this.team.me, { type: 'note', to: w.name, priority, text: `[team room] ${formatMsg(m)}` })
      delivered.push(w.tag)
    }
    if (this.recent.size > RELAYED_MAX) for (const [k, t] of this.recent) if (now - t > RELAY_DEDUPE_MS) this.recent.delete(k)
    if (delivered.length) this.o.log?.(`bridge: relayed team ${m.type} ${m.id} to ${delivered.join(', ')} at ${priority}`)
  }
}
