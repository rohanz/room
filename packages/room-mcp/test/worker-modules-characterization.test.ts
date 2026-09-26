import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexSessionId } from '../src/worker-process.js'
import { workerEnv, workerProcessEnv } from '../src/worker-config.js'
import { workerOwnedPaths, workerOperationKey } from '../src/worker-git.js'

describe('worker module characterization', () => {
  it('keeps worker-owned link exclusions and operation keys stable', () => {
    const paths = workerOwnedPaths({ link: ['inputs', 'config.json'] })
    expect(paths.includes('inputs/nested.txt')).toBe(true)
    expect(paths.includes('inputs-other')).toBe(false)
    expect(paths.exclusions).toEqual([':(exclude,literal)inputs', ':(exclude,literal)config.json'])
    expect(workerOperationKey({ dir: '/repo/./.room/workers/a' })).toBe(`worker:${path.resolve('/repo/./.room/workers/a')}`)
  })

  it('strips lead identity before adding worker identity and caps nested threads', () => {
    expect(workerEnv({ ROOM_OWNER: 'lead', PORT: '1234', KEEP: 'yes' }, { ROOM_OWNER: 'worker' }))
      .toEqual({ KEEP: 'yes', ROOM_OWNER: 'worker' })
    const env = workerProcessEnv({ threads: 2, memGb: 1, host: 'codex', server: 'ws://local', room: 'r', dir: '/worker', tag: 'w', lead: 'l', owner: 'o', share: 'intent', gen: 1, id: 'id', logDir: '/lead', isWorker: true }, { OMP_NUM_THREADS: '8' })
    expect(env.OMP_NUM_THREADS).toBe('2')
    expect(env.ROOM_LOG_FILE).toBe(path.join('/lead', '.room', 'workers', 'w.mcp.log'))
  })

  it('accepts only a Codex thread-start event as a session id', () => {
    const id = '00000000-0000-0000-0000-000000000001'
    expect(codexSessionId(JSON.stringify({ type: 'thread.started', thread_id: id }))).toBe(id)
    expect(codexSessionId(JSON.stringify({ type: 'thread.completed', thread_id: id }))).toBeUndefined()
    expect(codexSessionId('{bad json')).toBeUndefined()
  })
})
