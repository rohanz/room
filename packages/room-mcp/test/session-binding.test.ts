import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boundSession, readSessionRecord, readSessionRuntime, sessionDirectory, syntheticSessionId, writeSessionRecord, writeSessionRuntime } from '../src/session.js'
import type { ProcessIdentity } from '../src/leases.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const common = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-session-test-')); dirs.push(dir); return dir }
const parent: ProcessIdentity = { pid: 71, startTime: 'birth-71', executable: 'claude' }
const child: ProcessIdentity = { pid: 72, startTime: 'birth-72', executable: 'codex' }
function record(dir: string, id: string, host: 'claude' | 'codex', at: number, chain: ProcessIdentity[], worker_id?: string) {
  writeSessionRecord(dir, { session_id: id, host, cwd: dir, at, chain, hostPid: chain[0]?.pid ?? 0, ...(worker_id ? { worker_id } : {}) })
}

describe('host session binding', () => {
  it('uses separate durable session directories and a typed runtime record', () => {
    const dir = common()
    record(dir, 'one', 'claude', 1, [parent])
    record(dir, 'two', 'claude', 2, [child])
    writeSessionRuntime(dir, 'one', { model: 'claude-fable-5-1', effort: 'high', at: 3 })
    expect(sessionDirectory(dir, 'one')).not.toBe(sessionDirectory(dir, 'two'))
    expect(sessionDirectory(dir, 'one')).toContain(path.join('room', 'sessions'))
    expect(readSessionRecord(dir, 'one')?.session_id).toBe('one')
    expect(readSessionRuntime(dir, 'one')).toMatchObject({ model: 'claude-fable-5-1', effort: 'high' })
    expect(readSessionRuntime(dir, 'two')).toBeUndefined()
  })

  it('binds each lead to its parent and rebinds Claude after /clear', () => {
    const dir = common()
    record(dir, 'claude-a', 'claude', 1, [parent])
    record(dir, 'codex-b', 'codex', 2, [child])
    expect(boundSession({ commonDir: dir, host: 'claude', parent, env: { CLAUDE_CODE_SESSION_ID: 'stale' } })).toEqual({ id: 'claude-a', host: 'claude' })
    expect(boundSession({ commonDir: dir, host: 'codex', parent: child, env: {} })).toEqual({ id: 'codex-b', host: 'codex' })
    record(dir, 'claude-after-clear', 'claude', 3, [parent])
    expect(boundSession({ commonDir: dir, host: 'claude', parent, env: { CLAUDE_CODE_SESSION_ID: 'claude-a' } })).toEqual({ id: 'claude-after-clear', host: 'claude' })
    expect(boundSession({ commonDir: dir, host: 'claude', parent: { ...parent, startTime: 'reused' }, env: { CLAUDE_CODE_SESSION_ID: 'fallback' } })).toEqual({ id: 'fallback', host: 'claude' })
  })

  it('binds a worker by its own record and leaves a shared app-server unbound', () => {
    const dir = common()
    record(dir, 'worker-thread', 'codex', 1, [child], 'w_123')
    expect(boundSession({ commonDir: dir, host: 'codex', workerId: 'w_123' })).toEqual({ id: 'worker-thread', host: 'codex' })
    expect(boundSession({ commonDir: dir, host: 'claude', workerId: 'w_456', workerSessionId: 'pre-generated' })).toEqual({ id: 'pre-generated', host: 'claude' })
    expect(boundSession({ commonDir: dir, host: 'codex', appServer: true, parent: child })).toBeUndefined()
    expect(boundSession({ commonDir: dir, host: 'codex', parent: child, parentArgs: 'codex app-server', env: {} })).toBeUndefined()
    expect(syntheticSessionId(parent)).toBe('mcp:71:birth-71')
  })
})
