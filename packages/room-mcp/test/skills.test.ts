import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFS } from '../src/tools/index.js'
import { AGENT_INSTRUCTIONS } from '../src/prompt.js'

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

it('teaches the shared branch push and safe catch-up flow in both joining skills', () => {
  for (const name of ['room-join', 'room-etiquette']) {
    const skill = readFileSync(new URL(`../../../plugins/room/skills/${name}/SKILL.md`, import.meta.url), 'utf8')
    expect(skill).toContain('when your human asks you to push, push to the room branch; Room tells the others to catch up')
    expect(skill).toContain('git pull --ff-only --autostash')
    expect(skill).toContain('If it refuses, stop and tell your human')
    expect(skill).toContain('never merge another branch into this one')
  }
})

it('gives the agent the shared branch instruction through the MCP prompt', () => {
  expect(AGENT_INSTRUCTIONS()).toContain('when your human asks you to push, push to the room branch; Room tells the others to catch up')
  expect(AGENT_INSTRUCTIONS()).toContain('git pull --ff-only --autostash')
})

it('lists TypeScript incremental state among regenerable worker output', () => {
  const skill = readFileSync(new URL('../../../plugins/room/skills/room-workers/SKILL.md', import.meta.url), 'utf8')
  expect(skill).toContain('`*.tsbuildinfo`')
})
