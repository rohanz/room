import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { acceptedGit, claimInMyLines, claimsOverlap, containsPath, coversPath, digestPath, gitBlobHash, manifestKey, neighbours, observedContractChanges, participantRecord, participantsView, snapshot, snapshotMetadata, snapshotPath, snapshotStillCurrent, versionOf, type Claim, type Identity, type Msg, type NoteMsg, type ParticipantSnapshot, type ParticipantView, type PostBody, type RoomDoc, type Version } from '@room/shared'
import type { Post } from './post.js'
import type { Session } from './session.js'
import { git } from '@room/roomd/git'
import { comparePair } from '@room/roomd'
import { gitMergeFile } from './merge.js'
import { diffLines } from 'diff'
import { carriedPaths, carriesWork, MissingBaseBlob, type Baseline, type BaselineRead } from '@room/roomd/baseline'
import { ensureLanguages, parseFile } from './parse/engine.js'
import { consumesSymbol } from './graph-index.js'
import { trustedWorker, workerText } from './tools/context.js'
import { readBoundedCheckoutText, readBoundedHistoricalText } from './tools/disk-text.js'
import { registryForDir, registrySnapshotForDir } from './worker-registry.js'

export type ConflictKind = 'merge' | 'edit-in-claim' | 'claims' | 'contract'
type ConflictStatus = 'conflict' | 'possible' | 'unknown' | 'clean'
export interface ConflictSlot {
  kind: ConflictKind
  owner: string
  other: string
  path: string
  subject?: string
  status: ConflictStatus
  inputs: string
  factId: string
  settled: 'conflict' | 'possible' | 'clean' | 'none'
  clearedFrom?: 'conflict' | 'possible'
  epoch: number
  /** Stable within one authorized contract episode, new after the slot is withdrawn. */
  episode?: string
  lines?: number[]
  why?: string
  /** Present when the owner's overlapping edit was already there when the claim was made. */
  earlierSha?: string | null
  /** An edit inside a claim whose two versions merge without conflict as they stand: an overlap, not a CONFLICT. */
  merges?: 'clean'
  /** How many times an edit-in-claim conflict changed between merging and not: a burst notice per turn. */
  mergeTurns?: number
  fence: string
  checkedAt: number
  burstAt?: number
  retryAt?: number
  retrySource?: string
  /** Consumer paths are published only while their text grants remain valid. */
  consumers?: string[]
  /**
   * A possible edit-in-claim's episode (1, 2, …), shared by every claim of the same holder on the same path: an
   * approximate mapping cannot tell the holder's claims apart, so it is one fact with one notice and one "cleared". Kept after it clears.
   */
  possibleEpisode?: number
  /** This slot joined an episode another slot opened: that slot's notice covers it. */
  possibleJoined?: boolean
}
export type Evaluation = Pick<ConflictSlot, 'kind' | 'owner' | 'other' | 'path' | 'subject' | 'status' | 'inputs' | 'factId' | 'lines' | 'why' | 'earlierSha' | 'merges' | 'retrySource' | 'consumers'>

/** A conflict that turns between merging and not counts a turn; any other state keeps the count. */
const mergeTurns = (result: Evaluation, prev: ConflictSlot | undefined): Pick<ConflictSlot, 'mergeTurns'> => {
  const turns = (prev?.mergeTurns ?? 0) + (result.status === 'conflict' && prev?.settled === 'conflict' && !result.merges !== !prev.merges ? 1 : 0)
  return turns ? { mergeTurns: turns } : {}
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const slotKey = (owner: string, kind: ConflictKind, other: string, path: string, subject = ''): string =>
  [owner, kind, other, path, subject].join('\0')
export const noticeId = (key: string, epoch: number, episode?: string): string =>
  `cf:${hash(key)}:${epoch}${episode ? `:${episode}` : ''}`
const ROOM: Identity = { name: 'room', kind: 'agent' }
const retryMinutes = [1, 2, 4, 8]
class StaleConflictInputs extends Error {}
/** A registry record may keep the path a worktree was created with; trustedWorker reports its real path. */
const samePath = (a: string, b: string): boolean => {
  try { return fs.realpathSync(a) === fs.realpathSync(b) } catch { return false }
}
type LandedWorkerState = { id: string; name?: string; lead?: string; dir?: string; reported: string; run: string; seq: number; busy: boolean }
type TrustedLandedWorker = { id: string; status: string; dir: string; run: string; seq: number }

/** The one writer of each owner's derived slots. The hub deduplicates posts by deterministic ID. */
export class ConflictSlots {
  private readonly map
  constructor(
    private readonly room: RoomDoc,
    private readonly post: Post,
    private readonly fence: string | (() => string),
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = () => {},
    private readonly holderPost: Post = post,
    private readonly valid: () => boolean = () => true,
  ) { this.map = room.doc.getMap<ConflictSlot>('conflicts') }

  get(key: string): ConflictSlot | undefined { return this.map.get(key) }
  owned(owner: string): [string, ConflictSlot][] { return [...this.map.entries()].filter(([, slot]) => slot.owner === owner) }
  drop(key: string): void { this.room.doc.transact(() => this.map.delete(key)) }

  /** Graph provenance can lag a still-readable manifest. Keep episode identity while evidence is unknown. */
  markContractsUnknown(owner: string, other: string, why: string, paths?: ReadonlySet<string>): void {
    const now = this.now()
    const fence = typeof this.fence === 'function' ? this.fence() : this.fence
    this.room.doc.transact(() => {
      for (const [key, slot] of this.owned(owner)) {
        if (slot.kind !== 'contract' || slot.other !== other || paths && !paths.has(slot.path)) continue
        if (slot.status === 'unknown' && slot.why === why && slot.fence === fence) continue
        this.map.set(key, { ...slot, status: 'unknown', inputs: hash(`${key}\0${why}`), why,
          fence, checkedAt: now, retryAt: now + retryMinutes[0]! * 60_000 })
      }
    })
  }

  async settle(key: string, result: Evaluation): Promise<ConflictSlot> {
    const prev = this.map.get(key)
    const now = this.now()
    const fence = typeof this.fence === 'function' ? this.fence() : this.fence
    if (result.status === 'unknown' && prev?.status === 'unknown' && prev.inputs === result.inputs && prev.fence === fence && (prev.retryAt ?? 0) > now) return prev
    if (prev?.inputs === result.inputs && prev.status === result.status && prev.factId === result.factId && prev.fence === fence && result.status !== 'unknown') return prev
    const changedFact = result.status === 'conflict' || result.status === 'possible'
      ? prev?.settled !== result.status || prev.factId !== result.factId : false
    const epoch = (prev?.epoch ?? 0) + (changedFact ? 1 : 0)
    const settled = result.status === 'unknown' ? prev?.settled ?? 'none' : result.status
    const episode = result.kind === 'edit-in-claim' ? this.joinPossibleEpisode(key, result, settled, prev) : {}
    const unknownCount = result.status === 'unknown' ? Math.min(3, (prev?.status === 'unknown' ? Math.max(0, retryMinutes.findIndex(m => (prev.retryAt ?? 0) - prev.checkedAt <= m * 60_000)) + 1 : 0)) : 0
    const slot: ConflictSlot = {
      ...result, ...(result.status === 'unknown' && prev ? { factId: prev.factId } : {}), settled, epoch, fence, checkedAt: now, ...episode,
      ...(result.kind === 'contract' && (!prev || prev.episode) ? { episode: prev?.episode ?? randomUUID() } : {}),
      ...(result.status === 'clean' && (prev?.settled === 'conflict' || prev?.settled === 'possible') ? { clearedFrom: prev.settled } : {}),
      // A cleared slot re-checked clean (or unreadable) keeps what it cleared: the replay re-derives the same "cleared" id, never a second one.
      ...((result.status === 'clean' || result.status === 'unknown') && prev?.settled === 'clean' && prev.clearedFrom ? { clearedFrom: prev.clearedFrom } : {}),
      // What cleared was an overlap that merged, not a CONFLICT; an unreadable pass keeps what was last known.
      ...((result.status === 'clean' || result.status === 'unknown') && prev?.merges && (prev.settled === 'conflict' || prev.settled === 'clean' && prev.clearedFrom) ? { merges: prev.merges } : {}),
      ...(result.kind === 'edit-in-claim' ? mergeTurns(result, prev) : {}),
      ...(result.status === 'unknown' ? { retryAt: now + retryMinutes[unknownCount]! * 60_000 } : {}),
      ...(result.kind === 'edit-in-claim' && result.status === 'conflict' ? { burstAt: prev?.status === 'conflict' ? prev.burstAt ?? now : now } : {}),
    }
    this.room.doc.transact(() => this.map.set(key, slot))
    if (changedFact) await this.postNotice(key, slot)
    else if (result.status === 'clean' && (prev?.settled === 'conflict' || prev?.settled === 'possible')) await this.postNotice(key, slot)
    return slot
  }

  /** The other edit-in-claim slots of this owner for the same holder and path. */
  private claimGroup(key: string, slot: Pick<ConflictSlot, 'owner' | 'other' | 'path'>): [string, ConflictSlot][] {
    return this.owned(slot.owner).filter(([k, s]) => k !== key && s.kind === 'edit-in-claim' && s.other === slot.other && s.path === slot.path)
  }

  /** Join the open possible episode of this holder and path, or open a new one; a clean slot keeps the episode it clears. */
  private joinPossibleEpisode(key: string, result: Evaluation, settled: ConflictSlot['settled'], prev: ConflictSlot | undefined): Pick<ConflictSlot, 'possibleEpisode' | 'possibleJoined'> {
    // Every state keeps the episode number, so a later possibility (even after an exact conflict) numbers past it.
    if (settled !== 'possible') return prev?.possibleEpisode !== undefined ? { possibleEpisode: prev.possibleEpisode, possibleJoined: prev.possibleJoined } : {}
    if (prev?.settled === 'possible' && prev.possibleEpisode !== undefined) return { possibleEpisode: prev.possibleEpisode, possibleJoined: prev.possibleJoined }
    const group = this.claimGroup(key, result)
    const open = group.find(([, s]) => s.settled === 'possible' && s.possibleEpisode !== undefined)?.[1]
    if (open) return { possibleEpisode: open.possibleEpisode, possibleJoined: true }
    // Numbered like a slot's epoch, so its "cleared" shares the id of the same path's other cleared notices.
    return { possibleEpisode: 1 + Math.max(prev?.possibleEpisode ?? 0, ...group.map(([, s]) => s.possibleEpisode ?? 0)), possibleJoined: false }
  }

  /** A reconnect re-derives owed notices from replicated slots, without an in-memory queue. */
  async replay(owner: string, validSlot: (slot: ConflictSlot) => boolean = () => true): Promise<void> {
    for (const [key, slot] of this.owned(owner)) {
      if (!validSlot(slot)) continue
      if (slot.settled === 'conflict' || slot.settled === 'possible' || (slot.settled === 'clean' && slot.epoch > 0)) await this.postNotice(key, slot, true)
    }
  }

  async postNotice(key: string, slot: ConflictSlot, replay = false): Promise<void> {
    const current = () => this.valid() && this.map.get(key) === slot && (typeof this.fence === 'function' ? this.fence() : this.fence) === slot.fence
    if (!current()) return
    const workerView = this.room.workerViewOf(slot.other)
    if (slot.kind === 'edit-in-claim' && workerView?.lead === slot.owner && workerView.status !== 'running') return
    const episode = slot.kind === 'edit-in-claim' && slot.possibleEpisode !== undefined && (slot.settled === 'possible' || slot.clearedFrom === 'possible')
      ? slot.possibleEpisode : undefined
    if (episode !== undefined) {
      const open = this.claimGroup(key, slot).filter(([, s]) => s.settled === 'possible' && s.possibleEpisode === episode)
      // One notice per episode: its opener posts it (on a replay, the first open slot), and the last to clear posts "cleared".
      if (slot.settled === 'possible' && (replay ? open.some(([k]) => k < key) : slot.possibleJoined)) return
      if (slot.settled === 'clean' && open.length) return
    }
    const workerBurst = slot.kind === 'edit-in-claim' && slot.status === 'conflict' && workerView?.lead === slot.owner
      ? Math.min(...this.owned(slot.owner).filter(([, other]) => other.kind === 'edit-in-claim' && other.other === slot.other && other.path === slot.path && other.status === 'conflict').map(([, other]) => other.burstAt ?? other.checkedAt))
      : undefined
    const id = episode !== undefined
      ? `cf:${hash([slot.owner, slot.other, slot.path, 'possible', episode].join('\0'))}:${slot.settled === 'clean' ? 'clean' : 'possible'}`
      : slot.settled === 'clean' && slot.kind !== 'contract'
      ? `cf:${hash([slot.owner, slot.other, slot.path, slot.clearedFrom, slot.epoch].join('\0'))}:clean`
      : workerBurst !== undefined
        // A burst's clean overlap has its own id, so the same burst turning into a CONFLICT is still told.
        ? `cf:${hash([slot.owner, slot.other, slot.path, workerBurst].join('\0'))}:worker${slot.mergeTurns ? `:${slot.mergeTurns}` : ''}`
        : noticeId(key, slot.epoch, slot.episode) + (slot.settled === 'clean' ? ':clean' : '')
    const status = slot.settled
    const ownWorker = workerView?.lead === slot.owner
    const priority = status === 'possible' || status === 'clean' ? 'fyi' : slot.kind === 'edit-in-claim' && !ownWorker ? 'interrupt' : 'notify'
    // Name the claimed lines: an exact conflict is about one claim, a possible one about all of the holder's claims here.
    const held = this.room.openClaims().filter(c => c.by === slot.other && c.path === slot.path && !c.path.endsWith('/'))
    const claimed = (claims: Claim[]) => `${slot.other}'s claim${claims.length > 1 ? 's' : ''}${claims.length
      ? ` at line${claims.length > 1 || claims[0]!.from !== claims[0]!.to ? 's' : ''} ${claims.sort((a, b) => a.from - b.from).map(c => c.from === c.to ? `${c.from}` : `${c.from}-${c.to}`).join(', ')}` : ''}`
    const ownClaim = () => claimed(held.filter(c => c.id === slot.subject))
    const text = status === 'possible'
      ? slot.kind === 'edit-in-claim' ? `you may have edited ${slot.path} inside ${claimed(held)}; line mapping is approximate`
        : slot.kind === 'claims' ? `claims in ${slot.path} may overlap with ${slot.other}; line mapping is approximate`
          : `${slot.why ?? slot.other} changed ${slot.path} too, outside their declared area; Room cannot check this merge`
      : status === 'clean' ? `the ${slot.clearedFrom === 'possible' ? 'possible conflict' : slot.merges ? 'overlap' : 'conflict'} with ${slot.other} cleared`
      : slot.kind === 'edit-in-claim' ? slot.earlierSha !== undefined
        ? `your earlier change to ${slot.path}${slot.earlierSha ? ` (${slot.earlierSha})` : ''} overlaps ${ownClaim().replace(/'s claim/, "'s new claim")}`
        : `you edited ${slot.path} inside ${ownClaim()}${slot.why ? ` (${slot.why})` : ''}`
      : slot.kind === 'claims' ? `concurrent overlapping claims in ${slot.path} with ${slot.other}`
      : slot.kind === 'contract' ? `${slot.other} changed ${slot.subject ?? 'a symbol'} in ${slot.path}${slot.why ? ` (${slot.why})` : ''}`
      : `${slot.path} conflicts with ${slot.other}'s version${slot.lines?.length ? ` at lines ${slot.lines.join(', ')}` : ''}`
    const clearedFrom = status === 'clean' ? slot.clearedFrom : undefined
    const merges = slot.kind === 'edit-in-claim' && slot.merges === 'clean' && (status === 'conflict' || clearedFrom === 'conflict') ? { merges: 'clean' as const } : undefined
    const mergeNote = merges && status === 'conflict' ? '; merges cleanly' : ''
    const body = (slot.kind === 'merge'
      ? { type: 'merge-conflict', path: slot.path, to: slot.owner, priority, text, ...(clearedFrom ? { clearedFrom } : {}) }
      : slot.kind === 'contract'
        ? { type: 'contract', path: slot.path, symbol: slot.subject ?? '', to: slot.owner, priority, text }
        : { type: 'conflict', claimId: slot.subject?.split('\0')[0] ?? '', otherClaimId: slot.subject?.split('\0')[1] ?? '', path: slot.path, to: slot.owner, priority, text: text + mergeNote, ...(clearedFrom ? { clearedFrom } : {}), ...merges }) as unknown as PostBody<Msg>
    try {
      const posted = await this.post(ROOM, body, { id, auto: true })
      if (!posted.ok) this.log(`conflict notice ${id}: ${posted.text}`)
    } catch (e) { this.log(`conflict notice ${id}: ${String(e)}`) }
    if (slot.kind === 'edit-in-claim' && status === 'conflict') {
      if (!current()) return
      try {
        const holderText = slot.earlierSha !== undefined
          ? `${slot.owner}'s earlier change to ${slot.path}${slot.earlierSha ? ` (${slot.earlierSha})` : ''} overlaps your new claim`
          : `${slot.owner} edited ${slot.path} inside your claim${slot.why ? ` (${slot.why})` : ''}`
        const holder = await this.holderPost(ROOM, { ...body, to: slot.other, priority: 'notify', text: holderText + mergeNote } as PostBody<Msg>, { id: `${noticeId(key, slot.epoch)}:holder`, auto: true })
        if (!holder.ok) this.log(`conflict holder notice ${id}: ${holder.text}`)
      } catch (e) { this.log(`conflict holder notice ${id}: ${String(e)}`) }
    }
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
  private stopped = false
  private inputCheck?: NodeJS.Immediate
  private scheduledInputs = ''
  private carriedInput?: { baseline: Baseline; lead: string }
  private readonly checkedPairs = new Map<string, string>()
  /** Retain the complete evaluation guard, including projected/publisher provenance, for replay. */
  private readonly pairGuards = new Map<string, () => boolean>()
  private starts: number[] = []
  private readonly contractCache = new Map<string, ReturnType<typeof observedContractChanges>>()
  private guard: (() => boolean) | undefined
  constructor(private readonly team: Session, private readonly owner = team.me.name, private readonly notices: Session = team,
    private readonly log: (line: string) => void = line => process.stderr.write(`room-mcp: ${line}\n`), private readonly debounceMs = 2000,
    private readonly carriedFrom?: (participant: string) => { baseline: Baseline; lead: string } | undefined,
    private readonly localWorker: (name: string) => Promise<TrustedLandedWorker | undefined> = async name => {
      const registry = await registryForDir(team.dir)
      const trusted = await registry.trusted({ participant: team.me.name, room: team.roomName, dir: team.dir }, name)
      if (!trusted || trusted.record.name !== name) return undefined
      const run = trusted.status.run
      return { id: trusted.record.id, status: trusted.status.status, dir: fs.realpathSync(trusted.record.dir),
        run: run ? `${run.n}:${run.nonce}` : '', seq: trusted.record.seq }
    },
    private readonly workerState: (id: string) => LandedWorkerState | undefined = id => {
      const registry = registrySnapshotForDir(team.dir)
      return registry.freshness(id)
    },
    private readonly claimText: typeof workerText = workerText) {
    const fence = () => team.lease?.fence() ?? ''
    this.slots = new ConflictSlots(team.room, notices.post, fence, Date.now, log, team.post, () => this.guard?.() ?? false)
  }

  start(): void {
    this.scheduledInputs = this.inputsKey()
    const schedule = () => {
      // Revocation stays synchronous; expensive scheduling is once per event-loop turn.
      this.withdrawUnauthorizedContracts()
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
      this.team.room.claims, this.team.room.graphs, this.team.room.workerViews, this.team.room.expiry]) {
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
    this.tick = setInterval(() => this.schedule(0), 60_000)
    this.tick.unref?.()
    if (this.team.provider.synced) this.schedule(0)
  }

  /** Pair facts, excluding publication clocks, unrelated edits, and display-only graph edges. */
  private pairInputs(other: string, views: ParticipantView[]): string {
    const room = this.team.room
    const mine = snapshotMetadata(room, this.owner, views), theirs = snapshotMetadata(room, other, views)
    const claims = room.openClaims().filter(c => c.by === this.owner || c.by === other)
    const graph = room.graphs.get(other)
    const contracts = !!graph?.observed?.length
    // Different bases can hide committed overlaps; carried providers also need full consumer facts.
    const carried = this.carriedInput?.lead === other ? this.carriedInput.baseline : undefined
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
      graph?.sourceRev === theirs?.head.rev, graph?.truncated, graph?.observedTruncated, graph?.observed] : undefined
    return hash(JSON.stringify([metadata(mine), metadata(theirs), room.roomSalt, claims, entries(mine), entries(theirs), graphFacts,
      contracts || carried && carriesWork(carried) ? this.team.graph?.resolutionRevision : undefined,
      carried ? [carried.sha, carried.carriedCommit, [...carried.untracked]] : undefined]))
  }

  private inputsKey(): string {
    this.carriedInput = this.carriedFrom?.(this.owner)
    const room = this.team.room, views = participantsView(room, this.team.awareness, Date.now())
    const names = neighbours(views, this.owner).names().filter(name => this.owner === this.team.me.name || name !== this.team.me.name)
    return JSON.stringify([this.team.lease?.fence(), names.map(name => [name, this.pairInputs(name, views)]),
      room.openClaims().filter(c => c.by === this.owner),
      [...room.workerViews.values()].filter(w => w.lead === this.owner).map(w => [w.id, w.status, w.run])])
  }

  /** Remove every contract whose provider or consumer has left its text grant. */
  private withdrawUnauthorizedContracts(): void {
    if (!this.team.lease?.fence()) return
    const room = this.team.room
    const owned = this.slots.owned(this.owner).filter(([, slot]) => slot.kind === 'contract')
    if (!owned.length) return
    const views = participantsView(room, this.team.awareness, Date.now())
    const mine = snapshotMetadata(room, this.owner, views)
    const stale = new Set<string>()
    const peers = new Map<string, ReturnType<typeof snapshotMetadata>>()
    for (const [key, slot] of owned) {
      if (!peers.has(slot.other)) peers.set(slot.other, snapshotMetadata(room, slot.other, views))
      const theirs = peers.get(slot.other)
      if (!this.contractPathAuthorized(theirs, slot.path) || !slot.consumers?.length ||
          slot.consumers.some(path => !this.contractPathAuthorized(mine, path))) this.slots.drop(key)
      else {
        const graph = room.graphs.get(slot.other)
        if (!theirs?.head.complete || theirs.head.coverage.kind !== 'all' ||
            !graph || graph.status !== 'ready' || graph.sourceFence !== theirs.head.fence ||
            graph.sourceRev !== theirs.head.rev) stale.add(slot.other)
      }
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
    this.withdrawUnauthorizedContracts()
    this.slots.markContractsUnknown(this.owner, other, why)
  }
  stop(): void {
    this.stopped = true
    clearImmediate(this.inputCheck)
    for (const stop of this.stops) stop()
    this.stops.length = 0
    if (this.timer) clearTimeout(this.timer)
    if (this.tick) clearInterval(this.tick)
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
    if (this.running) { this.rerun = true; await this.running; return }
    this.running = (async () => {
      // At most two checks per turn. A continuing stream gets one coalesced future pass,
      // never a recursive chain that keeps flush/tools alive indefinitely.
      for (let attempt = 0; attempt < 2 && !this.stopped; attempt++) {
        this.rerun = false
        try { await this.run(reason) }
        catch (e) { if (!(e instanceof StaleConflictInputs)) throw e; this.rerun = true }
        if (!this.rerun) return
        if (attempt === 0) await new Promise<void>(resolve => setImmediate(resolve))
      }
      if (!this.stopped) this.log(`conflicts ${this.owner}: inputs moved twice; coalesced next check`)
    })()
    try { await this.running } finally { this.running = undefined }
    if (this.rerun && !this.stopped) { this.rerun = false; this.schedule() }
  }

  private async settle(key: string, result: Evaluation): Promise<ConflictSlot> {
    if (this.guard && !this.guard()) throw new StaleConflictInputs()
    return this.slots.settle(key, result)
  }

  private drop(key: string): void {
    if (this.guard && !this.guard()) throw new StaleConflictInputs()
    this.slots.drop(key)
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
    this.carriedInput = this.carriedFrom?.(this.owner)
    this.fileWork = 0
    const room = this.team.room
    const leaseFence = this.team.lease?.fence()
    if (!leaseFence) return
    await this.releaseLandedWorkerClaims(leaseFence)
    this.withdrawUnauthorizedContracts()
    const views = participantsView(room, this.team.awareness, Date.now())
    const mine = snapshot(room, this.owner, views)
    if (!mine || mine.head.fence !== leaseFence) return
    const ownNonPublisher = mine.head.coverage.kind === 'none' && mine.head.coverage.reason === 'not-publisher' && !!mine.head.publisher
    const ownPublisher = ownNonPublisher ? snapshot(room, mine.head.publisher!, views) : undefined
    const ownGit = acceptedGit(participantRecord(room, ownNonPublisher ? mine.head.publisher! : this.owner), views)
    if (ownGit === 'updating' || (ownNonPublisher && !ownPublisher)) return
    const authority = () => !this.stopped && this.team.lease?.fence() === leaseFence
    const claimInputs = JSON.stringify(room.openClaims().filter(c => c.by === this.owner))
    this.guard = () => authority() && snapshotStillCurrent(room, mine, participantsView(room, this.team.awareness, Date.now())) &&
      (!ownPublisher || snapshotStillCurrent(room, ownPublisher, participantsView(room, this.team.awareness, Date.now()))) &&
      JSON.stringify(room.openClaims().filter(c => c.by === this.owner)) === claimInputs
    const nb = neighbours(views, this.owner)
    const names = new Set(nb.names())
    for (const [key, slot] of this.slots.owned(this.owner)) if (!nb.has(slot.other)) this.drop(key)
    names.delete(this.owner)
    if (this.owner !== this.team.me.name) names.delete(this.team.me.name) // lead/own worker pair belongs to the workers room
    const capturedPairs = new Map([...names].map(name => [name, this.pairInputs(name, views)]))
    for (const other of [...names].sort()) {
      const pairInputs = capturedPairs.get(other)!
      if (this.pairInputs(other, participantsView(room, this.team.awareness, Date.now())) !== pairInputs) throw new StaleConflictInputs()
      const retryDue = this.slots.owned(this.owner).some(([, slot]) => slot.other === other && slot.status === 'unknown' && (slot.retryAt ?? 0) <= Date.now())
      if (this.checkedPairs.get(other) === pairInputs && !retryDue) continue
      let failed = false
      try {
        const theirs = snapshot(room, other, views)
        const theirGit = acceptedGit(participantRecord(room, other), views)
        const graphInput = room.graphs.get(other)?.observed
        this.guard = () => !this.stopped && authority() && this.pairInputs(other,
          participantsView(room, this.team.awareness, Date.now())) === pairInputs
        const existing = this.slots.owned(this.owner).filter(([, s]) => s.other === other)
        if (!theirs && !participantRecord(room, other)) {
          for (const [key] of existing) this.drop(key)
          continue
        }
        if (ownNonPublisher) {
          const pair = !theirs || theirGit === 'updating' ? undefined : await comparePair(this.team.dir, ownGit.remote ?? theirGit.remote, ownGit, theirGit)
          if (pair && !('cannotCompare' in pair)) {
            const committed = await git(this.team.dir, ['diff', '--name-only', `${pair.mergeBase}..${ownGit.base}`]).catch(() => '')
            await this.claims(ownPublisher!, theirs!, other, pair.mergeBase,
              new Set([...ownPublisher!.entries.keys(), ...committed.split('\n').filter(Boolean)]))
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
              const committed = await git(this.team.dir, ['diff', '--name-only', `${pair.mergeBase}..${ownGit.base}`]).catch(() => '')
              await this.claims(mine, published, other, pair.mergeBase, new Set([...mine.entries.keys(), ...committed.split('\n').filter(Boolean)]))
            }
          }
          continue // a non-publisher contributes claims, never a merge pair
        }
        if (!theirs || theirGit === 'updating') {
          const why = `${other}'s manifest or base is updating`
          await this.settle(slotKey(this.owner, 'merge', other, '*'), { owner: this.owner, other, kind: 'merge', path: '*', status: 'unknown', inputs: hash(why), factId: '', why })
          for (const [key, slot] of existing) if (slot.path !== '*' && slot.kind !== 'contract') await this.settle(key, { ...slot, status: 'unknown', inputs: hash(`${slot.inputs}\0${why}`), why })
          this.unknownContracts(other, why)
          continue
        }
        const retrySource = hash(JSON.stringify([mine.head.semRev, theirs.head.semRev, mine.head.fence, theirs.head.fence, ownGit, theirGit, graphInput, claimInputs]))
        if (existing.some(([, slot]) => slot.kind === 'merge' && slot.path === '*' && slot.status === 'unknown' && slot.retrySource === retrySource && (slot.retryAt ?? 0) > Date.now())) continue
        const pair = await comparePair(this.team.dir, ownGit.remote ?? theirGit.remote, ownGit, theirGit)
        if ('cannotCompare' in pair || !mine.head.complete || !theirs.head.complete || mine.head.coverage.kind !== 'all' || theirs.head.coverage.kind !== 'all' || !mine.fenceValid || !theirs.fenceValid || !mine.roomSalt || !theirs.roomSalt) {
          const why = 'cannotCompare' in pair ? pair.cannotCompare : 'manifest is incomplete or fenced out'
          const key = slotKey(this.owner, 'merge', other, '*')
          await this.settle(key, { owner: this.owner, other, kind: 'merge', path: '*', status: 'unknown', inputs: hash(JSON.stringify([ownGit, theirGit, mine.head.semRev, theirs.head.semRev, why])), retrySource, factId: '', why })
          for (const [existingKey, slot] of existing) if (slot.path !== '*' && slot.kind !== 'contract') await this.settle(existingKey, { ...slot, status: 'unknown', inputs: hash(`${slot.inputs}\0${why}`), why })
          this.unknownContracts(other, why)
          continue
        }
        await this.contracts(other, new Set([...mine.entries.keys(), ...room.openClaims().filter(c => c.by === this.owner).map(c => c.path)]), mine, theirs)
        this.drop(slotKey(this.owner, 'merge', other, '*'))
        const mergeBase = pair.mergeBase
        const changed = async (snap: ParticipantSnapshot, base: string) => {
          try {
            const committed = await git(this.team.dir, ['diff', '--name-only', `${mergeBase}..${base}`])
            return new Set([...snap.entries.keys(), ...committed.split('\n').filter(Boolean)])
          } catch { return undefined }
        }
        const [aPaths, bPaths] = await Promise.all([changed(mine, ownGit.base), changed(theirs, theirGit.base)])
        if (!aPaths || !bPaths) {
          await this.settle(slotKey(this.owner, 'merge', other, '*'), { owner: this.owner, other, kind: 'merge', path: '*', status: 'unknown', inputs: retrySource, retrySource, factId: '', why: 'cannot enumerate changed paths' })
          for (const [key, slot] of existing) if (slot.kind === 'merge') await this.settle(key, { ...slot, status: 'unknown', inputs: hash(`${slot.inputs}\0failed enumeration`), why: 'cannot enumerate changed paths' })
          continue
        }
        if (aPaths.size + bPaths.size > ConflictSet.MAX_PAIR_FILES) {
          const why = 'too many changed paths to compare'
          await this.settle(slotKey(this.owner, 'merge', other, '*'), { owner: this.owner, other, kind: 'merge', path: '*', status: 'unknown', inputs: hash(`${retrySource}\0${why}`), retrySource, factId: '', why })
          for (const [key, slot] of existing) {
            await this.fileTurn()
            if (slot.kind === 'merge') await this.settle(key, { ...slot, status: 'unknown', inputs: hash(`${slot.inputs}\0${why}`), why })
          }
          await this.claims(mine, theirs, other, pair.mergeBase, aPaths)
          continue
        }
        const ownMergePaths = new Set(aPaths)
        const unchangedCarried = new Set<string>()
        const carried = this.carriedFrom?.(this.owner)
        if (carried?.lead === other && carriesWork(carried.baseline)) {
          for (const path of aPaths) {
            await this.fileTurn()
            const baseline = await boundedBaseline(this.team.dir, carried.baseline, path)
            if (baseline.kind === 'unavailable') continue
            const ownText = asText(await this.read(mine, path))
            if (ownText !== undefined && ownText === (baseline.kind === 'absent' ? '' : baseline.text)) {
              ownMergePaths.delete(path)
              unchangedCarried.add(path)
            }
          }
        }
        const candidates = new Set([...ownMergePaths].filter(p => bPaths.has(p)))
        for (const [, slot] of existing) if (slot.kind === 'merge' && slot.path !== '*') candidates.add(slot.path)
        for (const path of [...candidates].sort()) {
          await this.fileTurn()
          const key = slotKey(this.owner, 'merge', other, path)
          const bothChanged = ownMergePaths.has(path) && bPaths.has(path)
          const inputs = hash(JSON.stringify([ownGit.base, theirGit.base, mergeBase, ownGit.anchored, theirGit.anchored,
            mine.head.semRev, theirs.head.semRev, sideInput(mine, path), sideInput(theirs, path),
            carried?.lead === other ? [carried.baseline.sha, unchangedCarried.has(path)] : undefined]))
          const previous = this.slots.get(key)
          if (unchangedCarried.has(path)) {
            await this.settle(key, { owner: this.owner, other, kind: 'merge', path, status: 'clean', inputs, factId: '' })
            continue
          }
          if (previous?.inputs === inputs && (previous.status !== 'unknown' || (previous.retryAt ?? 0) > Date.now())) continue
          const read = (snap: ParticipantSnapshot) => this.read(snap, path)
          const [a, b] = await Promise.all([read(mine), read(theirs)])
          if (!bothChanged) {
            const unreadable = [a, b].find(v => v.kind === 'excluded' || v.kind === 'unknown' || v.kind === 'held')
            await this.settle(key, { owner: this.owner, other, kind: 'merge', path,
              status: unreadable ? 'unknown' : 'clean', inputs, factId: '', ...(unreadable ? { why: 'cannot certify unchanged path' } : {}) })
            continue
          }
          const held = [a, b].some(v => v.kind === 'held' && !v.entry.hash)
          if (held) {
            const aChange = mine.entries.get(path)?.change ?? 'committed', bChange = theirs.entries.get(path)?.change ?? 'committed'
            const heldBy = [a.kind === 'held' && !a.entry.hash ? this.owner : '', b.kind === 'held' && !b.entry.hash ? other : ''].filter(Boolean).join(' and ')
            await this.settle(key, { owner: this.owner, other, kind: 'merge', path, status: 'possible', inputs,
              factId: hash(['possible', path, mergeBase, aChange, bChange].join('\0')), why: heldBy })
            continue
          }
          const at = asText(a), bt = asText(b)
          if (at === undefined || bt === undefined) {
            await this.settle(key, { owner: this.owner, other, kind: 'merge', path, status: 'unknown', inputs, factId: '', why: `cannot read ${at === undefined ? this.owner : other}'s version` })
            continue
          }
          let ancestor: string
          try { ancestor = await readBoundedHistoricalText(this.team.dir, mergeBase, path) ?? '' }
          catch { await this.settle(key, { owner: this.owner, other, kind: 'merge', path, status: 'unknown', inputs, factId: '', why: 'missing merge base' }); continue }
          await this.budget()
          const merged = await gitMergeFile(ancestor, at, bt, { ours: this.owner, base: 'base', theirs: other })
          const lines = merged.conflicts.map(c => c.from)
          await this.settle(key, { owner: this.owner, other, kind: 'merge', path, status: lines.length ? 'conflict' : 'clean', inputs,
            factId: lines.length ? hash(JSON.stringify([mergeBase, ...merged.conflicts.map(c => c.o)])) : '', lines })
        }
        await this.claims(mine, theirs, other, mergeBase, ownMergePaths)
      } catch (error) {
        failed = true
        this.checkedPairs.delete(other)
        throw error
      } finally {
        if (!failed && this.guard?.()) {
          this.checkedPairs.set(other, pairInputs)
          this.pairGuards.set(other, this.guard)
        }
      }
    }
    await this.slots.replay(this.owner, slot => {
      this.guard = this.pairGuards.get(slot.other)
      if (!this.guard?.()) {
        this.checkedPairs.delete(slot.other)
        this.pairGuards.delete(slot.other)
        this.rerun = true
        return false
      }
      return true
    })
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
      const initial = this.workerState(worker.id)
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
      const latest = this.workerState(worker.id)
      if (this.team.lease?.fence() !== leaseFence || !latest || latest.busy ||
          JSON.stringify(latest) !== JSON.stringify(initial) ||
          JSON.stringify(participantRecord(room, name)?.holder) !== holder ||
          JSON.stringify(currentClaims()) !== claimSnapshot) return
      room.doc.transact(() => { for (const claim of claims) room.removeClaim(claim.id) }, this.team.me)
      await this.team.post<NoteMsg>(ROOM, { type: 'note', to: this.owner, priority: 'fyi', text: `released ${name}'s claims: its changes are in your tree` },
        { id: `cf:${hash([this.owner, name, claims.map(c => c.id).sort().join(',')].join('\0'))}:landed`, auto: true })
    }
  }

  private async contracts(other: string, myPaths: Set<string>, mine: ParticipantSnapshot, theirs: ParticipantSnapshot): Promise<void> {
    this.withdrawUnauthorizedContracts()
    const graph = this.team.room.graphs.get(other)
    const carried = this.carriedFrom?.(this.owner)
    const carriedProvider = carried?.lead === other && carriesWork(carried.baseline)
    if (!carriedProvider && (!graph || graph.status !== 'ready' || graph.base !== theirs.head.base ||
        graph.sourceFence !== theirs.head.fence || graph.sourceRev !== theirs.head.rev || graph.observedTruncated || graph.truncated)) {
      this.unknownContracts(other, 'provider graph or manifest coverage is updating')
      return
    }
    const live = new Set<string>()
    let changes = graph?.observed ?? []
    if (carriedProvider) {
      const paths = new Set([...await carriedPaths(carried.baseline), ...theirs.entries.keys()])
      const observed: typeof changes = []
      for (const path of paths) {
        await this.fileTurn()
        if (!this.contractPathAuthorized(theirs, path)) continue
        const before = await boundedBaseline(this.team.dir, carried.baseline, path)
        if (before.kind === 'unavailable') {
          const key = slotKey(this.owner, 'contract', other, path, '*')
          await this.settle(key, { owner: this.owner, other, kind: 'contract', path, subject: '*', status: 'unknown',
            inputs: hash(JSON.stringify([carried.baseline.sha, path, 'unavailable'])), factId: '', why: before.error.message })
          const id = `cf:${hash(`${key}\0${carried.baseline.sha}`)}:degraded`
          if (this.guard && !this.guard()) throw new StaleConflictInputs()
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
          await ensureLanguages([path])
          parsed = observedContractChanges(oldText, after, path, parseFile)
          if (this.contractCache.size >= 1000) this.contractCache.delete(this.contractCache.keys().next().value!)
          this.contractCache.set(cacheKey, parsed)
        }
        observed.push(...parsed.map(change => ({ path, ...change })))
      }
      changes = observed
    }
    for (const change of changes) {
      await this.fileTurn()
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
        this.drop(key)
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

  private async claims(mine: ParticipantSnapshot, theirs: ParticipantSnapshot, other: string, mergeBase: string, changed: Set<string>): Promise<void> {
    const all = this.team.room.openClaims()
    const ownClaims = all.filter(c => c.by === this.owner)
    const ownFinishedWorker = this.owner === this.team.me.name && (await this.localWorker(other))?.status === 'done'
    const theirClaims = ownFinishedWorker ? [] : all.filter(c => c.by === other)
    if (ownFinishedWorker) for (const [key, slot] of this.slots.owned(this.owner)) {
      if (slot.other === other && (slot.kind === 'edit-in-claim' || slot.kind === 'claims')) this.drop(key)
    }
    const seen = new Set<string>()
    const paths = new Set([
      ...theirClaims.flatMap(c => c.path.endsWith('/') ? [...changed].filter(path => claimsOverlap(c, { path, from: 1, to: Number.MAX_SAFE_INTEGER })) : [c.path]),
      ...this.slots.owned(this.owner).filter(([, s]) => s.other === other && s.kind === 'edit-in-claim').map(([, s]) => s.path),
    ])
    const read = (snap: ParticipantSnapshot, path: string) => this.read(snap, path)
    for (const path of paths) {
      await this.fileTurn()
      if (path.endsWith('/')) continue
      const [ownV, theirV] = await Promise.all([read(mine, path), read(theirs, path)])
      const ownText = asText(ownV), theirText = asText(theirV)
      let ancestor: string | undefined
      try { ancestor = await readBoundedHistoricalText(this.team.dir, mergeBase, path) ?? '' } catch { /* unavailable */ }
      for (const claim of theirClaims.filter(c => claimsOverlap(c, { path, from: 1, to: Number.MAX_SAFE_INTEGER }))) {
        const key = slotKey(this.owner, 'edit-in-claim', other, path, claim.id)
        seen.add(key)
        const inputs = hash(JSON.stringify([mine.head.semRev, theirs.head.semRev, mergeBase, claim.id, claim.from, claim.to, claim.claimedHash, sideInput(mine, path), sideInput(theirs, path)]))
        if (ownText === undefined || ancestor === undefined) {
          await this.settle(key, { owner: this.owner, other, kind: 'edit-in-claim', path, subject: claim.id, status: 'unknown', inputs, factId: '', why: 'cannot map claim' }); continue
        }
        const mapped = claim.path.endsWith('/') ? { from: 1, to: Math.max(1, ownText.split('\n').length), approximate: false } : claimInMyLines(claim, theirText, ownText)
        const ranges = changed.has(path) ? changedRanges(ancestor, ownText) : []
        const hit = ranges.find(r => claimsOverlap({ path, ...mapped }, { path, ...r }) && !ownClaims.some(c => claimsOverlap(c, { path, ...r })))
        let earlierSha: string | null | undefined
        let merges: 'clean' | undefined
        if (hit && !mapped.approximate && theirText !== undefined) {
          await this.budget()
          const merged = await gitMergeFile(ancestor, ownText, theirText, { ours: this.owner, base: 'base', theirs: other })
          if (!merged.conflicts.length) merges = 'clean'
        }
        if (hit) {
          const entryAt = mine.entries.get(path)?.at
          if (entryAt !== undefined && entryAt <= claim.at) earlierSha = null
          else if (entryAt === undefined) {
            const last = await git(this.team.dir, ['log', '-1', '--format=%H:%ct', mine.head.base, '--', path]).catch(() => '')
            const match = /^([0-9a-f]{40,64}):(\d+)/.exec(last.trim())
            if (match && Number(match[2]) * 1000 <= claim.at) earlierSha = match[1]!.slice(0, 7)
          }
        }
        await this.settle(key, { owner: this.owner, other, kind: 'edit-in-claim', path, subject: claim.id, status: hit ? mapped.approximate ? 'possible' : 'conflict' : 'clean', inputs,
          // Whether it merges is part of the fact: an overlap that stops merging is a new notice, a CONFLICT.
          factId: hit ? hash(JSON.stringify([claim.id, hit, mapped, ...merges ? [merges] : []])) : '', ...(hit ? { lines: [hit.from], why: mapped.approximate ? 'approximate range' : claim.intent, ...(earlierSha !== undefined ? { earlierSha } : {}), ...(merges ? { merges } : {}) } : {}) })
      }
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
        inputs: hash(JSON.stringify([mine.head.semRev, theirs.head.semRev, a.id, a.from, a.to, a.claimedHash, b.id, b.from, b.to, b.claimedHash])),
        factId: hit ? hash(JSON.stringify([subject, a.from, a.to, mapped])) : '' })
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

/** Bridge-facing level reconcile: the team owns the slot, the workers room owns W's notice. */
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
