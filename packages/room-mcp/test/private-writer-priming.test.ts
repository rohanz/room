/** Async entry points must finish privacy priming before their synchronous writers run. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { primePrivateDirectory, primePrivateState } from '@room/relay'
import { createTools } from '../src/tools.js'
import { pollLogin, checkTeamAdmission } from '../src/session.js'
import { writeChoice } from '../src/choice.js'
import { teamHealth } from './fixtures/team-server.js'

vi.mock('@room/relay', async importOriginal => ({
  ...await importOriginal<typeof import('@room/relay')>(),
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

it('keeps compatibility discovery read-only after removing remembered selection', async () => {
  const dir = root()
  execFileSync('git', ['init', '-q', dir])
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/health') ? teamHealth() : Response.json(url.endsWith('/view-token') ? { view: 'fixture', hub: 1 } : {})))
  await checkTeamAdmission('ws://compat-prime.example', 'example/repo', { dir, credentialsPath: path.join(dir, 'credentials.json') })
  expect(primePrivateState).not.toHaveBeenCalled()
  expect(primePrivateDirectory).not.toHaveBeenCalled()
  expect(fs.readdirSync(path.join(dir, '.git')).filter(name => name.startsWith('room'))).toEqual([])
})
