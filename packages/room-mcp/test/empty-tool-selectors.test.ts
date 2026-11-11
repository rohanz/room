import { describe, expect, it, vi } from 'vitest'
import { createTools } from '../src/tools.js'
import { resolveConfig } from '../src/config.js'

const preflight = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../src/repository.js', async original => ({ ...await original<object>(), repositoryProblem: preflight }))

// Names and config-trimmed selectors treat whitespace as unset; literal paths do not.
const trimmedSelectors: [string, string][] = [
  ...['room_join', 'room_create'].flatMap(tool => ['room', 'name', 'where', 'server'].map(arg => [tool, arg] as [string, string])),
  ...['server', 'credentials', 'provider'].map(arg => ['room_login', arg] as [string, string]),
  ['room_export', 'room'], ['room_read', 'person'], ['room_impact', 'symbol'], ['room_claim', 'symbol'],
  ['room_preview_merge', 'person'], ['room_send', 'to'], ['room_send', 'inReplyTo'],
  ['room_wait', 'claimId'], ['room_wait', 'questionId'], ['room_spawn', 'model'],
]
const literalPaths: [string, string][] = [
  ['room_join', 'dir'], ['room_create', 'dir'], ['room_spawn', 'dir'],
  ['room_export', 'path'], ['room_state', 'path'], ['room_read', 'path'], ['room_impact', 'path'],
]
function fixture() {
  const tools = createTools({ cwd: process.cwd(), getSession: () => null, setSession() {} })
  const ensure = vi.fn(async () => { throw new Error('existing automatic join path') })
  const settle = vi.fn(async () => { throw new Error('existing explicit room path') })
  tools.setAutoJoin({ ensure, settle, cancel: vi.fn(), retarget: vi.fn() })
  preflight.mockClear()
  return { tools, ensure, settle }
}

describe.each([...trimmedSelectors, ...literalPaths])('%s %s', (tool, arg) => {
  it('refuses the exact empty string before any room or repository work', async () => {
    const blank = ''
    const { tools, ensure, settle } = fixture()
    expect(await tools.call(tool, { [arg]: blank })).toBe(`error: ${arg} was empty; omit ${arg} to use the default`)
    expect(preflight).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
  })
  it('keeps omitted and undefined arguments on their existing dispatch path', async () => {
    const { tools, ensure, settle } = fixture()
    const expected = tool === 'room_join' || tool === 'room_create' ? 'existing explicit room path' : 'existing automatic join path'
    await expect(tools.call(tool, {})).rejects.toThrow(expected)
    await expect(tools.call(tool, { [arg]: undefined })).rejects.toThrow(expected)
    expect(ensure.mock.calls.length + settle.mock.calls.length).toBe(2)
  })
})

describe.each(trimmedSelectors)('%s trimmed %s', (tool, arg) => {
  it.each(['   ', '\t\n'])('refuses whitespace %j before any work', async blank => {
    const { tools, ensure, settle } = fixture()
    expect(await tools.call(tool, { [arg]: blank })).toBe(`error: ${arg} was empty; omit ${arg} to use the default`)
    expect(preflight).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
  })
})

describe.each(literalPaths)('%s literal %s', (tool, arg) => {
  it.each(['   ', '\t\n'])('passes whitespace path %j through existing dispatch', async literal => {
    const { tools } = fixture()
    const expected = tool === 'room_join' || tool === 'room_create' ? 'existing explicit room path' : 'existing automatic join path'
    await expect(tools.call(tool, { [arg]: literal })).rejects.toThrow(expected)
    if (arg === 'dir' && tool !== 'room_spawn') expect(preflight).toHaveBeenCalledWith(literal)
  })
})

it.each(['local', 'ws://team.example'])('refuses blank room overrides on %s even with environment defaults', async where => {
  vi.stubEnv('ROOM_ROOM', 'local/from-env')
  try {
    const { tools, ensure, settle } = fixture()
    for (const room of ['', '   ']) expect(await tools.call('room_join', { where, room })).toBe('error: room was empty; omit room to use the default')
    expect(ensure).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled()
  } finally { vi.unstubAllEnvs() }
})

it('leaves empty free text and explicitly empty lists to the existing handlers', async () => {
  const { tools } = fixture()
  await expect(tools.call('room_send', { type: 'note', text: '' })).rejects.toThrow('existing automatic join path')
  await expect(tools.call('room_spawn', { task: 'work', tag: 'worker', link: [] })).rejects.toThrow('existing automatic join path')
  await expect(tools.call('room_preview_merge', { people: [] })).rejects.toThrow('existing automatic join path')
})

it('keeps empty environment and configuration values as unset', async () => {
  const config = await resolveConfig({ dir: process.cwd(), env: { ROOM_SERVER: '', ROOM_ROOM: '   ', ROOM_NAME: '' }, args: { room: '', name: '   ' } })
  expect(config.room).toBeUndefined()
  expect(config.name).toBeUndefined()
})
