// SessionStart: remember this Codex thread's id next to the clone, so the room can wake it
// (`codex queue --thread <id>`) when an interrupt or a question for this agent arrives.
import fs from 'node:fs'
import { readStdinJson, gitRoot, gitStatePath } from './common.mjs'

const ev = readStdinJson()
const root = gitRoot(ev.cwd)
if (root && ev.session_id) {
  try { fs.writeFileSync(gitStatePath(root, 'room-session.json'), JSON.stringify({ session_id: ev.session_id, at: Date.now(), cwd: ev.cwd }) + '\n') } catch { /* best effort */ }
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Room plugin active: this session can be woken by teammates’ interrupts and questions. Follow the room-etiquette skill.' } }))
