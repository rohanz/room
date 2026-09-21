// PreToolUse from hooks.json / hooks/claude.json: before every edit, including edits
// made through the shell. Codex documents Bash as canonical; keep shell/exec aliases
// for other versions. Deliver inbox/company on all calls; claims only on likely writes.
// Reads .git/room-state.json, which the room MCP server keeps current.
import fs from 'node:fs'
import path from 'node:path'
import { readStdinJson, gitRoot, sessionStateDir, readJson, readHookSeen, writeHookSeen, recordWriteIntents, pathsOf, isShellTool, shellLooksLikeWrite, companyLine, coversPath } from './common.mjs'

const ev = readStdinJson()
const root = gitRoot(ev.cwd)
if (!root) process.exit(0)
const stateDir = sessionStateDir(root, ev.session_id)
const state = readJson(path.join(stateDir, 'room-state.json'), null)
// Only the state lookup is needed while alone; no activity, transcript or write scans.
if (!state || state.company !== true) process.exit(0)
const activityFile = path.join(stateDir, 'room-hook-activity.json')
const now = Date.now()
const paths = (isShellTool(ev.tool_name) ? shellLooksLikeWrite(ev.tool_input) : /(?:^|__)(?:apply_patch|Write|Edit|MultiEdit|NotebookEdit)$/.test(ev.tool_name))
  ? pathsOf(ev.tool_name, ev.tool_input, root) : []
recordWriteIntents(stateDir, ev.session_id, root, paths, now)
const previous = readJson(activityFile, null)
if (previous?.session_id !== ev.session_id || typeof previous?.at !== 'number' || now - previous.at >= 5000 || previous.at > now) {
  try { fs.writeFileSync(activityFile, JSON.stringify({ at: now, session_id: ev.session_id })) } catch { /* best effort */ }
}
const seenFile = path.join(stateDir, 'room-hook-seen.json')
const hookSeen = readHookSeen(seenFile)
// Claude SessionStart omits model; assistant transcript entries report the active model.
// Persist the stat cache across hook processes, and never read more than the last 64 KiB.
let transcriptChecked = false
const sessionFile = path.join(stateDir, 'room-session.json')
const session = readJson(sessionFile, null)
if (session?.host === 'claude' && typeof ev.transcript_path === 'string') {
  let fd
  try {
    const stat = fs.statSync(ev.transcript_path)
    const cached = hookSeen.transcript
    if (cached?.path !== ev.transcript_path || cached?.mtimeMs !== stat.mtimeMs || cached?.size !== stat.size) {
      fd = fs.openSync(ev.transcript_path, 'r')
      const start = Math.max(0, stat.size - 64 * 1024)
      const tail = Buffer.alloc(Math.min(stat.size, 64 * 1024))
      const count = fs.readSync(fd, tail, 0, tail.length, start)
      const lines = tail.subarray(0, count).toString('utf8').split('\n')
      if (start > 0) lines.shift() // the first line may start outside the tail
      for (let i = lines.length - 1; i >= 0; i--) {
        let entry
        try { entry = JSON.parse(lines[i]) } catch { continue }
        const model = typeof entry?.message?.model === 'string' ? entry.message.model.trim() : ''
        if (!model || model.startsWith('<')) continue
        if (session.model !== model) fs.writeFileSync(sessionFile, JSON.stringify({ ...session, model }) + '\n')
        break
      }
      hookSeen.transcript = { path: ev.transcript_path, mtimeMs: stat.mtimeMs, size: stat.size }
      transcriptChecked = true
    }
  } catch { /* transcript absent, unreadable or being rotated: retry next hook */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* best effort */ } } }
}

const companyWasTold = hookSeen.companyTold
const seen = new Set(hookSeen.seen)
const fresh = (state.unread ?? []).filter(m => !seen.has(m.id))
if (typeof state.name === 'string' && fresh.length) {
  hookSeen.shown = { ...hookSeen.shown, ...Object.fromEntries(fresh.map(m => [m.id, state.name])) }
}
const claims = (state.claims ?? []).filter(c => paths.some(p => c.path.endsWith('/') ? p.startsWith(c.path) : p === c.path))

const nearby = (state.near ?? []).filter(n => paths.some(p => coversPath(p, n.path)))
const lines = []
if (state.company === true && !hookSeen.companyTold) {
  lines.push(companyLine(state))
  hookSeen.companyTold = true
}
if (fresh.length) {
  lines.push(`[room inbox ${fresh.length}]`)
  for (const m of fresh) lines.push(`  ${m.line}`)
}
if (nearby.length) {
  lines.push('[room] Claim before editing: ' + [...new Set(nearby.map(n => `${n.by} has ${n.reason} on ${n.path}`))].join('; ') + '.')
}
if (claims.length) {
  lines.push(`[room claims on ${paths.join(', ')}]`)
  for (const c of claims) lines.push(`  ${c.by}'s agent holds ${c.path}:${c.from}-${c.to} — ${c.intent}${c.plans ? ` (plans: ${c.plans})` : ''}. Do not edit inside that range; room_wait or ask.`)
}
if (transcriptChecked || fresh.length || lines.length || hookSeen.companyTold !== companyWasTold) {
  writeHookSeen(seenFile, { ...hookSeen, seen: [...seen, ...fresh.map(m => m.id)], companyTold: hookSeen.companyTold })
}
if (lines.length) {
  const interrupt = fresh.some(m => m.priority === 'interrupt')
  if (interrupt) lines.push('An interrupt is pending: re-plan before continuing (room_state).')
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lines.join('\n') } }))
}
