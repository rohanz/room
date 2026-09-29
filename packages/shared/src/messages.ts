import { claimsOverlap } from './claims.js'
import { isAgentic, displayName } from './identity.js'
import { normalizeCoordinationPath } from './near.js'
import type { BuiltinMsgType, Claim, MessageMap, Msg, MsgBase, MsgType, Plan, Identity, Priority, Scope } from './types.js'

export type MessageAudience = 'addressed' | 'broadcast' | 'claim-holders' | 'everyone'
export interface MessageWakeContext { me: Identity; hasUncommitted: boolean; myClaims: readonly Claim[] }
export type MessageWake<M extends MsgBase = Msg> = 'never' | 'interrupt' | 'addressed' | 'always' | ((m: M, ctx: MessageWakeContext) => boolean)
/** Current room state, so past events render as history. `claims` are the open claims. */
export interface MessageFormatContext { scopes: readonly Scope[]; messages: readonly Msg[]; claims?: readonly Claim[] }

export interface MessageWaiting {
  claimId?: string
  questionId?: string
  me?: string
  /** Used for the initial lookup, which only searches for the requested answer. */
  answersOnly?: boolean
  /** The workers bus historically surfaces questions even while the lead is waiting on something else. */
  workersRoom?: boolean
}

export interface MessageKind<M extends MsgBase = Msg> {
  format: (message: M, context?: MessageFormatContext) => string
  audience: MessageAudience
  wakes: MessageWake<M>
  priority: Priority | ((m: { symbols?: readonly string[]; [key: string]: unknown }) => Priority)
  endsWait?: (message: M, waiting: MessageWaiting) => boolean
  /** Whether unaddressed messages of this kind belong in agent inboxes. */
  inbox?: boolean
}

const who = (m: MsgBase) => displayName({ name: m.from, kind: m.fromKind })
const to = (m: MsgBase) => m.to ? ` → ${displayName({ name: m.to, kind: 'agent' })}` : ''
const priority = (m: MsgBase) => `[${m.priority}] `
const conflictLabel = (m: MsgBase & { text: string; clearedFrom?: 'conflict' | 'possible' }) => m.clearedFrom === 'possible'
  ? 'POSSIBLE conflict cleared' : m.clearedFrom === 'conflict' ? 'CONFLICT cleared'
    : m.priority !== 'fyi' ? 'CONFLICT' : 'POSSIBLE conflict'
const scopePaths = (paths: readonly string[]) => [...new Set(paths.map(normalizeCoordinationPath))].sort().join('\u0000')

export const BASE_CATCH_UP = 'Run git pull --ff-only --autostash to catch up. If it refuses, or your push is rejected, stop and tell your human; never merge another branch into this one, and do not undo, rebase or recommit your commits to get past it without their yes.'

const builtins = {
  claim: { priority: 'fyi', audience: 'claim-holders', inbox: false, wakes: 'never', format: (m, context) => context?.claims && !context.claims.some(c => c.id === m.claimId)
    ? `${priority(m)}earlier: ${who(m)} claimed ${m.path}:${m.from_line}-${m.to_line} (${new Date(m.at).toISOString().slice(11, 19)}) — ${m.intent}`
    : `${priority(m)}${who(m)} claims ${m.path}:${m.from_line}-${m.to_line} — ${m.intent}${m.plans?.length ? ` (plans: ${formatPlans(m.plans)})` : ''}` },
  release: { priority: 'fyi', audience: 'everyone', inbox: false, wakes: 'never', format: m => `${priority(m)}${who(m)} released ${m.path}${m.summary ? ` — ${m.summary}` : ''}${m.unfulfilled?.length ? ` (not done: ${formatPlans(m.unfulfilled)})` : ''}` },
  changed: { priority: m => m.symbols?.length ? 'notify' : 'fyi', audience: 'everyone', inbox: false, wakes: 'addressed', format: m => `${priority(m)}${who(m)} changed ${m.paths.join(', ')} — ${m.summary}${m.symbols?.length ? ` (${m.symbols.join(', ')})` : ''}` },
  question: { priority: 'notify', audience: 'addressed', wakes: 'addressed', endsWait: (m, w) => !w.answersOnly && m.to === w.me && (w.workersRoom || (!w.claimId && !w.questionId)), format: m => `${priority(m)}${who(m)}${to(m)} asks: ${m.text}` },
  answer: { priority: 'notify', audience: 'addressed', wakes: 'addressed', endsWait: (m, w) => !!w.questionId && m.inReplyTo === w.questionId && m.to === w.me, format: m => `${priority(m)}${who(m)}${to(m)} answers: ${m.text}` },
  conflict: { priority: 'interrupt', audience: 'claim-holders', wakes: 'always', format: m => `${priority(m)}${conflictLabel(m)} on ${m.path}: ${m.text}` },
  'merge-conflict': { priority: 'notify', audience: 'addressed', inbox: true, wakes: 'addressed', endsWait: (m, w) => !w.answersOnly && m.to === w.me, format: m => `${priority(m)}${conflictLabel(m)} on ${m.path}: ${m.text}` },
  contract: { priority: 'notify', audience: 'addressed', inbox: true, wakes: 'always', format: m => `${priority(m)}CONTRACT on ${m.path}: ${m.text}` },
  note: { priority: m => m.to ? 'notify' : 'fyi', audience: 'everyone', inbox: true, wakes: (m, ctx) => m.to === ctx.me.name, endsWait: (m, w) => !w.answersOnly && (m.to === w.me || (!m.to && m.priority === 'interrupt' && !!w.me && messageForMe({ name: w.me }, m))), format: m => `${priority(m)}${who(m)}${to(m)}: ${m.text}` },
  done: { priority: 'fyi', audience: 'addressed', wakes: 'addressed', endsWait: (m, w) => !w.answersOnly && m.to === w.me, format: m => `${priority(m)}${who(m)} (worker ${m.tag}) finished: ${m.summary}${m.changed.length ? ` — changed ${m.changed.join(', ')}` : ''}` },
  base: { priority: 'fyi', audience: 'everyone', wakes: 'never', format: m => `${priority(m)}${who(m)} moved the base to ${m.base.slice(0, 10)} (+${m.commits} commit${m.commits === 1 ? '' : 's'}: ${m.summary}) — ${BASE_CATCH_UP}` },
  pushed: { priority: 'notify', audience: 'everyone', wakes: (m, ctx) => m.from !== ctx.me.name && ctx.hasUncommitted, format: m => `${priority(m)}${m.from}'s local commits ${m.fromSha.slice(0, 7)}..${m.toSha.slice(0, 7)} are now on ${m.upstream} (${m.commits} commit${m.commits === 1 ? '' : 's'}: ${m.summary}) — if you work on ${m.upstream}: ${BASE_CATCH_UP}` },
  plan: { priority: 'fyi', audience: 'broadcast', wakes: 'interrupt', format: m => `${priority(m)}${who(m)} ${m.status} plan ${formatPlans([m.plan])} in ${m.path}${m.replacedBy ? ` → now ${formatPlans([m.replacedBy])}` : ''}${m.text ? ` — ${m.text}` : ''}` },
  scope: { priority: 'notify', audience: 'everyone', inbox: false, wakes: 'never', format: (m, context) => {
    const current = context?.scopes.some(s => s.by === m.from && s.area === m.area && s.summary === m.summary && scopePaths(s.paths) === scopePaths(m.paths))
      && context.messages.filter(x => x.type === 'scope' && x.from === m.from && x.area === m.area && x.summary === m.summary && scopePaths(x.paths) === scopePaths(m.paths)).at(-1)?.id === m.id
    return current
      ? `${priority(m)}${who(m)} is on ${m.area}: ${m.summary} (${m.paths.join(', ')})`
      : `${priority(m)}earlier: ${who(m)} was on ${m.area} (${new Date(m.at).toISOString().slice(11, 19)}): ${m.summary} (${m.paths.join(', ')})`
  } },
} satisfies Record<BuiltinMsgType, MessageKind<any>>

/** The single policy registry for bus message presentation and delivery. */
export const MessageKinds: Record<string, MessageKind<any>> = builtins

export function registerMessageKind<K extends MsgType>(type: K, kind: MessageKind<MessageMap[K]>): void {
  MessageKinds[type] = kind
}

export function messageKind(m: Msg): MessageKind<any> {
  const kind = MessageKinds[m.type]
  if (!kind) throw new Error(`unregistered message kind: ${m.type}`)
  return kind
}

export interface MessageRouteContext {
  claims?: readonly Claim[]
  inMyAreas?: (message: Msg) => boolean
}

function holdsClaim(me: string, m: Msg, claims: readonly Claim[]): boolean {
  const ids = 'claimId' in m ? [m.claimId, ...('otherClaimId' in m ? [m.otherClaimId] : [])] : []
  if (claims.some(c => c.by === me && ids.includes(c.id))) return true
  return 'path' in m && claims.some(c => c.by === me && isAgentic(c.byKind) && claimsOverlap(c, { path: m.path, from: 1, to: Number.MAX_SAFE_INTEGER }))
}

/** Shared inbox routing. Priority controls urgency; the kind controls its natural audience. */
export function messageForMe(me: { name: string }, m: Msg, context: MessageRouteContext = {}): boolean {
  if (m.type === 'note' && !m.to && (m.from === me.name || m.priority === 'fyi')) return false
  if (m.from === me.name && m.fromKind !== 'human') return false
  if (m.type === 'plan' && m.priority === 'fyi') return false
  if (m.to === me.name) return true
  if (m.to) return false
  const kind = messageKind(m)
  if (m.priority === 'interrupt') return true
  if (kind.inbox === false) return false
  if (kind.audience === 'everyone') return true
  if (kind.audience === 'addressed') return false
  if (kind.audience === 'claim-holders' && !holdsClaim(me.name, m, context.claims ?? [])) return false
  if (m.priority === 'notify') return context.inMyAreas?.(m) ?? false
  return false
}

export function messageEndsWait(m: Msg, waiting: MessageWaiting): boolean {
  return messageKind(m).endsWait?.(m, waiting) ?? false
}

export function formatMsg(m: Msg, context?: MessageFormatContext): string { return messageKind(m).format(m, context) }

export function formatPlans(plans: readonly Plan[]): string {
  return plans.map(p => `${p.kind} ${p.symbol}${p.detail ? ` → ${p.detail}` : ''}`).join('; ')
}
