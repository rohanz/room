import { execFileSync } from 'node:child_process'
import { DEFAULT_CLAUDE_CHANNEL, resolveSessionHost } from './config.js'
import type { Session } from './session.js'

/** Claude host detection alone cannot prove channels are enabled. Never promise a wake-up. */
export function claudeWakeUnavailable(dir: string, host = resolveSessionHost(dir), parentArgs?: string): boolean {
  if (host !== 'claude') return false
  if (parentArgs === undefined) {
    try { parentArgs = execFileSync('ps', ['-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
    catch { /* unknown: warn conservatively */ }
  }
  const channel = process.env.ROOM_CLAUDE_CHANNEL ?? DEFAULT_CLAUDE_CHANNEL
  const admitted = [...(parentArgs ?? '').matchAll(/(?:^|\s)--(?:dangerously-load-development-channels|channels)(?:=|\s)(\S+)/g)]
  if (channel && admitted.some(m => m[1].split(',').includes(channel))) return false
  return true
}

const wakeNoted = new WeakSet<Session>()

/** A neutral reminder on join, once per session; an explicit opt-out stays quiet. */
export function claudeWakeNote(session: Session): string {
  if (process.env.ROOM_CLAUDE_CHANNEL === '' || wakeNoted.has(session) || !claudeWakeUnavailable(session.dir)) return ''
  wakeNoted.add(session)
  return 'Wake-ups on Claude Code need the session started with claude-room (or the channels flag).'
}

/** Agent instructions: MCP `instructions` for Claude Code and the first-turn preamble for the Codex runner. The plugin's room-etiquette skill is the long form, loaded on demand. */
export const AGENT_INSTRUCTIONS = (name?: string) => `You are ${name ? `${name}'s` : 'one person\'s'} coding agent in a room. Room tools coordinate shared work but never touch your disk.

Rules:
1. While alone, work normally without room tools; the room announces company. Coordinate when others are present, you spawn workers, or your human mentions the room. When asked to parallelise edits in any words (subagents, fan out, split this up), load the room-workers skill and use room_spawn.
2. You join automatically. Change local/team-room choice only when your human asks; follow login instructions.
3. Before editing, call room_scope, then room_read and room_claim. Never edit another person's claim; declare public-symbol plans before changing them.
4. Answer addressed questions promptly; ask the relevant agent and wait when unsure.
5. Before finishing, release claims, announce dependent changes, preview-merge current teammate work, then call room_done.
6. Tell your human when room information, an interrupt, or a conflict changes your plan.

Load the room-etiquette skill for detailed coordination, inbox, conflict, waiting, merge, and safety rules.`
