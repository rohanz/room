export type Kind = 'human' | 'agent'

export interface Identity {
  /** Person's name. An agent uses its owner's name with kind 'agent'. */
  name: string
  kind: Kind
}

export interface RelativePositionJson {
  type?: { client: number; clock: number }
  tname?: string
  item?: { client: number; clock: number }
  assoc?: number
}

/** JSON-safe pair of Yjs relative positions for the inclusive line range. */
export interface ClaimAnchor {
  from: RelativePositionJson
  to: RelativePositionJson
}

/** Line ranges are 1-based, inclusive. */
/** A change the claimant intends to make, declared before editing so others can prepare. */
export interface Plan {
  kind: 'rename' | 'signature' | 'delete' | 'add'
  symbol: string
  detail?: string
}

export interface Claim {
  id: string
  path: string
  from: number
  to: number
  by: string
  byKind: Kind
  intent: string
  /** epoch ms */
  at: number
  /** Absent when the owner's overlay did not exist when the claim was made. */
  anchor?: ClaimAnchor
  plans?: Plan[]
}

export interface Scope {
  by: string
  byKind: Kind
  /** One-word ledger name, e.g. "auth". */
  area: string
  summary: string
  paths: string[]
  /** epoch ms */
  at: number
}

export type Priority = 'fyi' | 'notify' | 'interrupt'
export type MsgType = 'claim' | 'release' | 'changed' | 'question' | 'answer' | 'conflict' | 'note' | 'scope' | 'base'

export interface MsgBase {
  id: string
  type: MsgType
  priority: Priority
  from: string
  fromKind: Kind
  /** Recipient name (kind implied: agents talk to agents). Empty = broadcast. */
  to?: string
  at: number
}
export interface ClaimMsg extends MsgBase { type: 'claim'; claimId: string; path: string; from_line: number; to_line: number; intent: string; plans?: Plan[] }
export interface ReleaseMsg extends MsgBase { type: 'release'; claimId: string; path: string; summary?: string; unfulfilled?: Plan[] }
export interface ChangedMsg extends MsgBase { type: 'changed'; paths: string[]; summary: string; symbols?: string[] }
export interface QuestionMsg extends MsgBase { type: 'question'; text: string }
export interface AnswerMsg extends MsgBase { type: 'answer'; inReplyTo: string; text: string }
export interface ConflictMsg extends MsgBase { type: 'conflict'; claimId: string; otherClaimId: string; path: string; text: string }
export interface NoteMsg extends MsgBase { type: 'note'; text: string }
export interface ScopeMsg extends MsgBase { type: 'scope'; area: string; summary: string; paths: string[] }
/** The room's base commit moved forward (someone committed/pulled a descendant). */
export interface BaseMsg extends MsgBase { type: 'base'; base: string; prev: string; commits: number; paths: string[]; summary: string }
export type Msg = ClaimMsg | ReleaseMsg | ChangedMsg | QuestionMsg | AnswerMsg | ConflictMsg | NoteMsg | ScopeMsg | BaseMsg

export interface Meta {
  repo?: string
  branch?: string
  base?: string
  createdAt?: number
  seededBy?: string
}

export interface Cursor {
  path: string
  /** 1-based line numbers */
  from: number
  to: number
}

/** Awareness state published by every client. */
export interface Presence {
  user: Identity & { color: string }
  cursor?: Cursor
  status?: string
  /** epoch ms */
  lastActive?: number
}

export type ChatRole = 'human' | 'agent' | 'tool' | 'event' | 'status'
export interface ChatItem {
  id: string
  at: number
  role: ChatRole
  text: string
  meta?: Record<string, string>
}
