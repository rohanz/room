import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Env, HostAdapter, Runtime, WorkerCommandInput } from './types.js'
import { CODEX_SHELL_FILTER } from '../worker-shell-env.js'

/** Only public configuration is read; credentials are never inspected. */
function defaults(env: Env): Runtime {
  try {
    const config = fs.readFileSync(path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8')
    const top = config.split(/^\s*\[/m, 1)[0]
    const value = (key: string) => top.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'))?.[1]
    return { model: value('model'), effort: value('model_reasoning_effort') }
  } catch { return {} }
}

function command(input: WorkerCommandInput) {
  const { runtime: { model, effort }, prompt, sessionId, mode } = input
  const options = { resume: mode === 'resume', sessionId }
  return { cmd: 'codex', args: options.resume
    ? ['exec', 'resume', options.sessionId!, '-c', 'sandbox_mode="workspace-write"', '-c', CODEX_SHELL_FILTER, ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), '--json', prompt]
    : ['exec', '-s', 'workspace-write', '-c', CODEX_SHELL_FILTER, ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), '--json', prompt] }
}

export function createCodexWorker(env: Env = process.env): Pick<NonNullable<HostAdapter['worker']>, 'capabilities' | 'freshSessionId' | 'defaults' | 'normalizeRuntime' | 'command'> {
  return { capabilities: { resume: true }, freshSessionId: () => undefined,
    defaults: () => defaults(env), normalizeRuntime: runtime => runtime, command }
}
