import { expect, it } from 'vitest'
import { DEFS } from '../src/tools/index.js'

it('keeps all advertised tool names, descriptions and schemas within 9,500 characters', () => {
  const sizes = DEFS.map(({ name, description, inputSchema }) => ({ name, chars: name.length + description.length + JSON.stringify(inputSchema).length }))
  expect(sizes.reduce((sum, tool) => sum + tool.chars, 0), JSON.stringify(sizes)).toBeLessThanOrEqual(9_500)
  expect(DEFS.map(d => d.name)).not.toContain('room_who')
  expect(DEFS.map(d => d.name)).not.toContain('room_diff')
  expect(DEFS.map(d => d.name)).not.toContain('room_logout')
  expect(DEFS.map(d => d.name)).not.toContain('room_dismiss')
})
