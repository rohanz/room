import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { workerEnv, workerProcessEnv } from '../src/worker-config.js'
import { workerOwnedPaths } from '../src/worker-git.js'

describe('worker module characterization', () => {
  it('keeps worker-owned link exclusions and operation keys stable', () => {
    const paths = workerOwnedPaths({ link: ['inputs', 'config.json'] })
    expect(paths.includes('inputs/nested.txt')).toBe(true)
    expect(paths.includes('inputs-other')).toBe(false)
    expect(paths.exclusions).toEqual([':(exclude,literal)inputs', ':(exclude,literal)config.json'])
  })

  it('strips lead identity before adding worker identity and caps nested threads', () => {
    expect(workerEnv({ ROOM_OWNER: 'lead', PORT: '1234', KEEP: 'yes' }, { ROOM_OWNER: 'worker' }))
      .toEqual({ KEEP: 'yes', ROOM_OWNER: 'worker' })
    const env = workerProcessEnv({ threads: 2, memGb: 1, host: 'codex', server: 'ws://local', room: 'r', dir: '/worker', tag: 'w', lead: 'l', owner: 'o', share: 'intent', run: 1, nonce: 'test-nonce', registry: '/repo/.git/room/registry', id: 'id', logDir: '/lead', isWorker: true }, { OMP_NUM_THREADS: '8' })
    expect(env.OMP_NUM_THREADS).toBe('2')
    expect(env.ROOM_LOG_FILE).toBe(path.join('/lead', '.room', 'workers', 'w.mcp.log'))
    expect(env).toMatchObject({ ROOM_WORKER_ID: 'id', ROOM_WORKER_RUN: '1',
      ROOM_LAUNCH_NONCE: 'test-nonce', ROOM_REGISTRY: '/repo/.git/room/registry' })
  })
})
