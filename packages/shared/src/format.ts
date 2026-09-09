import type { Msg } from './types.js'
import { displayName } from './identity.js'

/** One-line, human-readable rendering used by the feed, the MCP tools and channel pushes. */
export function formatMsg(m: Msg): string {
  const who = displayName({ name: m.from, kind: m.fromKind })
  const to = m.to ? ` → ${m.to}'s agent` : ''
  switch (m.type) {
    case 'claim': return `${who} claims ${m.path}:${m.from_line}-${m.to_line} — ${m.intent}`
    case 'release': return `${who} released ${m.path}${m.summary ? ` — ${m.summary}` : ''}`
    case 'changed': return `${who} changed ${m.paths.join(', ')} — ${m.summary}${m.symbols?.length ? ` (${m.symbols.join(', ')})` : ''}`
    case 'question': return `${who}${to} asks: ${m.text}`
    case 'answer': return `${who}${to} answers: ${m.text}`
    case 'conflict': return `CONFLICT on ${m.path}: ${m.text}`
    case 'note': return `${who}: ${m.text}`
  }
}

export function withLineNumbers(text: string): string {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const w = String(lines.length).length
  return lines.map((l, i) => `${String(i + 1).padStart(w)}| ${l}`).join('\n')
}
