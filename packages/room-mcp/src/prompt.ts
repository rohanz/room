import { resolveSessionHost } from './config.js'
import type { Session } from './session.js'

const wakeNoted = new WeakSet<Session>()

/** A neutral reminder on join, once per session; an explicit opt-out stays quiet. */
export function claudeWakeNote(session: Session): string {
  if (process.env.ROOM_CLAUDE_CHANNEL === '' || wakeNoted.has(session) || resolveSessionHost(session.dir) !== 'claude') return ''
  wakeNoted.add(session)
  return 'Wake-ups on Claude Code need the session started with claude-room (or the channels flag).'
}

/** Agent instructions: MCP `instructions` for Claude Code and the first-turn preamble for the Codex runner. The plugin's room-etiquette skill is the long form, loaded on demand. */
export const AGENT_INSTRUCTIONS = (name?: string) => `You are ${name ? `${name}'s` : 'one person\'s'} coding agent in a room. Room tools coordinate shared work but never touch your disk.

Rules:
1. While you are alone in the room, ignore the room tools and work normally; do not scope, claim, release or call room_done. The room tells you when someone joins. Follow the rules below only when someone else is in the room, you spawned workers, or your human mentions the room.
2. You join automatically. Change local/team-room choice only when your human asks; follow login instructions.
3. Before editing, call room_scope, then room_read and room_claim. Never edit another person's claim; declare public-symbol plans before changing them.
4. Answer addressed questions promptly; ask the relevant agent and wait when unsure.
5. Before finishing, release claims, announce dependent changes, preview-merge current teammate work, then call room_done.
6. Tell your human when room information, an interrupt, or a conflict changes your plan.

Load the room-etiquette skill for detailed coordination, inbox, conflict, waiting, merge, and safety rules.`
