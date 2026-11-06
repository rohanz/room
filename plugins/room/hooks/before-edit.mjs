// PreToolUse from hooks.json / hooks/claude.json: before every edit, including edits
// made through the shell. Codex documents Bash as canonical; keep shell/exec aliases
// for other versions. Deliver the inbox and company on all calls; claims only on likely writes.
// Message content comes only from this session's MCP (its arbitration endpoint), never from a
// file: select, print, and confirm after the print (ledger "Before-edit and SessionStart hooks").
// Everything local lives in room/sessions/<sid>/ of the clone's common git directory.
import fs from 'node:fs'
import path from 'node:path'
import { compatibilityCodec, hookCodecFor } from './codecs.mjs'
import { readStdinJson, inputIncomplete, gitRoot, gitCommonDir, sessionDir, readJson, readReceipt, receiptSessionId, writeHookReceipt, writeJsonAtomic, openMcp, selectReply, writeStdout, pathsOf, companyLine, coversPath, containsPath, readTranscriptTail, CONTEXT_CAP, fitLines, joinedLength, STATE_MAX_BYTES } from './common.mjs'

const raw = await readStdinJson()
// Over the cap or late, `ev` holds only the complete fields of the input's prefix (readStdinJson).
const incomplete = inputIncomplete(raw)
const routing = compatibilityCodec.decode('before-tool', raw, process.argv, !!incomplete)
const unchecked = `[room] Room could not read this whole tool call (${incomplete}), so it did not check it against claims or nearby work. Call room_state before editing files others may be working on.`
const root = gitRoot(routing.cwd)
const id = routing.sessionId
if (!root || !receiptSessionId(id)) {
  // Without a session id Room cannot tell whether this session is in a room; where Room has run, say so.
  if (incomplete && root && fs.existsSync(path.join(gitCommonDir(root), 'room'))) {
    await writeStdout(JSON.stringify(compatibilityCodec.context('before-tool', unchecked)))
  }
  process.exit(0)
}
const dir = sessionDir(root, id)
const now = Date.now()

const activityFile = path.join(dir, 'hook-activity.json')
let previous
try { previous = readReceipt(activityFile) } catch { /* absent or invalid activity */ }
if (previous?.session_id !== id || previous?.event !== 'PreToolUse' || typeof previous?.at !== 'number' || now - previous.at >= 5000 || previous.at > now) {
  writeJsonAtomic(activityFile, { at: now, session_id: id, event: 'PreToolUse' })
}
writeHookReceipt(path.join(gitCommonDir(root), 'room'), id, now)

// runtime.json: this hook is its single writer (ledger SF3). The session's SessionStart values in
// session.json are the initial ones; a Claude transcript can reveal a later /model switch.
const session = readJson(path.join(dir, 'session.json'), null)
const codec = hookCodecFor(session?.host)
const ev = codec.decode('before-tool', raw, process.argv, !!incomplete)
const runtime = readJson(path.join(dir, 'runtime.json'), null) ?? {}
const next = codec.reduceRuntime(ev, { sessionRecord: session, previousRuntime: runtime,
  transcript: readTranscriptTail(ev.transcriptPath, runtime.transcript) })
if (JSON.stringify({ ...next, at: 0 }) !== JSON.stringify({ ...runtime, at: 0 })) writeJsonAtomic(path.join(dir, 'runtime.json'), { ...next, at: now })

const state = readJson(path.join(dir, 'state.json'), null, STATE_MAX_BYTES)
const stateAt = typeof state?.at === 'number' && state.at <= now ? state.at : undefined
const stateFresh = stateAt !== undefined && now - stateAt < 60_000
// Claude Code sets agent_id only inside a subagent. The main conversation is the participant: a subagent's
// hook selects and receipts nothing, and its claim and near lines do not count as the main one being told.
// An incomplete input may have lost agent_id past its prefix: treat it like a subagent's, so nothing is
// selected or recorded as told for the main conversation on uncertain identity.
const subagent = ev.subagent
// While alone with nothing owed, only the records above: no endpoint round trip, no scans. state.json is
// rewritten only when something changes, so while this session's MCP is up its age means nothing; without
// the MCP, a stale file is not trusted.
if (stateFresh && state.company !== true && !(state.owedCount ?? 0) && !(state.notices ?? 0) && typeof state.paused !== 'string') process.exit(0)
if (!stateFresh && !fs.existsSync(path.join(dir, 'mcp.json'))) process.exit(0)

const inbox = []
let confirm
const mcp = await openMcp(dir, 700, undefined, id)
const selected = mcp && !subagent ? selectReply(await mcp.request({ op: 'select', sessionId: id })) : undefined
const live = selected?.ok === true || (!!mcp && subagent && (await mcp.request({ op: 'ping', sessionId: id }))?.ok === true)
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
  inbox.push(incomplete ? `[room] ${count}; they arrive with the next tool call Room can read.`
    : subagent ? `[room] ${count} for the main conversation.` : `[room] ${count}; Room is reconnecting.`)
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
  const paths = ev.tool.kind !== 'other' ? pathsOf(ev.tool.originalName, ev.tool.input, root, codec) : []
  if (incomplete) addCoordination(paths.length
    ? `[room] Room read only the start of this tool call (${incomplete}): claims and nearby work were checked for ${paths.join(', ')} only; any other file it changes was not checked.`
    : unchecked)
  const claims = (state.claims ?? []).filter(c => paths.some(p => /[\\/]$/.test(c.path) ? containsPath(c.path, p) : containsPath(c.path, p) && containsPath(p, c.path)))
  const nearby = (state.near ?? []).filter(n => paths.some(p => coversPath(p, n.path)))
  const nearEvidence = [...new Set(nearby.map(n => n.reason === 'changed' ? `${n.by} changed ${n.path}` : `${n.by} has ${n.reason} on ${n.path}`))].sort()
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
    // Approximate lines are the holder's own numbers: Room could not map them into this checkout.
    for (const { claim: c, key, signature } of untold) addCoordination(`  ${c.by}'s agent holds ${/[\\/]$/.test(c.path) ? c.path : `${c.path}:${c.from}-${c.to}`}${c.approximate ? ' in their copy; their lines may have shifted relative to yours' : ''} — ${c.intent}${c.plans ? ` (plans: ${c.plans})` : ''}. Do not edit inside that range; room_wait or ask.`, () => {
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
  const written = await writeStdout(JSON.stringify(codec.context('before-tool', lines.join('\n'))))
  if (written && !subagent) {
    for (let i = 0; i < shownCoordination.length; i++) if (shownCoordination[i] === coordination[i]) receipts[i]?.()
    if (changed) writeJsonAtomic(hookFile, hook)
  }
  // Only a confirmed handoff becomes a receipt; a lost confirm lets the lease expire (a duplicate, never a loss).
  if (written && confirm) await mcp.request({ op: 'confirm', batch: confirm }, 1000)
} else if (changed && !subagent) writeJsonAtomic(hookFile, hook)
mcp?.close()
