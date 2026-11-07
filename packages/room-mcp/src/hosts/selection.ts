import { parentCommand } from './parent-command.js'
import { execFileSync } from 'node:child_process'
/** Compatibility selectors intentionally retain their different precedence and failure policies. */
import path from 'node:path'
import { identityAdapter, preBindingAdapter, workerAdapter } from './index.js'
import type { Env, HostId, Runtime } from './types.js'

const host = (v: unknown): HostId | undefined => v === 'claude' || v === 'codex' ? v : undefined
const value = (v: string | undefined) => v?.trim() || undefined

/** Naming: worker host, then plugin host, then parent, then Claude session environment. */
export function sessionHost(env: NodeJS.ProcessEnv = process.env, parentCommand: () => string = () => execFileSync('ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } })): string {
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
export function presenceKind(env: Env = process.env, readParent: () => string = parentCommand): 'interactive' | 'shared-app-server' {
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

/** Compatibility launch settings; each worker adapter owns its host requirements. */
export function workerLaunchOptions(host: HostId): { shellEnvHook: boolean; developmentPlugin: boolean } {
  return workerAdapter(host).launchOptions
}

/** Binding historically prefers either Claude variable, unlike naming and spawning. */
export function bindingHost(explicit: HostId | undefined, env: Env, parent?: { executable: string }): HostId | undefined {
  return explicit ?? (env.ROOM_WORKER_HOST === 'claude' || env.ROOM_HOST === 'claude' ? 'claude'
    : env.ROOM_WORKER_HOST === 'codex' || env.ROOM_HOST === 'codex' ? 'codex'
      : parent && /claude/i.test(path.basename(parent.executable)) ? 'claude'
        : parent && /codex/i.test(path.basename(parent.executable)) ? 'codex' : undefined)
}

/** Initial join grace follows only the worker host, independently of binding precedence. */
export function initialJoinIdentity(env: Env) {
  const selected = host(env.ROOM_WORKER_HOST)
  // Ask for pending policy without probing a repository or guessing a session.
  return selected ? identityAdapter(selected).identify({ env, records: [], repositoryAvailable: false }) : undefined
}

import { admittedCodexThread } from './codex-identity.js'
export const admittedIdentityKey = admittedCodexThread

export const registryEnvironmentSession = (env: Env) => env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID
export const workerEnvironmentSession = (host: HostId, env: Env) => host === 'claude' ? env.CLAUDE_CODE_SESSION_ID : env.CODEX_THREAD_ID
