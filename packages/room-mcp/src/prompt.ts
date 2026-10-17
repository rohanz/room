import { resolveSessionHost } from './config.js'
import type { Session } from './session.js'
import { claudeWakeAvailable } from './wake-path.js'
import { BASE_CATCH_UP } from '@room/shared'

/** The exported inbox socket (Claude Code 2.1.224+) or an admitted channel enables wakes. */
export function claudeWakeUnavailable(dir: string, host = resolveSessionHost(), parentArgs?: string): boolean {
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
    'For your human: no wake path is available for this Claude Code session. Pending messages can arrive on Room tool replies and eligible edit hooks; an idle session may need another turn.',
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
  const workerInstruction = 'Continue independent work while workers run. When blocked on an answer or claim, use room_wait(questionId/claimId); otherwise use short room_wait calls when ready for worker results. Keep headless leads alive until supervision is complete. A timeout is not an answer or approval.'
  if (wakeNoted.has(session)) return forWorkers ? workerInstruction : ''
  wakeNoted.add(session)
  const humanNote = claudeWakeText(options.shell ?? process.env.SHELL, process.env.ROOM_WAKE === 'off')
  return forWorkers ? `${workerInstruction}\n${humanNote}` : humanNote
}

/** Agent instructions: MCP `instructions` for Claude Code and the first-turn preamble for the Codex runner. The plugin's room-etiquette skill is the long form, loaded on demand. */
export const AGENT_INSTRUCTIONS = (name?: string) => `You are ${name ? `${name}'s` : 'one person\'s'} coding agent in a room. Room never changes your files unless you ask it to bring in a worker's output; explicit exports also write files.

1. While alone, work normally without room tools; the room announces company. Change local/team room only when your human asks.
2. With company, declare scope once. Claim only where someone else is near the file; claim the files you will edit. Respect others' claims and declare public-symbol plans.
3. With company, answer addressed questions promptly; ask the owning peer about dependencies, and the lead, if any, about scope or unresolved ownership. Without a lead, agree scope with affected peers. Continue independent work pending answers; when blocked, use room_wait(questionId/claimId). A timeout is not an answer or approval; permission decisions stay with the human.
   Workers report progress in room_done. Send findings directly to the owning peer; send a lead note only when it must know before finishing. Ask when blocked.
4. With company, agree interfaces and implement concurrently; dependencies still take time. Choose task-appropriate evidence; check affected interfaces when needed with room_preview_merge(people=[named peers, including finished ones], run="<focused check>"); never copy peer files into your overlay to test. Before finishing, preview current overlapping work, then room_done releases claims. Skipped present peers need explicit names. Reuse a complete passing preview only for identical preview inputs, command and relevant environment. Its input hash does not establish equivalence with the integrated tree. Whoever integrates runs full relevant validation, including the CI checks the change requires. Validate the integrated tree unless exact equivalence is independently established; partial or output-limited runs do not validate the whole tree. Rerun for relevant changed inputs, failures or uncertain evidence. No release or changed-message ritual.
5. Use room_spawn (load room-workers) only when the human explicitly requests Room for delegation, or is continuing an already requested Room worker workflow. Generic requests for another agent, parallel work, background work, or codex/claude help use the host’s normal delegation; Room being installed or joined is not consent to Room workers. For explicit Room work: start independent work early; agree the interfaces each task needs; split by task, dispatch independent parts in parallel early with short briefs, and claim regions. Sequence same-line edits or work that truly needs a result first. The lead uses focused previews of named workers when needed to verify interfaces while they run; workers need not wait for its integrated tree and may finish at different times. For a few lines, just do it yourself. Message a finished worker only for useful follow-ups; defer collection until revisions end, or room_collect(keep=true) to retain resumption. refresh=true rebases only stopped workers; prefer peer previews for live dependencies.
   Before handing a multi-task plan to one other agent, say what Room adds: workers in their own worktrees, claims and questions for overlap, collisions surfaced before they land, changed definitions announced to the files that use them, and a combined preview of the uncommitted result before collection.
6. Ask your human only when blocked on their decision. Never commit or push unless asked. In a room on a shared branch, when your human asks you to push, push to the room branch; Room tells the others to catch up. ${BASE_CATCH_UP}

Load room-etiquette for coordination details.`
