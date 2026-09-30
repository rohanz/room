import { expect, it } from 'vitest'
import { DEFS } from '../src/tools/index.js'

it('keeps all advertised tool names, descriptions and schemas within 9,350 characters', () => {
  const sizes = DEFS.map(({ name, description, inputSchema }) => ({ name, chars: name.length + description.length + JSON.stringify(inputSchema).length }))
  expect(sizes.reduce((sum, tool) => sum + tool.chars, 0), JSON.stringify(sizes)).toBeLessThanOrEqual(9_350)
  expect(DEFS.map(d => d.name)).not.toContain('room_who')
  expect(DEFS.map(d => d.name)).not.toContain('room_diff')
  expect(DEFS.map(d => d.name)).not.toContain('room_logout')
  expect(DEFS.map(d => d.name)).not.toContain('room_dismiss')
  const collect = DEFS.find(d => d.name === 'room_collect')!
  expect(collect.inputSchema.properties).not.toHaveProperty('commit')
  expect(collect.inputSchema.required ?? []).not.toContain('tag')
  expect(collect.inputSchema).toHaveProperty('additionalProperties', false)
  const spawn = DEFS.find(d => d.name === 'room_spawn')!.description
  for (const phrase of ['another agent', 'in parallel', 'in the background', 'codex', 'claude']) expect(spawn).toContain(phrase)
  const share = DEFS.find(d => d.name === 'room_share')!.description
  expect(share).toContain('share plans only')
  expect(share).toContain('only my declared files')
  const description = (name: string) => DEFS.find(d => d.name === name)!.description
  expect(description('room_state')).toContain('is Room set up right?')
  expect(description('room_send')).toContain('ask the worker a follow-up')
  expect(description('room_send')).toContain('interrupt the worker')
  expect(description('room_collect')).toContain('bring in their work')
  expect(description('room_leave')).toContain('work locally')
  expect(description('room_preview_merge')).toContain('will our changes work together?')
  const state = DEFS.find(d => d.name === 'room_state')!
  if ('check' in state.inputSchema.properties) expect(state.inputSchema.properties.check).toHaveProperty('description', 'setup check (room doctor)')
})
