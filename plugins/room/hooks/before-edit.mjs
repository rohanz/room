// PreToolUse from hooks.json / hooks/claude.json: before every edit, including edits
// made through the shell. Codex documents Bash as canonical; keep shell/exec aliases
// for other versions. Deliver inbox/company on all calls; claims only on likely writes.
// Reads .git/room-state.json, which the room MCP server keeps current.
import fs from 'node:fs'
import path from 'node:path'
import { readStdinJson, gitRoot, sessionStateDir, readJson, readHookSeen, writeHookSeen, takePendingContext, recordWriteIntents, pathsOf, isShellTool, shellLooksLikeWrite, companyLine, coversPath, containsPath, newestModelInTranscriptTail } from './common.mjs'

const ev = readStdinJson()
const root = gitRoot(ev.cwd)
if (!root) process.exit(0)
const stateDir = sessionStateDir(root, ev.session_id)
const now = Date.now()
const activityFile = path.join(stateDir, 'room-hook-activity.json')
const previous = readJson(activityFile, null)
if (previous?.session_id !== ev.session_id || previous?.event !== 'PreToolUse' || typeof previous?.at !== 'number' || now - previous.at >= 5000 || previous.at > now) {
  try { fs.writeFileSync(activityFile, JSON.stringify({ at: now, session_id: ev.session_id, event: 'PreToolUse' })) } catch { /* best effort */ }
}
const sessionFile = path.join(stateDir, 'room-session.json')
let session = readJson(sessionFile, null)
if (session && ev.session_id && session.session_id === ev.session_id) {
  const effort = typeof ev.effort?.level === 'string' && ev.effort.level.trim() ? ev.effort.level.trim().slice(0, 80) : undefined
  const model = session.host === 'codex' && typeof ev.model === 'string' && ev.model.trim() ? ev.model.trim().slice(0, 80) : undefined
  if ((effort && session.effort !== effort) || (model && session.model !== model)) {
    session = { ...session, ...(effort ? { effort } : {}), ...(model ? { model } : {}) }
    try { fs.writeFileSync(sessionFile, JSON.stringify(session) + '\n') } catch { /* best effort */ }
  }
}
const stateFile = path.join(stateDir, 'room-state.json')
const state = readJson(stateFile, null)
const sameSession = state?.sessionId === undefined || ev.session_id === undefined || state.sessionId === ev.session_id
const stateFresh = typeof state?.at !== 'number' || (state.at <= Date.now() && Date.now() - state.at < 60_000)
const pending = state && sameSession && (state.sessionId !== undefined || stateFresh) ? takePendingContext(stateFile, state) : []
// While alone, only the receipt above and the state lookup; no transcript or write scans.
if (!state || !sameSession || (state.company !== true && !pending.length)) process.exit(0)
if (state.company !== true) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: pending.join('\n') } }))
  process.exit(0)
}
const paths = (isShellTool(ev.tool_name) ? shellLooksLikeWrite(ev.tool_input) : /(?:^|__)(?:apply_patch|Write|Edit|MultiEdit|NotebookEdit)$/.test(ev.tool_name))
  ? pathsOf(ev.tool_name, ev.tool_input, root) : []
recordWriteIntents(stateDir, ev.session_id, root, paths, now)
const seenFile = path.join(stateDir, 'room-hook-seen.json')
const hookSeen = readHookSeen(seenFile)
// Claude SessionStart may omit model; assistant transcript entries can reveal a switch.
// Persist the stat cache across hook processes, and never read more than the last 64 KiB.
let transcriptChecked = false
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
      const model = newestModelInTranscriptTail(tail.subarray(0, count).toString('utf8'), start > 0)
      // SessionStart's model is authoritative over the first (possibly lagging)
      // transcript read. Later transcript changes can reveal a /model switch.
      if (model && session.model !== model && !(session.modelFromHook && !cached)) fs.writeFileSync(sessionFile, JSON.stringify({ ...session, model }) + '\n')
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
const claims = (state.claims ?? []).filter(c => paths.some(p => /[\\/]$/.test(c.path) ? containsPath(c.path, p) : containsPath(c.path, p) && containsPath(p, c.path)))

const nearby = (state.near ?? []).filter(n => paths.some(p => coversPath(p, n.path)))
const lines = [...pending]
if (state.company === true && !hookSeen.companyTold) {
  lines.push(companyLine(state))
  hookSeen.companyTold = true
}
if (fresh.length) {
  lines.push(`[room inbox ${fresh.length}]`)
  for (const m of fresh) lines.push(`  ${m.line}`)
}
const nearEvidence = [...new Set(nearby.map(n => `${n.by} has ${n.reason} on ${n.path}`))].sort()
const adequateClaim = paths.length > 0 && paths.every(p => (state.ownClaims ?? []).some(c => containsPath(c.path, p)))
const nearKey = JSON.stringify(nearEvidence)
const previousNear = hookSeen.near ?? {}
const nearChanged = paths.some(p => nearby.length
  ? previousNear[p] !== `${adequateClaim ? 'claimed' : 'open'}:${nearKey}`
  : previousNear[p] !== undefined)
for (const p of paths) {
  if (nearby.length) previousNear[p] = `${adequateClaim ? 'claimed' : 'open'}:${nearKey}`
  else delete previousNear[p]
}
hookSeen.near = previousNear
if (nearby.length && !adequateClaim && nearChanged) {
  lines.push('[room] Claim before editing: ' + nearEvidence.join('; ') + '.')
}
const claimEvidence = JSON.stringify(claims.map(c => [c.id, c.path, c.from, c.to, c.by, c.intent, c.plans]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
const previousClaims = hookSeen.claims ?? {}
const claimsChanged = paths.some(p => claims.length ? previousClaims[p] !== claimEvidence : previousClaims[p] !== undefined)
for (const p of paths) {
  if (claims.length) previousClaims[p] = claimEvidence
  else delete previousClaims[p]
}
hookSeen.claims = previousClaims
if (claims.length && claimsChanged) {
  lines.push(`[room claims on ${paths.join(', ')}]`)
  for (const c of claims) lines.push(`  ${c.by}'s agent holds ${c.path}:${c.from}-${c.to} — ${c.intent}${c.plans ? ` (plans: ${c.plans})` : ''}. Do not edit inside that range; room_wait or ask.`)
}
if (transcriptChecked || fresh.length || lines.length || nearChanged || claimsChanged || hookSeen.companyTold !== companyWasTold) {
  writeHookSeen(seenFile, { ...hookSeen, seen: [...seen, ...fresh.map(m => m.id)], companyTold: hookSeen.companyTold })
}
if (lines.length) {
  const interrupt = fresh.some(m => m.priority === 'interrupt')
  if (interrupt) lines.push('An interrupt is pending: re-plan before continuing (room_state).')
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lines.join('\n') } }))
}
