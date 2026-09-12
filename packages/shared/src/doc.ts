import diff from 'fast-diff'
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
} from './types.js'
import { newId } from './identity.js'
import { ledger as ledgerView, areaSummary as areaSummaryView, type LedgerQuery } from './ledger.js'

type ScopeInput = Omit<Scope, 'by' | 'at'> & { at?: number }
type NewScope = Omit<Scope, 'at'> & { at?: number }
type PostBody<T extends Msg> = Omit<T, 'id' | 'at' | 'from' | 'fromKind' | 'priority'> & { priority?: Priority }

/** Default bus priority from spec §6. */
export function defaultPriority(msg: { type: MsgType; symbols?: readonly string[]; [key: string]: unknown }): Priority {
  if (msg.type === 'conflict') return 'interrupt'
  if (msg.type === 'changed') return msg.symbols?.length ? 'notify' : 'fyi'
  if (msg.type === 'question' || msg.type === 'answer' || msg.type === 'scope') return 'notify'
  return 'fyi'
}

/** Typed accessors over the single room Y.Doc. */
export class RoomDoc {
  readonly doc: Y.Doc

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc
  }

  get overlays(): Y.Map<Y.Map<Y.Text>> { return this.doc.getMap<Y.Map<Y.Text>>('overlays') }
  get deleted(): Y.Map<Y.Map<true>> { return this.doc.getMap<Y.Map<true>>('deleted') }
  get scopes(): Y.Map<Scope> { return this.doc.getMap<Scope>('scopes') }
  get claims(): Y.Map<Claim> { return this.doc.getMap<Claim>('claims') }
  get bus(): Y.Array<Msg> { return this.doc.getArray<Msg>('bus') }
  get metaMap(): Y.Map<string | number> { return this.doc.getMap<string | number>('meta') }

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
    }, origin)
  }

  clearOverlay(person: string, relpath: string, origin?: unknown): void {
    const map = this.overlays.get(person)
    if (!map?.has(relpath)) return
    this.doc.transact(() => { map.delete(relpath) }, origin)
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
    this.doc.transact(() => { this.deletedFor(person).set(relpath, true) }, origin)
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

  claimsFor(relpath: string): Claim[] { return this.openClaims().filter(claim => claim.path === relpath) }

  addClaim(input: Omit<Claim, 'id' | 'at' | 'anchor'>, origin?: unknown): Claim {
    const text = this.overlayText(input.by, input.path)
    const anchor = text ? makeAnchor(text, input.from, input.to) : undefined
    const claim: Claim = { ...input, id: newId('c_'), at: Date.now(), ...(anchor ? { anchor } : {}) }
    this.doc.transact(() => { this.claims.set(claim.id, claim) }, origin)
    return claim
  }

  claimRange(claim: Claim): { from: number; to: number } {
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

  // ---- bus ---------------------------------------------------------------

  messages(): Msg[] { return this.bus.toArray() }
  lastMessages(n: number): Msg[] {
    const messages = this.messages()
    return messages.slice(Math.max(0, messages.length - n))
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

export function isMsgType(value: string): value is MsgType {
  return ['claim', 'release', 'changed', 'question', 'answer', 'conflict', 'note', 'scope'].includes(value)
}
