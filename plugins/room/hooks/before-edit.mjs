// PreToolUse from hooks.json / hooks/claude.json: before every edit, including edits
// made through the shell. Codex documents Bash as canonical; keep shell/exec aliases
// for other versions. Deliver the inbox and company on all calls; claims only on likely writes.
// Message content comes only from this session's MCP (its arbitration endpoint), never from a
// file: select, print, and confirm after the print (ledger "Before-edit and SessionStart hooks").
// Everything local lives in room/sessions/<sid>/ of the clone's common git directory.
import fs from 'node:fs'
import path from 'node:path'
import { readStdinJson, gitRoot, sessionDir, readJson, writeJsonAtomic, openMcp, writeStdout, recordWriteIntents, pathsOf, isShellTool, shellLooksLikeWrite, companyLine, coversPath, containsPath, newestModelInTranscriptTail } from './common.mjs'

const ev = readStdinJson()
const root = gitRoot(ev.cwd)
if (!root || typeof ev.session_id !== 'string' || !ev.session_id) process.exit(0)
const dir = sessionDir(root, ev.session_id)
const now = Date.now()

const activityFile = path.join(dir, 'hook-activity.json')
const previous = readJson(activityFile, null)
if (previous?.event !== 'PreToolUse' || typeof previous?.at !== 'number' || now - previous.at >= 5000 || previous.at > now) {
  writeJsonAtomic(activityFile, { at: now, session_id: ev.session_id, event: 'PreToolUse' })
}

// runtime.json: this hook is its single writer (ledger SF3). The session's SessionStart values in
// session.json are the initial ones; a Claude transcript can reveal a later /model switch.
const session = readJson(path.join(dir, 'session.json'), null)
const runtime = readJson(path.join(dir, 'runtime.json'), null) ?? {}
const next = { ...runtime }
const effort = typeof ev.effort?.level === 'string' && ev.effort.level.trim() ? ev.effort.level.trim().slice(0, 80) : undefined
if (effort) next.effort = effort
if (session?.host === 'codex' && typeof ev.model === 'string' && ev.model.trim()) next.model = ev.model.trim().slice(0, 80)
if (session?.host === 'claude' && typeof ev.transcript_path === 'string') {
  let fd
  try {
    const stat = fs.statSync(ev.transcript_path)
    const cached = runtime.transcript
    if (cached?.path !== ev.transcript_path || cached?.mtimeMs !== stat.mtimeMs || cached?.size !== stat.size) {
      fd = fs.openSync(ev.transcript_path, 'r')
      const start = Math.max(0, stat.size - 64 * 1024)
      const tail = Buffer.alloc(Math.min(stat.size, 64 * 1024))
      const count = fs.readSync(fd, tail, 0, tail.length, start)
      const model = newestModelInTranscriptTail(tail.subarray(0, count).toString('utf8'), start > 0)
      // SessionStart's model is authoritative over the first (possibly lagging) transcript read.
      if (model && !(typeof session.model === 'string' && session.model && !cached)) next.model = model
      next.transcript = { path: ev.transcript_path, mtimeMs: stat.mtimeMs, size: stat.size }
    }
  } catch { /* transcript absent, unreadable or being rotated: retry next hook */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* best effort */ } } }
}
if (JSON.stringify({ ...next, at: 0 }) !== JSON.stringify({ ...runtime, at: 0 })) writeJsonAtomic(path.join(dir, 'runtime.json'), { ...next, at: now })

const state = readJson(path.join(dir, 'state.json'), null)
const stateFresh = typeof state?.at === 'number' && state.at <= now && now - state.at < 60_000
const company = stateFresh && state.company === true
const pending = stateFresh ? (state.owedCount ?? 0) + (state.notices ?? 0) : 0
// While alone with nothing owed, only the records above: no endpoint round trip, no scans.
if (!company && !pending) process.exit(0)

const lines = []
let confirm
const mcp = await openMcp(dir, 700)
const selected = mcp && await mcp.request({ op: 'select', sessionId: ev.session_id })
let interrupt = false
if (selected?.ok) {
  lines.push(...selected.notices)
  if (selected.items.length) {
    lines.push(`[room inbox ${selected.items.length}]`)
    for (const m of selected.items) lines.push(`  ${m.line}`)
    interrupt = selected.items.some(m => m.priority === 'interrupt')
  }
  if (selected.items.length || selected.notices.length) confirm = selected.batch
} else if (stateFresh && state.owedCount > 0) {
  lines.push(`[room] ${state.owedCount} message${state.owedCount === 1 ? '' : 's'} pending; Room is reconnecting.`)
}
if (stateFresh && typeof state.paused === 'string') lines.push(state.paused)

const hookFile = path.join(dir, 'hook.json')
const hook = readJson(hookFile, {})
const told = hook.companyTold === true
let changed = false
if (company) {
  if (!told) { lines.push(companyLine(state)); hook.companyTold = true; changed = true }
  const paths = (isShellTool(ev.tool_name) ? shellLooksLikeWrite(ev.tool_input) : /(?:^|__)(?:apply_patch|Write|Edit|MultiEdit|NotebookEdit)$/.test(ev.tool_name))
    ? pathsOf(ev.tool_name, ev.tool_input, root) : []
  recordWriteIntents(dir, root, paths, now)
  const claims = (state.claims ?? []).filter(c => paths.some(p => /[\\/]$/.test(c.path) ? containsPath(c.path, p) : containsPath(c.path, p) && containsPath(p, c.path)))
  const nearby = (state.near ?? []).filter(n => paths.some(p => coversPath(p, n.path)))
  const nearEvidence = [...new Set(nearby.map(n => `${n.by} has ${n.reason} on ${n.path}`))].sort()
  const adequateClaim = paths.length > 0 && paths.every(p => (state.ownClaims ?? []).some(c => containsPath(c.path, p)))
  const nearKey = JSON.stringify(nearEvidence)
  const previousNear = hook.near ?? {}
  const nearChanged = paths.some(p => nearby.length
    ? previousNear[p] !== `${adequateClaim ? 'claimed' : 'open'}:${nearKey}`
    : previousNear[p] !== undefined)
  for (const p of paths) {
    if (nearby.length) previousNear[p] = `${adequateClaim ? 'claimed' : 'open'}:${nearKey}`
    else delete previousNear[p]
  }
  hook.near = Object.fromEntries(Object.entries(previousNear).slice(-200))
  if (nearby.length && !adequateClaim && nearChanged) lines.push('[room] Claim before editing: ' + nearEvidence.join('; ') + '.')
  const claimEvidence = JSON.stringify(claims.map(c => [c.id, c.path, c.from, c.to, c.by, c.intent, c.plans]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  const previousClaims = hook.claims ?? {}
  const claimsChanged = paths.some(p => claims.length ? previousClaims[p] !== claimEvidence : previousClaims[p] !== undefined)
  for (const p of paths) {
    if (claims.length) previousClaims[p] = claimEvidence
    else delete previousClaims[p]
  }
  hook.claims = Object.fromEntries(Object.entries(previousClaims).slice(-200))
  if (claims.length && claimsChanged) {
    lines.push(`[room claims on ${paths.join(', ')}]`)
    for (const c of claims) lines.push(`  ${c.by}'s agent holds ${c.path}:${c.from}-${c.to} — ${c.intent}${c.plans ? ` (plans: ${c.plans})` : ''}. Do not edit inside that range; room_wait or ask.`)
  }
  changed ||= nearChanged || claimsChanged
}
if (changed) writeJsonAtomic(hookFile, hook)
if (lines.length) {
  if (interrupt) lines.push('An interrupt is pending: re-plan before continuing (room_state).')
  const written = await writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lines.join('\n') } }))
  // Only a confirmed handoff becomes a receipt; a lost confirm lets the lease expire (a duplicate, never a loss).
  if (written && confirm) await mcp.request({ op: 'confirm', batch: confirm }, 1000)
}
mcp?.close()
