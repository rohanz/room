export type Kind = 'human' | 'agent' | 'bot' | 'ci'

/**
 * A participant (principal). `name` is the unique key in the doc (overlays, claims, messages).
 * A person's first agent shares the person's name with kind 'agent'; a second agent under the same
 * login is `${owner}+${label}`. `owner` is the verified login of the human responsible (a human's own
 * name; the runner of an agent; the account that registered a bot or CI). Older clients omit owner/label.
 */
export interface Identity {
  name: string
  kind: Kind
  owner?: string
  /** Display hint, e.g. "codex", "deploy bot". */
  label?: string
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
  /** Id of the bus message announcing this claim (dependents are found through it). */
  msgId?: string
}

export interface Scope {
  by: string
  byKind: Kind
  /** One-word ledger name, e.g. "auth". */
  area: string
  summary: string
  paths: string[]
  /** Areas (CODEOWNERS prefixes or top-level dirs) covering `paths` plus the person's changed paths; see areas.ts. */
  areas?: string[]
  /** epoch ms */
  at: number
}

export type Priority = 'fyi' | 'notify' | 'interrupt'
export type MsgType = 'claim' | 'release' | 'changed' | 'question' | 'answer' | 'conflict' | 'note' | 'scope' | 'base' | 'plan' | 'done'

export interface MsgBase {
  id: string
  type: MsgType
  priority: Priority
  from: string
  fromKind: Kind
  /** Recipient name (kind implied: agents talk to agents). Empty = broadcast. */
  to?: string
  at: number
  /** Set on a copy the room addressed to someone because it affects them; the original's id. */
  copyOf?: string
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
/** A declared plan changed: cancelled (released undone) or superseded by a new plan on the same symbol. Routed to everyone who was shown the original. */
export interface PlanMsg extends MsgBase { type: 'plan'; status: 'cancelled' | 'superseded'; claimId: string; path: string; plan: Plan; replacedBy?: Plan; text: string }
/** A worker finished its task; addressed to the lead that dispatched it. */
export interface DoneMsg extends MsgBase { type: 'done'; tag: string; summary: string; changed: string[] }
export type Msg = ClaimMsg | ReleaseMsg | ChangedMsg | QuestionMsg | AnswerMsg | ConflictMsg | NoteMsg | ScopeMsg | BaseMsg | PlanMsg | DoneMsg

/** A worker agent dispatched by a lead (room_spawn) into this room. Keyed by tag in RoomDoc.workers. */
export type WorkerStatus = 'running' | 'done' | 'failed' | 'dismissed'
export interface Worker {
  tag: string
  /** Participant name the worker joins as (lead's owner + tag). */
  name: string
  host: 'claude' | 'codex'
  model?: string
  task: string
  dir: string
  branch: string
  pid: number
  startedAt: number
  status: WorkerStatus
  summary?: string
  exitCode?: number
  /** Participant name of the lead that spawned it. */
  lead: string
  /** Spawn generation for this tag: exit callbacks of an older process must not touch a newer record. */
  gen?: number
}

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
  /** Sharing level this participant publishes its work at (roomd `share` option). */
  share?: ShareLevel
  /** Areas this participant is in (same rule as Scope.areas). */
  areas?: string[]
  /** epoch ms */
  lastActive?: number
}

export type ShareLevel = 'intent' | 'declared' | 'full'

export type ChatRole = 'human' | 'agent' | 'tool' | 'event' | 'status'
export interface ChatItem {
  id: string
  at: number
  role: ChatRole
  text: string
  meta?: Record<string, string>
}
