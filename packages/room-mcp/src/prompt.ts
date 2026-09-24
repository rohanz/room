import { resolveSessionHost } from './config.js'
import type { Session } from './session.js'
import { claudeWakeAvailable } from './wake-path.js'

/** The exported inbox socket (Claude Code 2.1.224+) or an admitted channel enables wakes. */
export function claudeWakeUnavailable(dir: string, host = resolveSessionHost(dir), parentArgs?: string): boolean {
  if (host !== 'claude') return false
  return !claudeWakeAvailable({ host, parentArgs })
}

const wakeNoted = new WeakSet<Session>()
const workerWaitNoted = new WeakSet<Session>()

/** Plain wording is separate from process detection so shell-specific setup can be checked. */
export function claudeWakeText(shell?: string, off = false): string {
  if (off) return 'For your human: wake-ups are off in this process (ROOM_WAKE=off). Set ROOM_WAKE=auto to enable them.'
  const rc = shell?.endsWith('bash') ? '~/.bashrc' : '~/.zshrc'
  return [
    "For your human: this Claude Code session can't be woken instantly. Everything still works; messages reach it on its next turn.",
    'First update Claude Code to 2.1.224 or later (2.1.234 or later on native Windows) so it can bind an inbox socket. Check /status for its Peer address.',
    `If a socket is unavailable, start Claude Code with \`claude-room\`. If that command is not found, add it: \`echo "alias claude-room='claude --dangerously-load-development-channels plugin:room@room'" >> ${rc}\``,
    'For claude-room channels on a claude.ai Team or Enterprise account, an Owner must enable channels; organization settings can also turn cross-session messaging off.',
  ].join('\n')
}

/** One human note per session; a later first spawn still gets its worker wait instruction. */
export function claudeWakeNote(session: Session, moment: 'alone' | 'company' | 'spawn', options: { host?: string; parentArgs?: string; shell?: string } = {}): string {
  if (moment === 'alone' || !claudeWakeUnavailable(session.dir, options.host, options.parentArgs)) return ''
  const forWorkers = moment === 'spawn' && !workerWaitNoted.has(session)
  if (forWorkers) workerWaitNoted.add(session)
  const workerInstruction = 'Block on room_wait in a loop to receive worker questions and completions.'
  if (wakeNoted.has(session)) return forWorkers ? workerInstruction : ''
  wakeNoted.add(session)
  const humanNote = claudeWakeText(options.shell ?? process.env.SHELL, process.env.ROOM_WAKE === 'off')
  return forWorkers ? `${workerInstruction}\n${humanNote}` : humanNote
}

/** Agent instructions: MCP `instructions` for Claude Code and the first-turn preamble for the Codex runner. The plugin's room-etiquette skill is the long form, loaded on demand. */
export const AGENT_INSTRUCTIONS = (name?: string) => `You are ${name ? `${name}'s` : 'one person\'s'} coding agent in a room. Room never changes your files unless you ask it to bring in a worker's output; explicit exports also write files.

1. While alone, work normally without room tools; the room announces company. Change local/team room only when your human asks.
2. With company, declare scope once. Claim only where someone else is near the file; claim the files you will edit. Respect others' claims and declare public-symbol plans.
3. With company, answer addressed questions promptly; ask the relevant agent and wait when unsure.
   Workers report progress in room_done. Send a note only when the lead must know before finishing; ask a question when blocked.
4. With company, preview current overlapping work before finishing, then room_done releases claims. No release or changed-message ritual.
5. Asked for another agent, agents in parallel, background work or a background lead, or for codex/claude to take part of an editing task: use room_spawn (load room-workers), not a built-in subagent. For a few lines, just do it yourself.
   Before handing a multi-task plan to one other agent, say what Room adds: workers in their own worktrees, collisions surfaced before they land, changed definitions announced to the files that use them, and a merged, uncommitted result to review.
6. Ask your human only when blocked on their decision. Never commit or push unless asked.

Load room-etiquette for coordination details.`
