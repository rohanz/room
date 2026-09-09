import * as Y from 'yjs'
import type { ChatItem, Claim, Identity, Meta, Msg, MsgType } from './types.js'
import { newId } from './identity.js'

/**
 * Typed accessors over the single room Y.Doc. Every client (daemon, MCP, browser)
 * uses these so the schema lives in exactly one place.
 */
export class RoomDoc {
  readonly doc: Y.Doc
  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc
  }

  get files(): Y.Map<Y.Text> { return this.doc.getMap<Y.Text>('files') }
  get claims(): Y.Map<Claim> { return this.doc.getMap<Claim>('claims') }
  get bus(): Y.Array<Msg> { return this.doc.getArray<Msg>('bus') }
  get chats(): Y.Map<Y.Array<ChatItem>> { return this.doc.getMap<Y.Array<ChatItem>>('chats') }
  get metaMap(): Y.Map<string | number> { return this.doc.getMap<string | number>('meta') }

  // ---- files -------------------------------------------------------------
  paths(): string[] { return Array.from(this.files.keys()).sort() }
  hasFile(path: string): boolean { return this.files.has(path) }
  text(path: string): string | undefined { return this.files.get(path)?.toString() }
  lineCount(path: string): number {
    const t = this.text(path)
    return t === undefined ? 0 : t.split('\n').length
  }
  /** Replace or create a file's content wholesale. Prefer applyDiff for live edits. */
  setFile(path: string, content: string, origin?: unknown): void {
    this.doc.transact(() => {
      let yt = this.files.get(path)
      if (!yt) { yt = new Y.Text(); this.files.set(path, yt) }
      if (yt.toString() === content) return
      yt.delete(0, yt.length)
      yt.insert(0, content)
    }, origin)
  }
  deleteFile(path: string, origin?: unknown): void {
    this.doc.transact(() => { this.files.delete(path) }, origin)
  }

  // ---- meta --------------------------------------------------------------
  get meta(): Meta {
    const m = this.metaMap
    return {
      repo: m.get('repo') as string | undefined,
      branch: m.get('branch') as string | undefined,
      base: m.get('base') as string | undefined,
      createdAt: m.get('createdAt') as number | undefined,
      seededBy: m.get('seededBy') as string | undefined,
    }
  }
  setMeta(patch: Partial<Meta>, origin?: unknown): void {
    this.doc.transact(() => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) this.metaMap.set(k, v as string | number)
    }, origin)
  }

  // ---- claims ------------------------------------------------------------
  openClaims(): Claim[] { return Array.from(this.claims.values()).sort((a, b) => a.at - b.at) }
  claimsFor(path: string): Claim[] { return this.openClaims().filter(c => c.path === path) }
  addClaim(c: Omit<Claim, 'id' | 'at'>, origin?: unknown): Claim {
    const claim: Claim = { ...c, id: newId('c_'), at: Date.now() }
    this.doc.transact(() => { this.claims.set(claim.id, claim) }, origin)
    return claim
  }
  removeClaim(id: string, origin?: unknown): Claim | undefined {
    const c = this.claims.get(id)
    if (c) this.doc.transact(() => { this.claims.delete(id) }, origin)
    return c
  }

  // ---- bus ---------------------------------------------------------------
  messages(): Msg[] { return this.bus.toArray() }
  lastMessages(n: number): Msg[] { const a = this.messages(); return a.slice(Math.max(0, a.length - n)) }
  post<T extends Msg>(from: Identity, body: Omit<T, 'id' | 'at' | 'from' | 'fromKind'>, origin?: unknown): T {
    const msg = { ...body, id: newId('m_'), at: Date.now(), from: from.name, fromKind: from.kind } as T
    this.doc.transact(() => { this.bus.push([msg]) }, origin)
    return msg
  }

  // ---- chats (human <-> own agent) ----------------------------------------
  chat(name: string): Y.Array<ChatItem> {
    let a = this.chats.get(name)
    if (!a) { a = new Y.Array<ChatItem>(); this.doc.transact(() => { this.chats.set(name, a!) }) }
    return a
  }
  say(name: string, item: Omit<ChatItem, 'id' | 'at'>, origin?: unknown): ChatItem {
    const it: ChatItem = { ...item, id: newId('h_'), at: Date.now() }
    this.doc.transact(() => { this.chat(name).push([it]) }, origin)
    return it
  }
}

export function isMsgType(s: string): s is MsgType {
  return ['claim', 'release', 'changed', 'question', 'answer', 'conflict', 'note'].includes(s)
}
