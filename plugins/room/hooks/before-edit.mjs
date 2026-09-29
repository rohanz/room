// PreToolUse from hooks.json / hooks/claude.json: before every edit, including edits
// made through the shell. Codex documents Bash as canonical; keep shell/exec aliases
// for other versions. Deliver the inbox and company on all calls; claims only on likely writes.
// Message content comes only from this session's MCP (its arbitration endpoint), never from a
// file: select, print, and confirm after the print (ledger "Before-edit and SessionStart hooks").
// Everything local lives in room/sessions/<sid>/ of the clone's common git directory.
import fs from 'node:fs'
import path from 'node:path'
import { readStdinJson, gitRoot, sessionDir, readJson, writeJsonAtomic, openMcp, writeStdout, recordWriteIntents, pathsOf, isShellTool, shellLooksLikeWrite, companyLine, coversPath, containsPath, newestModelInTranscriptTail, CONTEXT_CAP, fitLines, joinedLength } from './common.mjs'

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
const stateAt = typeof state?.at === 'number' && state.at <= now ? state.at : undefined
const stateFresh = stateAt !== undefined && now - stateAt < 60_000
// Claude Code sets agent_id only inside a subagent. The main conversation is the participant: a subagent's
// hook selects and receipts nothing, and its claim and near lines do not count as the main one being told.
const subagent = typeof ev.agent_id === 'string' && ev.agent_id !== ''
// While alone with nothing owed, only the records above: no endpoint round trip, no scans. state.json is
// rewritten only when something changes, so while this session's MCP is up its age means nothing; without
// the MCP, a stale file is not trusted.
if (stateFresh && state.company !== true && !(state.owedCount ?? 0) && !(state.notices ?? 0)) process.exit(0)
if (!stateFresh && !fs.existsSync(path.join(dir, 'mcp.json'))) process.exit(0)

const inbox = []
let confirm
const mcp = await openMcp(dir, 700)
const selected = mcp && !subagent ? await mcp.request({ op: 'select', sessionId: ev.session_id }) : undefined
const live = selected?.ok === true || (!!mcp && subagent && (await mcp.request({ op: 'ping', sessionId: ev.session_id }))?.ok === true)
const current = stateAt !== undefined && (stateFresh || live)
const company = current && state.company === true
let interrupt = false
if (selected?.ok) {
  inbox.push(...selected.notices)
  if (selected.items.length) {
    inbox.push(`[room inbox ${selected.items.length}]`)
    for (const m of selected.items) inbox.push(`  ${m.line}`)
    interrupt = selected.items.some(m => m.priority === 'interrupt')
  }
  if (selected.more) inbox.push(`[room] ${selected.more} more: call room_state`)
  if (selected.items.length || selected.notices.length) confirm = selected.batch
} else if (current && state.owedCount > 0) {
  const count = `${state.owedCount} message${state.owedCount === 1 ? '' : 's'} pending`
  inbox.push(subagent ? `[room] ${count} for the main conversation.` : `[room] ${count}; Room is reconnecting.`)
}
const coordination = []
const receipts = []
const addCoordination = (line, receipt) => { coordination.push(line); receipts.push(receipt) }
if (current && typeof state.paused === 'string') addCoordination(state.paused)

const hookFile = path.join(dir, 'hook.json')
const hook = subagent ? {} : readJson(hookFile, {})
const told = hook.companyTold === true
let changed = false
if (company) {
  if (!told && !subagent) addCoordination(companyLine(state), () => { hook.companyTold = true; changed = true })
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
    if (nearby.length && adequateClaim) { previousNear[p] = `claimed:${nearKey}`; changed ||= nearChanged }
    else if (!nearby.length && previousNear[p] !== undefined) { delete previousNear[p]; changed = true }
  }
  if (nearby.length && !adequateClaim && nearChanged) addCoordination('[room] Claim before editing: ' + nearEvidence.join('; ') + '.', () => {
    for (const p of paths) previousNear[p] = `open:${nearKey}`
    hook.near = Object.fromEntries(Object.entries(previousNear).slice(-200))
    changed = true
  })
  hook.near = Object.fromEntries(Object.entries(previousNear).slice(-200))
  const previousClaims = hook.claims ?? {}
  const evidence = claims.map(c => ({ claim: c, key: String(c.id), signature: JSON.stringify([c.id, c.path, c.from, c.to, c.approximate, c.by, c.intent, c.plans]) }))
  const untold = evidence.filter(({ key, signature }) => paths.some(p => previousClaims[p]?.[key] !== signature))
  for (const p of paths) {
    if (claims.length) {
      const old = previousClaims[p]
      previousClaims[p] = Object.fromEntries(evidence.filter(({ key, signature }) => old && typeof old === 'object' && old[key] === signature)
        .map(({ key, signature }) => [key, signature]))
      if (old && typeof old === 'object' && Object.keys(old).length !== Object.keys(previousClaims[p]).length) changed = true
    }
    else if (previousClaims[p] !== undefined) { delete previousClaims[p]; changed = true }
  }
  hook.claims = Object.fromEntries(Object.entries(previousClaims).slice(-200))
  if (untold.length) {
    addCoordination(`[room claims on ${paths.join(', ')}]`)
    for (const { claim: c, key, signature } of untold) addCoordination(`  ${c.by}'s agent holds ${c.path}:${c.from}-${c.to}${c.approximate ? ' (approximate whole-file warning)' : ''} — ${c.intent}${c.plans ? ` (plans: ${c.plans})` : ''}. Do not edit inside that range; room_wait or ask.`, () => {
      for (const p of paths) previousClaims[p][key] = signature
      changed = true
    })
  }
}
// Inbox first, then coordination cut to what is left of the cap. An inbox that alone would not fit (the MCP
// bounds it, so only an oversized notice) is not printed, and nothing is confirmed: it stays owed.
if (interrupt) inbox.push('An interrupt is pending: re-plan before continuing (room_state).')
const shownCoordination = fitLines(coordination, joinedLength(inbox) <= CONTEXT_CAP ? CONTEXT_CAP - joinedLength(inbox) - 1 : CONTEXT_CAP)
const lines = joinedLength(inbox) <= CONTEXT_CAP ? [...inbox, ...shownCoordination] : shownCoordination
if (joinedLength(inbox) > CONTEXT_CAP) confirm = undefined
if (lines.length) {
  const written = await writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lines.join('\n') } }))
  if (written && !subagent) {
    for (let i = 0; i < shownCoordination.length; i++) if (shownCoordination[i] === coordination[i]) receipts[i]?.()
    if (changed) writeJsonAtomic(hookFile, hook)
  }
  // Only a confirmed handoff becomes a receipt; a lost confirm lets the lease expire (a duplicate, never a loss).
  if (written && confirm) await mcp.request({ op: 'confirm', batch: confirm }, 1000)
} else if (changed && !subagent) writeJsonAtomic(hookFile, hook)
mcp?.close()
