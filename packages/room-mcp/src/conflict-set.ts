import { createHash, randomUUID } from 'node:crypto'
import { acceptedGit, claimInMyLines, claimsOverlap, containsPath, coversPath, digestPath, gitBlobHash, manifestKey, neighbours, observedContractChanges, participantRecord, participantsView, snapshot, snapshotStillCurrent, versionOf, type Identity, type Msg, type NoteMsg, type ParticipantSnapshot, type PostBody, type RoomDoc, type Version } from '@room/shared'
import type { Post } from './post.js'
import type { Session } from './session.js'
import { git, gitShow } from '@room/roomd/git'
import { comparePair } from '@room/roomd'
import { gitMergeFile } from './merge.js'
import { diffLines } from 'diff'
import { carriedPaths, carriesWork, readBaseline, type Baseline } from '@room/roomd/baseline'
import { ensureLanguages, parseFile } from './parse/engine.js'
import { consumesSymbol } from './graph-index.js'
import { trustedWorker, workerText } from './tools/context.js'

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
  fence: string
  checkedAt: number
  retryAt?: number
  retrySource?: string
  /** Consumer paths are published only while their text grants remain valid. */
  consumers?: string[]
}
export type Evaluation = Pick<ConflictSlot, 'kind' | 'owner' | 'other' | 'path' | 'subject' | 'status' | 'inputs' | 'factId' | 'lines' | 'why' | 'retrySource' | 'consumers'>

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const slotKey = (owner: string, kind: ConflictKind, other: string, path: string, subject = ''): string =>
  [owner, kind, other, path, subject].join('\0')
export const noticeId = (key: string, epoch: number, episode?: string): string =>
  `cf:${hash(key)}:${epoch}${episode ? `:${episode}` : ''}`
const ROOM: Identity = { name: 'room', kind: 'agent' }
const retryMinutes = [1, 2, 4, 8]
class StaleConflictInputs extends Error {}

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
    const unknownCount = result.status === 'unknown' ? Math.min(3, (prev?.status === 'unknown' ? Math.max(0, retryMinutes.findIndex(m => (prev.retryAt ?? 0) - prev.checkedAt <= m * 60_000)) + 1 : 0)) : 0
    const slot: ConflictSlot = {
      ...result, ...(result.status === 'unknown' && prev ? { factId: prev.factId } : {}), settled, epoch, fence, checkedAt: now,
      ...(result.kind === 'contract' && (!prev || prev.episode) ? { episode: prev?.episode ?? randomUUID() } : {}),
      ...(result.status === 'clean' && (prev?.settled === 'conflict' || prev?.settled === 'possible') ? { clearedFrom: prev.settled } : {}),
      ...(result.status === 'unknown' ? { retryAt: now + retryMinutes[unknownCount]! * 60_000 } : {}),
    }
    this.room.doc.transact(() => this.map.set(key, slot))
    if (changedFact) await this.postNotice(key, slot)
    else if (result.status === 'clean' && (prev?.settled === 'conflict' || prev?.settled === 'possible')) await this.postNotice(key, slot)
    return slot
  }

  /** A reconnect re-derives owed notices from replicated slots, without an in-memory queue. */
  async replay(owner: string): Promise<void> {
    for (const [key, slot] of this.owned(owner)) {
      if (slot.settled === 'conflict' || slot.settled === 'possible' || (slot.settled === 'clean' && slot.epoch > 0)) await this.postNotice(key, slot)
    }
  }

  async postNotice(key: string, slot: ConflictSlot): Promise<void> {
    const current = () => this.valid() && this.map.get(key) === slot && (typeof this.fence === 'function' ? this.fence() : this.fence) === slot.fence
    if (!current()) return
    const id = noticeId(key, slot.epoch, slot.episode) + (slot.settled === 'clean' ? ':clean' : '')
    const status = slot.settled
    const priority = status === 'possible' || status === 'clean' ? 'fyi' : slot.kind === 'edit-in-claim' ? 'interrupt' : 'notify'
    const text = status === 'possible'
      ? slot.kind === 'edit-in-claim' ? `you may have edited ${slot.path} inside ${slot.other}'s claim; line mapping is approximate`
        : slot.kind === 'claims' ? `claims in ${slot.path} may overlap with ${slot.other}; line mapping is approximate`
          : `${slot.why ?? slot.other} changed ${slot.path} too, outside their declared area; Room cannot check this merge`
      : status === 'clean' ? `${slot.path}: the ${slot.clearedFrom === 'possible' ? 'possible conflict' : 'conflict'} with ${slot.other} cleared`
      : slot.kind === 'edit-in-claim' ? `you edited ${slot.path} inside ${slot.other}'s claim${slot.why ? ` (${slot.why})` : ''}`
      : slot.kind === 'claims' ? `concurrent overlapping claims in ${slot.path} with ${slot.other}`
      : slot.kind === 'contract' ? `${slot.other} changed ${slot.subject ?? 'a symbol'} in ${slot.path}${slot.why ? ` (${slot.why})` : ''}`
      : `${slot.path} conflicts with ${slot.other}'s version${slot.lines?.length ? ` at lines ${slot.lines.join(', ')}` : ''}`
    const clearedFrom = status === 'clean' ? slot.clearedFrom : undefined
    const body = (slot.kind === 'merge'
      ? { type: 'merge-conflict', path: slot.path, to: slot.owner, priority, text, ...(clearedFrom ? { clearedFrom } : {}) }
      : slot.kind === 'contract'
        ? { type: 'contract', path: slot.path, symbol: slot.subject ?? '', to: slot.owner, priority, text }
        : { type: 'conflict', claimId: slot.subject?.split('\0')[0] ?? '', otherClaimId: slot.subject?.split('\0')[1] ?? '', path: slot.path, to: slot.owner, priority, text, ...(clearedFrom ? { clearedFrom } : {}) }) as unknown as PostBody<Msg>
    try {
      const posted = await this.post(ROOM, body, { id, auto: true })
      if (!posted.ok) this.log(`conflict notice ${id}: ${posted.text}`)
    } catch (e) { this.log(`conflict notice ${id}: ${String(e)}`) }
    if (slot.kind === 'edit-in-claim' && status === 'conflict') {
      if (!current()) return
      try {
        const holder = await this.holderPost(ROOM, { ...body, to: slot.other, priority: 'notify', text: `${slot.owner} edited ${slot.path} inside your claim${slot.why ? ` (${slot.why})` : ''}` } as PostBody<Msg>, { id: `${noticeId(key, slot.epoch)}:holder`, auto: true })
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
const sideInput = (snap: ParticipantSnapshot, path: string): unknown => {
  const entry = snap.entries.get(path)
  return entry ? entry.state === 'held' && !entry.hash
    ? { change: entry.change, state: entry.state, held: entry.held }
    : { hash: entry.hash, state: entry.state, change: entry.change }
    : { committed: snap.head.base }
}

/** Reconciles one owner's slots against all other comparable bases. */
export class ConflictSet {
  private readonly slots: ConflictSlots
  private readonly stops: (() => void)[] = []
  private timer: NodeJS.Timeout | undefined
  private tick: NodeJS.Timeout | undefined
  private running: Promise<void> | undefined
  private rerun = false
  private starts: number[] = []
  private readonly contractCache = new Map<string, ReturnType<typeof observedContractChanges>>()
  private guard: (() => boolean) | undefined
  constructor(private readonly team: Session, private readonly owner = team.me.name, private readonly notices: Session = team,
    private readonly log: (line: string) => void = line => process.stderr.write(`room-mcp: ${line}\n`), private readonly debounceMs = 2000,
    private readonly carriedFrom?: (participant: string) => { baseline: Baseline; lead: string } | undefined) {
    const fence = () => team.lease?.fence() ?? ''
    this.slots = new ConflictSlots(team.room, notices.post, fence, Date.now, log, team.post, () => this.guard?.() ?? false)
  }

  start(): void {
    const schedule = () => { this.withdrawUnauthorizedContracts(); this.schedule() }
    for (const map of [this.team.room.manifest, this.team.room.manifestHead, this.team.room.participants, this.team.room.claims, this.team.room.graphs]) {
      map.observe(schedule)
      this.stops.push(() => map.unobserve(schedule))
    }
    const onSync = () => this.schedule(0)
    this.team.provider.on?.('sync', onSync)
    this.stops.push(() => this.team.provider.off?.('sync', onSync))
    this.tick = setInterval(() => this.schedule(0), 60_000)
    this.tick.unref?.()
    if (this.team.provider.synced) this.schedule(0)
  }
  /** Remove every contract whose provider or consumer has left its text grant. */
  private withdrawUnauthorizedContracts(): void {
    if (!this.team.lease?.fence()) return
    const room = this.team.room
    const views = participantsView(room, this.team.awareness, Date.now())
    const mine = snapshot(room, this.owner, views)
    const stale = new Set<string>()
    for (const [key, slot] of this.slots.owned(this.owner)) {
      if (slot.kind !== 'contract') continue
      const theirs = snapshot(room, slot.other, views)
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
  private contractPathAuthorized(snap: ParticipantSnapshot | undefined, path: string): boolean {
    const room = this.team.room
    const head = snap?.head
    if (!snap?.fenceValid || !head || !room.roomSalt) return false
    const textAllowed = head.level === 'full' || head.level === 'declared' &&
      (head.textPrefixes ?? []).some(prefix => containsPath(prefix, path))
    const entry = room.manifest.get(manifestKey(snap.name, head.fence))?.get(path)
    return textAllowed && (!entry || entry.state === 'shared' && (entry.change === 'D' ? !entry.hash : !!entry.hash) && entry.fence === head.fence) &&
      !head.excluded.includes(digestPath(room.roomSalt, path))
  }
  private unknownContracts(other: string, why: string): void {
    this.withdrawUnauthorizedContracts()
    this.slots.markContractsUnknown(this.owner, other, why)
  }
  stop(): void {
    for (const stop of this.stops) stop()
    this.stops.length = 0
    if (this.timer) clearTimeout(this.timer)
    if (this.tick) clearInterval(this.tick)
  }
  private schedule(ms = this.debounceMs): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.reconcile('change').catch(e => this.log(`conflict reconcile: ${String(e)}`)) }, ms)
    this.timer.unref?.()
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    await this.reconcile('flush')
  }
  async reconcile(reason: string): Promise<void> {
    if (this.running) { this.rerun = true; await this.running; return }
    this.running = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await this.run(reason); return }
        catch (e) { if (!(e instanceof StaleConflictInputs)) throw e }
      }
      this.log(`conflicts ${this.owner}: inputs moved twice; retry on next change`)
    })()
    try { await this.running } finally { this.running = undefined }
    if (this.rerun) { this.rerun = false; await this.reconcile('changed during check') }
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
    const env = { gitAt: (sha: string, p: string) => gitShow(this.team.dir, sha, p),
      known: async (blob: string) => git(this.team.dir, ['cat-file', '-p', blob]).catch(() => undefined) }
    const projected = snap.name === this.owner && snap.head.projectedFrom && this.notices.room !== this.team.room
    const projectedEntry = snap.entries.get(path)
    if (projected && projectedEntry?.state === 'held' && projectedEntry.hash) {
      const source = snapshot(this.notices.room, this.owner, participantsView(this.notices.room, this.notices.awareness, Date.now()))
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
          const text = workerText(worker.dir, path)
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
    const room = this.team.room
    const leaseFence = this.team.lease?.fence()
    if (!leaseFence) return
    this.withdrawUnauthorizedContracts()
    const views = participantsView(room, this.team.awareness, Date.now())
    const mine = snapshot(room, this.owner, views)
    if (!mine || mine.head.fence !== leaseFence) return
    const ownNonPublisher = mine.head.coverage.kind === 'none' && mine.head.coverage.reason === 'not-publisher' && !!mine.head.publisher
    const ownPublisher = ownNonPublisher ? snapshot(room, mine.head.publisher!, views) : undefined
    const ownGit = acceptedGit(participantRecord(room, ownNonPublisher ? mine.head.publisher! : this.owner), views)
    if (ownGit === 'updating' || (ownNonPublisher && !ownPublisher)) return
    const authority = () => this.team.lease?.fence() === leaseFence
    const claimInputs = JSON.stringify(room.openClaims())
    this.guard = () => authority() && snapshotStillCurrent(room, mine, participantsView(room, this.team.awareness, Date.now())) &&
      (!ownPublisher || snapshotStillCurrent(room, ownPublisher, participantsView(room, this.team.awareness, Date.now()))) &&
      JSON.stringify(room.openClaims()) === claimInputs
    const nb = neighbours(views, this.owner)
    const names = new Set(nb.names())
    for (const [key, slot] of this.slots.owned(this.owner)) if (!nb.has(slot.other)) this.drop(key)
    names.delete(this.owner)
    if (this.owner !== this.team.me.name) names.delete(this.team.me.name) // lead/own worker pair belongs to the workers room
    for (const other of [...names].sort()) {
      const theirs = snapshot(room, other, views)
      const theirGit = acceptedGit(participantRecord(room, other), views)
      const graphInput = JSON.stringify(room.graphs.get(other))
      this.guard = () => {
        const current = participantsView(room, this.team.awareness, Date.now())
        return authority() && snapshotStillCurrent(room, mine, current) && (!theirs || snapshotStillCurrent(room, theirs, current)) &&
          (!ownPublisher || snapshotStillCurrent(room, ownPublisher, current)) &&
          JSON.stringify(room.openClaims()) === claimInputs && JSON.stringify(room.graphs.get(other)) === graphInput
      }
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
      const ownMergePaths = new Set(aPaths)
      const unchangedCarried = new Set<string>()
      const carried = this.carriedFrom?.(this.owner)
      if (carried?.lead === other && carriesWork(carried.baseline)) {
        for (const path of aPaths) {
          const baseline = await readBaseline(carried.baseline, path, (sha, p) => gitShow(this.team.dir, sha, p))
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
        try { ancestor = await gitShow(this.team.dir, mergeBase, path) ?? '' }
        catch { await this.settle(key, { owner: this.owner, other, kind: 'merge', path, status: 'unknown', inputs, factId: '', why: 'missing merge base' }); continue }
        await this.budget()
        const merged = await gitMergeFile(ancestor, at, bt, { ours: this.owner, base: 'base', theirs: other })
        const lines = merged.conflicts.map(c => c.from)
        await this.settle(key, { owner: this.owner, other, kind: 'merge', path, status: lines.length ? 'conflict' : 'clean', inputs,
          factId: lines.length ? hash(JSON.stringify([mergeBase, ...merged.conflicts.map(c => c.o)])) : '', lines })
      }
      await this.claims(mine, theirs, other, mergeBase, ownMergePaths)
    }
    if (this.guard && !this.guard()) throw new StaleConflictInputs()
    await this.slots.replay(this.owner)
    this.log(`conflicts ${this.owner}: reconciled ${reason}`)
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
        if (!this.contractPathAuthorized(theirs, path)) continue
        const before = await readBaseline(carried.baseline, path, (sha, p) => gitShow(this.team.dir, sha, p))
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
        const version = await versionOf(theirs, path, { gitAt: (sha, p) => gitShow(this.team.dir, sha, p), known: blob => git(this.team.dir, ['cat-file', '-p', blob]).catch(() => undefined) })
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
    const ownClaims = all.filter(c => c.by === this.owner), theirClaims = all.filter(c => c.by === other)
    const seen = new Set<string>()
    const paths = new Set([
      ...theirClaims.flatMap(c => c.path.endsWith('/') ? [...changed].filter(path => claimsOverlap(c, { path, from: 1, to: Number.MAX_SAFE_INTEGER })) : [c.path]),
      ...this.slots.owned(this.owner).filter(([, s]) => s.other === other && s.kind === 'edit-in-claim').map(([, s]) => s.path),
    ])
    const read = (snap: ParticipantSnapshot, path: string) => this.read(snap, path)
    for (const path of paths) {
      if (path.endsWith('/')) continue
      const [ownV, theirV] = await Promise.all([read(mine, path), read(theirs, path)])
      const ownText = asText(ownV), theirText = asText(theirV)
      let ancestor: string | undefined
      try { ancestor = await gitShow(this.team.dir, mergeBase, path) ?? '' } catch { /* unavailable */ }
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
        await this.settle(key, { owner: this.owner, other, kind: 'edit-in-claim', path, subject: claim.id, status: hit ? mapped.approximate ? 'possible' : 'conflict' : 'clean', inputs,
          factId: hit ? hash(JSON.stringify([claim.id, hit, mapped])) : '', ...(hit ? { lines: [hit.from], why: mapped.approximate ? 'approximate range' : claim.intent } : {}) })
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
      const mapped = at === undefined ? { from: 1, to: Number.MAX_SAFE_INTEGER, approximate: true } : claimInMyLines(b, bt, at)
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
