import type { Msg } from './types.js'
import { displayName } from './identity.js'

/** One-line, human-readable rendering used by the feed, the MCP tools and channel pushes. */
export function formatMsg(m: Msg): string {
  const who = displayName({ name: m.from, kind: m.fromKind })
  const to = m.to ? ` → ${m.to}'s agent` : ''
  const priority = `[${m.priority}] `
  switch (m.type) {
    case 'claim': return `${priority}${who} claims ${m.path}:${m.from_line}-${m.to_line} — ${m.intent}`
    case 'release': return `${priority}${who} released ${m.path}${m.summary ? ` — ${m.summary}` : ''}`
    case 'changed': return `${priority}${who} changed ${m.paths.join(', ')} — ${m.summary}${m.symbols?.length ? ` (${m.symbols.join(', ')})` : ''}`
    case 'question': return `${priority}${who}${to} asks: ${m.text}`
    case 'answer': return `${priority}${who}${to} answers: ${m.text}`
    case 'conflict': return `${priority}CONFLICT on ${m.path}: ${m.text}`
    case 'note': return `${priority}${who}: ${m.text}`
    case 'scope': return `${priority}${who} scopes ${m.paths.join(', ')} — ${m.summary}`
  }
}

export function withLineNumbers(text: string): string {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const w = String(lines.length).length
  return lines.map((l, i) => `${String(i + 1).padStart(w)}| ${l}`).join('\n')
}
