import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { acceptedGit, conflictEndReason, hasConflictIdentity, conflictWorkerId, claimInMyLines, claimsOverlap, containsPath, coversPath, digestPath, gitBlobHash, manifestKey, neighbours, observedContractAnalysis, participantRecord, participantsView, snapshot, snapshotMetadata, snapshotPath, snapshotStillCurrent, versionOf, type Claim, type ConflictEndEvidence, type Identity, type NoteMsg, type ParticipantMetadataSnapshot, type ParticipantSnapshot, type ParticipantView, type RoomDoc, type Version } from '@room/shared'
import type { Session } from './session.js'
import { git, gitBlobInfoMany } from '@room/roomd/git'
import { comparePair } from '@room/roomd'
import { gitMergeFile } from './merge.js'
import { diffLines } from 'diff'
import { carriedPaths, carriesWork, workerBaseline, pairBaseline, MissingBaseBlob, type Baseline, type BaselineRead } from '@room/roomd/baseline'
import { parseInWorker } from './parse/client.js'
import { specForPath } from './parse/index.js'
import { consumesSymbol } from './graph-index.js'
import { trustedWorker, workerText } from './tools/context.js'
import { readBoundedCheckoutText, readBoundedHistoricalText } from './tools/disk-text.js'
import { openWorkerReader, registryForDir } from './worker-registry.js'

import type { ConflictKind, ConflictSlot } from '@room/shared'
export type { ConflictKind, ConflictSlot } from '@room/shared'
export type Evaluation = Pick<ConflictSlot, 'kind' | 'owner' | 'other' | 'path' | 'subject' | 'status' | 'inputs' | 'factId' | 'lines' | 'why' | 'earlierSha' | 'merges' | 'retrySource' | 'consumers' | 'evaluatedRanges'> & { incomplete?: boolean }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const slotKey = (owner: string, kind: ConflictKind, other: string, path: string, subject = ''): string =>
  [owner, kind, other, path, subject].join('\0')
const peerMerge = (slot: Pick<ConflictSlot, 'kind' | 'path'>): boolean => slot.kind === 'merge' && slot.path !== '*'
const ROOM: Identity = { name: 'room', kind: 'agent' }
const retryMinutes = [1, 2, 4, 8]
class StaleConflictInputs extends Error {}
/** A registry record may keep the path a worktree was created with; trustedWorker reports its real path. */
const samePath = (a: string, b: string): boolean => {
  try { return fs.realpathSync(a) === fs.realpathSync(b) } catch { return false }
}
type LandedWorkerState = { id: string; name?: string; lead?: string; dir?: string; reported: string; run: string; seq: number; busy: boolean }
type TrustedLandedWorker = { id: string; status: string; dir: string; run: string; seq: number }

type SlotIndex = { owners: Map<string, Map<string, ConflictSlot>>; pairs: Map<string, Map<string, ConflictSlot>> }
const slotIndexes = new WeakMap<RoomDoc, SlotIndex>()
const pairKey = (owner: string, other: string) => JSON.stringify([owner, other])
/** One changed-key index per document, shared by native and projected evaluators. */
function conflictSlotIndex(room: RoomDoc): SlotIndex {
  const known = slotIndexes.get(room)
  if (known) return known
  const map = room.doc.getMap<ConflictSlot>('conflicts'), indexed = new Map<string, ConflictSlot>()
  const state: SlotIndex = { owners: new Map(), pairs: new Map() }
  const update = (key: string, slot?: ConflictSlot) => {
    const previous = indexed.get(key)
    if (previous) {
      for (const [groups, group] of [[state.owners, previous.owner], [state.pairs, pairKey(previous.owner, previous.other)]] as const) {
        const entries = groups.get(group); entries?.delete(key); if (!entries?.size) groups.delete(group)
      }
      indexed.delete(key)
    }
    if (!slot) return
    indexed.set(key, slot)
    for (const [groups, group] of [[state.owners, slot.owner], [state.pairs, pairKey(slot.owner, slot.other)]] as const) {
      let entries = groups.get(group)
      if (!entries) { entries = new Map(); groups.set(group, entries) }
      entries.set(key, slot)
    }
  }
  for (const [key, slot] of map) update(key, slot)
  map.observe(event => { for (const key of event.keysChanged) update(key, map.get(key)) })
  slotIndexes.set(room, state)
  return state
}

/** One writer per owner. Stage only the affected pair, sharing its document index. */
export class ConflictSlots {
  private readonly map
  private readonly index
  constructor(private readonly room: RoomDoc, private readonly fence: string | (() => string),
    private readonly now: () => number = Date.now, private readonly valid: () => boolean = () => true,
    private readonly endpoints: (names: string[]) => ConflictSlot['endpoints'] = names => names.map(name => {
      const workerId = conflictWorkerId(room, name); return { name, ...(workerId ? { workerId } : {}) }
    })) {
    this.map = room.doc.getMap<ConflictSlot>('conflicts')
    this.index = conflictSlotIndex(room)
  }
  private pair(owner: string, other: string): Map<string, ConflictSlot> { return this.index.pairs.get(pairKey(owner, other)) ?? new Map() }
  get(key: string): ConflictSlot | undefined { const slot = this.map.get(key); return hasConflictIdentity(slot) ? slot : undefined }
  owned(owner: string): [string, ConflictSlot][] { return [...this.index.owners.get(owner) ?? []] }
  private remove(key: string, evidence: ConflictEndEvidence): void {
    const slot = this.map.get(key)
    if (slot && conflictEndReason(this.room, slot, evidence)) this.map.delete(key)
  }
  drop(keys: string | readonly string[], evidence: ConflictEndEvidence = {}): void {
    const context = { policyCache: new Map(), retiredWorkerIds: new Set(this.room.retiredWorkers().flatMap(worker => worker.id ? [worker.id] : [])), ...evidence }
    this.room.doc.transact(() => { for (const key of typeof keys === 'string' ? [keys] : keys) this.remove(key, context) })
  }
  /** Coalesce duplicate records without ending the opening retained in keepKey. */
  consolidateClaims(keepKey: string, duplicateKeys: readonly string[]): Set<string> {
    if (!this.valid()) throw new StaleConflictInputs()
    const keep = this.get(keepKey), removed = new Set<string>()
    if (keep?.kind !== 'edit-in-claim') return removed
    this.room.doc.transact(() => {
      for (const key of duplicateKeys) {
        const slot = this.get(key)
        if (key === keepKey || slot?.kind !== keep.kind || slot.owner !== keep.owner || slot.other !== keep.other
          || slot.path !== keep.path || JSON.stringify(slot.endpoints) !== JSON.stringify(keep.endpoints)) continue
        this.map.delete(key); removed.add(key)
      }
    })
    return removed
  }
  markContractsUnknown(owner: string, other: string, why: string, paths?: ReadonlySet<string>): void {
    const now = this.now(), fence = typeof this.fence === 'function' ? this.fence() : this.fence
    this.room.doc.transact(() => {
      for (const [key, slot] of this.pair(owner, other)) {
        if (slot.kind !== 'contract' || paths && !paths.has(slot.path)) continue
        if (slot.status === 'unknown' && slot.why === why && slot.fence === fence) continue
        this.map.set(key, { ...slot, status: 'unknown', inputs: hash(`${key}\0${why}`), why,
          fence, checkedAt: now, retryAt: now + retryMinutes[0]! * 60_000 })
      }
    })
  }
  private groupKey(slot: Pick<ConflictSlot, 'kind' | 'path'>, status: ConflictSlot['settled']): string | undefined {
    return peerMerge(slot) || slot.kind === 'edit-in-claim' && status === 'possible' ? JSON.stringify([slot.kind, status, peerMerge(slot) ? '' : slot.path]) : undefined
  }
  private groups(state: Map<string, ConflictSlot>, endpoints: ConflictSlot['endpoints']): Map<string, string> {
    const groups = new Map<string, string>()
    for (const slot of state.values()) {
      const group = this.groupKey(slot, slot.settled)
      if (group && hasConflictIdentity(slot) && JSON.stringify(slot.endpoints) === JSON.stringify(endpoints)) groups.set(group, slot.openId)
    }
    return groups
  }
  async settle(key: string, result: Evaluation): Promise<ConflictSlot> {
    const grouped = peerMerge(result) || result.kind === 'edit-in-claim' && result.status === 'possible'
    const prior = this.map.get(key)
    const state = grouped ? new Map(this.pair(result.owner, result.other)) : new Map(prior ? [[key, prior]] : [])
    const endpoints = this.endpoints?.([result.owner, result.other])
    const slot = this.settleState(key, result, state, this.groups(state, endpoints), endpoints)
    this.room.doc.transact(() => { if (slot.status === 'clean') this.remove(key, { evaluated: 'clean' }); else if (this.map.get(key) !== slot) this.map.set(key, slot) })
    return slot
  }
  private settleState(key: string, result: Evaluation, state: Map<string, ConflictSlot>, groups: Map<string, string>, captured?: ConflictSlot['endpoints']): ConflictSlot {
    const stored = state.get(key), prev = hasConflictIdentity(stored) ? stored : undefined, now = this.now(), fence = typeof this.fence === 'function' ? this.fence() : this.fence
    if (prev?.settled === 'conflict' && result.incomplete)
      result = { ...result, status: 'unknown', why: 'latest evaluation inputs are unreadable' }
    const active = result.status === 'conflict' || result.status === 'possible', endpoints = active ? captured : prev?.endpoints ?? captured
    if (!endpoints || endpoints.length !== 2) throw new StaleConflictInputs()
    const identityChanged = active && JSON.stringify(endpoints) !== JSON.stringify(prev?.endpoints)
    if (result.status === 'unknown' && prev?.status === 'unknown' && prev.inputs === result.inputs && prev.fence === fence && (prev.retryAt ?? 0) > now) return prev
    if (prev?.inputs === result.inputs && prev.status === result.status && prev.factId === result.factId && prev.fence === fence && result.status !== 'unknown' && !identityChanged && prev.openId) return prev
    const settled = result.status === 'unknown' ? prev?.settled ?? 'none' : result.status
    const unknownCount = result.status === 'unknown' ? Math.min(3, (prev?.status === 'unknown' ? Math.max(0, retryMinutes.findIndex(m => (prev.retryAt ?? 0) - prev.checkedAt <= m * 60_000)) + 1 : 0)) : 0
    const continuing = prev && prev.settled === settled && ['conflict', 'possible'].includes(prev.settled) && !identityChanged
      && (prev.merges === 'clean') === (result.merges === 'clean')
    const group = this.groupKey(result, settled)
    const openId = active ? (continuing ? prev.openId : undefined) ?? (group ? groups.get(group) : undefined) ?? randomUUID() : prev?.openId ?? (result.status === 'unknown' ? randomUUID() : undefined)
    if (active && group) groups.set(group, openId!)
    const fact = result.status === 'unknown' && prev ? prev : result
    const slot: ConflictSlot = { kind: result.kind, owner: result.owner, other: result.other, path: result.path,
      ...(result.subject !== undefined ? { subject: result.subject } : {}), status: result.status, inputs: result.inputs, factId: fact.factId,
      lines: fact.lines, why: result.why, earlierSha: fact.earlierSha, merges: fact.merges, consumers: fact.consumers,
      evaluatedRanges: fact.evaluatedRanges, retrySource: result.retrySource, settled, fence, checkedAt: now,
      confirmedAt: result.status === 'unknown' ? prev?.confirmedAt : now,
      ...(openId && result.status !== 'clean' ? { openId } : {}), ...(endpoints ? { endpoints } : {}),
      ...(result.kind === 'edit-in-claim' ? { claimRanges: result.status === 'unknown' ? prev?.claimRanges
        : this.room.openClaims().filter(claim => claim.by === result.other && claim.path === result.path
          && (result.status === 'possible' || !result.subject || claim.id === result.subject)).map(({ from, to }) => ({ from, to })) } : {}),
      ...(result.status === 'unknown' ? { retryAt: now + retryMinutes[unknownCount]! * 60_000 } : {}) }
    if (result.status === 'clean' && conflictEndReason(this.room, prev ?? slot, { evaluated: 'clean' })) state.delete(key); else state.set(key, slot)
    return slot
  }
  async settlePair(owner: string, other: string, results: ReadonlyMap<string, Evaluation>, refresh?: () => Promise<boolean>): Promise<void> {
    await this.publishPair(owner, other, results, refresh, true)
  }
  async diagnosePair(result: Evaluation, refresh?: () => Promise<boolean>): Promise<void> {
    await this.publishPair(result.owner, result.other, new Map([[slotKey(result.owner, 'merge', result.other, '*'), result]]), refresh, false)
  }
  private async publishPair(owner: string, other: string, results: ReadonlyMap<string, Evaluation>, refresh: (() => Promise<boolean>) | undefined, complete: boolean): Promise<void> {
    if (!this.valid()) throw new StaleConflictInputs()
    const state = new Map(this.pair(owner, other)), endpoints = this.endpoints?.([owner, other]), groups = this.groups(state, endpoints)
    let prepared = 0
    for (const [key, result] of results) {
      if (++prepared % 32 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); if (!this.valid()) throw new StaleConflictInputs() }
      this.settleState(key, result, state, groups, endpoints)
    }
    if (refresh && !await refresh() || !this.valid()) throw new StaleConflictInputs()
    this.room.doc.transact(() => {
      if (complete) this.remove(slotKey(owner, 'merge', other, '*'), { evaluated: 'clean' })
      for (const key of results.keys()) { const slot = state.get(key); if (!slot) this.remove(key, { evaluated: 'clean' }); else if (this.map.get(key) !== slot) this.map.set(key, slot) }
    })
  }
}

export const changedRanges = (base: string, live: string): { from: number; to: number }[] => {
  if (base === live) return []
  const tokens = base.split('\n').length + live.split('\n').length
  const changes = diffLines(base, live, { maxEditLength: Math.max(1, Math.min(128, Math.floor(2_000_000 / tokens))) })
  if (!changes) return [{ from: 1, to: Math.max(1, live.split('\n').length - Number(live.endsWith('\n'))) }]
  const ranges: { from: number; to: number }[] = []
  let line = 1
  let start: number | undefined
  let added = 0
  const count = (value: string) => value ? value.split('\n').length - Number(value.endsWith('\n')) : 0
  const flush = () => {
    if (start === undefined) return
    ranges.push({ from: start, to: start + Math.max(0, added - 1) })
    start = undefined
    added = 0
  }
  for (const change of changes) {
    if (!change.added && !change.removed) { flush(); line += count(change.value) }
    else {
      start ??= line
      if (change.added) { added += count(change.value); line += count(change.value) }
    }
  }
  flush()
  return ranges
}
const asText = (v: Version): string | undefined => v.kind === 'text' ? v.text : v.kind === 'base' ? v.text ?? '' : v.kind === 'deleted' ? '' : undefined
type Carried = { baseline: Baseline; lead: string }
type CarriedLookup = (participant: string) => Carried | undefined
/** A pass's memoized lookup; `current()` says whether every registry source it read is unchanged. */
type CarriedPass = CarriedLookup & { current(): boolean; refresh(): Promise<boolean> }

/** Private lead/worker and sibling comparisons belong to their workers room. */
function sameFamily(a: ParticipantMetadataSnapshot | undefined, b: ParticipantMetadataSnapshot | undefined, views: ParticipantView[]): boolean {
  const leadOf = (snap: ParticipantMetadataSnapshot | undefined) => {
    const proj = snap?.record?.proj
    return snap?.fenceValid && proj?.projectedFrom && snap.head.projectedFrom === proj.projectedFrom
      && snap.head.projectedBy === proj.projectedBy && acceptedGit(snap.record, views) !== 'updating'
      ? proj.projectedBy : undefined
  }
  const leadA = leadOf(a), leadB = leadOf(b)
  return !!leadA && (b?.name === leadA || leadB === leadA) || !!leadB && a?.name === leadB
}

async function boundedBaseline(dir: string, baseline: Baseline, path: string): Promise<BaselineRead> {
  try {
    const carried = baseline.untracked.get(path)
    const text = carried ? await readBoundedCheckoutText(baseline.dir, carried.sha, path) : await readBoundedHistoricalText(dir, baseline.sha, path)
    if (carried && text === undefined) throw new MissingBaseBlob(path)
    return text === undefined ? { kind: 'absent' } : { kind: 'available', text }
  } catch (error) { return { kind: 'unavailable', error: error instanceof Error ? error : new Error(String(error)) } }
}
const sideInput = (snap: ParticipantSnapshot, path: string): unknown => {
  const entry = snap.entries.get(path)
  return entry ? entry.state === 'held' && !entry.hash
    ? { change: entry.change, state: entry.state, held: entry.held }
    : { hash: entry.hash, state: entry.state, change: entry.change }
    : { committed: snap.head.base }
}

/** Contract results vary widely in size; bound bytes as well as entry overhead. */
export class ContractAnalysisCache {
  private entries = new Map<string, { value: ReturnType<typeof observedContractAnalysis>; bytes: number }>()
  private used = 0
  constructor(private readonly maxBytes = 4 * 1024 * 1024) {}
  get size(): number { return this.entries.size }
  get bytes(): number { return this.used }
  get(key: string): ReturnType<typeof observedContractAnalysis> | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key); this.entries.set(key, entry)
    return entry.value
  }
  set(key: string, value: ReturnType<typeof observedContractAnalysis>): void {
    this.delete(key)
    const bytes = Buffer.byteLength(JSON.stringify(value)) + key.length * 2 + 96
    if (bytes > this.maxBytes) return
    while (this.used + bytes > this.maxBytes || this.entries.size >= 1000) this.delete(this.entries.keys().next().value!)
    this.entries.set(key, { value, bytes }); this.used += bytes
  }
  private delete(key: string): void {
    const entry = this.entries.get(key)
    if (entry) { this.used -= entry.bytes; this.entries.delete(key) }
  }
  clear(): void { this.entries.clear(); this.used = 0 }
}

/** Reconciles one owner's slots against all other comparable bases. */
export class ConflictSet {
  private static readonly MAX_PAIR_FILES = 2000
  private fileWork = 0
  private readonly slots: ConflictSlots
  private readonly stops: (() => void)[] = []
  private timer: NodeJS.Timeout | undefined
  private tick: NodeJS.Timeout | undefined
  private running: Promise<void> | undefined
  private rerun = false
  private started = false
  private stopped = false
  private inputCheck?: NodeJS.Immediate
  private scheduledInputs = ''
  private starts: number[] = []
  private readonly contractCache = new ContractAnalysisCache()
  private readonly seenPublications = new Set<string>()
  private guard: (() => boolean) | undefined
  private carriedValues = new Map<string, Carried | undefined>()
  private freshStorage?: () => Promise<boolean>
  constructor(private readonly team: Session, private readonly owner = team.me.name, private readonly notices: Session = team,
    private readonly log: (line: string) => void = line => process.stderr.write(`room-mcp: ${line}\n`), private readonly debounceMs = 2000,
    private readonly carriedFrom?: CarriedLookup,
    private readonly localWorker: (name: string) => Promise<TrustedLandedWorker | undefined> = async name => {
      const registry = await registryForDir(team.dir)
      const trusted = await registry.trusted({ participant: team.me.name, room: team.roomName, dir: team.dir }, name)
      if (!trusted || trusted.record.name !== name) return undefined
      const run = trusted.status.run
      return { id: trusted.record.id, status: trusted.status.status, dir: fs.realpathSync(trusted.record.dir),
        run: run ? `${run.n}:${run.nonce}` : '', seq: trusted.record.seq }
    },
    private readonly workerState: (id: string) => LandedWorkerState | undefined | Promise<LandedWorkerState | undefined> = async id => {
      const registry = await openWorkerReader(team.dir)
      return registry.freshness(id)
    },
    private readonly claimText: typeof workerText = workerText) {
    const fence = () => team.lease?.fence() ?? ''
    this.slots = new ConflictSlots(team.room, fence, Date.now, () => this.guard?.() ?? false, names => {
      return names.map(name => {
        const workerId = conflictWorkerId(team.room, name)
        return { name, ...(workerId ? { workerId } : {}) }
      })
    })
  }

  start(): void {
    this.started = true
    this.scheduledInputs = this.inputsKey()
    const schedule = () => {
      // Revocation stays synchronous; expensive scheduling is once per event-loop turn.
      this.withdrawEndedConflicts()
      if (this.inputCheck || this.stopped) return
      this.inputCheck = setImmediate(() => {
        this.inputCheck = undefined
        if (this.stopped) return
        const inputs = this.inputsKey()
        if (inputs === this.scheduledInputs) return
        this.scheduledInputs = inputs
        if (this.running) this.rerun = true
        else this.schedule()
      })
    }
    if (this.team.graph) this.stops.push(this.team.graph.onChange(schedule))
    for (const map of [this.team.room.manifest, this.team.room.manifestHead,
      this.team.room.claims, this.team.room.graphs, this.team.room.workerViews, this.team.room.expiry,
      this.team.room.doc.getMap('completedPublications'), this.team.room.doc.getMap('completedPublicationRevisions')]) {
      map.observeDeep(schedule)
      this.stops.push(() => map.unobserveDeep(schedule))
    }
    const onParticipant = (event: { keysChanged: Set<string> }) => {
      if ([...event.keysChanged].some(key => ['id', 'holder', 'git', 'proj'].includes(key.slice(key.lastIndexOf('\0') + 1)))) schedule()
    }
    const onMeta = (event: { keysChanged: Set<string> }) => { if (event.keysChanged.has('roomSalt')) schedule() }
    this.team.room.participants.observe(onParticipant)
    this.team.room.metaMap.observe(onMeta)
    this.team.awareness.on?.('change', schedule)
    this.stops.push(() => this.team.room.participants.unobserve(onParticipant),
      () => this.team.room.metaMap.unobserve(onMeta), () => this.team.awareness.off?.('change', schedule))
    const onSync = () => this.schedule(0)
    this.team.provider.on?.('sync', onSync)
    this.stops.push(() => this.team.provider.off?.('sync', onSync))
    this.schedulePeriodic()
    if (this.team.provider.synced) this.schedule(0)
  }

  /**
   * Every participant view is a peer, as before, except a worker that has been retired: an offline
   * participant's claims and published work still stand, a retired worker's do not.
   */
  private peerCurrent(view: ParticipantView | undefined, retired = new Set(this.team.room.retiredWorkers().map(worker => worker.id))): boolean {
    if (!view) return false
    const id = view.holder?.workerId ?? participantRecord(this.team.room, view.name)?.proj?.projectedFrom ?? this.team.room.workerViewOf(view.name)?.id
    return !(id && retired.has(id))
  }

  private peers(views: ParticipantView[]) {
    const retired = new Set(this.team.room.retiredWorkers().map(worker => worker.id))
    return neighbours(views.filter(view => this.peerCurrent(view, retired)), this.owner)
  }

  /**
   * One check pass's carried-baseline lookup: each participant's registry facts are read at most once per
   * pass. The immutable facts carry a revision, revalidated asynchronously before settlement.
   * Synchronous publication guards use that supplied snapshot and observed invalidation only:
   * a carried baseline replaced during an awaited comparison makes the pass stale, never published.
   */
  private async carriedPass(): Promise<CarriedPass> {
    const reader = await openWorkerReader(this.team.dir)
    const names = new Set([this.owner, ...this.peers(participantsView(this.team.room, this.team.awareness, Date.now())).names()])
    const tokens = new Map<string, string>(), records = new Map<string, Awaited<ReturnType<typeof reader.reserved>>>()
    const tagOf = (participant: string) => {
      const plus = participant.lastIndexOf('+')
      return plus > 0 ? participant.slice(plus + 1) : undefined
    }
    for (const name of names) {
      const tag = tagOf(name)
      if (!tag || tokens.has(tag)) continue
      // Capture the revision before any lookup can schedule work or yield to Git.
      tokens.set(tag, await reader.sourceToken(tag))
      if (!this.carriedFrom) records.set(tag, await reader.reserved(tag))
    }
    const memo = new Map<string, Carried | undefined>()
    this.carriedValues = memo
    let valid = true
    const lookup = (participant: string) => {
      if (!memo.has(participant)) {
        const tag = tagOf(participant), record = tag ? records.get(tag) : undefined
        const baseline = record?.name === participant && !['retired', 'abandoned'].includes(record.phase) ? workerBaseline(record) : undefined
        memo.set(participant, this.carriedFrom ? this.carriedFrom(participant)
          : baseline && record ? { baseline, lead: record.lead.participant } : undefined)
      }
      return memo.get(participant)
    }
    return Object.assign(lookup, { current: () => valid, refresh: async () => {
      if (!valid) return false
      for (const participant of memo.keys()) {
        const tag = tagOf(participant)
        if (tag && (!tokens.has(tag) || await reader.sourceToken(tag) !== tokens.get(tag))) { valid = false; break }
      }
      return valid
    } })
  }

  /** Pair facts, excluding publication clocks, unrelated edits, and display-only graph edges. */
  private pairInputs(other: string, views: ParticipantView[], carriedOf: CarriedLookup): string {
    const room = this.team.room
    const mine = snapshotMetadata(room, this.owner, views), theirs = snapshotMetadata(room, other, views)
    const claims = room.openClaims().filter(c => c.by === this.owner || c.by === other)
    const graph = room.graphs.get(other)
    const worker = room.workerViewOf(other)
    const contracts = !!graph?.observed?.length
    // Different bases can hide committed overlaps; carried providers also need full consumer facts.
    const own = carriedOf(this.owner)
    const carried = own?.lead === other ? own.baseline : undefined
    const all = mine?.head.base !== theirs?.head.base || !!carried && carriesWork(carried) || contracts
    const paths = new Set<string>()
    for (const path of mine?.entries.keys() ?? []) if (all || theirs?.entries.has(path) || claims.some(c => coversPath(c.path, path))) paths.add(path)
    for (const path of theirs?.entries.keys() ?? []) if (all || mine?.entries.has(path) || claims.some(c => coversPath(c.path, path))) paths.add(path)
    for (const claim of claims) if (!claim.path.endsWith('/')) paths.add(claim.path)
    const metadata = (snap: ReturnType<typeof snapshotMetadata>): unknown => {
      if (!snap) return undefined
      const { rev: _rev, semRev: _semRev, scannedAt: _scannedAt, ...head } = snap.head
      const record = snap.record
      const publisher = head.publisher ? snapshotMetadata(room, head.publisher, views) : undefined
      const publisherFacts = publisher ? [metadata({ ...publisher, head: { ...publisher.head, publisher: undefined } }),
        [...publisher.entries].sort(([a], [b]) => a.localeCompare(b))] : undefined
      return [head, record?.id, record?.holder, record?.git, record?.proj, snap.fenceValid, publisherFacts]
    }
    const entries = (snap: ReturnType<typeof snapshotMetadata>) => [...paths].sort().map(path => {
      const entry = snap?.entries.get(path)
      return [path, entry ? [entry.change, entry.state, entry.hash, entry.held, entry.fence,
        claims.some(c => coversPath(c.path, path)) ? entry.at : undefined] : undefined]
    })
    const graphFacts = contracts ? [graph?.base, graph?.status, graph?.sourceFence,
      graph?.sourceRev === theirs?.head.rev, graph?.truncated, graph?.observedTruncated, graph?.observed, graph?.uncoveredPaths, graph?.uncoveredTruncated] : undefined
    return hash(JSON.stringify([this.peerCurrent(views.find(view => view.name === other)), metadata(mine), metadata(theirs), room.roomSalt, claims, entries(mine), entries(theirs), graphFacts,
      worker ? [worker.id, worker.lead, worker.status, worker.run] : undefined,
      contracts || carried && carriesWork(carried) ? this.team.graph?.resolutionRevision : undefined,
      carried ? [carried.sha, carried.carriedCommit, [...carried.untracked]] : undefined,
      carriedOf(other)?.baseline.sha]))
  }

  private inputsKey(): string {
    const carriedOf: CarriedLookup = participant => this.carriedValues.get(participant)
    const room = this.team.room, views = participantsView(room, this.team.awareness, Date.now())
    const names = this.peers(views).names().filter(name => this.owner === this.team.me.name || name !== this.team.me.name)
    return JSON.stringify([this.team.lease?.fence(), names.map(name => [name, this.pairInputs(name, views, carriedOf)]),
      room.openClaims().filter(c => c.by === this.owner),
      [...room.workerViews.values()].filter(w => w.lead === this.owner).map(w => [w.id, w.status, w.run])])
  }

  /** Every destructive decision uses the shared positive-evidence rule. */
  private withdrawEndedConflicts(): void {
    if (!this.team.lease?.fence()) return
    const room = this.team.room, owned = this.slots.owned(this.owner)
    const views = participantsView(room, this.team.awareness, Date.now())
    const withdrawnParticipants = new Set<string>()
    const present = new Set(views.map(view => view.name))
    for (const name of this.seenPublications) if (!present.has(name)) {
      withdrawnParticipants.add(name); this.seenPublications.delete(name)
    }
    for (const view of views) if (snapshotMetadata(room, view.name, views)?.fenceValid) this.seenPublications.add(view.name)
    this.slots.drop(owned.map(([key]) => key), { withdrawnParticipants })
    const contracts = owned.filter(([key, slot]) => slot.kind === 'contract' && this.slots.get(key))
    if (!contracts.length) return
    const stale = new Set<string>()
    const peers = new Map<string, ReturnType<typeof snapshotMetadata>>()
    for (const [, slot] of contracts) {
      if (!peers.has(slot.other)) peers.set(slot.other, snapshotMetadata(room, slot.other, views))
      const theirs = peers.get(slot.other), graph = room.graphs.get(slot.other)
      if (!theirs?.fenceValid || !theirs.head.complete || theirs.head.coverage.kind !== 'all' || !graph ||
          graph.status !== 'ready' || graph.sourceFence !== theirs.head.fence || graph.sourceRev !== theirs.head.rev) stale.add(slot.other)
    }
    for (const other of stale) this.slots.markContractsUnknown(this.owner, other, 'provider graph or manifest coverage is updating')
  }
  private contractPathAuthorized(snap: Pick<ParticipantSnapshot, 'head' | 'fenceValid' | 'entries'> | undefined, path: string): boolean {
    const room = this.team.room
    const head = snap?.head
    if (!snap?.fenceValid || !head || !room.roomSalt) return false
    const textAllowed = head.level === 'full' || head.level === 'declared' &&
      (head.textPrefixes ?? []).some(prefix => containsPath(prefix, path))
    const entry = snap.entries.get(path)
    return textAllowed && (!entry || entry.state === 'shared' && (entry.change === 'D' ? !entry.hash : !!entry.hash) && entry.fence === head.fence) &&
      !head.excluded.includes(digestPath(room.roomSalt, path))
  }
  private unknownContracts(other: string, why: string): void {
    this.withdrawEndedConflicts()
    this.slots.markContractsUnknown(this.owner, other, why)
  }
  stop(): void {
    this.stopped = true
    this.contractCache.clear()
    clearImmediate(this.inputCheck)
    for (const stop of this.stops) stop()
    this.stops.length = 0
    if (this.timer) clearTimeout(this.timer)
    if (this.tick) clearTimeout(this.tick)
  }
  private schedulePeriodic(): void {
    if (!this.started || this.stopped) return
    this.tick = setTimeout(() => { this.tick = undefined; this.schedule(0) }, 60_000)
    this.tick.unref?.()
  }
  private schedule(ms = this.debounceMs): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.reconcile('change').catch(e => this.log(`conflict reconcile: ${String(e)}`)) }, ms)
    this.timer.unref?.()
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    await this.reconcile('flush')
  }
  async reconcile(reason: string): Promise<void> {
    if (this.stopped) return
    if (this.running) { await this.running; return }
    if (this.tick) { clearTimeout(this.tick); this.tick = undefined }
    this.running = (async () => {
      // At most two checks per turn. A continuing stream gets one coalesced future pass,
      // never a recursive chain that keeps flush/tools alive indefinitely.
      for (let attempt = 0; attempt < 2 && !this.stopped; attempt++) {
        this.rerun = false
        try { await this.run(reason) }
        catch (e) { if (!(e instanceof StaleConflictInputs)) throw e; this.rerun = true }
        finally { this.freshStorage = undefined; this.guard = undefined }
        if (!this.rerun) return
        if (attempt === 0) await new Promise<void>(resolve => setImmediate(resolve))
      }
      if (!this.stopped) this.log(`conflicts ${this.owner}: inputs moved twice; coalesced next check`)
    })()
    try { await this.running } finally { this.running = undefined; this.schedulePeriodic() }
    if (this.rerun && !this.stopped) { this.rerun = false; this.schedule() }
  }

  private async settle(key: string, result: Evaluation): Promise<ConflictSlot> {
    if (this.freshStorage && !await this.freshStorage()) throw new StaleConflictInputs()
    if (this.guard && !this.guard()) throw new StaleConflictInputs()
    return this.slots.settle(key, result)
  }

  private async drop(key: string | readonly string[], evidence: ConflictEndEvidence = {}): Promise<void> {
    if (this.freshStorage && !await this.freshStorage()) throw new StaleConflictInputs()
    if (this.guard && !this.guard()) throw new StaleConflictInputs()
    this.slots.drop(key, evidence)
  }

  private async read(snap: ParticipantSnapshot, path: string): Promise<Version> {
    const env = { gitAt: (sha: string, p: string) => readBoundedHistoricalText(this.team.dir, sha, p),
      known: async (blob: string) => readBoundedCheckoutText(this.team.dir, blob, path, 'utf8', false).catch(() => undefined) }
    const projected = snap.name === this.owner && snap.head.projectedFrom && this.notices.room !== this.team.room
    const projectedEntry = snap.entries.get(path)
    if (projected && projectedEntry?.state === 'held' && projectedEntry.hash) {
      await new Promise<void>(resolve => setImmediate(resolve))
      const source = snapshotPath(this.notices.room, this.owner, participantsView(this.notices.room, this.notices.awareness, Date.now()), path)
      if (source?.fenceValid && source.record?.holder?.workerId === snap.head.projectedFrom &&
          source.entries.get(path)?.hash === projectedEntry.hash) {
        const resolved = await versionOf(source, path, env)
        if (resolved.kind === 'text') {
          const priorGuard = this.guard
          this.guard = () => !!priorGuard?.() && snapshotStillCurrent(this.notices.room, source, participantsView(this.notices.room, this.notices.awareness, Date.now()))
          return { kind: 'text', text: resolved.text, entry: projectedEntry }
        }
      }
      const worker = await trustedWorker(this.notices, this.owner).catch(() => undefined)
      if (worker && worker.id === snap.head.projectedFrom) {
        try {
          const text = await workerText(worker.dir, path)
          if (text !== null && gitBlobHash(text, projectedEntry.hash.length === 64 ? 'sha256' : 'sha1') === projectedEntry.hash)
            return { kind: 'text', text, entry: projectedEntry }
        } catch { /* leave the version held */ }
      }
    }
    return versionOf(snap, path, env)
  }

  /** A filtered snapshot cannot turn a wrong-fenced raw entry into certified base. */
  private async readableConsumer(snap: ParticipantSnapshot, path: string): Promise<string | undefined> {
    if (!this.contractPathAuthorized(snap, path) || !snap.head.complete || snap.head.coverage.kind !== 'all') return undefined
    if (!snap.roomSalt || snap.head.excluded.includes(digestPath(snap.roomSalt, path))) return undefined
    const raw = this.team.room.manifest.get(manifestKey(snap.name, snap.head.fence))?.get(path)
    if (raw && raw.fence !== snap.head.fence) return undefined
    const version = await this.read(snap, path)
    if (raw && !snap.entries.has(path)) return undefined
    return asText(version)
  }

  /** Authorized but stale consumer text leaves an existing episode unknown. */
  private async priorConsumersReadable(key: string, mine: ParticipantSnapshot): Promise<boolean> {
    const prior = this.slots.get(key)
    if (!prior || prior.settled === 'none') return true
    for (const path of prior.consumers ?? []) if (await this.readableConsumer(mine, path) === undefined) return false
    return true
  }

  private async unknownConsumer(key: string, slot: ConflictSlot): Promise<void> {
    const why = 'consumer version is not readable'
    await this.settle(key, { ...slot, status: 'unknown', inputs: hash(`${key}\0${why}`), why })
  }

  private async run(reason: string): Promise<void> {
    const carriedOf = await this.carriedPass()
    const baselineFor = (owner: string, other: string, ancestor: string) => {
      const ours = carriedOf(owner), theirs = carriedOf(other)
      return pairBaseline(ours?.lead === other ? ours.baseline : undefined,
        theirs?.lead === owner ? theirs.baseline : undefined, ancestor,
        (base, sha) => git(this.team.dir, ['merge-base', '--is-ancestor', base, sha]).then(() => true, () => false))
    }
    this.freshStorage = carriedOf.refresh
    this.fileWork = 0
    const room = this.team.room
    const leaseFence = this.team.lease?.fence()
    if (!leaseFence) return
    // Old data cannot seed settled evidence or input/backoff caches, even before inputs arrive.
    const obsolete = this.slots.owned(this.owner).filter(([, slot]) => !hasConflictIdentity(slot)).map(([key]) => key)
    if (obsolete.length) this.slots.drop(obsolete)
    await this.releaseLandedWorkerClaims(leaseFence)
    this.withdrawEndedConflicts()
    const views = participantsView(room, this.team.awareness, Date.now())
    const mine = snapshot(room, this.owner, views)
    if (!mine || mine.head.fence !== leaseFence) return
    const ownNonPublisher = mine.head.coverage.kind === 'none' && mine.head.coverage.reason === 'not-publisher' && !!mine.head.publisher
    const ownPublisher = ownNonPublisher ? snapshot(room, mine.head.publisher!, views) : undefined
    const ownGit = acceptedGit(participantRecord(room, ownNonPublisher ? mine.head.publisher! : this.owner), views)
    if (ownGit === 'updating' || (ownNonPublisher && !ownPublisher)) return
    const authority = () => !this.stopped && this.team.lease?.fence() === leaseFence
    const claimInputs = JSON.stringify(room.openClaims().filter(c => c.by === this.owner))
    this.guard = () => authority() && carriedOf.current() && snapshotStillCurrent(room, mine, participantsView(room, this.team.awareness, Date.now())) &&
      (!ownPublisher || snapshotStillCurrent(room, ownPublisher, participantsView(room, this.team.awareness, Date.now()))) &&
      JSON.stringify(room.openClaims().filter(c => c.by === this.owner)) === claimInputs
    const nb = this.peers(views)
    const names = new Set(nb.names())
    if (!await carriedOf.refresh()) throw new StaleConflictInputs()
    const family = (other: string) => sameFamily(mine, snapshotMetadata(room, other, views), views)
    // Not being a neighbour is unknown during recovery, never a clearance.
    await this.drop(this.slots.owned(this.owner).map(([key]) => key))
    names.delete(this.owner)
    for (const other of names) if (family(other)) names.delete(other)
    const capturedPairs = new Map([...names].map(name => [name, this.pairInputs(name, views, carriedOf)]))
    for (const other of [...names].sort()) {
      const pairInputs = capturedPairs.get(other)!
      if (!await carriedOf.refresh() || this.pairInputs(other, participantsView(room, this.team.awareness, Date.now()), carriedOf) !== pairInputs) throw new StaleConflictInputs()
      const results = new Map<string, Evaluation>()
      const evaluate = async (key: string, result: Evaluation) => {
        if (this.freshStorage && !await this.freshStorage() || !this.guard?.()) throw new StaleConflictInputs()
        results.set(key, result)
      }
      const diagnose = async (result: Evaluation) => {
        if (this.freshStorage && !await this.freshStorage() || !this.guard?.()) throw new StaleConflictInputs()
        await this.slots.diagnosePair(result, carriedOf.refresh)
      }
      try {
        const theirs = snapshot(room, other, views)
        const theirGit = acceptedGit(theirs?.record ?? participantRecord(room, other), views)
        this.guard = () => !this.stopped && authority() && carriedOf.current() && this.pairInputs(other,
          participantsView(room, this.team.awareness, Date.now()), carriedOf) === pairInputs
        const existing = this.slots.owned(this.owner).filter(([, s]) => s.other === other)
        if (ownNonPublisher) {
          const pair = !theirs || theirGit === 'updating' ? undefined : await comparePair(this.team.dir, ownGit.remote ?? theirGit.remote, ownGit, theirGit)
          if (pair && !('cannotCompare' in pair)) {
            const committed = await git(this.team.dir, ['diff', '--no-renames', '--name-only', '-z', `${pair.mergeBase}..${ownGit.base}`])
            await this.claims(ownPublisher!, theirs!, other, pair.mergeBase,
              new Set([...ownPublisher!.entries.keys(), ...committed.split('\0').filter(Boolean)]),
              await baselineFor(ownPublisher!.name, theirs!.name, pair.mergeBase))
          }
          continue // only the checkout publisher owns the merge pair
        }
        if (theirs?.head.coverage.kind === 'none' && theirs.head.coverage.reason === 'not-publisher' && theirs.head.publisher) {
          const published = snapshot(room, theirs.head.publisher, views)
          const publishedGit = acceptedGit(participantRecord(room, theirs.head.publisher), views)
          if (published && publishedGit !== 'updating') {
            const priorGuard = this.guard
            this.guard = () => !!priorGuard?.() && snapshotStillCurrent(room, published, participantsView(room, this.team.awareness, Date.now()))
            const pair = await comparePair(this.team.dir, ownGit.remote ?? publishedGit.remote, ownGit, publishedGit)
            if (!('cannotCompare' in pair)) {
              const committed = await git(this.team.dir, ['diff', '--no-renames', '--name-only', '-z', `${pair.mergeBase}..${ownGit.base}`])
              await this.claims(mine, published, other, pair.mergeBase, new Set([...mine.entries.keys(), ...committed.split('\0').filter(Boolean)]),
                await baselineFor(mine.name, published.name, pair.mergeBase))
            }
          }
          continue // a non-publisher contributes claims, never a merge pair
        }
        if (!theirs || theirGit === 'updating') {
          const why = `${other}'s manifest or base is updating`
          await diagnose({ owner: this.owner, other, kind: 'merge', path: '*', status: 'unknown', inputs: hash(why), factId: '', why })
          for (const [key, slot] of existing) if (slot.kind !== 'merge' && slot.kind !== 'contract') await this.settle(key, { ...slot, status: 'unknown', inputs: hash(`${slot.inputs}\0${why}`), why })
          this.unknownContracts(other, why)
          continue
        }
        const retrySource = pairInputs
        if (existing.some(([, slot]) => hasConflictIdentity(slot) && slot.kind === 'merge' && slot.path === '*' && slot.status === 'unknown' && slot.retrySource === retrySource && (slot.retryAt ?? 0) > Date.now())) continue
        const pair = await comparePair(this.team.dir, ownGit.remote ?? theirGit.remote, ownGit, theirGit)
        if ('cannotCompare' in pair || !mine.head.complete || !theirs.head.complete || mine.head.coverage.kind !== 'all' || theirs.head.coverage.kind !== 'all' || !mine.fenceValid || !theirs.fenceValid || !mine.roomSalt || !theirs.roomSalt) {
          const why = 'cannotCompare' in pair ? pair.cannotCompare : 'manifest is incomplete or fenced out'
          await diagnose({ owner: this.owner, other, kind: 'merge', path: '*', status: 'unknown', inputs: hash(JSON.stringify([ownGit, theirGit, mine.head.semRev, theirs.head.semRev, why])), retrySource, factId: '', why })
          for (const [existingKey, slot] of existing) if (slot.kind !== 'merge' && slot.kind !== 'contract') await this.settle(existingKey, { ...slot, status: 'unknown', inputs: hash(`${slot.inputs}\0${why}`), why })
          this.unknownContracts(other, why)
          continue
        }
        await this.contracts(other, new Set([...mine.entries.keys(), ...room.openClaims().filter(c => c.by === this.owner).map(c => c.path)]), mine, theirs, carriedOf)
        // Delivered/carried edits belong to the lead only in that worker's own lead pair.
        // Other pairs may share inherited blobs, but only with ancestry proved on both sides.
        const ours = carriedOf(this.owner), theirsCarried = carriedOf(other)
        const leadPair = ours?.lead === other || theirsCarried?.lead === this.owner
        const descends = (sha: string) => sha === pair.mergeBase || git(this.team.dir, ['merge-base', '--is-ancestor', pair.mergeBase, sha]).then(() => true, () => false)
        const baseline = await baselineFor(this.owner, other, pair.mergeBase)
        const sharedBaselines = !leadPair && ours && theirsCarried &&
          (await Promise.all([descends(ours.baseline.sha), descends(theirsCarried.baseline.sha)])).every(Boolean)
          ? [ours.baseline, theirsCarried.baseline] : undefined
        // Worker publications stay pinned to their recorded bases even after Git
        // merges. A common HEAD ancestor proves adoption on both branches; it may
        // advance the ancestor only past both recorded baselines. Private kept or
        // carried snapshots not in that history retain their existing rules.
        let sharedHead: string | undefined
        if (sharedBaselines && (ownGit.head !== ownGit.base || theirGit.head !== theirGit.base)) {
          try {
            const common = (await git(this.team.dir, ['merge-base', ownGit.head, theirGit.head])).trim()
            if (common !== pair.mergeBase && (await Promise.all(sharedBaselines.map(base =>
              git(this.team.dir, ['merge-base', '--is-ancestor', base.sha, common]).then(() => true, () => false)))).every(Boolean)) sharedHead = common
          } catch { /* missing HEAD history cannot prove adoption */ }
        }
        const mergeBase = baseline?.sha ?? sharedHead ?? pair.mergeBase
        const changed = async (snap: ParticipantSnapshot, base: string) => {
          try {
            const committed = await git(this.team.dir, ['diff', '--no-renames', '--name-only', '-z', `${mergeBase}..${base}`])
            // The ordinary lead has no Git deletion or manifest entry after deleting a
            // carried untracked file. Include that baseline's paths on the lead side;
            // current reads still decide whether either version actually conflicts.
            const carriedLead = ours?.lead === other ? other : theirsCarried?.lead === this.owner ? this.owner : undefined
            return new Set([...snap.entries.keys(), ...committed.split('\0').filter(Boolean),
              ...(snap.name === carriedLead ? baseline?.untracked.keys() ?? [] : [])])
          } catch { return undefined }
        }
        const [aPaths, bPaths] = await Promise.all([changed(mine, ownGit.base), changed(theirs, theirGit.base)])
        if (!aPaths || !bPaths) {
          await diagnose({ owner: this.owner, other, kind: 'merge', path: '*', status: 'unknown', inputs: retrySource, retrySource, factId: '', why: 'cannot enumerate changed paths' })
          continue
        }
        if (aPaths.size + bPaths.size > ConflictSet.MAX_PAIR_FILES) {
          const why = 'too many changed paths to compare'
          await diagnose({ owner: this.owner, other, kind: 'merge', path: '*', status: 'unknown', inputs: hash(`${retrySource}\0${why}`), retrySource, factId: '', why })
          await this.claims(mine, theirs, other, mergeBase, aPaths, baseline)
          continue
        }
        const ownMergePaths = new Set(aPaths)
        const unchangedCarried = new Set<string>()
        // Reuse carried blob results within this pair's pass, including failed
        // reads. Tracked ancestors already use the historical-text cache.
        const ancestors = new Map<string, BaselineRead>()
        const carried = ours
        if (carried?.lead === other && carriesWork(carried.baseline)) {
          for (const path of aPaths) {
            await this.fileTurn()
            const ancestor = await boundedBaseline(this.team.dir, carried.baseline, path)
            if (baseline === carried.baseline && baseline.untracked.has(path)) ancestors.set(path, ancestor)
            if (ancestor.kind === 'unavailable') continue
            let ownText: string | undefined
            try { ownText = asText(await this.read(mine, path)) }
            catch (error) { if (error instanceof StaleConflictInputs) throw error; continue }
            if (ownText !== undefined && ownText === (ancestor.kind === 'absent' ? '' : ancestor.text)) {
              ownMergePaths.delete(path)
              unchangedCarried.add(path)
            }
          }
        }
        const candidates = new Set([...ownMergePaths].filter(p => bPaths.has(p)))
        for (const [, slot] of existing) if (slot.kind === 'merge' && slot.path !== '*') candidates.add(slot.path)
        // Batch blob metadata once per side; never read whole file text to prove identity.
        const sharedPaths = new Set<string>()
        if (sharedBaselines) {
          try {
            const [aBase, bBase] = sharedBaselines
            const [aInfo, bInfo] = await Promise.all([gitBlobInfoMany(this.team.dir, aBase.sha, candidates), gitBlobInfoMany(this.team.dir, bBase.sha, candidates)])
            for (const path of candidates) {
              // The newer common commit owns tracked history. Untracked carry
              // still needs its full recorded ancestor outside that history.
              if (sharedHead && !aBase.untracked.has(path) && !bBase.untracked.has(path)) continue
              const aHash = aBase.untracked.get(path)?.sha ?? aInfo.get(path)?.hash
              const bHash = bBase.untracked.get(path)?.sha ?? bInfo.get(path)?.hash
              if (aHash && aHash === bHash) sharedPaths.add(path)
            }
          } catch { /* unavailable proof: use the Git ancestor */ }
        }
        for (const path of [...candidates].sort()) {
          await this.fileTurn()
          const key = slotKey(this.owner, 'merge', other, path)
          const bothChanged = ownMergePaths.has(path) && bPaths.has(path)
          const sharedBase = sharedPaths.has(path) ? sharedBaselines![0] : undefined
          const inputs = hash(JSON.stringify([ownGit.base, theirGit.base, mergeBase, ownGit.anchored, theirGit.anchored,
            mine.head.semRev, theirs.head.semRev, sideInput(mine, path), sideInput(theirs, path),
            baseline ? [baseline.sha, baseline.untracked.get(path)?.sha] : undefined,
            sharedBase ? sharedBaselines!.map(base => [base.sha, base.untracked.get(path)?.sha]) : undefined,
            carried?.lead === other ? [carried.baseline.sha, unchangedCarried.has(path)] : undefined]))
          const prior = this.slots.get(key)
          // Unknown slots retain retry state, never completed merge evidence.
          if (prior?.status === 'unknown' && prior.inputs === inputs && prior.fence === leaseFence && (prior.retryAt ?? 0) > Date.now()) continue
          const checkFile = async (): Promise<Evaluation> => {
            if (unchangedCarried.has(path)) {
              return { owner: this.owner, other, kind: 'merge', path, status: 'clean', inputs, factId: '' }
            }
            const read = (snap: ParticipantSnapshot) => this.read(snap, path)
            const [aRead, bRead] = await Promise.allSettled([read(mine), read(theirs)])
            // An arriving input wins over an unrelated failure in the opposite read.
            for (const read of [aRead, bRead]) {
              if (read.status === 'rejected' && read.reason instanceof StaleConflictInputs
                || read.status === 'fulfilled' && read.value.kind === 'unknown'
                  && ['updating', 'no-record', 'not-publisher'].includes(read.value.why)) throw new StaleConflictInputs()
            }
            if (aRead.status === 'rejected') throw aRead.reason
            if (bRead.status === 'rejected') throw bRead.reason
            const a = aRead.value, b = bRead.value
            if (!bothChanged) {
              const unreadable = [a, b].find(v => v.kind === 'excluded' || v.kind === 'unknown')
              return { owner: this.owner, other, kind: 'merge', path,
                status: unreadable ? 'unknown' : 'clean', inputs, factId: '', ...(unreadable ? { why: 'cannot certify unchanged path' } : {}) }
            }
            const at = asText(a), bt = asText(b)
            if (at === undefined || bt === undefined) {
              // Unreadable changed versions are possible conflicts, with or without hashes.
              // Excluded, updating and binary versions keep their existing gap handling.
              const gap = [a, b].some(v => v.kind === 'excluded'
                || v.kind === 'unknown' && !['fetch', 'no-base-text', 'too-large'].includes(v.why)
                || v.kind === 'held' && v.entry.held === 'binary' && !!v.entry.hash)
              const aEntry = mine.entries.get(path), bEntry = theirs.entries.get(path)
              if (!gap && aEntry?.hash && aEntry.hash === bEntry?.hash) {
                return { owner: this.owner, other, kind: 'merge', path, status: 'clean', inputs, factId: '' }
              } else if (!gap) {
                const unreadableBy = [at === undefined ? this.owner : '', bt === undefined ? other : ''].filter(Boolean).join(' and ')
                return { owner: this.owner, other, kind: 'merge', path, status: 'possible', inputs,
                  incomplete: ![a, b].some(value => value.kind === 'held' && value.entry.held === 'scope')
                    && [a, b].some(value => value.kind === 'unknown' || value.kind === 'held'),
                  factId: hash(['possible', path, mergeBase, aEntry?.change ?? 'committed', bEntry?.change ?? 'committed'].join('\0')), why: unreadableBy }
              } else {
                return { owner: this.owner, other, kind: 'merge', path, status: 'unknown', inputs, factId: '', why: `cannot read ${at === undefined ? this.owner : other}'s version` }
              }
            }
            // Identical peer copies are a clean merge, including additions. Keep them silent like any
            // other clean pair; closed results are not retained.
            if (at === bt) {
              return { owner: this.owner, other, kind: 'merge', path, status: 'clean', inputs, factId: '' }
            }
            let ancestor: string | undefined
            try {
              if (sharedBase || baseline) {
                const read = (!sharedBase ? ancestors.get(path) : undefined) ?? await boundedBaseline(this.team.dir, (sharedBase ?? baseline)!, path)
                if (!sharedBase && baseline?.untracked.has(path)) ancestors.set(path, read)
                if (read.kind === 'unavailable') throw read.error
                ancestor = read.kind === 'available' ? read.text : undefined
              } else ancestor = await readBoundedHistoricalText(this.team.dir, mergeBase, path)
            }
            catch { return { owner: this.owner, other, kind: 'merge', path, status: 'unknown', inputs, factId: '', why: 'missing merge base' } }
            if (ancestor === undefined) {
              // An add/add conflict has no base lines. Locate the first differing line in the new
              // versions rather than reporting the empty ancestor's line 1 for every copied file.
              const aLines = at.split('\n'), bLines = bt.split('\n')
              let line = 0
              while (aLines[line] === bLines[line]) line++
              return { owner: this.owner, other, kind: 'merge', path, status: 'conflict', inputs,
                factId: hash(JSON.stringify([mergeBase, 'add/add'])), lines: [line + 1] }
            }
            if (at === ancestor || bt === ancestor) {
              return { owner: this.owner, other, kind: 'merge', path, status: 'clean', inputs, factId: '', lines: [] }
            }
            await this.budget()
            const merged = await gitMergeFile(ancestor, at, bt, { ours: this.owner, base: 'base', theirs: other })
            const lines = merged.conflicts.map(c => c.from)
            return { owner: this.owner, other, kind: 'merge', path, status: lines.length ? 'conflict' : 'clean', inputs,
              factId: lines.length ? hash(JSON.stringify([mergeBase, ...merged.conflicts.map(c => c.o)])) : '', lines }
          }
          let result: Evaluation
          try { result = await checkFile() }
          catch (error) {
            if (error instanceof StaleConflictInputs) throw error
            result = { owner: this.owner, other, kind: 'merge', path, status: 'unknown', inputs, factId: '', why: 'file comparison failed' }
          }
          // Storage freshness and input guards are pair-wide, never file failures.
          await evaluate(key, result)
        }
        await this.slots.settlePair(this.owner, other, results, carriedOf.refresh)
        await this.claims(mine, theirs, other, mergeBase, ownMergePaths, baseline, ancestors)
      } finally {
        if (!await carriedOf.refresh() || !this.guard?.()) this.rerun = true
      }
    }
    this.log(`conflicts ${this.owner}: reconciled ${reason}`)
  }

  /** Retain resumable workers, but end their stale claims once all claimed files reached the lead. */
  private async releaseLandedWorkerClaims(leaseFence: string): Promise<void> {
    if (this.owner !== this.team.me.name) return
    const room = this.team.room
    const groups = new Map<string, ReturnType<RoomDoc['openClaims']>>()
    for (const claim of room.openClaims()) {
      if (claim.byKind === 'human') continue
      const list = groups.get(claim.by) ?? []
      list.push(claim); groups.set(claim.by, list)
    }
    for (const [name, claims] of groups) {
      const holder = JSON.stringify(participantRecord(room, name)?.holder)
      if (!holder) continue
      const worker = await this.localWorker(name)
      if (worker?.status !== 'done' || !worker.run || !claims.length) continue
      const initial = await this.workerState(worker.id)
      if (!initial || initial.id !== worker.id || initial.name && initial.name !== name ||
          initial.lead && initial.lead !== this.owner || initial.dir && !samePath(initial.dir, worker.dir) ||
          initial.run !== worker.run || initial.seq !== worker.seq || initial.busy ||
          JSON.stringify(participantRecord(room, name)?.holder) !== holder) continue
      const currentClaims = () => room.openClaims().filter(claim => claim.by === name)
        .sort((a, b) => a.id.localeCompare(b.id))
      const claimSnapshot = JSON.stringify(currentClaims())
      if (claimSnapshot !== JSON.stringify([...claims].sort((a, b) => a.id.localeCompare(b.id)))) continue
      let landed = true
      for (const claim of claims) {
        try {
          const paths = claim.path.endsWith('/')
            ? new Set((await Promise.all([this.team.dir, worker.dir].map(dir => git(dir, ['ls-files', '-co', '--exclude-standard', '--', claim.path]))))
              .flatMap(output => output.split('\n').filter(Boolean)))
            : new Set([claim.path])
          if (paths.size > 2000) { landed = false; break }
          for (const path of paths) {
            const [leadText, finalText] = await Promise.all([this.claimText(this.team.dir, path), this.claimText(worker.dir, path)])
            if (leadText !== finalText) { landed = false; break }
          }
          if (!landed) break
        } catch { landed = false; break }
      }
      if (!landed) continue
      const latest = await this.workerState(worker.id)
      if (this.team.lease?.fence() !== leaseFence || !latest || latest.busy ||
          JSON.stringify(latest) !== JSON.stringify(initial) ||
          JSON.stringify(participantRecord(room, name)?.holder) !== holder ||
          JSON.stringify(currentClaims()) !== claimSnapshot) return
      room.doc.transact(() => { for (const claim of claims) room.removeClaim(claim.id) }, this.team.me)
      await this.team.post<NoteMsg>(ROOM, { type: 'note', to: this.owner, priority: 'fyi', text: `released ${name}'s claims: its changes are in your tree` },
        { id: `cf:${hash([this.owner, name, claims.map(c => c.id).sort().join(',')].join('\0'))}:landed`, auto: true })
    }
  }

  private async contracts(other: string, myPaths: Set<string>, mine: ParticipantSnapshot, theirs: ParticipantSnapshot, carriedOf: CarriedLookup): Promise<void> {
    this.withdrawEndedConflicts()
    const graph = this.team.room.graphs.get(other)
    const carried = carriedOf(this.owner)
    const carriedProvider = carried?.lead === other && carriesWork(carried.baseline)
    if (!carriedProvider && graph?.uncoveredTruncated) {
      this.unknownContracts(other, 'contract coverage gap list truncated')
      return
    }
    if (!carriedProvider && (!graph || graph.status !== 'ready' || graph.base !== theirs.head.base ||
        graph.sourceFence !== theirs.head.fence || graph.sourceRev !== theirs.head.rev || graph.observedTruncated || graph.truncated)) {
      this.unknownContracts(other, 'provider graph or manifest coverage is updating')
      return
    }
    const live = new Set<string>()
    const uncovered = new Set<string>()
    const unknownPath = async (path: string, why: string, inputs: string) => {
      uncovered.add(path)
      const key = slotKey(this.owner, 'contract', other, path, '*')
      live.add(key)
      await this.settle(key, { owner: this.owner, other, kind: 'contract', path, subject: '*', status: 'unknown', inputs, factId: '', why })
      // A coverage gap cannot certify that a previously reported symbol conflict disappeared.
      for (const [priorKey, slot] of this.slots.owned(this.owner)) if (slot.kind === 'contract' && slot.other === other && slot.path === path && priorKey !== key) {
        live.add(priorKey)
        await this.settle(priorKey, { ...slot, status: 'unknown', inputs, why })
      }
    }
    let changes = graph?.observed ?? []
    if (!carriedProvider) for (const path of graph?.uncoveredPaths ?? []) {
      if (!this.contractPathAuthorized(theirs, path)) continue
      await unknownPath(path, 'outside the contract analysis budget or not analysable', hash(JSON.stringify([graph?.sourceFence, graph?.sourceRev, path, 'uncovered'])))
    }
    if (carriedProvider) {
      const paths = new Set([...await carriedPaths(carried.baseline), ...theirs.entries.keys()])
      const observed: typeof changes = []
      for (const path of paths) {
        await this.fileTurn()
        if (!specForPath(path) || !this.contractPathAuthorized(theirs, path)) continue
        const before = await boundedBaseline(this.team.dir, carried.baseline, path)
        if (before.kind === 'unavailable') {
          const key = slotKey(this.owner, 'contract', other, path, '*')
          await unknownPath(path, before.error.message, hash(JSON.stringify([carried.baseline.sha, path, 'unavailable'])))
          const id = `cf:${hash(`${key}\0${carried.baseline.sha}`)}:degraded`
          if (this.freshStorage && !await this.freshStorage() || this.guard && !this.guard()) throw new StaleConflictInputs()
          const notice = await this.notices.post<NoteMsg>(ROOM, { type: 'note', to: this.owner, priority: 'notify',
            text: `contract coverage degraded for ${path}: carried baseline unavailable; changes in this file cannot be checked` }, { id, auto: true })
          if (!notice.ok) this.log(`contract coverage notice ${id}: ${notice.text}`)
          continue
        }
        const version = await versionOf(theirs, path, { gitAt: (sha, p) => readBoundedHistoricalText(this.team.dir, sha, p), known: blob => readBoundedCheckoutText(this.team.dir, blob, path, 'utf8', false).catch(() => undefined) })
        const after = asText(version)
        if (after === undefined) { this.unknownContracts(other, 'provider version is not readable'); return }
        const oldText = before.kind === 'absent' ? '' : before.text
        const cacheKey = hash(JSON.stringify([carried.baseline.sha, path, oldText, after]))
        let parsed = this.contractCache.get(cacheKey)
        if (!parsed) {
          const versions = await parseInWorker(path, [oldText, after])
          const preparsed = new Map([[oldText, versions[0]], [after, versions[1]]])
          parsed = observedContractAnalysis(oldText, after, path, (_path, text) => preparsed.get(text))
          if (!this.stopped) this.contractCache.set(cacheKey, parsed)
        }
        if (parsed.status === 'unavailable') {
          await unknownPath(path, parsed.detail, cacheKey)
          continue
        }
        observed.push(...parsed.changes.map(change => ({ path, ...change })))
      }
      changes = observed
    }
    for (const change of changes) {
      await this.fileTurn()
      if (uncovered.has(change.path)) continue
      if (change.kind === 'add') continue
      if (!this.contractPathAuthorized(theirs, change.path)) continue
      const provider = await this.read(theirs, change.path)
      const deleted = change.kind === 'delete' && provider.kind === 'deleted'
      if (!deleted && (asText(provider) === undefined || (!carriedProvider && provider.kind === 'base'))) {
        this.unknownContracts(other, 'provider version is not readable')
        return
      }
      const key = slotKey(this.owner, 'contract', other, change.path, change.symbol)
      const prior = this.slots.get(key)
      if (prior && !await this.priorConsumersReadable(key, mine)) {
        await this.unknownConsumer(key, prior)
        continue
      }
      const uses: string[] = []
      for (const path of myPaths) {
        await this.fileTurn()
        if (!this.contractPathAuthorized(mine, path)) continue
        const text = await this.readableConsumer(mine, path)
        if (text === undefined) { this.unknownContracts(other, 'consumer version is not readable'); return }
        if (text && await consumesSymbol(path, text, change.path, change.symbol, this.team.graph?.graph)) uses.push(path)
      }
      uses.sort()
      if (!uses.length) continue
      live.add(key)
      const input = hash(JSON.stringify([change, uses]))
      await this.settle(key, { owner: this.owner, other, kind: 'contract', path: change.path, subject: change.symbol,
        status: 'conflict', inputs: input, factId: hash(JSON.stringify([change.symbol, change.detail, change.kind])), why: change.detail, consumers: uses })
    }
    for (const [key, slot] of this.slots.owned(this.owner)) {
      if (slot.kind !== 'contract' || slot.other !== other || live.has(key)) continue
      if (!this.contractPathAuthorized(theirs, slot.path) || !slot.consumers?.every(path => this.contractPathAuthorized(mine, path))) {
        await this.drop(key)
        if (this.slots.get(key)) await this.settle(key, { ...slot, status: 'unknown', inputs: hash(`unknown-grant\0${key}`), why: 'provider or consumer grant is unknown' })
        continue
      }
      if (!await this.priorConsumersReadable(key, mine)) {
        await this.unknownConsumer(key, slot)
        continue
      }
      const provider = await this.read(theirs, slot.path)
      if (asText(provider) === undefined) {
        this.unknownContracts(other, 'provider version is not readable')
        return
      }
      await this.settle(key, { owner: this.owner, other, kind: 'contract', path: slot.path, subject: slot.subject,
        status: 'clean', inputs: hash(`clean\0${key}`), factId: '', consumers: slot.consumers })
    }
  }

  private async claims(mine: ParticipantSnapshot, theirs: ParticipantSnapshot, other: string, mergeBase: string, changed: Set<string>, baseline?: Baseline, ancestors?: ReadonlyMap<string, BaselineRead>): Promise<void> {
    const all = this.team.room.openClaims()
    const ownClaims = all.filter(c => c.by === this.owner)
    const peerClaims = all.filter(c => c.by === other)
    const priorClaims = this.slots.owned(this.owner).filter(([, slot]) => slot.other === other
      && (slot.kind === 'edit-in-claim' || slot.kind === 'claims'))
    // Finished-worker authority only matters when there is claim state to suppress or retire.
    const ownWorker = this.owner === this.team.me.name && (peerClaims.length > 0 || priorClaims.length > 0) ? await this.localWorker(other) : undefined
    const ownFinishedWorker = ownWorker?.status === 'done'
    const theirClaims = ownFinishedWorker ? [] : peerClaims
    if (ownFinishedWorker) for (const [key] of priorClaims) await this.drop(key, { ownWorker: { name: other, id: ownWorker.id, lead: this.owner, status: 'done' } })
    const seen = new Set<string>()
    const paths = new Set([
      ...theirClaims.flatMap(c => c.path.endsWith('/') ? [...changed].filter(path => claimsOverlap(c, { path, from: 1, to: Number.MAX_SAFE_INTEGER })) : [c.path]),
      ...this.slots.owned(this.owner).filter(([, s]) => s.other === other && s.kind === 'edit-in-claim').map(([, s]) => s.path),
    ])
    const read = (snap: ParticipantSnapshot, path: string) => this.read(snap, path)
    for (const path of paths) {
      await this.fileTurn()
      if (path.endsWith('/')) continue
      // One semantic overlap per peer and path. Claim renewal/replacement changes the inputs,
      // not the opening identity. Keep a legacy slot's key when consolidating old claim slots.
      const prior = this.slots.owned(this.owner).filter(([, s]) => s.kind === 'edit-in-claim' && s.other === other && s.path === path)
        .sort(([ak, a], [bk, b]) => Number(b.settled === 'conflict') - Number(a.settled === 'conflict') ||
          Number(b.settled === 'possible') - Number(a.settled === 'possible') || ak.localeCompare(bk))
      const key = prior[0]?.[0] ?? slotKey(this.owner, 'edit-in-claim', other, path)
      seen.add(key)
      if (prior.length > 1) {
        if (this.freshStorage && !await this.freshStorage() || this.guard && !this.guard()) throw new StaleConflictInputs()
        for (const removed of this.slots.consolidateClaims(key, prior.slice(1).map(([key]) => key))) seen.add(removed)
      }
      const claims = theirClaims.filter(c => claimsOverlap(c, { path, from: 1, to: Number.MAX_SAFE_INTEGER }))
        .sort((a, b) => a.id.localeCompare(b.id))
      const inputs = hash(JSON.stringify([mine.head.semRev, theirs.head.semRev, mergeBase,
        baseline ? [baseline.sha, baseline.untracked.get(path)?.sha] : undefined,
        claims.map(c => [c.id, c.from, c.to, c.claimedHash, c.at]), sideInput(mine, path), sideInput(theirs, path)]))
      const base = { owner: this.owner, other, kind: 'edit-in-claim' as const, path, inputs }
      if (!claims.length) {
        await this.settle(key, { ...base, status: 'clean', factId: '' })
        continue
      }
      const [ownV, theirV] = await Promise.all([read(mine, path), read(theirs, path)])
      const ownText = asText(ownV), theirText = asText(theirV)
      let ancestor: string | undefined
      try {
        // A carried untracked file is inherited text, absent from the Git tree.
        // Map claims against the same full ancestor used for the text comparison.
        if (baseline) {
          const read = ancestors?.get(path) ?? await boundedBaseline(this.team.dir, baseline, path)
          if (read.kind === 'unavailable') throw read.error
          ancestor = read.kind === 'available' ? read.text : ''
        } else ancestor = await readBoundedHistoricalText(this.team.dir, mergeBase, path) ?? ''
      } catch { /* unavailable */ }
      if (ownText === undefined || ancestor === undefined) {
        for (const [priorKey, priorSlot] of prior.slice(1)) {
          if (!this.slots.get(priorKey)) continue
          seen.add(priorKey)
          await this.settle(priorKey, { ...priorSlot, status: 'unknown', inputs, why: 'cannot map claim' })
        }
        await this.settle(key, { ...base, subject: claims[0]!.id, status: 'unknown', factId: '', why: 'cannot map claim' })
        continue
      }
      // Copies between separate publishers create no competing edit. A non-publisher's claim
      // still coordinates edits in its shared checkout, whose versions come from one publisher.
      const identicalCopy = mine.name !== theirs.name && ownText === theirText
      const ranges = changed.has(path) && !identicalCopy ? changedRanges(ancestor, ownText)
        .filter(r => !ownClaims.some(c => claimsOverlap(c, { path, ...r }))) : []
      const overlaps = claims.map(claim => {
        const mapped = claim.path.endsWith('/') ? { from: 1, to: Math.max(1, ownText.split('\n').length), approximate: false } : claimInMyLines(claim, theirText, ownText)
        return { claim, mapped, hits: ranges.filter(r => claimsOverlap({ path, ...mapped }, { path, ...r })) }
      }).filter(c => c.hits.length)
      // Exact evidence takes precedence over a second claim whose mapping is only approximate.
      const exact = overlaps.filter(c => !c.mapped.approximate)
      const relevant = exact.length ? exact : overlaps
      const representative = relevant[0]
      if (!representative) {
        await this.settle(key, { ...base, status: 'clean', factId: '' })
        continue
      }
      const hits = ranges.filter(r => relevant.some(c => c.hits.includes(r)))
      const { claim } = representative
      let earlierSha: string | null | undefined
      let revision = gitBlobHash(ownText)
      let merges: 'clean' | undefined
      let conflicts: Awaited<ReturnType<typeof gitMergeFile>>['conflicts'] | undefined
      if (exact.length && theirText !== undefined) {
        if (ownText === theirText || ownText === ancestor || theirText === ancestor) conflicts = []
        else {
          await this.budget()
          const merged = await gitMergeFile(ancestor, ownText, theirText, { ours: this.owner, base: 'base', theirs: other })
          conflicts = merged.conflicts
        }
        if (!conflicts.length) merges = 'clean'
      }
      const entryAt = mine.entries.get(path)?.at
      if (entryAt !== undefined && entryAt <= claim.at) earlierSha = null
      else if (entryAt === undefined) {
        const last = await git(this.team.dir, ['log', '-1', '--format=%H:%ct', mine.head.base, '--', path]).catch(() => '')
        const match = /^([0-9a-f]{40,64}):(\d+)/.exec(last.trim())
        if (match) {
          revision = match[1]!
          if (Number(match[2]) * 1000 <= claim.at) earlierSha = revision.slice(0, 7)
        }
      }
      await this.settle(key, { ...base, subject: claim.id, status: exact.length ? 'conflict' : 'possible',
        incomplete: theirText === undefined && !(theirs.head.level === 'declared'
          && !(theirs.head.textPrefixes ?? []).some(prefix => containsPath(prefix, path))),
        // Claim IDs, timestamps and range padding are inputs, not new overlap facts. Actual
        // conflicting regions matter even when the merge verdict stays "conflict"; another
        // rewrite of the peer's text inside the same region does not change that verdict.
        factId: hash(JSON.stringify([revision, merges ? [] : hits, conflicts?.map(c => [c.from, c.o])])), lines: hits.map(r => r.from),
        why: exact.length ? claim.intent : 'approximate range', ...(earlierSha !== undefined ? { earlierSha } : {}), ...(merges ? { merges } : {}) })
    }
    for (const a of ownClaims) for (const b of theirClaims) {
      if (!coversPath(a.path, b.path)) continue
      if (a.path.endsWith('/') || b.path.endsWith('/')) {
        const subject = `${a.id}\0${b.id}`, path = a.path.endsWith('/') ? b.path : a.path, key = slotKey(this.owner, 'claims', other, path, subject)
        seen.add(key)
        await this.settle(key, { owner: this.owner, other, kind: 'claims', path, subject, status: 'conflict',
          inputs: hash(JSON.stringify([a.id, a.path, a.from, a.to, b.id, b.path, b.from, b.to])), factId: hash(JSON.stringify([subject, a.path, b.path])) })
        continue
      }
      const [av, bv] = await Promise.all([read(mine, a.path), read(theirs, b.path)])
      const at = asText(av), bt = asText(bv)
      const mapped = at === undefined ? { from: b.from, to: b.to, approximate: true } : claimInMyLines(b, bt, at)
      const subject = `${a.id}\0${b.id}`, key = slotKey(this.owner, 'claims', other, a.path, subject)
      seen.add(key)
      const hit = claimsOverlap(a, { path: b.path, ...mapped })
      await this.settle(key, { owner: this.owner, other, kind: 'claims', path: a.path, subject,
        status: hit ? mapped.approximate ? 'possible' : 'conflict' : 'clean',
        incomplete: at === undefined || mapped.approximate && bt === undefined && !(theirs.head.level === 'declared'
          && !(theirs.head.textPrefixes ?? []).some(prefix => containsPath(prefix, b.path))),
        inputs: hash(JSON.stringify([mine.head.semRev, theirs.head.semRev, a.id, a.from, a.to, a.claimedHash, b.id, b.from, b.to, b.claimedHash])),
        factId: hit ? hash(JSON.stringify([subject, a.from, a.to, mapped])) : '',
        ...(hit && !mapped.approximate ? { evaluatedRanges: [{ from: Math.max(a.from, mapped.from), to: Math.min(a.to, mapped.to) }] } : {}) })
    }
    for (const [key, slot] of this.slots.owned(this.owner)) {
      if (slot.other !== other || (slot.kind !== 'claims' && slot.kind !== 'edit-in-claim') || seen.has(key)) continue
      await this.settle(key, { owner: this.owner, other, kind: slot.kind, path: slot.path, subject: slot.subject,
        status: 'clean', inputs: hash(`released\0${key}`), factId: '' })
    }
  }

  private async budget(): Promise<void> {
    const now = Date.now()
    this.starts = this.starts.filter(t => now - t < 10_000)
    if (this.starts.length >= 4) await new Promise(resolve => setTimeout(resolve, 10_000 - (now - this.starts[0]!)))
    this.starts.push(Date.now())
  }

  /** Yield before fast as well as slow file branches, so cached/held paths count. */
  private async fileTurn(): Promise<void> {
    if (++this.fileWork % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** Bridge-facing reconciliation: the team owns detection state; the bridge mirrors it privately. */
const projectedSets = new WeakMap<Session, WeakMap<Session, Map<string, ConflictSet>>>()
export async function reconcileProjectedConflicts({ team, workers, owner }: { team: Session; workers: Session; owner: string }): Promise<void> {
  let byWorkers = projectedSets.get(team)
  if (!byWorkers) { byWorkers = new WeakMap(); projectedSets.set(team, byWorkers) }
  let byOwner = byWorkers.get(workers)
  if (!byOwner) { byOwner = new Map(); byWorkers.set(workers, byOwner) }
  let set = byOwner.get(owner)
  if (!set) { set = new ConflictSet(team, owner, workers); byOwner.set(owner, set) }
  await set.reconcile('projection')
}
