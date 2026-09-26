import diff from 'fast-diff'
import { claimsOverlap } from './claims.js'
import { MessageKinds } from './messages.js'
import * as Y from 'yjs'
import type {
  ChatItem,
  Claim,
  ClaimAnchor,
  Identity,
  Meta,
  Msg,
  MsgType,
  Priority,
  Scope,
  Worker,
  RetiredWorker,
  ReleaseMsg,
} from './types.js'
import { newId, PALETTE } from './identity.js'
import type { GraphSnapshot } from './graph.js'
import { ledger as ledgerView, areaSummary as areaSummaryView, emptyLedgerArchive, foldLedger, messageAreas, compactRetiredWorker, MAX_RETIRED_WORKERS, type LedgerArchive, type LedgerQuery } from './ledger.js'

type ScopeInput = Omit<Scope, 'by' | 'at'> & { at?: number }
type NewScope = Omit<Scope, 'at'> & { at?: number }
type PostBody<T extends Msg> = Omit<T, 'id' | 'at' | 'from' | 'fromKind' | 'priority'> & { priority?: Priority }
const validColorIndex = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < PALETTE.length

/** Default bus priority from spec §6. */
export function defaultPriority(msg: { type: MsgType; symbols?: readonly string[]; [key: string]: unknown }): Priority {
  const kind = MessageKinds[msg.type]
  if (!kind) throw new Error(`unregistered message kind: ${msg.type}`)
  return typeof kind.priority === 'function' ? kind.priority(msg) : kind.priority
}

/** Typed accessors over the single room Y.Doc. */
export class RoomDoc {
  readonly doc: Y.Doc
  private colorName?: string
  private colorOrigin?: unknown
  get graphs(): Y.Map<GraphSnapshot> { return this.doc.getMap<GraphSnapshot>('graphs') }
  /** Persistent participant -> palette slot assignments. */
  get colors(): Y.Map<number> { return this.doc.getMap<number>('colors') }

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc
    this.colors.observe(() => { if (this.colorName) this.reconcileColors(this.colorName, this.colorOrigin) })
  }

  /** Claim the lowest unused slot, retaining existing slots across reconnects. */
  assignColor(name: string, origin?: unknown): number {
    this.colorName = name
    this.colorOrigin = origin
    if (!this.colors.has(name)) {
      const used = new Set(Array.from(this.colors.values()).filter(validColorIndex))
      const free = Array.from({ length: PALETTE.length }, (_, i) => i).find(i => !used.has(i))
      this.doc.transact(() => { this.colors.set(name, free ?? (this.colors.size % PALETTE.length)) }, origin)
    }
    this.reconcileColors(name, origin)
    return this.colors.get(name)!
  }

  /** Lexically first keeps a concurrently claimed slot; a later caller moves only its own slot. */
  reconcileColors(name: string, origin?: unknown): void {
    const current = this.colors.get(name)
    if (current === undefined) return
    const entries = [...this.colors.entries()]
    const losesTie = validColorIndex(current) && entries.some(([other, slot]) => other.localeCompare(name) < 0 && slot === current)
    if (validColorIndex(current) && !losesTie) return
    const used = new Set(entries.flatMap(([other, slot]) => other !== name && validColorIndex(slot) ? [slot] : []))
    const free = Array.from({ length: PALETTE.length }, (_, i) => i).find(i => !used.has(i))
    if (free !== undefined && free !== current) this.doc.transact(() => { this.colors.set(name, free) }, origin)
  }

  get overlays(): Y.Map<Y.Map<Y.Text>> { return this.doc.getMap<Y.Map<Y.Text>>('overlays') }
  /** person -> ms of their last overlay write (set/clear/delete); lets a later joiner evict stale work. */
  get overlayAt(): Y.Map<number> { return this.doc.getMap<number>('overlayAt') }
  overlayAtOf(person: string): number | undefined { return this.overlayAt.get(person) }
  /** ms since the person's last overlay write; undefined when they never wrote one. */
  overlayAge(person: string, now = Date.now()): number | undefined {
    const at = this.overlayAt.get(person)
    return at === undefined ? undefined : Math.max(0, now - at)
  }
  /** Drop everything a person has shared: overlays, deletions and their timestamp. */
  clearOverlays(person: string, origin?: unknown): number {
    const n = this.changedPaths(person).length
    this.doc.transact(() => {
      this.overlays.delete(person)
      this.deleted.delete(person)
      this.overlayAt.delete(person)
    }, origin)
    return n
  }
  get deleted(): Y.Map<Y.Map<true>> { return this.doc.getMap<Y.Map<true>>('deleted') }
  get scopes(): Y.Map<Scope> { return this.doc.getMap<Scope>('scopes') }
  get claims(): Y.Map<Claim> { return this.doc.getMap<Claim>('claims') }
  get bus(): Y.Array<Msg> { return this.doc.getArray<Msg>('bus') }
  /** Compact histories keyed by area; `_room` contains every archived message. */
  get ledgerArchives(): Y.Map<LedgerArchive> { return this.doc.getMap<LedgerArchive>('ledger') }
  /** Workers dispatched into this room by leads (room_spawn), keyed by tag. */
  get workers(): Y.Map<Worker> { return this.doc.getMap<Worker>('workers') }
  setWorker(w: Worker): void {
    this.doc.transact(() => {
      const prior = this.workers.get(w.tag)
      if (prior && (prior.id !== w.id || prior.startedAt !== w.startedAt)) this.clearWorkerCoordination(prior.name)
      this.workers.set(w.tag, w)
    })
  }
  /** Patch the record under `tag`; with `id`, only if that is still the record's identity (an older spawn must not touch a newer one). */
  updateWorker(tag: string, patch: Partial<Worker>, id?: string): Worker | undefined {
    const w = this.workers.get(tag)
    if (!w || (id !== undefined && w.id !== id)) return undefined
    const next = { ...w, ...patch }
    this.workers.set(tag, next)
    return next
  }
  workerOf(name: string): Worker | undefined { for (const w of this.workers.values()) if (w.name === name) return w; return undefined }
  workerById(id: string): Worker | undefined { for (const w of this.workers.values()) if (w.id === id) return w; return undefined }
  retiredWorkers(): RetiredWorker[] { return this.doc.getArray<RetiredWorker>('retiredWorkers').toArray() }

  /** Repair older archives that left live records behind; this is document-only and cheap for room_state. */
  sweepRetiredWorkers(present: ReadonlySet<string> = new Set()): number {
    let swept = 0
    for (const retired of this.retiredWorkers()) {
      if (present.has(retired.name)) continue
      const currentWorkers = [...this.workers.values()].filter(w => w.name === retired.name)
      // A name can later belong to a standalone participant. Only the matching live
      // worker record proves that coordination under it belongs to this retirement.
      if (currentWorkers.length !== 1) continue
      const current = currentWorkers[0]
      if (current.startedAt !== retired.startedAt || current.lead !== retired.lead || current.tag !== retired.tag) continue
      this.retireParticipant(retired.name, retired)
      swept++
    }
    return swept
  }

  /** Remove coordination from a worker that can no longer act, including records from older releases. */
  clearWorkerCoordination(name: string, reason = 'worker stopped'): void {
    this.doc.transact(() => {
      for (const claim of this.claims.values()) if (claim.by === name) {
        this.claims.delete(claim.id)
        this.post<ReleaseMsg>({ name, kind: claim.byKind }, { type: 'release', claimId: claim.id, path: claim.path, summary: reason })
      }
      this.clearOverlays(name)
      this.scopes.delete(name)
      this.graphs.delete(name)
    })
  }

  /** Atomically replace live worker state with a bounded archive entry. */
  retireParticipant(name: string, record: RetiredWorker): void {
    if (record.name !== name) throw new Error('retirement name does not match record')
    const current = this.workerOf(name)
    if (current && (current.startedAt !== record.startedAt || current.lead !== record.lead)) return
    this.doc.transact(() => {
      const archive = this.doc.getArray<RetiredWorker>('retiredWorkers')
      this.clearWorkerCoordination(name, 'retired')
      const archived = archive.toArray().some(r => r.name === name && r.startedAt === record.startedAt && r.lead === record.lead)
      this.colors.delete(name)
      this.bases.delete(name)
      this.seen(name).clear()
      const worker = this.workers.get(record.tag)
      if (worker?.name === name && worker.startedAt === record.startedAt) this.workers.delete(record.tag)
      if (!archived) {
        archive.push([compactRetiredWorker(record)])
        if (archive.length > MAX_RETIRED_WORKERS) archive.delete(0, archive.length - MAX_RETIRED_WORKERS)
      }
    })
  }
  get metaMap(): Y.Map<string | number> { return this.doc.getMap<string | number>('meta') }
  /** Base-commit text of files someone has changed, keyed "<sha>:<path>", so browsers can three-way merge. */
  get baseTexts(): Y.Map<string> { return this.doc.getMap<string>('basetext') }
  baseText(sha: string, relpath: string): string | undefined { return this.baseTexts.get(`${sha}:${relpath}`) }
  setBaseText(sha: string, relpath: string, text: string, origin?: unknown): void {
    const k = `${sha}:${relpath}`
    if (this.baseTexts.has(k)) return
    this.doc.transact(() => { this.baseTexts.set(k, text) }, origin)
  }
  /** Each person's own HEAD: the commit their overlay is a delta from. */
  get bases(): Y.Map<string> { return this.doc.getMap<string>('bases') }
  baseOf(person: string): string | undefined { return this.bases.get(person) ?? this.meta.base }
  setBaseOf(person: string, sha: string, origin?: unknown): void { this.doc.transact(() => { this.bases.set(person, sha) }, origin) }

  // ---- overlays ----------------------------------------------------------

  overlay(person: string): Y.Map<Y.Text> {
    let map = this.overlays.get(person)
    if (!map) {
      map = new Y.Map<Y.Text>()
      this.overlays.set(person, map)
    }
    return map
  }

  overlayText(person: string, relpath: string): Y.Text | undefined {
    return this.overlays.get(person)?.get(relpath)
  }

  /** Apply character-level diff operations, preserving Yjs relative positions. */
  setOverlay(person: string, relpath: string, content: string, origin?: unknown): void {
    const existing = this.overlayText(person, relpath)
    if (existing?.toString() === content) return
    this.doc.transact(() => {
      let text = this.overlayText(person, relpath)
      if (!text) {
        text = new Y.Text()
        this.overlay(person).set(relpath, text)
      }
      let index = 0
      for (const [kind, value] of diff(text.toString(), content)) {
        if (kind === diff.EQUAL) index += value.length
        else if (kind === diff.DELETE) text.delete(index, value.length)
        else {
          text.insert(index, value)
          index += value.length
        }
      }
      this.overlayAt.set(person, Date.now())
    }, origin)
  }

  clearOverlay(person: string, relpath: string, origin?: unknown): void {
    const map = this.overlays.get(person)
    if (!map?.has(relpath)) return
    this.doc.transact(() => { map.delete(relpath); this.overlayAt.set(person, Date.now()) }, origin)
  }

  deletedFor(person: string): Y.Map<true> {
    let map = this.deleted.get(person)
    if (!map) {
      map = new Y.Map<true>()
      this.deleted.set(person, map)
    }
    return map
  }

  markDeleted(person: string, relpath: string, origin?: unknown): void {
    if (this.deleted.get(person)?.has(relpath)) return
    this.doc.transact(() => { this.deletedFor(person).set(relpath, true); this.overlayAt.set(person, Date.now()) }, origin)
  }

  unmarkDeleted(person: string, relpath: string, origin?: unknown): void {
    const map = this.deleted.get(person)
    if (!map?.has(relpath)) return
    this.doc.transact(() => { map.delete(relpath) }, origin)
  }

  changedPaths(person: string): string[] {
    return Array.from(new Set([
      ...Array.from(this.overlays.get(person)?.keys() ?? []),
      ...Array.from(this.deleted.get(person)?.keys() ?? []),
    ])).sort()
  }

  whoChanged(relpath: string): string[] {
    const people = new Set<string>()
    for (const [person, map] of this.overlays) if (map.has(relpath)) people.add(person)
    for (const [person, map] of this.deleted) if (map.has(relpath)) people.add(person)
    return Array.from(people).sort()
  }

  scope(person: string): Scope | undefined { return this.scopes.get(person) }
  allScopes(): Scope[] { return Array.from(this.scopes.values()).sort((a, b) => a.at - b.at) }
  ledger(q: LedgerQuery = {}): Msg[] { return ledgerView(this.messages(), this.allScopes(), q) }
  archivedLedger(q: Pick<LedgerQuery, 'area'> = {}): LedgerArchive {
    return this.ledgerArchives.get(q.area ?? '_room') ?? emptyLedgerArchive()
  }
  areaSummary(windowMs?: number): string[] { return areaSummaryView(this.messages(), this.allScopes(), windowMs) }

  setScope(scope: NewScope, origin?: unknown): Scope
  setScope(person: string, scope: ScopeInput, origin?: unknown): Scope
  setScope(personOrScope: string | NewScope, scopeOrOrigin?: ScopeInput | unknown, origin?: unknown): Scope {
    const value: Scope = typeof personOrScope === 'string'
      ? { ...(scopeOrOrigin as ScopeInput), by: personOrScope, at: (scopeOrOrigin as ScopeInput).at ?? Date.now() }
      : { ...personOrScope, at: personOrScope.at ?? Date.now() }
    const transactionOrigin = typeof personOrScope === 'string' ? origin : scopeOrOrigin
    this.doc.transact(() => { this.scopes.set(value.by, value) }, transactionOrigin)
    return value
  }

  clearScope(person: string, origin?: unknown): Scope | undefined {
    const scope = this.scopes.get(person)
    if (scope) this.doc.transact(() => { this.scopes.delete(person) }, origin)
    return scope
  }

  text(relpath: string, person?: string): string | undefined {
    return person ? this.overlayText(person, relpath)?.toString() : undefined
  }

  /** Compatibility helper for phase-1 consumers: aggregate changed paths. */
  paths(person?: string): string[] {
    if (person) return this.changedPaths(person)
    const paths = new Set<string>()
    for (const p of this.overlays.keys()) for (const relpath of this.changedPaths(p)) paths.add(relpath)
    for (const p of this.deleted.keys()) for (const relpath of this.changedPaths(p)) paths.add(relpath)
    return Array.from(paths).sort()
  }

  hasFile(relpath: string, person?: string): boolean {
    return person ? this.overlayText(person, relpath) !== undefined : this.whoChanged(relpath).length > 0
  }

  lineCount(relpath: string, person?: string): number {
    const text = this.text(relpath, person)
    if (text === undefined) return 0
    const count = text.split('\n').length
    return text.endsWith('\n') ? count - 1 : count
  }

  // ---- meta --------------------------------------------------------------

  get meta(): Meta {
    const map = this.metaMap
    return {
      repo: map.get('repo') as string | undefined,
      branch: map.get('branch') as string | undefined,
      base: map.get('base') as string | undefined,
      createdAt: map.get('createdAt') as number | undefined,
      seededBy: map.get('seededBy') as string | undefined,
    }
  }

  setMeta(patch: Partial<Meta>, origin?: unknown): void {
    this.doc.transact(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) this.metaMap.set(key, value as string | number)
      }
    }, origin)
  }

  // ---- claims ------------------------------------------------------------

  openClaims(): Claim[] {
    return Array.from(this.claims.values())
      .map(claim => ({ ...claim, ...this.claimRange(claim) }))
      .sort((a, b) => a.at - b.at)
  }

  claimsFor(relpath: string): Claim[] { return this.openClaims().filter(claim => claimsOverlap(claim, { path: relpath, from: 1, to: Number.MAX_SAFE_INTEGER })) }

  /** Everyone who was shown a message: recipients of routed copies plus agents with a read receipt for it or its copies. */
  dependentsOf(msgId: string): string[] {
    const out = new Set<string>(this.seenBy(msgId))
    for (const m of this.messages()) if (m.copyOf === msgId) { if (m.to) out.add(m.to); for (const p of this.seenBy(m.id)) out.add(p) }
    return Array.from(out).sort()
  }

  setClaimMsg(claimId: string, msgId: string, origin?: unknown): void {
    const c = this.claims.get(claimId)
    if (c) this.doc.transact(() => { this.claims.set(claimId, { ...c, msgId }) }, origin)
  }

  addClaim(input: Omit<Claim, 'id' | 'at' | 'anchor'>, origin?: unknown): Claim {
    const text = this.overlayText(input.by, input.path)
    const anchor = text && !input.mirrorOf ? makeAnchor(text, input.from, input.to) : undefined
    const claim: Claim = { ...input, id: newId('c_'), at: Date.now(), ...(anchor ? { anchor } : {}) }
    this.doc.transact(() => { this.claims.set(claim.id, claim) }, origin)
    return claim
  }

  claimRange(claim: Claim): { from: number; to: number } {
    if (claim.mirrorOf) return { from: claim.from, to: claim.to }
    const text = this.overlayText(claim.by, claim.path)
    if (!text || !claim.anchor) return { from: claim.from, to: claim.to }
    try {
      const from = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(claim.anchor.from), this.doc,
      )
      const to = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(claim.anchor.to), this.doc,
      )
      if (!from || !to || from.type !== text || to.type !== text) return { from: claim.from, to: claim.to }
      const fromLine = lineAt(text.toString(), from.index)
      const toLine = lineAt(text.toString(), to.index)
      return { from: fromLine, to: Math.max(fromLine, toLine) }
    } catch {
      return { from: claim.from, to: claim.to }
    }
  }

  removeClaim(id: string, origin?: unknown): Claim | undefined {
    const claim = this.claims.get(id)
    if (claim) this.doc.transact(() => { this.claims.delete(id) }, origin)
    return claim
  }

  /** Replace a claim's line range and any obsolete overlay anchor after HEAD changes. */
  moveClaim(id: string, from: number, to: number, origin?: unknown, claimedHash?: string): Claim | undefined {
    const claim = this.claims.get(id)
    if (!claim) return undefined
    const text = this.overlayText(claim.by, claim.path)
    const { anchor: _oldAnchor, ...rest } = claim
    const next: Claim = { ...rest, from, to, ...(claimedHash !== undefined ? { claimedHash } : {}), ...(text && !claim.mirrorOf ? { anchor: makeAnchor(text, from, to) } : {}) }
    this.doc.transact(() => { this.claims.set(id, next) }, origin)
    return next
  }

  // ---- bus ---------------------------------------------------------------

  messages(): Msg[] { return this.bus.toArray() }
  lastMessages(n: number): Msg[] {
    const messages = this.messages()
    return messages.slice(Math.max(0, messages.length - n))
  }

  /** Fold an old contiguous prefix into compact histories, preserving actionable entries in full. */
  trimBus(keep = 2000, origin?: unknown): number {
    const messages = this.messages()
    const cutoff = Math.max(0, messages.length - Math.max(0, keep))
    if (!cutoff) return 0
    const answered = new Set(messages.filter(m => m.type === 'answer').map(m => m.inReplyTo))
    const removable: Msg[] = []
    const indexes: number[] = []
    for (let i = 0; i < cutoff; i++) {
      const m = messages[i]
      if (m.type === 'question' && !answered.has(m.id)) continue
      removable.push(m); indexes.push(i)
    }
    if (!removable.length) return 0
    const scopes = this.allScopes()
    this.doc.transact(() => {
      this.ledgerArchives.set('_room', foldLedger(this.ledgerArchives.get('_room'), removable))
      const byArea = new Map<string, Msg[]>()
      for (const m of removable) for (const area of messageAreas(m, scopes)) {
        const list = byArea.get(area) ?? []
        list.push(m); byArea.set(area, list)
      }
      for (const [area, list] of byArea) this.ledgerArchives.set(area, foldLedger(this.ledgerArchives.get(area), list))
      // Delete backwards so retained open questions do not shift later indexes.
      for (let end = indexes.length - 1; end >= 0;) {
        let start = end
        while (start > 0 && indexes[start - 1] === indexes[start] - 1) start--
        this.bus.delete(indexes[start], indexes[end] - indexes[start] + 1)
        end = start - 1
      }
    }, origin)
    return removable.length
  }

  post<T extends Msg>(from: Identity, body: PostBody<T>, origin?: unknown): T {
    const msg = {
      ...body,
      priority: body.priority ?? defaultPriority(body as { type: MsgType; symbols?: string[] }),
      id: newId('m_'),
      at: Date.now(),
      from: from.name,
      fromKind: from.kind,
    } as T
    this.doc.transact(() => { this.bus.push([msg]) }, origin)
    return msg
  }

  // ---- read receipts ------------------------------------------------------
  /** Message ids a person's agent has been shown (inbox delivery), with the time. */
  seen(name: string): Y.Map<number> { return this.doc.getMap<number>(`seen:${encodeURIComponent(name)}`) }
  markSeen(name: string, ids: string[], origin?: unknown): void {
    if (!ids.length) return
    const at = Date.now()
    this.doc.transact(() => { const m = this.seen(name); for (const id of ids) if (!m.has(id)) m.set(id, at) }, origin)
  }
  seenBy(msgId: string): string[] {
    const out: string[] = []
    for (const key of this.doc.share.keys()) if (key.startsWith('seen:') && this.doc.getMap<number>(key).has(msgId)) out.push(decodeURIComponent(key.slice(5)))
    return out.sort()
  }

  // ---- chats (human <-> own agent) --------------------------------------

  chat(name: string): Y.Array<ChatItem> {
    return this.doc.getArray<ChatItem>(`chat:${encodeURIComponent(name)}`)
  }

  say(name: string, item: Omit<ChatItem, 'id' | 'at'>, origin?: unknown): ChatItem {
    const value: ChatItem = { ...item, id: newId('h_'), at: Date.now() }
    this.doc.transact(() => { this.chat(name).push([value]) }, origin)
    return value
  }
}

function lineStart(text: string, oneBasedLine: number): number {
  let index = 0
  for (let line = 1; line < Math.max(1, oneBasedLine); line++) {
    const newline = text.indexOf('\n', index)
    if (newline < 0) return text.length
    index = newline + 1
  }
  return index
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < Math.min(index, text.length); i++) if (text[i] === '\n') line++
  return line
}

function makeAnchor(text: Y.Text, from: number, to: number): ClaimAnchor {
  return {
    from: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, lineStart(text.toString(), from))) as ClaimAnchor['from'],
    to: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, lineStart(text.toString(), to))) as ClaimAnchor['to'],
  }
}
