import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const boundary = vi.hoisted(() => vi.fn())
vi.mock('y-websocket', () => ({ WebsocketProvider: class { constructor(server: string, room: string, _doc: unknown, options: unknown) { boundary(server, room, options); throw new Error('connection boundary') } } }))
let dir: string, originalArgv: string[]
beforeEach(() => {
  vi.resetModules()
  boundary.mockClear()
  for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) vi.stubEnv(key, undefined)
  dir = mkdtempSync(join(tmpdir(), 'roomagent-cli-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init'])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://gitlab.example/team/repo.git'])
  originalArgv = process.argv
  process.argv = ['node', 'roomagent', '--dir', dir, '--name', 'Ada']
  vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`) })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })
const run = () => import('../src/cli.js')
it('never connects without a destination', async () => {
  await expect(run()).rejects.toThrow('exit 2')
  expect(boundary).not.toHaveBeenCalled()
})
it('does not let stored metadata or ROOM_URL override ROOM_SERVER', async () => {
  writeFileSync(join(dir, '.room.json'), JSON.stringify({ room: 'ws://stored/stored', dir }))
  vi.stubEnv('ROOM_URL', 'ws://url/url')
  vi.stubEnv('ROOM_SERVER', 'ws://selected')
  await expect(run()).rejects.toThrow('connection boundary')
  expect(boundary).toHaveBeenCalledWith('ws://selected', expect.any(String), expect.anything())
})
it('uses explicit room before explicit server and environment', async () => {
  process.argv.push('--room', 'ws://argument/chosen', '--server', 'ws://server')
  vi.stubEnv('ROOM_SERVER', 'ws://env')
  await expect(run()).rejects.toThrow('connection boundary')
  expect(boundary).toHaveBeenCalledWith('ws://argument', 'chosen', expect.anything())
})
it('passes every explicit room credential to the websocket instead of dropping the query', async () => {
  process.argv.push('--room', 'ws://argument/chosen?session=session-id&token=shared-token&key=local-key')
  await expect(run()).rejects.toThrow('connection boundary')
  expect(boundary).toHaveBeenCalledWith('ws://argument', 'chosen', expect.objectContaining({
    params: { session: 'session-id', token: 'shared-token', key: 'local-key' },
  }))
})
it('uses ROOM_URL before saved metadata', async () => {
  writeFileSync(join(dir, '.room.json'), JSON.stringify({ room: 'ws://stored/stored', dir }))
  vi.stubEnv('ROOM_URL', 'ws://url/chosen')
  await expect(run()).rejects.toThrow('connection boundary')
  expect(boundary).toHaveBeenCalledWith('ws://url', 'chosen', expect.anything())
})
it('refuses local mode instead of joining saved team metadata', async () => {
  writeFileSync(join(dir, '.room.json'), JSON.stringify({ room: 'ws://stored/stored', dir }))
  process.argv.push('--server', 'local')
  await expect(run()).rejects.toThrow('exit 2')
  expect(boundary).not.toHaveBeenCalled()
})
