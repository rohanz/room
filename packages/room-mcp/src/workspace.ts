import { codexPreBinding as callMetadata } from './hosts/codex-binding.js'
import { missingWorkspace, workspaceMismatch } from './hosts/workspace-guidance.js'
/** Codex 0.157.1 may spawn MCP servers from a shared app-server in another clone. */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { gitCommonDir } from '@room/roomd'


const worktreeRoot = (dir: string): string | undefined => {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined }
  catch { return undefined }
}


/** Tool-call metadata is supplied by Codex, not by MCP initialize or roots/list. */
export function admittedWorkspace(candidates: readonly string[], rootOf: (dir: string) => string | undefined = worktreeRoot): string | undefined {
  const roots = new Set<string>()
  const plain = new Set<string>()
  for (const key of candidates) {
    try {
      const real = fs.realpathSync(key)
      const root = rootOf(real)
      if (root) roots.add(fs.realpathSync(root))
      else if (fs.statSync(real).isDirectory()) plain.add(real)
    } catch { /* missing or inaccessible workspace */ }
  }
  // A lone folder that is not a repository is still this session's folder: Room tells the human, never joins elsewhere.
  const only = roots.size ? roots : plain
  return only.size === 1 ? only.values().next().value : undefined
}

/** Same worktree root and Git repository; a subfolder of the bound worktree matches, sibling worktrees do not. */
async function sameWorkspace(a: string, b: string): Promise<boolean> {
  try {
    const [rootA, rootB] = [worktreeRoot(a) ?? a, worktreeRoot(b) ?? b].map(dir => fs.realpathSync(dir))
    if (rootA !== rootB) return false
    const [gitA, gitB] = await Promise.allSettled([gitCommonDir(a), gitCommonDir(b)])
    if (gitA.status === 'rejected' || gitB.status === 'rejected') return gitA.status === gitB.status
    return fs.realpathSync(gitA.value) === fs.realpathSync(gitB.value)
  } catch { return false }
}

const startFailure = (attempt: { dir: string; failed?: unknown }): string =>
  `Room could not start for ${attempt.dir}: ${attempt.failed instanceof Error ? attempt.failed.message : String(attempt.failed)}; try again.`
const closingMessage = 'Room is shutting down; restart this session to use Room.'

export function createWorkspaceBinding<T>({ deferred, fallbackDir, initialize, logFallback, logFailure, matches = sameWorkspace }: {
  deferred: boolean; fallbackDir: () => string; initialize: (dir: string, signal: AbortSignal) => Promise<T>
  logFallback: () => void; logFailure?: (error: unknown) => void
  matches?: (a: string, b: string) => Promise<boolean>
}) {
  type Attempt = { dir: string; promise: Promise<T>; failed?: unknown }
  // A started workspace is kept for the process (a different Codex workspace is told to restart); a failed one is retried.
  let current: Attempt | undefined
  let closing = false
  const abort = new AbortController()
  const bind = (dir: string): Attempt => {
    const attempt = Promise.resolve().then(() => {
      if (closing) throw new Error(closingMessage)
      return initialize(dir, abort.signal)
    })
    const tracked = attempt.catch(error => {
      binding.failed = error
      if (current === binding) current = undefined
      // Non-deferred startup is fatal in index.ts; deferred attempts stay retryable.
      if (deferred && !closing) logFailure?.(error)
      throw error
    })
    // Observed here so a failure during a caller's validation is never an unhandled rejection.
    tracked.catch(() => {})
    const binding: Attempt = { dir, promise: tracked }
    current = binding
    return binding
  }
  const forCall = async (params: { _meta?: unknown }): Promise<{ runtime: T; error?: never } | { error: string; runtime?: never }> => {
    if (closing) return { error: closingMessage }
    const workspace = admittedWorkspace(callMetadata.decodeCall(params._meta).workspaceCandidates)
    if (deferred && !workspace) return { error: missingWorkspace }
    while (true) {
      if (closing) return { error: closingMessage }
      let binding = current
      if (!binding) {
        if (!workspace) logFallback()
        binding = bind(deferred ? workspace! : fallbackDir())
      }
      const matchesBinding = !workspace || await matches(workspace, binding.dir)
      if (closing) return { error: closingMessage }
      if (current !== binding) {
        // Revalidate only against a real replacement; this call's own failed attempt ends this call.
        if (!current && 'failed' in binding) return { error: startFailure(binding) }
        continue
      }
      if (!matchesBinding) return { error: workspaceMismatch(workspace, binding.dir) }
      let runtime: T
      try { runtime = await binding.promise } catch { return { error: closing ? closingMessage : startFailure(binding) } }
      return closing ? { error: closingMessage } : { runtime }
    }
  }
  return {
    start: () => closing || deferred ? Promise.resolve(undefined) : (current ?? bind(fallbackDir())).promise,
    current: () => current?.promise,
    /** Stop new work immediately; the caller shuts down any runtime that finishes starting. */
    close: () => { closing = true; abort.abort(); return current?.promise },
    forCall,
    async run<R>(params: { _meta?: unknown }, action: (runtime: T) => Promise<R>): Promise<{ value: R; error?: never } | { error: string; value?: never }> {
      const result = await forCall(params)
      if (result.error) return { error: result.error }
      if (closing) return { error: closingMessage }
      return { value: await action(result.runtime!) }
    },
  }
}
