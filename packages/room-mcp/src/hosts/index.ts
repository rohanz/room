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

import { createClaudeLogDecoder } from './claude-log.js'
import { createCodexLogDecoder } from './codex-log.js'
import type { HostLogDecoder, LogContext } from './types.js'

/** Revision participates in every scanner cache identity; bump when decoder semantics change. */
const logDecoderRevision = '1'
export const logHosts: readonly HostId[] = ['claude', 'codex']
const logDecoders = { claude: createClaudeLogDecoder, codex: createCodexLogDecoder }
export function createLogDecoder(host: HostId, context: LogContext): HostLogDecoder { return logDecoders[host](context) }
export function logDecoderKey(host: HostId, context: LogContext): string {
  return JSON.stringify([host, logDecoderRevision, context.workerId, context.run, context.logStart, context.dir, context.scope])
}
