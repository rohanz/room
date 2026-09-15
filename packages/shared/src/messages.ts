import { isAgentic, displayName } from './identity.js'
import type { BuiltinMsgType, Claim, MessageMap, Msg, MsgBase, MsgType, Plan } from './types.js'

export type MessageAudience = 'addressed' | 'broadcast' | 'claim-holders' | 'everyone'
export type MessageWake = 'never' | 'addressed' | 'always'

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
  format: (message: M) => string
  audience: MessageAudience
  wakes: MessageWake
  endsWait?: (message: M, waiting: MessageWaiting) => boolean
}

const who = (m: MsgBase) => displayName({ name: m.from, kind: m.fromKind })
const to = (m: MsgBase) => m.to ? ` → ${m.to}'s agent` : ''
const priority = (m: MsgBase) => `[${m.priority}] `

const builtins = {
  claim: { audience: 'claim-holders', wakes: 'always', format: m => `${priority(m)}${who(m)} claims ${m.path}:${m.from_line}-${m.to_line} — ${m.intent}${m.plans?.length ? ` (plans: ${formatPlans(m.plans)})` : ''}` },
  release: { audience: 'claim-holders', wakes: 'always', format: m => `${priority(m)}${who(m)} released ${m.path}${m.summary ? ` — ${m.summary}` : ''}${m.unfulfilled?.length ? ` (not done: ${formatPlans(m.unfulfilled)})` : ''}` },
  changed: { audience: 'broadcast', wakes: 'always', format: m => `${priority(m)}${who(m)} changed ${m.paths.join(', ')} — ${m.summary}${m.symbols?.length ? ` (${m.symbols.join(', ')})` : ''}` },
  question: { audience: 'addressed', wakes: 'addressed', endsWait: (m, w) => !w.answersOnly && m.to === w.me && (w.workersRoom || (!w.claimId && !w.questionId)), format: m => `${priority(m)}${who(m)}${to(m)} asks: ${m.text}` },
  answer: { audience: 'addressed', wakes: 'addressed', endsWait: (m, w) => !!w.questionId && m.inReplyTo === w.questionId, format: m => `${priority(m)}${who(m)}${to(m)} answers: ${m.text}` },
  conflict: { audience: 'claim-holders', wakes: 'always', format: m => `${priority(m)}CONFLICT on ${m.path}: ${m.text}` },
  note: { audience: 'broadcast', wakes: 'never', format: m => `${priority(m)}${who(m)}: ${m.text}` },
  done: { audience: 'addressed', wakes: 'addressed', endsWait: (m, w) => !w.answersOnly && m.to === w.me, format: m => `${priority(m)}${who(m)} (worker ${m.tag}) finished: ${m.summary}${m.changed.length ? ` — changed ${m.changed.join(', ')}` : ''}` },
  base: { audience: 'everyone', wakes: 'never', format: m => `${priority(m)}${who(m)} moved the base to ${m.base.slice(0, 10)} (+${m.commits} commit${m.commits === 1 ? '' : 's'}: ${m.summary}) — git pull to catch up` },
  plan: { audience: 'broadcast', wakes: 'never', format: m => `${priority(m)}${who(m)} ${m.status} plan ${formatPlans([m.plan])} in ${m.path}${m.replacedBy ? ` → now ${formatPlans([m.replacedBy])}` : ''} — ${m.text}` },
  scope: { audience: 'broadcast', wakes: 'always', format: m => `${priority(m)}${who(m)} is on ${m.area}: ${m.summary} (${m.paths.join(', ')})` },
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
  return 'path' in m && claims.some(c => c.by === me && isAgentic(c.byKind) && c.path === m.path)
}

/** Shared inbox routing. Priority controls urgency; the kind controls its natural audience. */
export function messageForMe(me: { name: string }, m: Msg, context: MessageRouteContext = {}): boolean {
  if (m.from === me.name && isAgentic(m.fromKind)) return false
  if (m.to === me.name) return true
  if (m.to) return false
  const kind = messageKind(m)
  if (kind.audience === 'everyone') return true
  if (kind.audience === 'addressed') return false
  if (kind.audience === 'claim-holders' && !holdsClaim(me.name, m, context.claims ?? [])) return false
  if (m.priority === 'interrupt') return true
  if (m.priority === 'notify') return context.inMyAreas?.(m) ?? false
  return false
}

export function messageEndsWait(m: Msg, waiting: MessageWaiting): boolean {
  return messageKind(m).endsWait?.(m, waiting) ?? false
}

export function formatMsg(m: Msg): string { return messageKind(m).format(m) }

export function formatPlans(plans: readonly Plan[]): string {
  return plans.map(p => `${p.kind} ${p.symbol}${p.detail ? ` → ${p.detail}` : ''}`).join('; ')
}
