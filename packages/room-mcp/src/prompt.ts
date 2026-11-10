import { delegationInstructions } from './hosts/instructions.js'
import type { Session } from './session.js'
import { wakeUnavailable, wakeText } from './hosts/prompt.js'
import { BASE_CATCH_UP } from '@room/shared'

const wakeNoted = new WeakSet<Session>()
const workerWaitNoted = new WeakSet<Session>()

/** One human note per session; a later first spawn still gets its worker wait instruction. */
export function sessionWakeNote(session: Session, moment: 'alone' | 'company' | 'spawn', options: { host?: string } = {}): string {
  if (moment === 'alone' || !wakeUnavailable(session.dir, options.host)) return ''
  const forWorkers = moment === 'spawn' && !workerWaitNoted.has(session)
  if (forWorkers) workerWaitNoted.add(session)
  const workerInstruction = 'Continue independent work while workers run. When blocked on an answer or claim, use room_wait(questionId/claimId); otherwise use short room_wait calls when ready for worker results. Keep headless leads alive until supervision is complete. A timeout is not an answer or approval.'
  if (wakeNoted.has(session)) return forWorkers ? workerInstruction : ''
  wakeNoted.add(session)
  const humanNote = wakeText(process.env.ROOM_WAKE === 'off')
  return forWorkers ? `${workerInstruction}\n${humanNote}` : humanNote
}

/** Agent instructions: MCP `instructions` for Claude Code and the first-turn preamble for the Codex runner. The plugin's room-etiquette skill is the long form, loaded on demand. */
export const AGENT_INSTRUCTIONS = (name?: string) => `You are ${name ? `${name}'s` : 'one person\'s'} coding agent in a room. Room never changes your files unless you ask it to bring in a worker's output; explicit exports also write files.

1. While alone, work normally without room tools; the room announces company. Change local/team room only when your human asks.
2. With company, declare scope once. Claim only where someone else is near the file; claim the files you will edit. Respect others' claims and declare public-symbol plans.
3. With company, answer addressed questions promptly; ask the owning peer about dependencies, and the lead, if any, about scope or unresolved ownership. Without a lead, agree scope with affected peers. Continue independent work pending answers; when blocked, use room_wait(questionId/claimId). A timeout is not an answer or approval; permission decisions stay with the human.
   Workers report progress in room_done. Send findings directly to the owning peer; send a lead note only when it must know before finishing. Ask when blocked.
4. With company, agree interfaces and implement concurrently; dependencies still take time. Choose task-appropriate evidence; check affected interfaces when needed with room_preview_merge(people=[named peers, including finished ones], run="<focused check>"); never copy peer files into your overlay to test. Before finishing, preview current overlapping work, then room_done releases claims. Skipped present peers need explicit names. Reuse a complete passing preview only for identical preview inputs, command and relevant environment. Whoever integrates runs full relevant validation, including the CI checks the change requires. Validate the collected tree unless collect reports it identical to the most recent preview of this checkout, which passed the same command; that covers files and command only, not Git state, environment or ignored files. Partial or output-limited runs do not validate the whole tree. Rerun for relevant changed inputs, failures or uncertain evidence. No release or changed-message ritual.
${delegationInstructions}
   Before handing a multi-task plan to one other agent, say what Room adds: workers in their own worktrees, claims and questions for overlap, collisions surfaced before they land, changed definitions announced to the files that use them, and a combined preview of the uncommitted result before collection.
6. Ask your human only when blocked on their decision. Never commit or push unless asked. In a room on a shared branch, when your human asks you to push, push to the room branch; Room tells the others to catch up. ${BASE_CATCH_UP}

Load room-etiquette for coordination details.`
