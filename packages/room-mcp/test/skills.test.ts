import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFS } from '../src/tools/index.js'
import { AGENT_INSTRUCTIONS } from '../src/prompt.js'
import { workerPrompt } from '../src/worker-config.js'

describe('room-workers skill', () => {
  it('has discovery frontmatter and references only registered tools', () => {
    const skill = readFileSync(new URL('../../../plugins/room/skills/room-workers/SKILL.md', import.meta.url), 'utf8')
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)
    expect(frontmatter).not.toBeNull()
    expect(frontmatter![1]).toMatch(/^name: room-workers$/m)
    expect(frontmatter![1]).toMatch(/^description: (?:>-\n +)?\S/m)
    const names = new Set(DEFS.map(def => def.name))
    const references = [...new Set(skill.match(/room_[a-z_]+/g))]
    expect(references.length).toBeGreaterThan(0)
    for (const name of references) expect(names.has(name), name).toBe(true)
  })
})

it('teaches branch-specific push and safe catch-up in repository rooms', () => {
  for (const name of ['room-join', 'room-etiquette']) {
    const skill = readFileSync(new URL(`../../../plugins/room/skills/${name}/SKILL.md`, import.meta.url), 'utf8')
    expect(skill).toContain('When your human asks you to push, push your current branch; Room tells teammates on that branch to catch up')
    expect(skill).toContain('git pull --ff-only --autostash')
    expect(skill).toContain('If it refuses, or your push is rejected, stop and tell your human')
    expect(skill).toContain('do not undo, rebase or recommit your commits to get past it without their yes')
    expect(skill).toContain('never merge another branch into this one')
  }
})

// Text consistency checks only; these do not establish live host coordination behavior.
it('preserves load-bearing coordination guidance across skills and prompts', () => {
  const texts = {
    workers: readFileSync(new URL('../../../plugins/room/skills/room-workers/SKILL.md', import.meta.url), 'utf8'),
    etiquette: readFileSync(new URL('../../../plugins/room/skills/room-etiquette/SKILL.md', import.meta.url), 'utf8'),
    agent: AGENT_INSTRUCTIONS(),
    worker: workerPrompt('lead', 'a', 'task'),
  }
  type Source = keyof typeof texts
  // `absent` pins wording that was removed on purpose and must not creep back.
  const rows: { sources: Source[]; phrases?: string[]; absent?: string[] }[] = [
    { sources: ['etiquette'], absent: ["the lead's integrated tree"] },
    { sources: ['workers', 'etiquette'], absent: ['Finished headless workers cannot answer new questions'] },
    { sources: ['worker'], absent: ['up to three times'] },
    { sources: ['workers', 'etiquette', 'agent', 'worker'], absent: ['completion is `fyi` and waits for idle'] },
    { sources: ['agent'], phrases: [
      'when your human asks you to push, push to the room branch; Room tells the others to catch up',
      'git pull --ff-only --autostash', 'do not undo, rebase or recommit your commits to get past it without their yes',
      'Choose task-appropriate evidence',
    ] },
    { sources: ['workers'], phrases: [
      '`*.tsbuildinfo`', 'the spec sections or rules that are its slice', 'Never write "if relevant"',
      "same spec rules, not at an implementer's file list",
      "about twice another's effort", 'split a large set by member across two owners',
      'each told the same rule', 'ask the running worker what members remain',
      'hand some to the finished worker', 'Agree the handoff and release old claims',
      'start the integrated test run in the background and review diffs or write the summary',
      'Await completion and inspect the actual result', 'Stop remaining background commands and monitors you started before the final message',
    ] },
    { sources: ['workers', 'etiquette', 'worker'], phrases: [
      'when responsiveness matters', 'actual result before room_done', 'unverified hosts, including Codex',
      'background lifetime and completion delivery are verified',
    ] },
    { sources: ['workers', 'etiquette', 'agent'], phrases: [
      'Reuse a complete passing preview only for identical preview inputs, command and relevant environment',
      'CI checks the change requires',
    ] },
    ...(['workers', 'etiquette', 'agent'] as const).map(source => {
      const tree = source === 'workers' ? 'collected' : 'integrated'
      return { sources: [source], phrases: [
        `Its input hash does not establish equivalence with the ${tree} tree`,
        `Validate the ${tree} tree unless exact equivalence is independently established`,
      ] }
    }),
    { sources: ['etiquette'], phrases: [
      'A timeout, interruption or missing result is not a pass',
      'source review or document checks where applicable', 'Whoever integrates owns comprehensive relevant validation',
      'independent peers manage their own sessions', 'A brief is a slice of the task, not its edge',
      'well under the 5-minute limit', 'Name tests or a single file rather than whole suites',
      'Narrow a command stopped at the time limit; do not repeat it on unchanged inputs',
      'an identical timed-out command on the same inputs unless `allowSlow: true` is passed',
      'stop remaining background commands and monitors you started before `room_done` and the final message',
    ] },
    { sources: ['etiquette', 'agent'], phrases: ['Without a lead, agree scope with affected peers'] },
    { sources: ['worker'], phrases: [
      'focused checks for your changes', 'Ask the peer responsible for a dependency directly',
      'ask lead for scope decisions or unresolved ownership', 'Continue independent work while an answer is pending',
      'room_wait(questionId)', 'send failures to their owner',
    ] },
    { sources: ['workers', 'etiquette'], phrases: [
      'room_wait observes Room dependencies only', 'use host task completion for your own commands', 'one room_wait at a time',
      'message from its lead to a finished worker resumes its retained session',
      'output-limited runs do not validate the whole tree',
      'completion from their own registered workers mid-turn as tool output', 'not proof that content was read or acted on',
    ] },
    { sources: ['workers', 'etiquette', 'agent', 'worker'], phrases: [
      'timeout is not an answer or approval', 'decisions stay with the human',
    ] },
  ]
  for (const { sources, phrases = [], absent = [] } of rows) {
    for (const source of sources) {
      const text = texts[source].replace(/\s+/g, ' ')
      for (const phrase of phrases) expect(text, `${source}: ${phrase}`).toContain(phrase)
      for (const phrase of absent) expect(text, `${source} must not say: ${phrase}`).not.toContain(phrase)
    }
  }
})
