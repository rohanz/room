/** Codex 0.157.1 may spawn MCP servers from a shared app-server in another clone. */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { gitCommonDir } from '@room/roomd'

export type ParentCommandReader = () => string
/** Existing explicit-worker and inherited-directory precedence. */
export function fallbackWorkspace(env: NodeJS.ProcessEnv, processDir: string): string {
  const value = (key: string) => env[key]?.trim() || undefined
  return value('ROOM_DIR') ?? value('PWD') ?? value('INIT_CWD') ?? processDir
}

const parentCommand: ParentCommandReader = () => execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)], {
  encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
}).trim()

/** Unknown parent identity is conservative: Codex's inherited PWD may belong to another session. */
export function deferForSharedCodex(env: NodeJS.ProcessEnv, readParent: ParentCommandReader = parentCommand, platform = process.platform): boolean {
  if (env.ROOM_HOST !== 'codex' || (env.ROOM_DIR && env.ROOM_DIR.trim())) return false
  if (platform === 'win32') return true
  try {
    const command = readParent().trim()
    return !command || command.includes('app-server')
  } catch { return true }
}

const worktreeRoot = (dir: string): string | undefined => {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined }
  catch { return undefined }
}

/** Tool-call metadata is supplied by Codex, not by MCP initialize or roots/list. */
export function codexWorkspace(params: { _meta?: unknown }, rootOf: (dir: string) => string | undefined = worktreeRoot): string | undefined {
  const meta = params._meta
  if (!meta || typeof meta !== 'object') return undefined
  const turn = (meta as Record<string, unknown>)['x-codex-turn-metadata']
  if (!turn || typeof turn !== 'object') return undefined
  const workspaces = (turn as Record<string, unknown>).workspaces
  if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces)) return undefined
  const roots = new Set<string>()
  for (const key of Object.keys(workspaces)) {
    try {
      const real = fs.realpathSync(key)
      const root = rootOf(real)
      if (root) roots.add(fs.realpathSync(root))
    } catch { /* missing or inaccessible workspace */ }
  }
  return roots.size === 1 ? roots.values().next().value : undefined
}

/** Both the physical folder and Git repository must match; sibling worktrees are distinct sessions. */
async function sameWorkspace(a: string, b: string): Promise<boolean> {
  try {
    const [realA, realB] = [fs.realpathSync(a), fs.realpathSync(b)]
    if (realA !== realB) return false
    const [gitA, gitB] = await Promise.allSettled([gitCommonDir(a), gitCommonDir(b)])
    if (gitA.status === 'rejected' || gitB.status === 'rejected') return gitA.status === gitB.status
    return fs.realpathSync(gitA.value) === fs.realpathSync(gitB.value)
  } catch { return false }
}

const missingWorkspace = 'Room could not tell which folder this Codex session is in (no workspace in the call). Update Codex, or start it with ROOM_DIR=<repo>.'
const closingMessage = 'Room is shutting down; restart this session to use Room.'

export function createWorkspaceBinding<T>({ deferred, fallbackDir, initialize, logFallback, logFailure, matches = sameWorkspace }: {
  deferred: boolean; fallbackDir: () => string; initialize: (dir: string, signal: AbortSignal) => Promise<T>
  logFallback: () => void; logFailure?: (error: unknown) => void
  matches?: (a: string, b: string) => Promise<boolean>
}) {
  let boundDir: string | undefined
  let pending: Promise<T> | undefined
  let closing = false
  const abort = new AbortController()
  const bind = (dir: string): Promise<T> => {
    boundDir = dir
    const attempt = Promise.resolve().then(() => {
      if (closing) throw new Error(closingMessage)
      return initialize(dir, abort.signal)
    })
    const tracked = attempt.catch(error => {
      if (pending === tracked) { pending = undefined; boundDir = undefined }
      // Non-deferred startup is fatal in index.ts; deferred attempts stay retryable.
      if (deferred && !closing) logFailure?.(error)
      throw error
    })
    pending = tracked
    return tracked
  }
  const forCall = async (params: { _meta?: unknown }): Promise<{ runtime: T; error?: never } | { error: string; runtime?: never }> => {
    if (closing) return { error: closingMessage }
    const workspace = codexWorkspace(params)
    if (deferred && !workspace) return { error: missingWorkspace }
    if (pending && workspace && boundDir && !(await matches(workspace, boundDir))) {
      return { error: `This Codex session's workspace is ${workspace}, but Room is attached to ${boundDir}; restart the session to switch.` }
    }
    if (closing) return { error: closingMessage }
    if (!pending) {
      if (!workspace) logFallback()
      bind(deferred ? workspace! : fallbackDir())
    }
    const runtime = await pending!
    return closing ? { error: closingMessage } : { runtime }
  }
  return {
    start: () => closing || deferred ? Promise.resolve(undefined) : pending ?? bind(fallbackDir()),
    current: () => pending,
    /** Stop new work immediately; the caller shuts down any runtime that finishes starting. */
    close: () => { closing = true; abort.abort(); return pending },
    forCall,
    async run<R>(params: { _meta?: unknown }, action: (runtime: T) => Promise<R>): Promise<{ value: R; error?: never } | { error: string; value?: never }> {
      const result = await forCall(params)
      if (result.error) return { error: result.error }
      if (closing) return { error: closingMessage }
      return { value: await action(result.runtime!) }
    },
  }
}
