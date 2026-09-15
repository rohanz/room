import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileStore, PgStore, WriteQueue, MEM_AUDIT_MAX, storeFromEnv, type AuditEntry } from '../src/store.js'

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
    expect((await b.readAudit()).map(e => e.event)).toEqual(['login', 'join', 'refused'])
    expect((await b.readAudit({ since: 20 })).map(e => e.at)).toEqual([20, 30])
    expect((await b.readAudit({ limit: 1 })).map(e => e.at)).toEqual([30])
    // a corrupt line is skipped, not fatal
    fs.appendFileSync(path.join(dir, 'audit.log'), 'not json\n')
    expect(await b.readAudit()).toHaveLength(3)
  })

  it('works in memory when no directory is given', async () => {
    const s = new FileStore()
    await s.init()
    await s.putSession('x', { login: 'a', provider: 'oidc', at: 1 })
    await s.saveRooms({ 'local/d': { at: 1, branches: [] } })
    await s.audit({ at: 1, event: 'logout', login: 'a' })
    expect(await s.loadRooms()).toEqual({})
    expect(await s.readAudit()).toEqual([{ at: 1, event: 'logout', login: 'a' }])
  })

  it('keeps at most MEM_AUDIT_MAX in-memory audit entries, dropping the oldest', async () => {
    const s = new FileStore()
    for (let at = 1; at <= MEM_AUDIT_MAX + 25; at++) await s.audit({ at, event: 'join', room: 'r' })
    const all = await s.readAudit({ limit: 100_000 })
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

  it('storeFromEnv picks Postgres only with DATABASE_URL', () => {
    expect(storeFromEnv({})).toBeInstanceOf(FileStore)
    expect(storeFromEnv({ YPERSISTENCE: '/tmp/x' })).toBeInstanceOf(FileStore)
    expect(storeFromEnv({ DATABASE_URL: 'postgres://u:p@h/db' })).toBeInstanceOf(PgStore)
  })
})

describe('PgStore', () => {
  /** A tiny SQL interpreter for exactly the statements PgStore issues: proves the queries and parameters, not Postgres itself. */
  function fakePg() {
    const repos = new Map<string, unknown>(), sessions = new Map<string, unknown>()
    const audit: { id: number; at: number; data: AuditEntry }[] = []
    const log: string[] = []
    let ended = false
    const query = async (text: string, values: unknown[] = []) => {
      log.push(text.split(/\s+/).slice(0, 3).join(' '))
      const rows: Record<string, unknown>[] = []
      if (/^CREATE|^BEGIN|^COMMIT|^ROLLBACK/.test(text)) return { rows }
      if (text.startsWith('SELECT repo, data FROM room_repos')) for (const [repo, data] of repos) rows.push({ repo, data })
      else if (text.startsWith('DELETE FROM room_repos')) repos.clear()
      else if (text.startsWith('INSERT INTO room_repos')) repos.set(values[0] as string, JSON.parse(values[1] as string))
      else if (text.startsWith('SELECT id, data FROM room_sessions')) for (const [id, data] of sessions) rows.push({ id, data })
      else if (text.startsWith('INSERT INTO room_sessions')) sessions.set(values[0] as string, JSON.parse(values[1] as string))
      else if (text.startsWith('DELETE FROM room_sessions')) sessions.delete(values[0] as string)
      else if (text.startsWith('INSERT INTO room_audit')) audit.push({ id: audit.length + 1, at: values[0] as number, data: JSON.parse(values[1] as string) })
      else if (text.startsWith('SELECT data FROM room_audit')) for (const r of audit.filter(r => r.at >= (values[0] as number)).sort((a, b) => b.id - a.id).slice(0, values[1] as number)) rows.push({ data: r.data })
      else throw new Error(`unexpected SQL: ${text}`)
      return { rows }
    }
    let clients = 0
    const connect = async () => { clients++; return { query, release: () => { clients-- } } }
    return { pool: { query, connect, end: async () => { ended = true } }, log, isEnded: () => ended, openClients: () => clients }
  }

  it('creates the tables and round-trips through the fake pool (no live Postgres in CI)', async () => {
    const pg = fakePg()
    const s = new PgStore('postgres://x', async () => pg.pool)
    await s.init()
    expect(pg.log.filter(l => l.startsWith('CREATE TABLE'))).toHaveLength(3)
    await s.saveRooms({ 'git/gitlab.example.com/grp/app': { by: 'ann@example.com', at: 1, branches: [] } })
    expect(pg.log.slice(-4)).toEqual(['BEGIN', 'DELETE FROM room_repos', 'INSERT INTO room_repos', 'COMMIT'])
    expect(await s.loadRooms()).toEqual({ 'git/gitlab.example.com/grp/app': { by: 'ann@example.com', at: 1, branches: [] } })
    await s.putSession('s1', { login: 'ann@example.com', provider: 'oidc', at: 5 })
    expect(await s.loadSessions()).toEqual({ s1: { login: 'ann@example.com', provider: 'oidc', at: 5 } })
    await s.deleteSession('s1')
    expect(await s.loadSessions()).toEqual({})
    for (const at of [1, 2, 3]) await s.audit({ at, event: 'join', room: 'r' })
    expect((await s.readAudit({ since: 2 })).map(e => e.at)).toEqual([2, 3])
    expect((await s.readAudit({ limit: 2 })).map(e => e.at)).toEqual([2, 3])
    await s.close()
    expect(pg.isEnded()).toBe(true)
  })

  it('overlapping PgStore writes never interleave: each full-table replacement completes before the next begins', async () => {
    const pg = fakePg()
    // a slow pool: every query yields, so two unqueued saveRooms would interleave their DELETE/INSERT
    const slow = { ...pg.pool, connect: async () => { const c = await pg.pool.connect(); return { ...c, query: async (t: string, v?: unknown[]) => { await new Promise(r => setTimeout(r, 1)); return c.query(t, v) } } } }
    const s = new PgStore('postgres://x', async () => slow)
    const a = s.saveRooms({ 'github.com/a/one': { at: 1, branches: [] }, 'github.com/a/two': { at: 1, branches: [] } })
    const b = s.saveRooms({ 'github.com/a/three': { at: 2, branches: [] } })
    const c = s.putSession('s1', { login: 'ann', provider: 'github', at: 3 })
    await Promise.all([a, b, c])
    const tx = pg.log.filter(l => /^BEGIN|^COMMIT|^DELETE FROM room_repos|^INSERT INTO room_repos|^INSERT INTO room_sessions/.test(l))
    expect(tx).toEqual(['BEGIN', 'DELETE FROM room_repos', 'INSERT INTO room_repos', 'INSERT INTO room_repos', 'COMMIT', 'BEGIN', 'DELETE FROM room_repos', 'INSERT INTO room_repos', 'COMMIT', 'INSERT INTO room_sessions'])
    expect(await s.loadRooms()).toEqual({ 'github.com/a/three': { at: 2, branches: [] } })
    expect(pg.openClients()).toBe(0)
  })

  it('WriteQueue runs jobs in order and a failure does not block the ones after it', async () => {
    const q = new WriteQueue()
    const order: string[] = []
    const first = q.run(async () => { await new Promise(r => setTimeout(r, 5)); order.push('first') })
    const second = q.run(async () => { order.push('second'); throw new Error('boom') })
    const third = q.run(async () => { order.push('third'); return 3 })
    await first
    await expect(second).rejects.toThrow('boom')
    expect(await third).toBe(3)
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('PgStore.saveRooms runs its transaction on one client and releases it', async () => {
    const pg = fakePg()
    const s = new PgStore('postgres://x', async () => pg.pool)
    await s.saveRooms({ 'github.com/a/b': { at: 1, branches: [] } })
    expect(pg.openClients()).toBe(0)
    expect(pg.log.some(l => l.startsWith('BEGIN'))).toBe(true)
    expect(pg.log.some(l => l.startsWith('COMMIT'))).toBe(true)
  })
})
