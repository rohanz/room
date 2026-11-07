import type { WorkerInput } from '../../src/hosts/types.js'

/** Inert filesystem/environment evidence for pure adapter plan assertions. */
export function workerInput(overrides: Partial<WorkerInput> = {}): WorkerInput {
  return { cwd: '/fixture', logDir: '/fixture', env: {}, tag: '', shellEnvHook: false,
    wakeChannels: false, mode: 'fresh', runtime: {}, prompt: 'task', claudeChannel: '', ...overrides }
}
