/** The real entry point refuses to start on an invalid explicit capacity instead of running uncapped. */
import { describe, it, expect, afterAll } from 'vitest'
import { RETIRED_ENVIRONMENT } from '@room/shared'
import { devServers } from './dev-server.js'

const retired = RETIRED_ENVIRONMENT.server.filter(name => name !== 'ROOM_LEGACY_DAYS' && !name.startsWith('ROOM_MIGRATION_'))
const servers = devServers()
afterAll(() => servers.stopAll())

describe('server settings at startup', () => {
  it('exits with a message naming each invalid setting', async () => {
    const child = servers.start({ env: { ...process.env, HOST: '127.0.0.1', PORT: '0', ROOM_SERVER: '',
      ...Object.fromEntries(retired.map(name => [name, 'invalid-secret-value'])),
      ROOM_MAX_CONNECTIONS: 'lots', ROOM_MAX_TOTAL_QUEUED_MB: 'Infinity' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout!.on('data', d => { output += d }); child.stderr!.on('data', d => { output += d })
    const code = await new Promise<number | null>(resolve => child.once('exit', resolve))
    expect(code).toBe(1)
    for (const name of retired) {
      expect(output.split(`${name} is retired and no longer has an effect`)).toHaveLength(2)
    }
    expect(output).not.toContain('invalid-secret-value')
    expect(output).toContain('invalid server settings')
    expect(output).toContain('ROOM_MAX_CONNECTIONS must be a positive whole number (got "lots")')
    expect(output).toContain('ROOM_MAX_TOTAL_QUEUED_MB must be a positive number of megabytes (got "Infinity")')
  }, 30_000)
})
