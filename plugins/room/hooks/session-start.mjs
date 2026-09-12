// SessionStart: remember this Codex thread's id next to the clone, so the room can wake it
// (`codex queue --thread <id>`) when an interrupt or a question for this agent arrives.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStdinJson, gitRoot, gitStatePath } from './common.mjs'

const ev = readStdinJson()
const root = gitRoot(ev.cwd)
const id = ev.session_id ?? ev.thread_id ?? ev.sessionId
if (root && id) {
  try { fs.writeFileSync(gitStatePath(root, 'room-session.json'), JSON.stringify({ session_id: id, at: Date.now(), cwd: ev.cwd }) + '\n') } catch { /* best effort */ }
} else {
  try { fs.appendFileSync(path.join(os.tmpdir(), 'room-hook.log'), `${new Date().toISOString()} session-start: no root/id; keys=${Object.keys(ev).join(',')} cwd=${ev.cwd}\n`) } catch { /* ignore */ }
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Room plugin active: this session can be woken by teammates’ interrupts and questions. Follow the room-etiquette skill.' } }))
