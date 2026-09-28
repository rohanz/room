import { createHash } from 'node:crypto'
import { acceptedGit, bareSymbol, claimInMyLines, claimsOverlap, coversPath, observedContractChanges, participantRecord, participantsView, snapshot, versionOf, type Identity, type Msg, type NoteMsg, type ParticipantSnapshot, type PostBody, type RoomDoc, type Version } from '@room/shared'
import type { Post } from './post.js'
import type { Session } from './session.js'
import { git, gitShow } from '@room/roomd/git'
import { comparePair } from '@room/roomd'
import { gitMergeFile } from './merge.js'
import { structuredPatch } from 'diff'
import { carriedPaths, carriesWork, readBaseline, type Baseline } from '@room/roomd/baseline'
import { ensureLanguages, parseFile } from './parse/engine.js'
import { consumesSymbol } from './graph-index.js'

export type ConflictKind = 'merge' | 'edit-in-claim' | 'claims' | 'contract'
export type ConflictStatus = 'conflict' | 'possible' | 'unknown' | 'clean'
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
  epoch: number
  lines?: number[]
  why?: string
  fence: string
  checkedAt: number
  retryAt?: number
}
export type Evaluation = Pick<ConflictSlot, 'kind' | 'owner' | 'other' | 'path' | 'subject' | 'status' | 'inputs' | 'factId' | 'lines' | 'why'>

export const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const slotKey = (owner: string, kind: ConflictKind, other: string, path: string, subject = ''): string =>
  [owner, kind, other, path, subject].join('\0')
export const noticeId = (key: string, epoch: number): string => `cf:${hash(key)}:${epoch}`
const ROOM: Identity = { name: 'room', kind: 'agent' }
const retryMinutes = [1, 2, 4, 8]

/** The one writer of each owner's derived slots. The hub deduplicates posts by deterministic ID. */
export class ConflictSlots {
  private readonly map
  constructor(
    private readonly room: RoomDoc,
    private readonly post: Post,
    private readonly fence: string,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = () => {},
  ) { this.map = room.doc.getMap<ConflictSlot>('conflicts') }

  get(key: string): ConflictSlot | undefined { return this.map.get(key) }
  owned(owner: string): [string, ConflictSlot][] { return [...this.map.entries()].filter(([, slot]) => slot.owner === owner) }
  drop(key: string): void { this.room.doc.transact(() => this.map.delete(key)) }

  async settle(key: string, result: Evaluation): Promise<ConflictSlot> {
    const prev = this.map.get(key)
    const now = this.now()
    if (prev?.inputs === result.inputs && prev.status === result.status && prev.factId === result.factId && result.status !== 'unknown') return prev
    const changedFact = result.status === 'conflict' || result.status === 'possible'
      ? prev?.settled !== result.status || prev.factId !== result.factId : false
    const epoch = (prev?.epoch ?? 0) + (changedFact ? 1 : 0)
    const settled = result.status === 'unknown' ? prev?.settled ?? 'none' : result.status
    const unknownCount = result.status === 'unknown' ? Math.min(3, (prev?.status === 'unknown' ? Math.max(0, retryMinutes.findIndex(m => (prev.retryAt ?? 0) - prev.checkedAt <= m * 60_000)) + 1 : 0)) : 0
    const slot: ConflictSlot = {
      ...result, ...(result.status === 'unknown' && prev ? { factId: prev.factId } : {}), settled, epoch, fence: this.fence, checkedAt: now,
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
    const id = noticeId(key, slot.epoch) + (slot.settled === 'clean' ? ':clean' : '')
    const status = slot.settled
    const priority = status === 'possible' || status === 'clean' ? 'fyi' : slot.kind === 'edit-in-claim' ? 'interrupt' : 'notify'
    const text = status === 'possible'
      ? `${slot.other} changed ${slot.path} too, outside their declared area; Room cannot check this merge`
      : status === 'clean' ? `${slot.path}: the conflict with ${slot.other} cleared`
      : slot.kind === 'edit-in-claim' ? `you edited ${slot.path} inside ${slot.other}'s claim${slot.why ? ` (${slot.why})` : ''}`
      : slot.kind === 'claims' ? `concurrent overlapping claims in ${slot.path} with ${slot.other}`
      : slot.kind === 'contract' ? `${slot.other} changed ${slot.subject ?? 'a symbol'} in ${slot.path}${slot.why ? ` (${slot.why})` : ''}`
      : `${slot.path} conflicts with ${slot.other}'s version${slot.lines?.length ? ` at lines ${slot.lines.join(', ')}` : ''}`
    const body = (slot.kind === 'merge'
      ? { type: 'merge-conflict', path: slot.path, to: slot.owner, priority, text }
      : slot.kind === 'contract'
        ? { type: 'contract', path: slot.path, symbol: slot.subject ?? '', to: slot.owner, priority, text }
        : { type: 'conflict', claimId: slot.subject?.split('\0')[0] ?? '', otherClaimId: slot.subject?.split('\0')[1] ?? '', path: slot.path, to: slot.owner, priority, text }) as unknown as PostBody<Msg>
    const posted = await this.post(ROOM, body, { id, auto: true })
    if (!posted.ok) this.log(`conflict notice ${id}: ${posted.text}`)
    if (slot.kind === 'edit-in-claim' && status === 'conflict') {
      const holder = await this.post(ROOM, { ...body, to: slot.other, priority: 'notify' }, { id: `${noticeId(key, slot.epoch)}:holder`, auto: true })
      if (!holder.ok) this.log(`conflict holder notice ${id}: ${holder.text}`)
    }
  }
}

export const changedRanges = (base: string, live: string): { from: number; to: number }[] =>
  structuredPatch('a', 'b', base, live, '', '', { context: 0 }).hunks.map(h =>
    ({ from: h.newStart, to: h.newStart + Math.max(0, h.newLines - 1) }))
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
  constructor(private readonly team: Session, private readonly owner = team.me.name, private readonly notices: Session = team,
    private readonly log: (line: string) => void = line => process.stderr.write(`room-mcp: ${line}\n`), private readonly debounceMs = 2000,
    private readonly carriedFrom?: (participant: string) => { baseline: Baseline; lead: string } | undefined) {
    const record = participantRecord(team.room, owner)
    const fence = owner === team.me.name ? record?.holder?.sessionId ?? '' : participantRecord(team.room, team.me.name)?.holder?.sessionId ?? ''
    this.slots = new ConflictSlots(team.room, notices.post, fence, Date.now, log)
  }

  start(): void {
    const schedule = () => this.schedule()
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
    this.running = this.run(reason)
    try { await this.running } finally { this.running = undefined }
    if (this.rerun) { this.rerun = false; await this.reconcile('changed during check') }
  }

  private async run(reason: string): Promise<void> {
    const room = this.team.room
    const views = participantsView(room, this.team.awareness, Date.now())
    const mine = snapshot(room, this.owner, views)
    const ownGit = acceptedGit(participantRecord(room, this.owner), views)
    if (!mine || ownGit === 'updating') return
    const names = new Set([...room.manifestHead.keys(), ...room.openClaims().map(c => c.by), ...this.slots.owned(this.owner).map(([, s]) => s.other)])
    names.delete(this.owner)
    if (this.owner !== this.team.me.name) names.delete(this.team.me.name) // lead/own worker pair belongs to the workers room
    for (const other of [...names].sort()) {
      const theirs = snapshot(room, other, views)
      const theirGit = acceptedGit(participantRecord(room, other), views)
      const existing = this.slots.owned(this.owner).filter(([, s]) => s.other === other)
      if (!theirs && !participantRecord(room, other)) {
        for (const [key] of existing) this.slots.drop(key)
        continue
      }
      if (!theirs || theirGit === 'updating') {
        const why = `${other}'s manifest or base is updating`
        await this.slots.settle(slotKey(this.owner, 'merge', other, '*'), { owner: this.owner, other, kind: 'merge', path: '*', status: 'unknown', inputs: hash(why), factId: '', why })
        for (const [key, slot] of existing) if (slot.path !== '*') await this.slots.settle(key, { ...slot, status: 'unknown', inputs: hash(`${slot.inputs}\0${why}`), why })
        continue
      }
      await this.contracts(other, new Set([...mine.entries.keys(), ...room.openClaims().filter(c => c.by === this.owner).map(c => c.path)]), theirs)
      const pair = await comparePair(this.team.dir, ownGit.remote ?? theirGit.remote, ownGit, theirGit)
      if ('cannotCompare' in pair || !mine.head.complete || !theirs.head.complete || mine.head.coverage.kind !== 'all' || theirs.head.coverage.kind !== 'all' || !mine.fenceValid || !theirs.fenceValid) {
        const why = 'cannotCompare' in pair ? pair.cannotCompare : 'manifest is incomplete or fenced out'
        const key = slotKey(this.owner, 'merge', other, '*')
        await this.slots.settle(key, { owner: this.owner, other, kind: 'merge', path: '*', status: 'unknown', inputs: hash(JSON.stringify([ownGit, theirGit, mine.head.semRev, theirs.head.semRev, why])), factId: '', why })
        for (const [existingKey, slot] of existing) if (slot.path !== '*') await this.slots.settle(existingKey, { ...slot, status: 'unknown', inputs: hash(`${slot.inputs}\0${why}`), why })
        continue
      }
      this.slots.drop(slotKey(this.owner, 'merge', other, '*'))
      const mergeBase = pair.mergeBase
      const changed = async (snap: ParticipantSnapshot, base: string) => {
        const committed = await git(this.team.dir, ['diff', '--name-only', `${mergeBase}..${base}`]).catch(() => '')
        return new Set([...snap.entries.keys(), ...committed.split('\n').filter(Boolean)])
      }
      const [aPaths, bPaths] = await Promise.all([changed(mine, ownGit.base), changed(theirs, theirGit.base)])
      const candidates = new Set([...aPaths].filter(p => bPaths.has(p)))
      for (const [, slot] of existing) if (slot.kind === 'merge' && slot.path !== '*') candidates.add(slot.path)
      for (const path of [...candidates].sort()) {
        const key = slotKey(this.owner, 'merge', other, path)
        if (!aPaths.has(path) || !bPaths.has(path)) {
          await this.slots.settle(key, { owner: this.owner, other, kind: 'merge', path, status: 'clean', inputs: hash(JSON.stringify([ownGit.base, theirGit.base, mine.head.semRev, theirs.head.semRev, 'outside-candidate'])), factId: '' })
          continue
        }
        const inputs = hash(JSON.stringify([ownGit.base, theirGit.base, mergeBase, ownGit.anchored, theirGit.anchored,
          mine.head.semRev, theirs.head.semRev, sideInput(mine, path), sideInput(theirs, path)]))
        const previous = this.slots.get(key)
        if (previous?.inputs === inputs && previous.status !== 'unknown') continue
        const read = (snap: ParticipantSnapshot) => versionOf(snap, path, {
          gitAt: (sha, p) => gitShow(this.team.dir, sha, p),
          known: async blob => git(this.team.dir, ['cat-file', '-p', blob]).catch(() => undefined),
        })
        const [a, b] = await Promise.all([read(mine), read(theirs)])
        const held = [a, b].some(v => v.kind === 'held' && !v.entry.hash)
        if (held) {
          const aChange = mine.entries.get(path)?.change ?? 'committed', bChange = theirs.entries.get(path)?.change ?? 'committed'
          await this.slots.settle(key, { owner: this.owner, other, kind: 'merge', path, status: 'possible', inputs,
            factId: hash(['possible', path, mergeBase, aChange, bChange].join('\0')) })
          continue
        }
        const at = asText(a), bt = asText(b)
        if (at === undefined || bt === undefined) {
          await this.slots.settle(key, { owner: this.owner, other, kind: 'merge', path, status: 'unknown', inputs, factId: '', why: `cannot read ${at === undefined ? this.owner : other}'s version` })
          continue
        }
        let ancestor: string
        try { ancestor = await gitShow(this.team.dir, mergeBase, path) ?? '' }
        catch { await this.slots.settle(key, { owner: this.owner, other, kind: 'merge', path, status: 'unknown', inputs, factId: '', why: 'missing merge base' }); continue }
        await this.budget()
        const merged = await gitMergeFile(ancestor, at, bt, { ours: this.owner, base: 'base', theirs: other })
        const lines = merged.conflicts.map(c => c.from)
        await this.slots.settle(key, { owner: this.owner, other, kind: 'merge', path, status: lines.length ? 'conflict' : 'clean', inputs,
          factId: lines.length ? hash(JSON.stringify([mergeBase, ...merged.conflicts.map(c => c.o)])) : '', lines })
      }
      await this.claims(mine, theirs, other, mergeBase, aPaths)
    }
    await this.slots.replay(this.owner)
    this.log(`conflicts ${this.owner}: reconciled ${reason}`)
  }

  private async contracts(other: string, myPaths: Set<string>, theirs: ParticipantSnapshot): Promise<void> {
    const graph = this.team.room.graphs.get(other)
    const live = new Set<string>()
    const carried = this.carriedFrom?.(this.owner)
    let changes = graph?.observed ?? []
    if (carried?.lead === other && carriesWork(carried.baseline)) {
      const paths = new Set([...await carriedPaths(carried.baseline), ...theirs.entries.keys()])
      const observed: typeof changes = []
      for (const path of paths) {
        const before = await readBaseline(carried.baseline, path, (sha, p) => gitShow(this.team.dir, sha, p))
        if (before.kind === 'unavailable') {
          const key = slotKey(this.owner, 'contract', other, path, '*')
          await this.slots.settle(key, { owner: this.owner, other, kind: 'contract', path, subject: '*', status: 'unknown',
            inputs: hash(JSON.stringify([carried.baseline.sha, path, 'unavailable'])), factId: '', why: before.error.message })
          const id = `cf:${hash(`${key}\0${carried.baseline.sha}`)}:degraded`
          const notice = await this.notices.post<NoteMsg>(ROOM, { type: 'note', to: this.owner, priority: 'notify',
            text: `contract coverage degraded for ${path}: carried baseline unavailable; changes in this file cannot be checked` }, { id, auto: true })
          if (!notice.ok) this.log(`contract coverage notice ${id}: ${notice.text}`)
          continue
        }
        const version = await versionOf(theirs, path, { gitAt: (sha, p) => gitShow(this.team.dir, sha, p), known: blob => git(this.team.dir, ['cat-file', '-p', blob]).catch(() => undefined) })
        const after = asText(version)
        if (after === undefined) continue
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
      let uses: string[]
      if (carried?.lead === other && carriesWork(carried.baseline)) {
        uses = []
        for (const path of myPaths) {
          const version = await versionOf(snapshot(this.team.room, this.owner, participantsView(this.team.room, this.team.awareness, Date.now())), path,
            { gitAt: (sha, p) => gitShow(this.team.dir, sha, p), known: blob => git(this.team.dir, ['cat-file', '-p', blob]).catch(() => undefined) })
          const text = asText(version)
          if (text && await consumesSymbol(path, text, change.path, change.symbol, this.team.graph?.graph)) uses.push(path)
        }
        uses.sort()
      } else uses = graph?.edges.filter(edge => edge.source === change.path && myPaths.has(edge.target) &&
        edge.symbols.some(symbol => bareSymbol(symbol) === bareSymbol(change.symbol))).map(edge => edge.target).sort() ?? []
      if (!uses.length) continue
      const key = slotKey(this.owner, 'contract', other, change.path, change.symbol)
      live.add(key)
      const input = hash(JSON.stringify([change, uses]))
      await this.slots.settle(key, { owner: this.owner, other, kind: 'contract', path: change.path, subject: change.symbol,
        status: 'conflict', inputs: input, factId: hash(JSON.stringify([change.symbol, change.detail, change.kind])), why: change.detail })
    }
    for (const [key, slot] of this.slots.owned(this.owner)) {
      if (slot.kind !== 'contract' || slot.other !== other || live.has(key)) continue
      await this.slots.settle(key, { owner: this.owner, other, kind: 'contract', path: slot.path, subject: slot.subject,
        status: 'clean', inputs: hash(`clean\0${key}`), factId: '' })
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
    const read = (snap: ParticipantSnapshot, path: string) => versionOf(snap, path, { gitAt: (sha, p) => gitShow(this.team.dir, sha, p), known: blob => git(this.team.dir, ['cat-file', '-p', blob]).catch(() => undefined) })
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
          await this.slots.settle(key, { owner: this.owner, other, kind: 'edit-in-claim', path, subject: claim.id, status: 'unknown', inputs, factId: '', why: 'cannot map claim' }); continue
        }
        const mapped = claim.path.endsWith('/') ? { from: 1, to: Math.max(1, ownText.split('\n').length), approximate: false } : claimInMyLines(claim, theirText, ownText)
        const ranges = changed.has(path) ? changedRanges(ancestor, ownText) : []
        const hit = ranges.find(r => claimsOverlap({ path, ...mapped }, { path, ...r }) && !ownClaims.some(c => claimsOverlap(c, { path, ...r })))
        await this.slots.settle(key, { owner: this.owner, other, kind: 'edit-in-claim', path, subject: claim.id, status: hit ? mapped.approximate ? 'possible' : 'conflict' : 'clean', inputs,
          factId: hit ? hash(JSON.stringify([claim.id, hit, mapped])) : '', ...(hit ? { lines: [hit.from], why: mapped.approximate ? 'approximate range' : claim.intent } : {}) })
      }
    }
    for (const a of ownClaims) for (const b of theirClaims) {
      if (!coversPath(a.path, b.path)) continue
      if (a.path.endsWith('/') || b.path.endsWith('/')) {
        const subject = `${a.id}\0${b.id}`, path = a.path.endsWith('/') ? b.path : a.path, key = slotKey(this.owner, 'claims', other, path, subject)
        seen.add(key)
        await this.slots.settle(key, { owner: this.owner, other, kind: 'claims', path, subject, status: 'conflict',
          inputs: hash(JSON.stringify([a.id, a.path, a.from, a.to, b.id, b.path, b.from, b.to])), factId: hash(JSON.stringify([subject, a.path, b.path])) })
        continue
      }
      const [av, bv] = await Promise.all([read(mine, a.path), read(theirs, b.path)])
      const at = asText(av), bt = asText(bv)
      const mapped = at === undefined ? { from: 1, to: Number.MAX_SAFE_INTEGER, approximate: true } : claimInMyLines(b, bt, at)
      const subject = `${a.id}\0${b.id}`, key = slotKey(this.owner, 'claims', other, a.path, subject)
      seen.add(key)
      const hit = claimsOverlap(a, { path: b.path, ...mapped })
      await this.slots.settle(key, { owner: this.owner, other, kind: 'claims', path: a.path, subject,
        status: hit ? mapped.approximate ? 'possible' : 'conflict' : 'clean',
        inputs: hash(JSON.stringify([mine.head.semRev, theirs.head.semRev, a.id, a.from, a.to, a.claimedHash, b.id, b.from, b.to, b.claimedHash])),
        factId: hit ? hash(JSON.stringify([subject, a.from, a.to, mapped])) : '' })
    }
    for (const [key, slot] of this.slots.owned(this.owner)) {
      if (slot.other !== other || (slot.kind !== 'claims' && slot.kind !== 'edit-in-claim') || seen.has(key)) continue
      await this.slots.settle(key, { owner: this.owner, other, kind: slot.kind, path: slot.path, subject: slot.subject,
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
export async function reconcileProjectedConflicts({ team, workers, owner }: { team: Session; workers: Session; owner: string }): Promise<void> {
  await new ConflictSet(team, owner, workers).reconcile('projection')
}
