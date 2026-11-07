/** Async entry points must finish privacy priming before their synchronous writers run. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { primePrivateDirectory, primePrivateState } from '@room/local-state/private-state'
import { createTools } from '../src/tools.js'
import { pollLogin, checkTeamAdmission } from '../src/session.js'
import { writeChoice } from '../src/choice.js'
import { CURRENT_COMPAT } from '@room/hub-core'

vi.mock('@room/local-state/private-state', async importOriginal => ({
  ...await importOriginal<typeof import('@room/local-state/private-state')>(),
  primePrivateDirectory: vi.fn(async () => {}), primePrivateState: vi.fn(async () => {}),
}))
const roots: string[] = []
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-writer-prime-')); roots.push(dir); return dir }
afterEach(() => {
  vi.clearAllMocks(); vi.unstubAllGlobals()
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function holdPrime() {
  let finish!: () => void
  vi.mocked(primePrivateDirectory).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  return () => finish()
}

it('awaits config priming before storing a pending tool login', async () => {
  const dir = root(), file = path.join(dir, 'new', 'credentials.json'), finish = holdPrime()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/auth/config')
    ? { providers: ['github'], github: 'device' }
    : { provider: 'github', device: 'device', expires_in: 900, interval: 0, user_code: 'CODE', verification_uri: 'https://example.test' })))
  const tools = createTools({ getSession: () => null, setSession() {}, cwd: dir })
  try {
    const login = tools.call('room_login', { server: 'ws://pending-prime.example', credentials: file })
    await vi.waitFor(() => expect(primePrivateDirectory).toHaveBeenCalledWith(path.dirname(file)))
    expect(fs.existsSync(file)).toBe(false)
    finish()
    expect(await login).toContain('CODE')
    expect(fs.existsSync(file)).toBe(true)
  } finally { await tools.shutdown() }
})

it('awaits config priming before polling stores a confirmed credential', async () => {
  const file = path.join(root(), 'new', 'credentials.json'), finish = holdPrime()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ session: 'session', login: 'octo' })))
  const login = pollLogin(file, 'ws://confirmed-prime.example', { provider: 'github', device: 'device', expires_in: 900, interval: 0 })
  await vi.waitFor(() => expect(primePrivateDirectory).toHaveBeenCalledWith(path.dirname(file)))
  expect(fs.existsSync(file)).toBe(false)
  finish()
  await expect(login).resolves.toEqual({ login: 'octo' })
  expect(fs.existsSync(file)).toBe(true)
})

it('awaits priming before the guarded remembered choice write', async () => {
  const dir = root(), finish = holdPrime()
  execFileSync('git', ['init', '-q', dir])
  const file = path.join(dir, '.git', 'room-choice.json')
  const writing = writeChoice(dir, 'local')
  await vi.waitFor(() => expect(primePrivateDirectory).toHaveBeenCalledWith(path.dirname(file)))
  expect(fs.existsSync(file)).toBe(false)
  finish()
  await writing
  expect(fs.existsSync(file)).toBe(true)
})

it('primes the Room boundary before a modern compatibility discovery can later remember selection', async () => {
  const dir = root()
  execFileSync('git', ['init', '-q', dir])
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/health') ? { compat: CURRENT_COMPAT } : url.endsWith('/view-token') ? { view: 'fixture', hub: 1 } : {})))
  await checkTeamAdmission('ws://compat-prime.example', 'example/repo', { dir, credentialsPath: path.join(dir, 'credentials.json') })
  expect(primePrivateState).toHaveBeenCalledWith(fs.realpathSync.native(path.join(dir, '.git')))
})
