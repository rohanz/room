import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTools } from '../src/tools.js'
import { configureCredentials } from '../src/credentials.js'
import { resolveAuth } from '../src/session.js'

const dirs: string[] = []
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); configureCredentials(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
it('login before join honors the credentials argument for pending login, auth and logout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-login-config-')); dirs.push(dir)
  const file = path.join(dir, 'argument.json'), envFile = path.join(dir, 'environment.json')
  vi.stubEnv('ROOM_CREDENTIALS', envFile)
  const server = 'ws://login-config.example'
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url.endsWith('/auth/config') ? { github: 'device', providers: ['github'] }
      : url.endsWith('/auth/start') ? { provider: 'github', device: 'device', expires_in: 900, interval: 0, user_code: 'CODE', verification_uri: 'https://example.test' }
      : url.endsWith('/auth/poll') ? { session: 'session', login: 'octo' } : { ok: true }
    return new Response(JSON.stringify(body), { status: 200 })
  }))
  const t = createTools({ getSession: () => null, setSession: () => {}, cwd: dir })
  expect(await t.call('room_login', { server, credentials: file })).toContain('CODE')
  expect(fs.existsSync(file)).toBe(true)
  expect(fs.existsSync(envFile)).toBe(false)
  expect(await t.call('room_login', { server, wait: 5 })).toContain('as octo')
  expect(await resolveAuth(server, 'github.com/x/y/main')).toMatchObject({ session: 'session', login: 'octo' })
  expect(await t.call('room_logout', { server, credentials: file })).toContain('logged out')
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({})
})
