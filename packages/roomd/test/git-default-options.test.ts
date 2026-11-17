import { expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ exec: [] as unknown[], stream: [] as unknown[] }))
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  return { ...actual,
    execFile: (_file: string, _args: string[], options: unknown, done: Function) => {
      calls.exec.push(options); queueMicrotask(() => done(null, 'ok', ''))
      return new EventEmitter()
    },
    spawn: (_file: string, _args: string[], options: unknown) => {
      calls.stream.push(options)
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { end: () => queueMicrotask(() => child.emit('close', 0)) }) })
      return child
    },
  }
})
import { git, gitStream } from '../src/git.js'
it('keeps every ordinary execution option byte-identical to e2a60241 with no read deadline', async () => {
  await git('/repo', ['ls-files'])
  await gitStream('/repo', ['ls-files'], '', { timeoutMs: 30000, maxBytes: 1024 })
  expect(calls.exec).toStrictEqual([{ cwd: '/repo', maxBuffer: 64 * 1024 * 1024, timeout: 30000 }])
  expect(calls.stream).toStrictEqual([{ cwd: '/repo', stdio: ['pipe', 'pipe', 'pipe'] }])
})
