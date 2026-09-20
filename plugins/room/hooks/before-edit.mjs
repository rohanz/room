// PreToolUse on edit tools (Codex apply_patch/Write/Edit; Claude Code Edit/Write/MultiEdit/
// NotebookEdit): put the agent's unread room messages, and any teammate claims on the files it
// is about to edit, in front of the model before the edit happens.
// Reads .git/room-state.json, which the room MCP server keeps current.
import { readStdinJson, gitRoot, gitStatePath, readJson, readHookSeen, writeHookSeen, pathsOf } from './common.mjs'

const ev = readStdinJson()
const root = gitRoot(ev.cwd)
if (!root) process.exit(0)
const state = readJson(gitStatePath(root, 'room-state.json'), null)
if (!state) process.exit(0)

const seenFile = gitStatePath(root, 'room-hook-seen.json')
const hookSeen = readHookSeen(seenFile)
const companyWasTold = hookSeen.companyTold
const seen = new Set(hookSeen.seen)
const fresh = (state.unread ?? []).filter(m => !seen.has(m.id))
const paths = pathsOf(ev.tool_name, ev.tool_input, root)
const claims = (state.claims ?? []).filter(c => paths.includes(c.path))

const lines = []
if (state.company === true && !hookSeen.companyTold) {
  const others = Array.isArray(state.others) ? state.others : []
  const names = others.length ? others.join(', ') : 'Someone'
  const verb = others.length > 1 ? 'are' : 'is'
  lines.push(`[room] ${names} ${verb} in this room: follow the room-etiquette skill (room_scope, then room_claim before editing).`)
  hookSeen.companyTold = true
} else if (state.company !== true && hookSeen.companyTold) {
  hookSeen.companyTold = false
}
if (fresh.length) {
  lines.push(`[room inbox ${fresh.length}]`)
  for (const m of fresh) lines.push(`  ${m.priority.padEnd(9)} ${m.line}`)
}
if (claims.length) {
  lines.push(`[room claims on ${paths.join(', ')}]`)
  for (const c of claims) lines.push(`  ${c.by}'s agent holds ${c.path}:${c.from}-${c.to} — ${c.intent}${c.plans ? ` (plans: ${c.plans})` : ''}. Do not edit inside that range; room_wait or ask.`)
}
if (fresh.length || lines.length || hookSeen.companyTold !== companyWasTold) {
  writeHookSeen(seenFile, { seen: [...seen, ...fresh.map(m => m.id)], companyTold: hookSeen.companyTold })
}
if (lines.length) {
  const interrupt = fresh.some(m => m.priority === 'interrupt')
  if (interrupt) lines.push('An interrupt is pending: re-plan before continuing (room_state).')
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lines.join('\n') } }))
}
