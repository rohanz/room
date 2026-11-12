import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { FileStore, MEM_AUDIT_MAX, storeFromEnv, type AuditEntry } from '../src/store.js'

describe('FileStore', () => {
  it('round-trips rooms, sessions (0600) and audit lines through a directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-store-'))
    const a = new FileStore({ dir })
    await a.init()
    expect(await a.loadRooms()).toEqual({})
    await a.saveRooms({ 'github.com/o/r': { by: 'ann', at: 1, branches: ['github.com/o/r/main'] }, 'local/demo': { at: 2, branches: [] } })
    await a.putSession('s1', { login: 'ann', provider: 'github', ghToken: 'gho_x', at: 1 })
    await a.putSession('s2', { login: 'bob@example.com', provider: 'oidc', at: 2 })
    await a.deleteSession('s1')
    await a.audit({ at: 10, event: 'login', login: 'ann', provider: 'github' })
    await a.audit({ at: 20, event: 'join', login: 'ann', room: 'github.com/o/r/main' })
    await a.audit({ at: 30, event: 'refused', room: 'local/x/main', reason: '401 not logged in' })
    expect(fs.statSync(path.join(dir, 'sessions.json')).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').trim().split('\n')).toHaveLength(3)

    // a fresh instance (restart) reads everything back
    const b = new FileStore({ dir })
    await b.init()
    expect(await b.loadRooms()).toEqual({ 'github.com/o/r': { by: 'ann', at: 1, branches: ['github.com/o/r/main'], lastSeen: undefined }, 'local/demo': { by: undefined, at: 2, branches: [], lastSeen: undefined } })
    expect(await b.loadSessions()).toEqual({ s2: { login: 'bob@example.com', provider: 'oidc', at: 2 } })
    expect((await b.readAudit()).entries.map(e => e.event)).toEqual(['login', 'join', 'refused'])
    expect((await b.readAudit({ since: 20 })).entries.map(e => e.at)).toEqual([20, 30])
    expect((await b.readAudit({ limit: 1 })).entries.map(e => e.at)).toEqual([30])
    // A corrupt line is skipped by the listing and marks the queried tail incomplete.
    fs.appendFileSync(path.join(dir, 'audit.log'), 'not json\n')
    expect(await b.readAudit()).toMatchObject({ complete: false, gaps: ['unreadable'] })
    expect((await b.readAudit()).entries).toHaveLength(3)
  })

  it('treats only an absent file as empty: unreadable or corrupt state is an error, never an empty map', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-store-corrupt-'))
    try {
      const s = new FileStore({ dir }); await s.init()
      expect(await s.loadSessions()).toEqual({})
      expect(await s.loadRooms()).toEqual({})
      for (const bad of ['{"s1": {"login": "ann"', '[1]', 'null', '7']) {
        fs.writeFileSync(path.join(dir, 'sessions.json'), bad)
        fs.writeFileSync(path.join(dir, 'rooms.json'), bad)
        await expect(s.loadSessions()).rejects.toThrow(/sessions\.json/)
        await expect(s.loadRooms()).rejects.toThrow(/rooms\.json/)
      }
      // A directory where the file should be is an I/O failure, not absence.
      fs.rmSync(path.join(dir, 'sessions.json')); fs.mkdirSync(path.join(dir, 'sessions.json'))
      await expect(s.loadSessions()).rejects.toThrow(/sessions\.json/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('never replaces a sessions file it cannot read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-store-keep-'))
    try {
      const s = new FileStore({ dir }); await s.init()
      const file = path.join(dir, 'sessions.json')
      fs.writeFileSync(file, '{"s1": {"login": "ann"')
      await expect(s.putSession('s2', { login: 'bob', provider: 'oidc', at: 1 })).rejects.toThrow(/sessions\.json/)
      await expect(s.deleteSession('s1')).rejects.toThrow(/sessions\.json/)
      expect(fs.readFileSync(file, 'utf8')).toBe('{"s1": {"login": "ann"')
      // Once it is readable again, writes build on what the file holds, including an operator's edits.
      fs.writeFileSync(file, JSON.stringify({ s1: { login: 'ann', provider: 'oidc', at: 1 } }))
      await s.putSession('s2', { login: 'bob', provider: 'oidc', at: 2 })
      expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual(['s1', 's2'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('replaces the sessions file atomically and leaves no temporary file when a write fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-store-atomic-'))
    try {
      const s = new FileStore({ dir }); await s.init()
      const file = path.join(dir, 'sessions.json')
      await s.putSession('s1', { login: 'ann', provider: 'oidc', at: 1 })
      const before = fs.readFileSync(file, 'utf8')
      const renames: string[] = []
      const realRename = fs.renameSync.bind(fs)
      const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { renames.push(String(to)); realRename(from, to) })
      await s.putSession('s2', { login: 'bob', provider: 'oidc', at: 2 })
      expect(renames).toEqual([file])
      const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw Object.assign(new Error('disk gone'), { code: 'EIO' }) })
      await expect(s.putSession('s3', { login: 'cy', provider: 'oidc', at: 3 })).rejects.toThrow('disk gone')
      await expect(s.saveRooms({ 'local/d': { at: 1, branches: [] } })).rejects.toThrow('disk gone')
      fsync.mockRestore(); rename.mockRestore()
      expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...JSON.parse(before), s2: { login: 'bob', provider: 'oidc', at: 2 } })
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    } finally { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('works in memory when no directory is given', async () => {
    const s = new FileStore()
    await s.init()
    await s.putSession('x', { login: 'a', provider: 'oidc', at: 1 })
    await s.saveRooms({ 'local/d': { at: 1, branches: [] } })
    await s.audit({ at: 1, event: 'logout', login: 'a' })
    expect(await s.loadRooms()).toEqual({})
    expect(await s.readAudit()).toEqual({ entries: [{ at: 1, event: 'logout', login: 'a' }], complete: true, gaps: [] })
    // the in-memory audit drops entries past MEM_AUDIT_MAX, so it is never evidence
  })

  it('preserves existing schema-2 archive metadata in a complete registry snapshot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-store-migrate-'))
    const s = new FileStore({ dir }); await s.init()
    const entry = { at: 1, branches: ['github.com/o/r/main'], mode: 'repo' as const,
      legacy: ['github.com/o/r/main'], plan: { id: 'p1', sources: ['github.com/o/r/main'] }, step: 'written' as const, migratedAt: 1 }
    await s.saveRooms({ 'github.com/o/r': entry })
    expect(await new FileStore({ dir }).loadRooms()).toMatchObject({ 'github.com/o/r': entry })
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps at most MEM_AUDIT_MAX in-memory audit entries, dropping the oldest', async () => {
    const s = new FileStore()
    for (let at = 1; at <= MEM_AUDIT_MAX + 25; at++) await s.audit({ at, event: 'join', room: 'r' })
    const { entries: all } = await s.readAudit({ limit: 100_000 })
    expect(all).toHaveLength(MEM_AUDIT_MAX)
    expect(all[0].at).toBe(26)
    expect(all.at(-1)!.at).toBe(MEM_AUDIT_MAX + 25)
  })

  it('overlapping saveRooms calls land in order: the last call wins on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-store-q-'))
    const s = new FileStore({ dir })
    await s.init()
    const writes = [1, 2, 3].map(n => s.saveRooms({ [`local/${n}`]: { at: n, branches: [] } }))
    await Promise.all(writes)
    expect(Object.keys(await s.loadRooms())).toEqual(['local/3'])
  })

  it('storeFromEnv uses files or memory and refuses the removed DATABASE_URL option', () => {
    expect(storeFromEnv({})).toBeInstanceOf(FileStore)
    expect(storeFromEnv({ YPERSISTENCE: '/tmp/x' })).toBeInstanceOf(FileStore)
    expect(storeFromEnv({ DATABASE_URL: '  ' })).toBeInstanceOf(FileStore)
    expect(() => storeFromEnv({ DATABASE_URL: 'postgres://u:p@h/db' })).toThrow('DATABASE_URL is no longer supported')
  })
})

it('refuses DATABASE_URL at startup before opening file storage, without exposing its value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-removed-database-'))
  try {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'packages/server/src/index.ts'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'test', GITHUB_CLIENT_ID: '', OIDC_ISSUER: '',
        DATABASE_URL: 'postgres://private-secret@database/room', YPERSISTENCE: dir },
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(1)
    expect(child.stdout).toBe('')
    expect(child.stderr).toBe('DATABASE_URL is no longer supported; remove it and use YPERSISTENCE for file storage\n')
    expect(fs.readdirSync(dir)).toEqual([])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
