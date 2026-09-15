import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, DEFAULT_SERVER, LOCAL } from '../src/config.js'
import { writeChoice } from '../src/choice.js'

const repo = () => { const dir = mkdtempSync(join(tmpdir(), 'room-config-')); execFileSync('git', ['-C', dir, 'init', '-q']); return dir }

describe('resolveConfig', () => {
  it('uses documented argument > environment > remembered > default precedence', async () => {
    const dir = repo()
    expect((await resolveConfig({ dir, env: {} })).server).toBe(LOCAL)
    await writeChoice(dir, 'team')
    expect((await resolveConfig({ dir, env: {} })).server).toBe(DEFAULT_SERVER)
    expect((await resolveConfig({ dir, env: { ROOM_SERVER: 'ws://env' } })).server).toBe('ws://env')
    const c = await resolveConfig({ dir, env: { ROOM_SERVER: 'ws://env', ROOM_SHARE: 'declared', ROOM_MAX_WORKERS: '3' }, args: { where: 'local', share: 'intent', maxWorkers: 2 } })
    expect(c).toMatchObject({ server: LOCAL, whereRule: 'argument', share: 'intent', maxWorkers: 2 })
  })

  it('resolves runner URLs without overriding explicit or remembered destinations', async () => {
    const dir = repo(), url = 'ws://runner/room'
    expect((await resolveConfig({ dir, env: { ROOM_URL: url } })).roomUrl).toBe(url)
    expect((await resolveConfig({ dir, env: { ROOM_URL: url, ROOM_SERVER: 'local' } })).roomUrl).toBeUndefined()
    expect((await resolveConfig({ dir, env: { ROOM_URL: url }, args: { where: 'local' } })).roomUrl).toBeUndefined()
    await writeChoice(dir, 'team')
    expect((await resolveConfig({ dir, env: { ROOM_URL: url } })).roomUrl).toBeUndefined()
    expect((await resolveConfig({ dir, env: { ROOM_URL: url }, args: { roomUrl: 'ws://argument/room' } })).roomUrl).toBe('ws://argument/room')
  })

  it('resolves identity, paths, secrets and numeric defaults without mutating env', async () => {
    const dir = repo()
    const env = { ROOM_NAME: 'env-name', ROOM_OWNER: 'env-owner', ROOM_TAG: 'env-tag', ROOM_KIND: 'bot', ROOM_TOKEN: 'env-token', ROOM_LOG_FILE: '/env/log', ROOM_CREDENTIALS: '/env/creds', ROOM_STALE_DAYS: '11' }
    const c = await resolveConfig({ dir, env, args: { name: 'arg-name', tag: 'arg-tag', kind: 'ci', token: 'arg-token', logFile: '/arg/log', credentialsPath: '/arg/creds', staleDays: 4 } })
    expect(c).toMatchObject({ name: 'arg-name', owner: 'env-owner', tag: 'arg-tag', kind: 'ci', token: 'arg-token', logFile: '/arg/log', credentialsPath: '/arg/creds', staleDays: 4, maxWorkers: 8 })
    expect(env.ROOM_TOKEN).toBe('env-token')
  })
})
