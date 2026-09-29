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
export type BuiltinMsgType = 'claim' | 'release' | 'changed' | 'question' | 'answer' | 'conflict' | 'merge-conflict' | 'contract' | 'note' | 'scope' | 'base' | 'pushed' | 'plan' | 'done'
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
  /** Assigned by the room's hub, the sole appender (hub §3). */
  seq?: number
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
export interface NoteMsg extends MsgBase { type: 'note'; text: string; inReplyTo?: string }
export interface ScopeMsg extends MsgBase { type: 'scope'; area: string; summary: string; paths: string[] }
/** The room's base commit moved forward (someone committed/pulled a descendant). */
export interface BaseMsg extends MsgBase { type: 'base'; base: string; prev: string; commits: number; paths: string[]; summary: string }
/** The author's own commits fromSha..toSha are now on `upstream` (reporooms §B4): an observed upstream advance, never addressed. */
export interface PushedMsg extends MsgBase { type: 'pushed'; branch: string; upstream: string; fromSha: string; toSha: string; commits: number; paths: string[]; summary: string }
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
  pushed: PushedMsg
  plan: PlanMsg
  done: DoneMsg
}
export type Msg = MessageMap[MsgType]

/** The registry's `statusOf` vocabulary (registry §6). */
export type WorkerStatus = 'starting' | 'running' | 'unknown' | 'ambiguous' | 'done' | 'failed' | 'stopped' | 'imported' | 'collecting' | 'retired' | 'abandoned'
export type WorkerStopReason = 'lead-session-ended' | 'discarded' | 'message-delivered-cancelled' | 'message-delivered-failed'
/** Statuses in which the worker's host may still be running. */
export const LIVE_WORKER_STATUSES: readonly WorkerStatus[] = ['starting', 'running', 'unknown', 'ambiguous']
export const workerLive = (status: WorkerStatus): boolean => LIVE_WORKER_STATUSES.includes(status)

/**
 * A lead's worker as the room shows it, keyed by worker ID in RoomDoc.workerViews (registry §14).
 * Display and remote classification only: a local action reads the lead's registry, never this.
 * Written by the lead's projector in that room; valid while `fence` is the lead's live holder.
 */
export interface WorkerView {
  id: string
  tag: string
  /** Participant name the worker joins as (lead's owner + tag). */
  name: string
  /** Participant name of the lead that spawned it. */
  lead: string
  mode: 'here' | 'local'
  host: 'claude' | 'codex'
  model?: string
  effort?: string
  /** At most 200 characters. */
  task: string
  branch: string
  status: WorkerStatus
  summary?: string
  /** The status row's detail ("has not joined…", "follow-up not delivered"). */
  note?: string
  run: number
  startedAt: number
  finishedAt?: number
  exitCode?: number
  stopReason?: WorkerStopReason
  /** The lead's holder fence when written (its session id until names are hub leases). */
  fence: string
}

/** Compact history of a worker whose live room state has been removed. */
export interface RetiredWorker {
  /** The retired worker's ID; the archive holds one entry per ID. Absent on 0.16 entries. */
  id?: string
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
  stopReason?: WorkerStopReason
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
  schemaVersion?: number
  /** Written once by the room creator; salts manifest path digests (manifest §4.1). */
  roomSalt?: string
}

export interface Cursor {
  path: string
  /** 1-based line numbers */
  from: number
  to: number
}

/** Awareness state published by every client. */
export interface Presence {
  /** Immutable host-session identity used to match a participant's live holder. */
  sessionId?: string
  /** Session cannot receive an idle wake; messages remain for its next turn. */
  wakeUnavailable?: boolean
  /** SHA256 of the watched directory realpath; never the path itself. */
  watchedDirectory?: string
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
  /** Minutes since this session's last Room call or hook contact, on its own clock (registry §18). */
  idleMin?: number
}

export type ShareLevel = 'intent' | 'declared' | 'full'

// ---- delivery ledger (docs/superpowers/specs/2026-09-28-ledger.md) ----------

/** How a message was handed off to the host. */
export type Via = 'reply' | 'wait' | 'hook' | 'prompt' | 'agent'
/** `seen:<P>[msgId]`; `s` is the holder session that got it (provenance, never a filter). Legacy receipts are a number. */
export interface Receipt { s: string; via: Via; at: number }
/** Terminal outcome of an addressed message that was never receipted. */
export interface Outcome { to: string; from: string; outcome: 'expired' | 'over-cap' | 'recipient-retired'; at: number }
/** A release's plans left undone, kept in the archive for the PR ledger. */
export interface ArchivedRelease { path: string; plans: Plan[]; summary?: string }
/** Compact record of a message that left the bus: [type, from, at, areas, unfulfilled?]. */
export type ArchivedMsg = [type: MsgType, from: string, at: number, areas: string[], unfulfilled?: ArchivedRelease]
/** One session's causal cursor in a room: bus ids observed at first bind, and broadcasts routing rejected. */
/** A session's broadcast cursor (ledger "Cursor"): the highest hub `seq` it had observed at its first bind, and broadcasts routed away. */
export interface DeliveryCursor { frontier: number; routed: ReadonlySet<string> }

export type ChatRole = 'human' | 'agent' | 'tool' | 'event' | 'status'
export interface ChatItem {
  id: string
  at: number
  role: ChatRole
  text: string
  meta?: Record<string, string>
}
