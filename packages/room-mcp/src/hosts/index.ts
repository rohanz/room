/** Explicit, narrow registry for the facets extracted so far. No binding or transport state lives here. */
import { claudePreBinding } from './claude-binding.js'
import { codexPreBinding } from './codex-binding.js'
import { createClaudeWorker } from './claude-worker.js'
import { createCodexWorker } from './codex-worker.js'
import type { Env, HostId } from './types.js'

const adapters = {
  claude: { preBinding: claudePreBinding, worker: createClaudeWorker },
  codex: { preBinding: codexPreBinding, worker: createCodexWorker },
}
export function preBindingAdapter(host: HostId) { return adapters[host].preBinding }
export function workerAdapter(host: HostId, env: Env = process.env) { return adapters[host].worker(env) }
