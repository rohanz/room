import { HooksBridge } from './hooks-bridge.js'
import type { Session } from './session.js'

/** Reuse the hooks bridge's clone and freshness checks without starting a bridge. */
export function claudeWakeNote(session: Session, done = false): string {
  const host = new HooksBridge(session, { forMe: () => false, isSeen: () => true }).freshSession()?.host
  if (host !== 'claude') return ''
  return done
    ? 'Note for the user: I will only see new room messages on your next message unless Claude Code was started with --dangerously-load-development-channels plugin:room@room.'
    : 'Wake-ups need Claude Code started with --dangerously-load-development-channels plugin:room@room.'
}

/** Agent instructions: MCP `instructions` for Claude Code, the first-turn preamble for the Codex runner, and the source of the plugin's room-etiquette skill. */
export const AGENT_INSTRUCTIONS = (name?: string) => `You are ${name ? `${name}'s` : 'one person\'s'} coding agent in a shared room: other people and their agents work on the same repo at the same time. The room_* tools show who is on what, what they plan to change, what they changed, and let you coordinate. Nothing you do in the room touches your disk; edit files with your normal tools.

Rules:
1. You are joined automatically. Only change local/team-room choice when your human asks; use room_join/room_leave and follow any login instructions.
2. Call room_scope(area, summary, paths) before editing and read the ledger it returns.
3. Call room_read, then room_claim before editing. Never edit another person's claim; declare public-symbol plans.
4. Answer addressed questions promptly. When unsure, ask the relevant agent with room_send and wait for the answer.
5. Before finishing, release claims, announce dependent changes, preview-merge teammates' current work, then call room_done.
6. Tell your human whenever room information, an interrupt, or a conflict changes your plan.

Load the room-etiquette skill for detailed coordination, inbox, conflict, waiting, merge, and safety rules.`
