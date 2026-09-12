// PreToolUse on edit tools: put the agent's unread room messages, and any teammate claims on
// the files it is about to edit, in front of the model before the edit happens.
// Reads .git/room-state.json, which the room MCP server keeps current.
import fs from 'node:fs'
import { readStdinJson, gitRoot, gitStatePath, readJson, pathsOf } from './common.mjs'

const ev = readStdinJson()
const root = gitRoot(ev.cwd)
if (!root) process.exit(0)
const state = readJson(gitStatePath(root, 'room-state.json'), null)
if (!state) process.exit(0)

const seenFile = gitStatePath(root, 'room-hook-seen.json')
const seen = new Set(readJson(seenFile, []))
const fresh = (state.unread ?? []).filter(m => !seen.has(m.id))
const paths = pathsOf(ev.tool_name, ev.tool_input, root)
const claims = (state.claims ?? []).filter(c => paths.includes(c.path))

const lines = []
if (fresh.length) {
  lines.push(`[room inbox ${fresh.length}]`)
  for (const m of fresh) lines.push(`  ${m.priority.padEnd(9)} ${m.line}`)
}
if (claims.length) {
  lines.push(`[room claims on ${paths.join(', ')}]`)
  for (const c of claims) lines.push(`  ${c.by}'s agent holds ${c.path}:${c.from}-${c.to} — ${c.intent}${c.plans ? ` (plans: ${c.plans})` : ''}. Do not edit inside that range; room_wait or ask.`)
}
if (lines.length) {
  try { fs.writeFileSync(seenFile, JSON.stringify([...seen, ...fresh.map(m => m.id)].slice(-2000))) } catch { /* best effort */ }
  const interrupt = fresh.some(m => m.priority === 'interrupt')
  if (interrupt) lines.push('An interrupt is pending: re-plan before continuing (room_state).')
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lines.join('\n') } }))
}
