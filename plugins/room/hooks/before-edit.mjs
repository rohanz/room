// PreToolUse from hooks.json / hooks/claude.json: before every edit, including edits
// made through the shell. Codex documents Bash as canonical; keep shell/exec aliases
// for other versions. Deliver inbox/company on all calls; claims only on likely writes.
// Reads .git/room-state.json, which the room MCP server keeps current.
import { readStdinJson, gitRoot, gitStatePath, readJson, readHookSeen, writeHookSeen, pathsOf, isShellTool, shellLooksLikeWrite } from './common.mjs'

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
const paths = !isShellTool(ev.tool_name) || shellLooksLikeWrite(ev.tool_input)
  ? pathsOf(ev.tool_name, ev.tool_input, root) : []
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
