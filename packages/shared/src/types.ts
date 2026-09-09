export type Kind = 'human' | 'agent'

export interface Identity {
  /** Person's name. An agent uses its owner's name with kind 'agent'. */
  name: string
  kind: Kind
}

/** Line ranges are 1-based, inclusive. */
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
}

export type MsgType = 'claim' | 'release' | 'changed' | 'question' | 'answer' | 'conflict' | 'note'

export interface MsgBase {
  id: string
  type: MsgType
  from: string
  fromKind: Kind
  /** Recipient name (kind implied: agents talk to agents). Empty = broadcast. */
  to?: string
  at: number
}
export interface ClaimMsg extends MsgBase { type: 'claim'; claimId: string; path: string; from_line: number; to_line: number; intent: string }
export interface ReleaseMsg extends MsgBase { type: 'release'; claimId: string; path: string; summary?: string }
export interface ChangedMsg extends MsgBase { type: 'changed'; paths: string[]; summary: string; symbols?: string[] }
export interface QuestionMsg extends MsgBase { type: 'question'; text: string }
export interface AnswerMsg extends MsgBase { type: 'answer'; inReplyTo: string; text: string }
export interface ConflictMsg extends MsgBase { type: 'conflict'; claimId: string; otherClaimId: string; path: string; text: string }
export interface NoteMsg extends MsgBase { type: 'note'; text: string }
export type Msg = ClaimMsg | ReleaseMsg | ChangedMsg | QuestionMsg | AnswerMsg | ConflictMsg | NoteMsg

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
}

export type ChatRole = 'human' | 'agent' | 'tool' | 'event' | 'status'
/** One line in a person's chat with their own agent. Stored per person under doc.getMap('chats'). */
export interface ChatItem {
  id: string
  at: number
  role: ChatRole
  text: string
  meta?: Record<string, string>
}
