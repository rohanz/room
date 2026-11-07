import { claudeIdentity } from './claude-identity.js'
import { codexIdentity } from './codex-identity.js'
/** Explicit, narrow registry for the facets extracted so far. No binding or transport state lives here. */
import { claudePreBinding } from './claude-binding.js'
import { codexPreBinding } from './codex-binding.js'
import { createClaudeWorker } from './claude-worker.js'
import { createCodexWorker } from './codex-worker.js'
import { createClaudeLogDecoder } from './claude-log.js'
import { createCodexLogDecoder } from './codex-log.js'
import type { Env, HostAdapter, HostId, HostLogDecoder, LogContext } from './types.js'

const adapters = {
  claude: { identity: claudeIdentity, preBinding: claudePreBinding, worker: createClaudeWorker,
    createLogDecoder: createClaudeLogDecoder satisfies NonNullable<HostAdapter['createLogDecoder']> },
  codex: { identity: codexIdentity, preBinding: codexPreBinding, worker: createCodexWorker,
    createLogDecoder: createCodexLogDecoder satisfies NonNullable<HostAdapter['createLogDecoder']> },
}
export const hostIds = Object.keys(adapters) as readonly HostId[]
export function preBindingAdapter(host: HostId) { return adapters[host].preBinding }
export function workerAdapter(host: HostId, env: Env = process.env) { return adapters[host].worker(env) }

/** Revision participates in every scanner cache identity; bump when decoder semantics change. */
const logDecoderRevision = '1'
export const logHosts: readonly HostId[] = ['claude', 'codex']
export function createLogDecoder(host: HostId, context: LogContext): HostLogDecoder { return adapters[host].createLogDecoder(context) }
export function logDecoderKey(host: HostId, context: LogContext): string {
  return JSON.stringify([host, logDecoderRevision, context.workerId, context.run, context.logStart, context.dir, context.scope])
}

export function identityAdapter(host: HostId) { return adapters[host].identity }
