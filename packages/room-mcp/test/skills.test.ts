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

it('gives the agent the shared branch instruction through the MCP prompt', () => {
  expect(AGENT_INSTRUCTIONS()).toContain('when your human asks you to push, push to the room branch; Room tells the others to catch up')
  expect(AGENT_INSTRUCTIONS()).toContain('git pull --ff-only --autostash')
  expect(AGENT_INSTRUCTIONS()).toContain('do not undo, rebase or recommit your commits to get past it without their yes')
})

it('lists TypeScript incremental state among regenerable worker output', () => {
  const skill = readFileSync(new URL('../../../plugins/room/skills/room-workers/SKILL.md', import.meta.url), 'utf8')
  expect(skill).toContain('`*.tsbuildinfo`')
})

it('requires actual completion and limits background advice to a verified host', () => {
  for (const text of [workerPrompt('lead', 'a', 'task'), ...['room-workers', 'room-etiquette'].map(name =>
    readFileSync(new URL(`../../../plugins/room/skills/${name}/SKILL.md`, import.meta.url), 'utf8').replace(/\s+/g, ' '))]) {
    expect(text).toContain('(verified on 2.1.300)')
    expect(text).toContain('when responsiveness matters')
    expect(text).toMatch(/actual result before room_done/)
    expect(text).toContain('unverified hosts, including Codex')
    expect(text).toContain('background lifetime and completion delivery are verified')
  }
  const etiquette = readFileSync(new URL('../../../plugins/room/skills/room-etiquette/SKILL.md', import.meta.url), 'utf8')
  for (const limit of ['2.1.285', '10 minutes', '30 minutes', '2 hours', 'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS']) expect(etiquette).toContain(limit)
  expect(etiquette).toContain('A timeout, interruption or missing result is not a pass')
})

it('distinguishes matching preview inputs from independently established integrated-tree equivalence', () => {
  for (const [text, tree] of [[AGENT_INSTRUCTIONS(), 'integrated'], ...['room-etiquette', 'room-workers'].map(name =>
    [readFileSync(new URL(`../../../plugins/room/skills/${name}/SKILL.md`, import.meta.url), 'utf8').replace(/\s+/g, ' '), name === 'room-workers' ? 'collected' : 'integrated'])]) {
    expect(text).toContain('Reuse a complete passing preview only for identical preview inputs, command and relevant environment')
    expect(text).toContain(`Its input hash does not establish equivalence with the ${tree} tree`)
    expect(text).toContain(`Validate the ${tree} tree unless exact equivalence is independently established`)
    expect(text).toContain('CI checks the change requires')
  }
})

it('uses task-appropriate checks and does not assign independent peers a worker lifecycle', () => {
  const etiquette = readFileSync(new URL('../../../plugins/room/skills/room-etiquette/SKILL.md', import.meta.url), 'utf8').replace(/\s+/g, ' ')
  expect(etiquette).toContain('source review or document checks where applicable')
  expect(etiquette).toContain('Whoever integrates owns comprehensive relevant validation')
  expect(etiquette).toContain('independent peers manage their own sessions')
  expect(etiquette).not.toContain("the lead's integrated tree")
  expect(AGENT_INSTRUCTIONS()).toContain('Choose task-appropriate evidence')
  expect(AGENT_INSTRUCTIONS()).toContain('Without a lead, agree scope with affected peers')
  expect(etiquette).toContain('Without a lead, agree scope with affected peers')
  expect(workerPrompt('lead', 'a', 'task')).toContain('focused checks for your changes')
})

it('reserves room_wait for Room dependencies, with one wait at a time', () => {
  for (const name of ['room-etiquette', 'room-workers']) {
    const text = readFileSync(new URL(`../../../plugins/room/skills/${name}/SKILL.md`, import.meta.url), 'utf8').replace(/\s+/g, ' ')
    expect(text).toContain('room_wait observes Room dependencies only')
    expect(text).toContain('use host task completion for your own commands')
    expect(text).toContain('one room_wait at a time')
  }
})

it('teaches that the lead can resume a finished worker', () => {
  for (const name of ['room-workers', 'room-etiquette']) {
    const skill = readFileSync(new URL(`../../../plugins/room/skills/${name}/SKILL.md`, import.meta.url), 'utf8')
    expect(skill, name).toMatch(/[Aa] message from its lead to a finished worker resumes its retained session/)
    expect(skill, name).not.toContain('Finished headless workers cannot answer new questions')
  }
})

// Text consistency checks only; these do not establish live host coordination behavior.
it('keeps peer questions, independent progress and permission boundaries consistent', () => {
  const prompt = workerPrompt('lead', 'a', 'task')
  expect(prompt).toContain('Ask the peer responsible for a dependency directly')
  expect(prompt).toContain('ask lead for scope decisions or unresolved ownership')
  expect(prompt).toContain('Continue independent work while an answer is pending')
  expect(prompt).toContain('room_wait(questionId)')
  expect(prompt).toContain('send failures to their owner')
  expect(prompt).not.toContain('up to three times')
  for (const text of [prompt, AGENT_INSTRUCTIONS(), ...['room-etiquette', 'room-workers'].map(name =>
    readFileSync(new URL(`../../../plugins/room/skills/${name}/SKILL.md`, import.meta.url), 'utf8').replace(/\s+/g, ' '))]) {
    expect(text).toMatch(/[Aa] timeout is not an answer or approval/)
    expect(text).toMatch(/[Pp]ermission decisions stay with the human/)
  }
})

it('limits preview reuse and does not describe own-worker completion as idle-only', () => {
  for (const name of ['room-etiquette', 'room-workers']) {
    const text = readFileSync(new URL(`../../../plugins/room/skills/${name}/SKILL.md`, import.meta.url), 'utf8').replace(/\s+/g, ' ')
    expect(text).toContain('Reuse a complete passing preview only for identical preview inputs, command and relevant environment')
    expect(text).toContain('output-limited runs do not validate the whole tree')
    expect(text).toContain('completion from their own registered workers mid-turn as tool output')
    expect(text).toContain('not proof that content was read or acted on')
    expect(text).not.toContain('completion is `fyi` and waits for idle')
  }
})
