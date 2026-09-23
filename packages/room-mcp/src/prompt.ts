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
const workerWaitNoted = new WeakSet<Session>()

/** Plain wording is separate from process detection so shell-specific setup can be checked. */
export function claudeWakeText(shell?: string): string {
  const rc = shell?.endsWith('bash') ? '~/.bashrc' : '~/.zshrc'
  return [
    "For your human: this Claude Code session can't be woken instantly. Everything still works; messages reach it on its next turn.",
    `To turn wake-ups on, start Claude Code with \`claude-room\`. If that command is not found, add it: \`echo "alias claude-room='claude --dangerously-load-development-channels plugin:room@room'" >> ${rc}\``,
    'On a claude.ai Team or Enterprise account, an Owner must enable channels first.',
  ].join('\n')
}

/** One human note per session; a later first spawn still gets its worker wait instruction. */
export function claudeWakeNote(session: Session, moment: 'alone' | 'company' | 'spawn', options: { host?: string; parentArgs?: string; shell?: string } = {}): string {
  if (moment === 'alone' || process.env.ROOM_CLAUDE_CHANNEL === '' || !claudeWakeUnavailable(session.dir, options.host, options.parentArgs)) return ''
  const forWorkers = moment === 'spawn' && !workerWaitNoted.has(session)
  if (forWorkers) workerWaitNoted.add(session)
  const workerInstruction = 'Block on room_wait in a loop to receive worker questions and completions.'
  if (wakeNoted.has(session)) return forWorkers ? workerInstruction : ''
  wakeNoted.add(session)
  const humanNote = claudeWakeText(options.shell ?? process.env.SHELL)
  return forWorkers ? `${workerInstruction}\n${humanNote}` : humanNote
}

/** Agent instructions: MCP `instructions` for Claude Code and the first-turn preamble for the Codex runner. The plugin's room-etiquette skill is the long form, loaded on demand. */
export const AGENT_INSTRUCTIONS = (name?: string) => `You are ${name ? `${name}'s` : 'one person\'s'} coding agent in a room. Room never changes your files unless you ask it to bring in a worker's output; explicit exports also write files.

1. While alone, work normally without room tools; the room announces company. Change local/team room only when your human asks.
2. With company, declare scope once. Claim only where someone else is near the file; claim the files you will edit. Respect others' claims and declare public-symbol plans.
3. With company, answer addressed questions promptly; ask the relevant agent and wait when unsure.
4. With company, preview current overlapping work before finishing, then room_done releases claims. No release or changed-message ritual.
5. Asked for another agent, agents in parallel, background work or a background lead, or for codex/claude to take part of an editing task: use room_spawn (load room-workers), not a built-in subagent. For a few lines, just do it yourself.
   Before handing a multi-task plan to one other agent, say what Room adds: workers in their own worktrees, collisions surfaced before they land, changed definitions announced to the files that use them, and a merged, uncommitted result to review.
6. Ask your human only when blocked on their decision. Never commit or push unless asked.

Load room-etiquette for coordination details.`
