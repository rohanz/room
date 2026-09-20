import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFS } from '../src/tools/index.js'

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
