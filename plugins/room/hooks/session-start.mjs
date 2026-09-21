// SessionStart: remember this session's id next to the clone, so the room can wake it when
// an interrupt or a question for this agent arrives. Under Codex that is `codex queue
// --thread <id>`; under Claude Code the MCP channel delivers wake-ups, so the bridge only
// needs to know which host it is. The host comes from `--host <name>` on the command line
// (hooks/claude.json passes `--host claude`; the Codex hooks.json passes nothing).
// No flag means Codex: both hosts now send hook_event_name and transcript_path.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStdinJson, gitRoot, gitStatePath, sessionStateDir, readJson, readHookSeen, writeHookSeen, takePendingContext, companyLine } from './common.mjs'

const ev = readStdinJson()
const root = gitRoot(ev.cwd)
const id = ev.session_id ?? ev.thread_id ?? ev.sessionId
const flag = process.argv.indexOf('--host')
const host = flag >= 0 && process.argv[flag + 1] ? process.argv[flag + 1] : 'codex'
if (root && id) {
  const stateDir = sessionStateDir(root, id)
  try { fs.writeFileSync(path.join(stateDir, 'room-hook-session-activity.json'), JSON.stringify({ session_id: id, event: 'SessionStart', at: Date.now() })) } catch { /* best effort */ }
  try { fs.writeFileSync(path.join(stateDir, 'room-session.json'), JSON.stringify({ session_id: id, at: Date.now(), cwd: ev.cwd, host, ...(host === 'claude' && typeof ev.transcript_path === 'string' && ev.transcript_path ? { transcript_path: ev.transcript_path } : {}), ...(typeof ev.model === 'string' && ev.model.trim() ? { model: ev.model.trim().slice(0, 80) } : {}) }) + '\n') } catch { /* best effort */ }
} else {
  try { fs.appendFileSync(path.join(os.tmpdir(), 'room-hook.log'), `${new Date().toISOString()} session-start: no root/id; keys=${Object.keys(ev).join(',')} cwd=${ev.cwd}\n`) } catch { /* ignore */ }
}
if (root) {
  const seenFile = gitStatePath(root, 'room-hook-seen.json')
  const hookSeen = readHookSeen(seenFile)
  const stateFile = gitStatePath(root, 'room-state.json')
  const state = readJson(stateFile, null)
  const now = Date.now()
  const fresh = typeof state?.at === 'number' && state.at <= now && now - state.at < 60_000
  const sameSession = state?.sessionId === id
  const notices = fresh && (state?.sessionId === undefined || sameSession) ? takePendingContext(stateFile, state) : []
  const announced = fresh && sameSession && typeof state?.room === 'string' && state.room.length > 0 && state.company === true
  writeHookSeen(seenFile, { ...hookSeen, companyTold: announced })
  const lines = [...notices, ...(announced ? [companyLine(state)] : [])]
  if (lines.length) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } }))
  }
}
