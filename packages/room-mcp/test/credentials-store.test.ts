import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getCredential, getPending, removeCredential, setCredential, setPending } from '../src/credentials.js'
import { pollLogin } from '../src/session.js'

const dirs: string[] = []
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'room-cred-store-')); dirs.push(d); return d }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

const entry = (login: string) => ({ session: login.repeat(8), login, at: 1 })

it('a corrupt credentials file is never replaced: the write reports the parse error and keeps the original bytes', () => {
  const file = path.join(tempDir(), 'credentials.json')
  // Two saved logins, then a truncated tail (what an interrupted direct write leaves behind).
  const corrupt = JSON.stringify({ 'wss://a.example': entry('ann'), 'wss://b.example': entry('bob') }, null, 1).slice(0, -3)
  fs.writeFileSync(file, corrupt, { mode: 0o600 })
  expect(() => setCredential(file, 'wss://c.example', entry('cat'))).toThrow(/credentials\.json.*JSON/s)
  expect(() => setPending(file, 'wss://c.example', { provider: 'github', device: 'd', expires_in: 900, interval: 1, startedAt: Date.now() })).toThrow(/JSON/)
  expect(() => removeCredential(file, 'wss://a.example')).toThrow(/JSON/)
  expect(() => getCredential(file, 'wss://a.example')).toThrow(/JSON/)
  expect(fs.readFileSync(file, 'utf8')).toBe(corrupt)
})

it('only an absent file reads as empty; unreadable or non-object files are errors', () => {
  const dir = tempDir()
  const absent = path.join(dir, 'nested', 'credentials.json')
  expect(getCredential(absent, 'wss://a.example')).toBeUndefined()
  expect(getPending(absent, 'wss://a.example')).toBeUndefined()
  expect(removeCredential(absent, 'wss://a.example')).toBe(false)
  expect(fs.existsSync(absent)).toBe(false)
  setCredential(absent, 'wss://a.example', entry('ann'))
  expect(getCredential(absent, 'wss://a.example')).toMatchObject({ login: 'ann' })

  const directory = path.join(dir, 'is-a-directory.json')
  fs.mkdirSync(directory)
  expect(() => getCredential(directory, 'wss://a.example')).toThrow(/is-a-directory\.json/)
  expect(() => setCredential(directory, 'wss://a.example', entry('ann'))).toThrow(/is-a-directory\.json/)

  for (const body of ['[]', 'null', '"text"']) {
    const file = path.join(dir, 'shape.json')
    fs.writeFileSync(file, body)
    expect(() => setCredential(file, 'wss://a.example', entry('ann'))).toThrow(/shape\.json/)
    expect(fs.readFileSync(file, 'utf8')).toBe(body)
  }
})

it('saves atomically with mode 0600, keeps the file format, and removes its temporary file when the replace fails', () => {
  const dir = tempDir()
  const file = path.join(dir, 'credentials.json')
  setCredential(file, 'wss://a.example/', entry('ann'))
  setCredential(file, 'wss://b.example', entry('bob'))
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ 'wss://a.example': entry('ann'), 'wss://b.example': entry('bob') })
  if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(fs.readdirSync(dir)).toEqual(['credentials.json'])

  const before = fs.readFileSync(file, 'utf8')
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) })
  expect(() => setCredential(file, 'wss://c.example', entry('cat'))).toThrow(/disk full/)
  vi.restoreAllMocks()
  expect(fs.readFileSync(file, 'utf8')).toBe(before)
  expect(fs.readdirSync(dir)).toEqual(['credentials.json'])
})

it('a login saves into the store captured when it started, whatever the default path is when it is approved', async () => {
  const dir = tempDir()
  const captured = path.join(dir, 'captured.json'), other = path.join(dir, 'default.json')
  vi.stubEnv('ROOM_CREDENTIALS', other)
  let release!: () => void
  const approved = new Promise<void>(r => { release = r })
  vi.stubGlobal('fetch', vi.fn(async () => { await approved; return new Response(JSON.stringify({ session: 's'.repeat(64), login: 'octo' }), { status: 200 }) }))
  const polling = pollLogin(captured, 'ws://captured.example', { provider: 'github', device: 'd', expires_in: 900, interval: 0 })
  // Meanwhile another login or join selects a different store.
  vi.stubEnv('ROOM_CREDENTIALS', path.join(dir, 'later.json'))
  release()
  expect(await polling).toEqual({ login: 'octo' })
  expect(getCredential(captured, 'ws://captured.example')).toMatchObject({ login: 'octo' })
  expect(fs.existsSync(other)).toBe(false)
  expect(fs.existsSync(path.join(dir, 'later.json'))).toBe(false)
})
