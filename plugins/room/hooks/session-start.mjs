// SessionStart: remember this session's id next to the clone, so the room can wake it when
// an interrupt or a question for this agent arrives. Under Codex that is `codex queue
// --thread <id>`; under Claude Code the MCP channel delivers wake-ups, so the bridge only
// needs to know which host it is. The host comes from `--host <name>` on the command line
// (hooks/claude.json passes `--host claude`; the Codex hooks.json passes nothing), with the
// Claude-only stdin fields (hook_event_name, transcript_path) as a fallback.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStdinJson, gitRoot, gitStatePath } from './common.mjs'

const ev = readStdinJson()
const root = gitRoot(ev.cwd)
const id = ev.session_id ?? ev.thread_id ?? ev.sessionId
const flag = process.argv.indexOf('--host')
const host = flag >= 0 && process.argv[flag + 1] ? process.argv[flag + 1] : (ev.hook_event_name || ev.transcript_path ? 'claude' : 'codex')
if (root && id) {
  try { fs.writeFileSync(gitStatePath(root, 'room-session.json'), JSON.stringify({ session_id: id, at: Date.now(), cwd: ev.cwd, host }) + '\n') } catch { /* best effort */ }
} else {
  try { fs.appendFileSync(path.join(os.tmpdir(), 'room-hook.log'), `${new Date().toISOString()} session-start: no root/id; keys=${Object.keys(ev).join(',')} cwd=${ev.cwd}\n`) } catch { /* ignore */ }
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Room plugin active: this session can be woken by teammates’ interrupts and questions. Follow the room-etiquette skill.' } }))
