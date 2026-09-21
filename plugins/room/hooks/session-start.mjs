// SessionStart: remember this session's id next to the clone, so the room can wake it when
// an interrupt or a question for this agent arrives. Under Codex that is `codex queue
// --thread <id>`; under Claude Code the MCP channel delivers wake-ups, so the bridge only
// needs to know which host it is. The host comes from `--host <name>` on the command line
// (hooks/claude.json passes `--host claude`; the Codex hooks.json passes nothing).
// No flag means Codex: both hosts now send hook_event_name and transcript_path.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStdinJson, gitRoot, gitStatePath, readJson, readHookSeen, writeHookSeen } from './common.mjs'

const ev = readStdinJson()
const root = gitRoot(ev.cwd)
const id = ev.session_id ?? ev.thread_id ?? ev.sessionId
const flag = process.argv.indexOf('--host')
const host = flag >= 0 && process.argv[flag + 1] ? process.argv[flag + 1] : 'codex'
if (root && id) {
  try { fs.writeFileSync(gitStatePath(root, 'room-session.json'), JSON.stringify({ session_id: id, at: Date.now(), cwd: ev.cwd, host, ...(typeof ev.model === 'string' && ev.model.trim() ? { model: ev.model.trim().slice(0, 80) } : {}) }) + '\n') } catch { /* best effort */ }
} else {
  try { fs.appendFileSync(path.join(os.tmpdir(), 'room-hook.log'), `${new Date().toISOString()} session-start: no root/id; keys=${Object.keys(ev).join(',')} cwd=${ev.cwd}\n`) } catch { /* ignore */ }
}
if (root) {
  const seenFile = gitStatePath(root, 'room-hook-seen.json')
  const hookSeen = readHookSeen(seenFile)
  // Company must be announced to each new session; delivered inbox ids stay seen.
  writeHookSeen(seenFile, { ...hookSeen, companyTold: false })
  const state = readJson(gitStatePath(root, 'room-state.json'), null)
  if (state?.company === true) {
    const names = Array.isArray(state.others) ? state.others.join(', ') : 'Company'
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `Room: ${names} in this room. Follow the room-etiquette skill.` } }))
  }
}
