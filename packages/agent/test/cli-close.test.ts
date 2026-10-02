// A close that ends roomagent (4409 after a compacting restart) can arrive while the first sync is awaited: the
// shutdown runs then, with its guard initialised, and exits 75 (review round 2).
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const providers = vi.hoisted(() => [] as EventEmitter[])
vi.mock('y-websocket', async () => {
  const { EventEmitter } = await import('node:events')
  return { WebsocketProvider: class extends EventEmitter {
    synced = false; wsconnected = false
    awareness = { setLocalState: () => {}, setLocalStateField: () => {}, getLocalState: () => ({}), getStates: () => new Map(), on: () => {}, off: () => {} }
    constructor() { super(); providers.push(this) }
    destroy() {}
  } }
})
let dir: string, originalArgv: string[]
const exits: number[] = []
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) vi.stubEnv(key, undefined)
  dir = mkdtempSync(join(tmpdir(), 'roomagent-close-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  originalArgv = process.argv
  process.argv = ['node', 'roomagent', '--dir', dir, '--name', 'Ada', '--room', 'ws://127.0.0.1:9/github.com%2Fo%2Fr', '--connect-timeout-ms', '60000']
  vi.spyOn(process, 'exit').mockImplementation((code => { exits.push(Number(code)); return undefined as never }) as typeof process.exit)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

it('a 4409 close during the first sync exits 75 with the restart line', async () => {
  const rejections: unknown[] = []
  const onRejection = (e: unknown) => { rejections.push(e) }
  process.on('unhandledRejection', onRejection)
  try {
    void import('../src/cli.js')
    for (let i = 0; i < 200 && !providers.length; i++) await new Promise(r => setTimeout(r, 10))
    providers[0]!.emit('connection-close', { code: 4409, reason: "this room's document was compacted when the server restarted; rejoin with a fresh copy" }, providers[0])
    for (let i = 0; i < 300 && !exits.length; i++) await new Promise(r => setTimeout(r, 10))
    expect(exits).toEqual([75])
    expect(rejections).toEqual([])
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('restart roomagent to rejoin with a fresh copy')
  } finally { process.off('unhandledRejection', onRejection) }
})
