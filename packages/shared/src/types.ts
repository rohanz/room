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
  /** Digest of the covered lines at claim time; no source text is shared. */
  claimedHash?: string
  plans?: Plan[]
  /** Id of the bus message announcing this claim (dependents are found through it). */
  msgId?: string
  /** Set on a lead's team-room claim that mirrors a worker's local claim: the worker's tag. */
  mirrorOf?: string
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
export type BuiltinMsgType = 'claim' | 'release' | 'changed' | 'question' | 'answer' | 'conflict' | 'merge-conflict' | 'contract' | 'note' | 'scope' | 'base' | 'plan' | 'done'
export type MsgType = keyof MessageMap & string

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
/** An observed foreign contract edit that a file in the recipient's work references. */
export interface MergeConflictMsg extends MsgBase { type: 'merge-conflict'; path: string; text: string }
export interface ContractMsg extends MsgBase { type: 'contract'; path: string; symbol: string; text: string }
export interface NoteMsg extends MsgBase { type: 'note'; text: string }
export interface ScopeMsg extends MsgBase { type: 'scope'; area: string; summary: string; paths: string[] }
/** The room's base commit moved forward (someone committed/pulled a descendant). */
export interface BaseMsg extends MsgBase { type: 'base'; base: string; prev: string; commits: number; paths: string[]; summary: string }
/** A declared plan changed: cancelled (released undone) or superseded by a new plan on the same symbol. Routed to everyone who was shown the original. */
export interface PlanMsg extends MsgBase { type: 'plan'; status: 'cancelled' | 'superseded'; claimId: string; path: string; plan: Plan; replacedBy?: Plan; text: string }
/** A worker finished its task; addressed to the lead that dispatched it. */
export interface DoneMsg extends MsgBase { type: 'done'; tag: string; summary: string; changed: string[] }
/** Extensible mapping from a bus kind to its payload. Add a member alongside its MessageKinds entry. */
export interface MessageMap {
  claim: ClaimMsg
  release: ReleaseMsg
  changed: ChangedMsg
  question: QuestionMsg
  answer: AnswerMsg
  conflict: ConflictMsg
  'merge-conflict': MergeConflictMsg
  contract: ContractMsg
  note: NoteMsg
  scope: ScopeMsg
  base: BaseMsg
  plan: PlanMsg
  done: DoneMsg
}
export type Msg = MessageMap[MsgType]

/** A worker agent dispatched by a lead (room_spawn) into this room. Keyed by tag in RoomDoc.workers. */
export type WorkerStatus = 'running' | 'done' | 'failed' | 'dismissed'
export interface Worker {
  /** Stable identity of this spawn: `<lead>/<tag>#<gen>`. Everything about the worker (process, worktree, log, doc entry) is looked up by it. Absent on records from older clients. */
  id?: string
  tag: string
  /** Participant name the worker joins as (lead's owner + tag). */
  name: string
  host: 'claude' | 'codex'
  model?: string
  effort?: string
  /** Host conversation to resume for a follow-up in this worktree. */
  hostSessionId?: string
  budget?: { threads: number; memGb: number; nice: number }
  /** Assigned dev-server port (PORT); unique among this lead's live workers. */
  port?: number
  /** Effective sharing level at spawn; older records omit it and resume conservatively at intent. */
  share?: ShareLevel
  /** Repo-relative inputs linked from the lead's clone; read-only by worker instruction. */
  link?: string[]
  task: string
  dir: string
  branch: string
  /** Commit the worker branch was created from; absent for reused/legacy worktrees. */
  base?: string
  /** Internal tracked-WIP commit, when one was made. `base` remains the worker delta base. */
  carriedBase?: string
  /** Lead-owned untracked files copied outside branch history; sha is a blob retained by a private Room tree ref. */
  carriedUntracked?: { path: string; sha: string; mode?: number }[]
  pid: number
  /** OS process start identity (boot plus start tick/second); absent on legacy records. */
  processStartTime?: string
  startedAt: number
  status: WorkerStatus
  summary?: string
  exitCode?: number
  finishedAt?: number
  dismissedAt?: number
  /** Why the host was stopped, preserved across lead sessions. */
  stopReason?: 'lead-session-ended' | 'message-delivered-cancelled' | 'message-delivered-failed'
  /** Participant name of the lead that spawned it. */
  lead: string
  /** Spawn generation for this tag: exit callbacks of an older process must not touch a newer record. */
  gen?: number
}

/** Compact history of a worker whose live room state has been removed. */
export interface RetiredWorker {
  name: string
  tag: string
  lead: string
  host: 'claude' | 'codex'
  model?: string
  task: string
  summary: string
  files: string[]
  fileCount: number
  startedAt: number
  finishedAt: number
  retiredAt: number
  outcome: 'merged' | 'dismissed' | 'clean'
  /** How the worker left the room; older records have no disposition. */
  disposition?: 'collected' | 'discarded' | 'stopped'
  stopReason?: Worker['stopReason']
  /** Uncommitted/untracked files left on disk when explicitly dismissed. */
  uncommitted?: number
  /** Collected worktree retained for later explicit cleanup, usually because it has ignored output. */
  keptWorktree?: string
  /** Why collection retained the worktree. */
  keptReason?: string
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
  /** Session cannot receive an idle wake; messages remain for its next turn. */
  wakeUnavailable?: boolean
  /** SHA256 of the watched directory realpath; never the path itself. */
  watchedDirectory?: string
  /** Co-located participant publishing this directory; this participant publishes no files. */
  publishUnder?: string
  host?: string
  model?: string
  effort?: string
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
