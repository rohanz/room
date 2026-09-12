import type { Msg, Plan } from './types.js'
import { displayName } from './identity.js'

/** One-line, human-readable rendering used by the feed, the MCP tools and channel pushes. */
export function formatMsg(m: Msg): string {
  const who = displayName({ name: m.from, kind: m.fromKind })
  const to = m.to ? ` → ${m.to}'s agent` : ''
  const priority = `[${m.priority}] `
  switch (m.type) {
    case 'claim': return `${priority}${who} claims ${m.path}:${m.from_line}-${m.to_line} — ${m.intent}${m.plans?.length ? ` (plans: ${formatPlans(m.plans)})` : ''}`
    case 'release': return `${priority}${who} released ${m.path}${m.summary ? ` — ${m.summary}` : ''}${m.unfulfilled?.length ? ` (not done: ${formatPlans(m.unfulfilled)})` : ''}`
    case 'changed': return `${priority}${who} changed ${m.paths.join(', ')} — ${m.summary}${m.symbols?.length ? ` (${m.symbols.join(', ')})` : ''}`
    case 'question': return `${priority}${who}${to} asks: ${m.text}`
    case 'answer': return `${priority}${who}${to} answers: ${m.text}`
    case 'conflict': return `${priority}CONFLICT on ${m.path}: ${m.text}`
    case 'note': return `${priority}${who}: ${m.text}`
    case 'base': return `${priority}${who} moved the base to ${m.base.slice(0, 10)} (+${m.commits} commit${m.commits === 1 ? '' : 's'}: ${m.summary}) — git pull to catch up`
    case 'plan': return `${priority}${who} ${m.status} plan ${formatPlans([m.plan])} in ${m.path}${m.replacedBy ? ` → now ${formatPlans([m.replacedBy])}` : ''} — ${m.text}`
    case 'scope': return `${priority}${who} is on ${m.area}: ${m.summary} (${m.paths.join(', ')})`
  }
}

export function withLineNumbers(text: string): string {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const w = String(lines.length).length
  return lines.map((l, i) => `${String(i + 1).padStart(w)}| ${l}`).join('\n')
}

export function formatPlans(plans: readonly Plan[]): string {
  return plans.map(p => `${p.kind} ${p.symbol}${p.detail ? ` → ${p.detail}` : ''}`).join('; ')
}
