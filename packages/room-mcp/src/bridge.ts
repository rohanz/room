/**
 * A lead in two rooms: the team room (server) it belongs to, and a local workers room on this
 * machine where its spawned `local` workers live. The bridge is the lead's single writer in the team
 * room for those workers (manifest §5.5–5.6, registry §13), and never touches the lead's own scope,
 * policy or manifest:
 *  - `coordination[lead]` holds the union of the workers' scope and changed paths;
 *  - each worker is projected: its participant record, manifest head and entries against the lead's
 *    team base, fenced by the lead's holder, `projectedFrom` its worker ID; its view; its retirement;
 *  - workers' claims are mirrored into the team room under the lead's name ("[tag] intent");
 *  - team messages that touch a worker's paths are re-posted into the local room as interrupts
 *    addressed to that worker.
 * Workers' questions to the lead and their done messages stay local; the lead reads both rooms.
 */
import { git } from '@room/roomd/git'
import { authorizesText, defaultIgnoredPath, validRepoPath, DISK_READ_PATH } from '@room/roomd'
import { defaultExcludedPath } from '../../roomd/src/policy.js'
import { ignoredTrackedPaths } from '../../roomd/src/disk-scan.js'
import * as Y from 'yjs'
import { digestPath, formatMsg, manifestKey, msgPaths, participantRecord, participantsView, scopeCovers, snapshot } from '@room/shared'
import type { Claim, CoordinationRecord, Coverage, ManifestEntry, ManifestHead, Msg, NoteMsg, ParticipantGit, ReleaseMsg } from '@room/shared'
import type { Session } from './session.js'
import { registryForDir, type WorkerRegistry } from './worker-registry.js'
import type { WorkerRecord } from './worker-status.js'
import { projectWorkers } from './worker-projector.js'

const RELAY_TYPES = new Set<Msg['type']>(['claim', 'release', 'changed', 'conflict', 'plan', 'base', 'scope'])
/** Team messages that stop a worker: everything else arrives at notify, read on its next action. */
const INTERRUPT_TYPES = new Set<Msg['type']>(['plan', 'conflict', 'base'])
const RELAY_DEDUPE_MS = 60_000
const RELAYED_MAX = 2000
/** Backstop for inputs no observer reports (a policy change, a missed registry watch): manifest §12 "projection lag". */
const PROJECT_TICK_MS = 30_000

export interface BridgeOptions {
  log?: (line: string) => void
  /** Debounce for projection; default 300 ms (0 = run on every change, for tests). */
  debounceMs?: number
  /** The lead's registry; opened from the workers room's clone when omitted. */
  registry?: WorkerRegistry
  /** Conflict slots owned by a projected worker in the team room (reporooms §B5, registry §13); level-triggered. */
  reconcileConflicts?: (input: { team: Session; workers: Session; owner: string }) => Promise<void>
}

/** One projected path, before the lead's policy decides whether its hash may be published. */
interface ProjectedFact { change: 'M' | 'A' | 'D'; hash?: string; size?: number; baseHash?: string; at: number }

const headIdentity = (h: ManifestHead) => JSON.stringify({ base: h.base, fence: h.fence, coverage: h.coverage, level: h.level, textPrefixes: h.textPrefixes, complete: h.complete, projectedBy: h.projectedBy, projectedFrom: h.projectedFrom })
const entryIdentity = (e: ManifestEntry | undefined) => e && JSON.stringify({ change: e.change, state: e.state, held: e.held, hash: e.hash, size: e.size, baseHash: e.baseHash, fence: e.fence })

export class Bridge {
  /** local claim id -> mirrored team claim id */
  private mirrored = new Map<string, string>()
  private relayed: string[] = []
  /** worker|path|type -> last relay time, so a chatty team room does not become a stream of notices. */
  private recent = new Map<string, number>()
  private unobserve: (() => void)[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private tick: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private registry?: WorkerRegistry
  private running: Promise<void> = Promise.resolve()

  constructor(public team: Session, public local: Session, private o: BridgeOptions = {}) {
    this.registry = o.registry
  }

  /** This lead's `local` workers that are not retiring, from the registry (never the room). */
  workers(): WorkerRecord[] {
    return (this.registry?.list() ?? []).filter(r => r.lead.participant === this.local.me.name && r.room === this.local.roomName
      && !['retiring', 'retired', 'abandoned'].includes(r.phase))
  }
  private tagOf(name: string): string | undefined { return this.workers().find(w => w.name === name)?.tag }

  /** A worker's changed paths in the workers room: its current manifest incarnation, held entries included. */
  private changedPaths(name: string): string[] {
    const head = this.local.room.manifestHead.get(name)
    return head ? [...this.local.room.manifest.get(manifestKey(name, head.fence))?.keys() ?? []] : []
  }

  /** Every path a worker has declared or changed. */
  workerPaths(): string[] {
    const out = new Set<string>()
    for (const w of this.workers()) {
      for (const p of this.local.room.scope(w.name)?.paths ?? []) out.add(p)
      for (const p of this.changedPaths(w.name)) out.add(p)
    }
    return Array.from(out).sort()
  }

  start(): void {
    const l = this.local.room, t = this.team.room
    const onLocal = () => this.schedule()
    const onLocalClaims = (ev: { changes: { keys: Map<string, { action: string }> } }) => {
      for (const [id, ch] of ev.changes.keys) {
        if (ch.action === 'add') this.mirrorClaim(id)
        else if (ch.action === 'update') this.updateMirrorClaim(id)
        else if (ch.action === 'delete') this.unmirrorClaim(id)
      }
    }
    // A mirror removed by something other than this bridge (the lead's own room_done or a stale sweep)
    // while the worker's claim is still open: put it back.
    const onTeamClaims = (ev: { changes: { keys: Map<string, { action: string }> } }, tr: { origin: unknown }) => {
      if (tr.origin === this) return
      for (const [teamId, ch] of ev.changes.keys) {
        if (ch.action !== 'delete') continue
        const localId = this.localIdOf(teamId)
        if (!localId) continue
        this.mirrored.delete(localId)
        if (this.local.room.claims.has(localId)) { this.mirrorClaim(localId); this.o.log?.(`bridge: re-mirrored ${localId} (its mirror ${teamId} was removed by someone else)`) }
      }
    }
    const onTeamBus = (ev: { changes: { delta: { insert?: unknown }[] }; transaction: { local: boolean } }) => {
      if (ev.transaction.local) return
      for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) this.relayDown(m)
    }
    // The lead's team base, level or fence moving changes every projection (R3c).
    const onTeamLead = (ev: { keysChanged: Set<string> }, tr: { origin: unknown }) => {
      if (tr.origin === this) return
      const me = this.team.me.name
      if (ev.keysChanged.has(me) || [...ev.keysChanged].some(k => k.startsWith(`${me}\u0000`))) this.schedule()
    }
    l.scopes.observe(onLocal); l.claims.observe(onLocalClaims)
    l.manifestHead.observe(onLocal); l.manifest.observeDeep(onLocal)
    t.bus.observe(onTeamBus); t.claims.observe(onTeamClaims)
    t.participants.observe(onTeamLead); t.manifestHead.observe(onTeamLead)
    const onSync = (synced: boolean) => { if (synced) this.schedule() }
    this.team.provider.on?.('sync', onSync)
    this.local.provider.on?.('sync', onSync)
    this.unobserve.push(
      () => l.scopes.unobserve(onLocal), () => l.claims.unobserve(onLocalClaims),
      () => l.manifestHead.unobserve(onLocal), () => l.manifest.unobserveDeep(onLocal),
      () => t.bus.unobserve(onTeamBus), () => t.claims.unobserve(onTeamClaims),
      () => t.participants.unobserve(onTeamLead), () => t.manifestHead.unobserve(onTeamLead),
      () => this.team.provider.off?.('sync', onSync), () => this.local.provider.off?.('sync', onSync),
    )
    this.tick = setInterval(() => this.schedule(), PROJECT_TICK_MS)
    this.tick.unref?.()
    const attach = (registry: WorkerRegistry) => {
      if (this.stopped) return
      this.registry = registry
      this.unobserve.push(registry.onChange(() => this.schedule()))
      for (const c of l.openClaims()) this.mirrorClaim(c.id)
      this.schedule()
    }
    if (this.registry) attach(this.registry)
    else void registryForDir(this.local.dir).then(attach, e => this.o.log?.(`bridge: no worker registry: ${e instanceof Error ? e.message : String(e)}`))
  }

  /** Remove mirrored claims and the coordination record, and stop observing. Projections stay until retirement. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.tick) clearInterval(this.tick)
    for (const u of this.unobserve) u()
    this.unobserve = []
    for (const teamId of this.mirrored.values()) this.team.room.removeClaim(teamId, this)
    this.mirrored.clear()
    const lead = this.team.me.name
    if (this.team.room.coordination.has(lead)) this.team.room.doc.transact(() => { this.team.room.coordination.delete(lead) }, this)
  }

  private localIdOf(teamId: string): string | undefined {
    for (const [l, t] of this.mirrored) if (t === teamId) return l
    return undefined
  }

  private schedule(): void {
    if (this.stopped) return
    const ms = this.o.debounceMs ?? 300
    if (ms === 0) { void this.sync(); return }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.sync() }, ms)
    this.timer.unref?.()
  }

  /** Coordination now, then one serialized projection pass. */
  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    try { this.syncCoordination() } catch (e) { this.o.log?.(`bridge: could not sync coordination: ${e instanceof Error ? e.message : String(e)}`) }
    return this.project()
  }

  /**
   * `coordination[lead] = {paths, workers, at}`: the union of the lead's projectable workers' scope and
   * changed paths (manifest §5.6). Deleted when there are none. Never reads or writes `scopes[lead]`.
   */
  syncCoordination(): void {
    if (this.stopped || !this.registry) return
    const lead = this.team.me.name
    const paths = this.workerPaths()
    const workers = this.workers().map(w => w.name).sort()
    const current = this.team.room.coordination.get(lead)
    if (!paths.length) {
      if (current) this.team.room.doc.transact(() => { this.team.room.coordination.delete(lead) }, this)
      return
    }
    if (current && JSON.stringify([current.paths, current.workers]) === JSON.stringify([paths, workers])) return
    const next: CoordinationRecord = { paths, workers, at: Date.now() }
    this.team.room.doc.transact(() => { this.team.room.coordination.set(lead, next) }, this)
    this.o.log?.(`bridge: coordination covers ${paths.length} path(s) from ${workers.length} worker(s)`)
  }

  /** Serialized: one pass at a time, and a request during a pass runs once after it. */
  project(): Promise<void> {
    const next = this.running.then(async () => {
      if (this.stopped || !this.registry) return
      try { await this.projectOnce(this.registry) }
      catch (e) { this.o.log?.(`bridge: could not project workers: ${e instanceof Error ? e.message : String(e)}`) }
    })
    this.running = next
    return next
  }

  /**
   * `project(set)` (manifest §5.5, registry §13): views and retirement through the projector in the
   * `projected` role, then each written worker's participant record and manifest; projections of this lead
   * whose worker is no longer in the set are deleted.
   */
  private async projectOnce(registry: WorkerRegistry): Promise<void> {
    const written = await projectWorkers(this.team, registry, this.local.me.name, 'projected', this)
    const keep = new Set(written.map(r => r.id))
    const lead = this.team.me.name
    const stale: string[] = []
    for (const key of this.team.room.participants.keys()) {
      if (!key.endsWith('\u0000proj')) continue
      const proj = this.team.room.participants.get(key) as { projectedFrom: string; projectedBy: string } | undefined
      if (proj?.projectedBy === lead && !keep.has(proj.projectedFrom)) stale.push(key.slice(0, -'\u0000proj'.length))
    }
    if (stale.length) this.team.room.doc.transact(() => { for (const name of stale) this.dropProjection(name) }, this)
    for (const record of written) {
      if (this.stopped) return
      await this.projectWorker(record)
      await this.o.reconcileConflicts?.({ team: this.team, workers: this.local, owner: record.name })
    }
  }

  /** Delete a projected participant's team records: its flat keys, manifest incarnations and head. */
  private dropProjection(name: string): void {
    const room = this.team.room
    for (const key of [...room.participants.keys()]) if (key.startsWith(`${name}\u0000`)) room.participants.delete(key)
    for (const key of [...room.manifest.keys()]) if (key.startsWith(`${name}\u0000`)) room.manifest.delete(key)
    room.manifestHead.delete(name)
  }

  /**
   * Compose one worker's team projection, purely from local facts (manifest §5.5): base = the lead's team base B;
   * entries = the worker's own workers-room manifest (against C) plus everything between B and C; every entry
   * `held: 'worker'` except D; hashes only where the lead's team policy authorizes the path's text. Coverage is
   * inherited from the source, never upgraded (N2).
   */
  private async projectWorker(record: WorkerRecord, retry = 0): Promise<void> {
    const team = this.team.room, lead = this.team.me.name
    const leadGit = participantRecord(team, lead)?.git
    const fence = this.team.daemon.fence
    const policy = this.team.policyStore.policy
    const rules = this.team.daemon.inputs.rules
    if (!leadGit || !fence) return // no team base or live name lease: the lead will schedule another pass
    const B = leadGit.base, C = record.base
    const view = participantsView(this.local.room, this.local.awareness, Date.now())
    const source = snapshot(this.local.room, record.name, view)
    const sourceHead = source?.head
    const coverage: Coverage = policy.level === 'intent' ? { kind: 'none', reason: 'unprojectable' }
      : !sourceHead || !source?.fenceValid || !sourceHead.complete ? { kind: 'none', reason: 'starting' }
      : sourceHead.coverage.kind === 'none' ? { kind: 'none', reason: sourceHead.coverage.reason === 'not-publisher' ? 'not-publisher' : sourceHead.coverage.reason === 'intent' ? 'intent' : 'starting' }
      : sourceHead.excluded.length ? { kind: 'none', reason: 'unprojectable' }
      : { kind: 'all' }
    const entries = new Map<string, ManifestEntry>()
    const excluded: string[] = []
    let complete = coverage.kind === 'all'
    if (coverage.kind === 'all' && C && source) {
      const facts = await this.composeFacts(record, B, C, source.entries).catch(e => {
        this.o.log?.(`bridge: cannot compose ${record.tag}'s projection: ${e instanceof Error ? e.message : String(e)}`)
        return undefined
      })
      if (!facts) complete = false
      else {
        const current = this.registry?.read(record.id)
        const latestSource = snapshot(this.local.room, record.name, participantsView(this.local.room, this.local.awareness, Date.now()))
        const latestLead = participantRecord(team, lead)?.git
        if (this.stopped || this.team.policyStore.policy !== policy || this.team.daemon.inputs.rules.id !== rules.id
          || this.team.daemon.fence !== fence || latestLead?.base !== B || latestLead?.fence !== leadGit.fence
          || latestSource?.head.semRev !== sourceHead?.semRev || latestSource?.head.fence !== sourceHead?.fence
          || !latestSource?.fenceValid || current?.id !== record.id || current?.phase !== record.phase
          || ['retiring', 'retired', 'abandoned'].includes(current.phase)) {
          this.o.log?.(`bridge: stale projection ${record.tag}: ${JSON.stringify({ policy: this.team.policyStore.policy !== policy, rules: this.team.daemon.inputs.rules.id !== rules.id, fence: this.team.daemon.fence !== fence, base: latestLead?.base !== B, gitFence: latestLead?.fence !== leadGit.fence, semRev: latestSource?.head.semRev !== sourceHead?.semRev, sourceFence: latestSource?.head.fence !== sourceHead?.fence, sourceValid: latestSource?.fenceValid, id: current?.id !== record.id, phase: current?.phase !== record.phase })}`)
          if (retry < 1 && current && !['retiring', 'retired', 'abandoned'].includes(current.phase)) return this.projectWorker(current, retry + 1)
          team.doc.transact(() => this.dropProjection(record.name), this)
          return
        }
        const salt = team.ensureRoomSalt()
        const ignored = await ignoredTrackedPaths(this.local.dir, [...facts.all.keys()])
        // The Git ignore read yields too. A newer policy, source or worker phase must win.
        if (this.stopped || this.team.policyStore.policy !== policy || this.team.daemon.inputs.rules.id !== rules.id
          || this.team.daemon.fence !== fence || participantRecord(team, lead)?.git?.base !== B
          || snapshot(this.local.room, record.name, participantsView(this.local.room, this.local.awareness, Date.now()))?.head.semRev !== sourceHead?.semRev
          || this.registry?.read(record.id)?.phase !== record.phase) {
          if (retry < 1) return this.projectWorker(this.registry?.read(record.id) ?? record, retry + 1)
          team.doc.transact(() => this.dropProjection(record.name), this)
          return
        }
        let used = 0
        for (const [path, fact] of facts.all) {
          if (ignored.has(path) || rules.roomIgnore.ignores(path) || defaultIgnoredPath(path)
            || defaultExcludedPath(path) || !validRepoPath(path, DISK_READ_PATH)
            || (fact.change !== 'D' && fact.size !== undefined && (fact.size > rules.sizeCap
              || (authorizesText(policy, path) && used + fact.size > rules.budget)))) {
            excluded.push(digestPath(salt, path))
            continue
          }
          if (fact.change !== 'D' && authorizesText(policy, path) && fact.size !== undefined) used += fact.size
          const entry: ManifestEntry = fact.change === 'D'
            ? { change: 'D', state: 'shared', at: fact.at, fence }
            : { change: fact.change, state: 'held', held: 'worker', at: fact.at, fence }
          if (authorizesText(policy, path)) {
            if (fact.change !== 'D' && fact.hash) {
              entry.hash = fact.hash
              if (fact.size !== undefined) entry.size = fact.size
              if (fact.baseHash) entry.baseHash = fact.baseHash
            } else if (fact.change === 'D' && fact.baseHash && (facts.carried.has(path) || source.entries.get(path)?.baseHash)) {
              entry.baseHash = fact.baseHash
            }
          }
          entries.set(path, entry)
        }
      }
    } else if (coverage.kind === 'all') complete = false
    excluded.sort()
    const key = manifestKey(record.name, fence)
    const prevHead = team.manifestHead.get(record.name)
    const prevMap = team.manifest.get(key)
    const entriesChanged = (prevMap?.size ?? 0) !== entries.size || [...entries].some(([p, e]) => entryIdentity(prevMap?.get(p)) !== entryIdentity(e))
    const exclusionChanged = JSON.stringify(prevHead?.excluded ?? []) !== JSON.stringify(excluded)
    const head: ManifestHead = {
      base: B, fence, coverage: complete ? coverage : coverage.kind === 'all' ? { kind: 'none', reason: 'starting' } : coverage,
      projectedBy: lead, projectedFrom: record.id, level: policy.level,
      ...(policy.level === 'declared' ? { textPrefixes: [...policy.textPrefixes] } : {}), excluded,
      rev: (prevHead?.rev ?? 0) + (entriesChanged || exclusionChanged || prevHead?.fence !== fence ? 1 : 0), semRev: 0,
      scannedAt: Date.now(), complete,
    }
    head.semRev = (prevHead?.semRev ?? 0) + (!prevHead || head.rev !== prevHead.rev || headIdentity(head) !== headIdentity(prevHead) ? 1 : 0)
    const prevGit = participantRecord(team, record.name)?.git
    const { rev: _leadRev, fence: _leadFence, ...leadFields } = leadGit
    const git: ParticipantGit = { ...leadFields, base: B, rev: prevGit?.rev ?? 0, fence }
    const { rev: _prevRev, ...prevFields } = prevGit ?? { rev: 0 }
    const { rev: _nextRev, ...nextFields } = git
    if (JSON.stringify(prevFields) !== JSON.stringify(nextFields)) git.rev += 1
    const identity = { name: record.name, kind: 'agent' as const, owner: this.team.me.owner ?? lead, label: record.tag }
    const proj = { projectedFrom: record.id, projectedBy: lead }
    const unchanged = head.semRev === prevHead?.semRev && git.rev === prevGit?.rev
      && JSON.stringify(team.participants.get(`${record.name}\u0000proj`)) === JSON.stringify(proj)
    if (unchanged) {
      team.doc.transact(() => {
        if (prevMap) for (const [p, e] of entries) if (prevMap.get(p)?.at !== e.at) prevMap.set(p, e)
        team.manifestHead.set(record.name, head)
      }, this)
      return
    }
    team.doc.transact(() => {
      for (const k of [...team.manifest.keys()]) if (k.startsWith(`${record.name}\u0000`) && k !== key) team.manifest.delete(k)
      let map = team.manifest.get(key)
      if (!map) { map = new Y.Map<ManifestEntry>(); team.manifest.set(key, map) }
      for (const p of [...map.keys()]) if (!entries.has(p)) map.delete(p)
      for (const [p, e] of entries) if (entryIdentity(map.get(p)) !== entryIdentity(e) || map.get(p)?.at !== e.at) map.set(p, e)
      team.manifestHead.set(record.name, head)
      team.participants.set(`${record.name}\u0000id`, identity)
      team.participants.set(`${record.name}\u0000proj`, proj)
      team.participants.set(`${record.name}\u0000git`, git)
    }, this)
  }

  /**
   * Source 1, the worker's own manifest against C, re-based onto B; source 2, `git diff B C` and the carried
   * untracked files for paths the worker did not touch. `carried` lists source-2 paths (they pass the lead's
   * exclusion rules). A path whose content equals B's blob has no entry.
   */
  private async composeFacts(record: WorkerRecord, B: string, C: string, own: ReadonlyMap<string, ManifestEntry>): Promise<{ all: Map<string, ProjectedFact>; carried: Map<string, ProjectedFact> }> {
    const dir = this.local.dir
    const between = new Map<string, { change: 'M' | 'A' | 'D'; oldBlob?: string; newBlob?: string }>()
    if (B !== C) {
      const raw = await git(dir, ['diff', '--raw', '--no-renames', '--no-abbrev', '-z', B, C])
      const parts = raw.split('\0')
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const meta = parts[i].replace(/^:/, '').split(' '), path = parts[i + 1]
        if (meta.length < 5 || !path) continue
        const status = meta[4][0] as 'M' | 'A' | 'D'
        if (!['M', 'A', 'D'].includes(status)) continue
        between.set(path, { change: status, ...(status !== 'A' ? { oldBlob: meta[2] } : {}), ...(status !== 'D' ? { newBlob: meta[3] } : {}) })
      }
    }
    const untracked = new Map((record.carriedUntracked ?? []).map(f => [f.path, f.sha]))
    const candidates = new Set([...own.keys(), ...between.keys(), ...untracked.keys()])
    const atB = await blobsAt(dir, B, candidates)
    const all = new Map<string, ProjectedFact>(), carried = new Map<string, ProjectedFact>()
    const now = Date.now()
    const put = (path: string, hash: string | undefined, at: number, size?: number): ProjectedFact | undefined => {
      const base = atB.get(path)
      if (hash === undefined) return base ? { change: 'D', baseHash: base.blob, at } : undefined
      if (base?.blob === hash) return undefined
      return { change: base ? 'M' : 'A', hash, ...(size !== undefined ? { size } : {}), ...(base ? { baseHash: base.blob } : {}), at }
    }
    for (const [path, e] of own) {
      // A hashless source entry (outside the worker's own text area) is still a change against B.
      const fact = e.change === 'D' ? put(path, undefined, e.at)
        : e.hash ? put(path, e.hash, e.at, e.size)
        : { change: atB.has(path) ? 'M' as const : 'A' as const, ...(atB.get(path) ? { baseHash: atB.get(path)!.blob } : {}), at: e.at }
      if (fact) all.set(path, fact)
    }
    const sizes = await blobsAt(dir, C, [...between.keys()].filter(p => !own.has(p) && between.get(p)!.newBlob))
    for (const [path, d] of between) {
      if (own.has(path) || untracked.has(path)) continue
      const fact = put(path, d.newBlob, now, sizes.get(path)?.size)
      if (fact) { all.set(path, fact); carried.set(path, fact) }
    }
    for (const [path, sha] of untracked) {
      if (own.has(path)) continue
      const size = Number((await git(dir, ['cat-file', '-s', sha])).trim())
      const fact = put(path, sha, now, size)
      if (fact) { all.set(path, fact); carried.set(path, fact) }
    }
    return { all, carried }
  }

  private mirrorClaim(localId: string): void {
    if (this.mirrored.has(localId)) return
    const c = this.local.room.claims.get(localId)
    if (!c) return
    const tag = this.tagOf(c.by)
    if (!tag) return
    const me = this.team.me
    const { id: _id, at: _at, anchor: _anchor, ...rest } = c as Claim & { anchor?: unknown }
    const t = this.team.room.addClaim({ ...rest, by: me.name, byKind: me.kind, intent: `[${tag}] ${c.intent}`, mirrorOf: tag }, this)
    this.mirrored.set(localId, t.id)
    this.o.log?.(`bridge: mirrored ${c.by}'s claim ${c.path}:${c.from}-${c.to} into the team room as ${t.id}`)
  }

  private updateMirrorClaim(localId: string): void {
    const teamId = this.mirrored.get(localId)
    if (!teamId) { this.mirrorClaim(localId); return }
    const local = this.local.room.claims.get(localId)
    const mirrored = this.team.room.claims.get(teamId)
    if (!local || !mirrored) return
    const { id: _id, at: _at, anchor: _anchor, ...rest } = local as Claim & { anchor?: unknown }
    const { anchor: _mirrorAnchor, ...mirrorRest } = mirrored
    this.team.room.doc.transact(() => this.team.room.claims.set(teamId, {
      ...mirrorRest, ...rest, id: teamId, at: mirrored.at, by: this.team.me.name, byKind: this.team.me.kind,
      intent: `[${mirrored.mirrorOf}] ${local.intent}`, mirrorOf: mirrored.mirrorOf,
    }), this)
  }

  /** The local claim is gone: drop the mirror and tell the team what became of the plans it showed them. */
  private unmirrorClaim(localId: string): void {
    const teamId = this.mirrored.get(localId)
    if (!teamId) return
    this.mirrored.delete(localId)
    const mirrored = this.team.room.claims.get(teamId)
    this.team.room.removeClaim(teamId, this)
    if (!mirrored) return
    const local = [...this.local.room.messages()].reverse().find((m): m is ReleaseMsg => m.type === 'release' && m.claimId === localId)
    const tag = mirrored.intent.match(/^\[([^\]]+)\]/)?.[1]
    void this.team.post<ReleaseMsg>(this.team.me, {
      type: 'release', claimId: teamId, path: mirrored.path,
      summary: `${tag ? `[${tag}] ` : ''}${local?.summary ?? 'released'}`,
      ...(local?.unfulfilled?.length ? { unfulfilled: local.unfulfilled } : {}),
    }, { auto: true })
  }

  /** A team message about a worker's paths is re-posted to that worker locally: plans, conflicts and base
   *  moves as interrupts, the rest at notify. One per worker, path and type per minute. */
  private relayDown(m: Msg): void {
    if (this.relayed.includes(m.id)) return
    if (m.from === this.team.me.name && m.fromKind !== 'human') return
    const broadcast = m.type === 'note' && !m.to && (m.priority === 'notify' || m.priority === 'interrupt')
    if (!broadcast && !RELAY_TYPES.has(m.type)) return
    const paths = msgPaths(m)
    if (!broadcast && !paths.length) return
    const now = Date.now()
    const hit = this.workers().filter(w => {
      if (broadcast) return true
      const sc = this.local.room.scope(w.name)
      const changed = this.changedPaths(w.name)
      return paths.some(p => (sc && scopeCovers(sc, p)) || changed.includes(p))
    })
    if (!hit.length) return
    this.relayed.push(m.id)
    if (this.relayed.length > RELAYED_MAX) this.relayed.splice(0, this.relayed.length - RELAYED_MAX)
    const priority = broadcast ? m.priority as 'notify' | 'interrupt' : INTERRUPT_TYPES.has(m.type) ? 'interrupt' : 'notify'
    const delivered: string[] = []
    for (const w of hit) {
      const key = `${w.name}|${paths.slice().sort().join(',')}|${m.type}`
      const last = this.recent.get(key) ?? 0
      if (!broadcast && priority !== 'interrupt' && now - last < RELAY_DEDUPE_MS) continue
      this.recent.set(key, now)
      void this.local.post<NoteMsg>(this.team.me, { type: 'note', to: w.name, priority, text: `[team room] ${formatMsg(m)}` }, { auto: true })
      delivered.push(w.tag)
    }
    if (this.recent.size > RELAYED_MAX) for (const [k, t] of this.recent) if (now - t > RELAY_DEDUPE_MS) this.recent.delete(k)
    if (delivered.length) this.o.log?.(`bridge: relayed team ${m.type} ${m.id} to ${delivered.join(', ')} at ${priority}`)
  }
}

/** Blob id and size of each path at a commit; absent when the commit has no such file. */
async function blobsAt(dir: string, commit: string, paths: Iterable<string>): Promise<Map<string, { blob: string; size: number }>> {
  const list = [...paths]
  const out = new Map<string, { blob: string; size: number }>()
  if (!list.length) return out
  const raw = await git(dir, ['ls-tree', '-r', '-z', '--long', '--full-tree', commit, '--', ...list])
  for (const line of raw.split('\0')) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.*)$/s)
    if (m) out.set(m[3], { blob: m[1], size: Number(m[2]) })
  }
  return out
}
