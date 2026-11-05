/** Compatibility selectors intentionally retain their different precedence and failure policies. */
import path from 'node:path'
import { preBindingAdapter } from './index.js'
import type { Env, HostId, Runtime } from './types.js'

const host = (v: unknown): HostId | undefined => v === 'claude' || v === 'codex' ? v : undefined
const value = (v: string | undefined) => v?.trim() || undefined

/** Naming: worker host, then plugin host, then parent, then Claude session environment. */
export function sessionHost(env: Env, parentCommand: () => string): string {
  if (host(env.ROOM_WORKER_HOST)) return env.ROOM_WORKER_HOST!
  if (host(env.ROOM_HOST)) return env.ROOM_HOST!
  try {
    const command = path.basename(parentCommand().trim()).toLowerCase()
    if (/^codex(?:[.-]|$)/.test(command)) return 'codex'
    if (/^claude(?:[.-]|$)/.test(command)) return 'claude'
  } catch { /* ps unavailable */ }
  return value(env.CLAUDE_CODE_SESSION_ID) ? 'claude' : 'agent'
}

/** Spawn: argument, then plugin host, then worker host; unknown values choose Claude. */
export function workerHost(argument: unknown, env: Env = process.env): HostId {
  return (argument ?? env.ROOM_HOST ?? env.ROOM_WORKER_HOST) === 'codex' ? 'codex' : 'claude'
}

/** Workspace fallback and deferral use only the static plugin host, unlike naming and presence. */
export function workspaceAdapter(env: Env) { return preBindingAdapter(env.ROOM_HOST === 'codex' ? 'codex' : 'claude') }

/** Presence recognizes either Codex variable, and unreadable parents remain interactive. */
export function presenceKind(env: Env, readParent: () => string): 'interactive' | 'shared-app-server' {
  if (env.ROOM_HOST !== 'codex' && env.ROOM_WORKER_HOST !== 'codex') return 'interactive'
  try { return preBindingAdapter('codex').startup({ env, processDir: '', platform: '', parentCommand: readParent() }).presenceKind }
  catch { return 'interactive' }
}

/** Explicit > per-host Room env > generic Room env; public host settings remain separate. */
export function workerRuntimeForHost(host: HostId, runtime: Runtime, env: Env): Runtime {
  const prefix = host === 'codex' ? 'ROOM_CODEX_WORKER_' : 'ROOM_CLAUDE_WORKER_'
  return { model: value(runtime.model) ?? value(env[`${prefix}MODEL`]) ?? value(env.ROOM_WORKER_MODEL),
    effort: value(runtime.effort) ?? value(env[`${prefix}EFFORT`]) ?? value(env.ROOM_WORKER_EFFORT) }
}

/** Shell artifact writing and its failure handling remain shared until the isolation extraction. */
export function workerLaunchOptions(host: HostId): { shellEnvHook: boolean; developmentPlugin: boolean } {
  return { shellEnvHook: host === 'claude', developmentPlugin: host === 'claude' }
}
