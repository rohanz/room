/** Logical shadow checks use controlled timing; real budgets/Git timing have separate coverage. */
import { afterEach, beforeEach, vi } from 'vitest'
import { ConflictShadow } from '../src/conflict-shadow.js'
import { setGitTimeoutForTest } from '@room/roomd/git'

const gitWait = 2_147_483_647
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, execFile: new Proxy(actual.execFile, { apply(target, receiver, args) {
    if (args[0] === 'git' && args[2] && typeof args[2] === 'object') args[2] = { ...args[2], timeout: 0 }
    return Reflect.apply(target, receiver, args)
  } }) }
})
vi.mock('@room/roomd/git', async original => {
  const actual = await original<typeof import('@room/roomd/git')>()
  return { ...actual,
    withGitReadDeadline: <T>(_deadline: number, work: () => Promise<T>, signal?: AbortSignal) => actual.withGitReadDeadline(Infinity, work, signal),
    gitStream: (dir: string, args: readonly string[], input: string, options: Parameters<typeof actual.gitStream>[3]) =>
      actual.gitStream(dir, args, input, { ...options, timeoutMs: 2_147_483_647 }),
  }
})
vi.mock('../src/shadow-graph.js', async original => {
  const actual = await original<typeof import('../src/shadow-graph.js')>()
  class LogicalGraph extends actual.ShadowGraph {
    constructor(...args: ConstructorParameters<typeof actual.ShadowGraph>) {
      super(...args)
      Object.defineProperty(this, 'deadline', { get: () => Infinity, set: () => {}, configurable: true })
    }
  }
  return { ...actual, ShadowGraph: LogicalGraph }
})

beforeEach(() => {
  const actual = globalThis.performance
  vi.stubGlobal('performance', new Proxy(actual, { get(target, key) {
    if (key === 'now') return () => 0
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } }))
  setGitTimeoutForTest(gitWait)
  // Keep the production abort path; tests decide when to stop, rather than racing the host clock.
  vi.spyOn(ConflictShadow.prototype as any, 'budget').mockImplementation(function (this: any, work: () => Promise<unknown>, cleanup = false) {
    if (cleanup) return Promise.resolve().then(work)
    const signal: AbortSignal = this.cancellation.signal
    let abort: () => void
    return new Promise((resolve, reject) => {
      abort = () => reject(new Error('shadow stopped'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      Promise.resolve().then(work).then(resolve, reject)
    }).finally(() => signal.removeEventListener('abort', abort))
  })
})
afterEach(() => { setGitTimeoutForTest(undefined); vi.unstubAllGlobals(); vi.restoreAllMocks() })
