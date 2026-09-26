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

/** Tool-call metadata is supplied by Codex, not by MCP initialize or roots/list. */
export function codexWorkspace(params: { _meta?: unknown }, insideWorktree: (dir: string) => boolean = dir => {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true' }
  catch { return false }
}): string | undefined {
  const meta = params._meta
  if (!meta || typeof meta !== 'object') return undefined
  const turn = (meta as Record<string, unknown>)['x-codex-turn-metadata']
  if (!turn || typeof turn !== 'object') return undefined
  const workspaces = (turn as Record<string, unknown>).workspaces
  if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces)) return undefined
  const keys = Object.keys(workspaces)
  if (keys.length === 1) return keys[0]
  return keys.find(insideWorktree)
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

export function createWorkspaceBinding<T>({ deferred, fallbackDir, initialize, logFallback, matches = sameWorkspace }: {
  deferred: boolean; fallbackDir: () => string; initialize: (dir: string) => Promise<T>
  logFallback: () => void; matches?: (a: string, b: string) => Promise<boolean>
}) {
  let boundDir: string | undefined
  let pending: Promise<T> | undefined
  const bind = (dir: string) => {
    boundDir = dir
    pending = initialize(dir)
    return pending
  }
  return {
    start: () => deferred ? Promise.resolve(undefined) : bind(fallbackDir()),
    current: () => pending,
    async forCall(params: { _meta?: unknown }): Promise<{ runtime: T; warning: string }> {
      const workspace = codexWorkspace(params)
      let usedFallback = false
      if (!pending) {
        usedFallback = deferred && !workspace
        bind(deferred && workspace ? workspace : fallbackDir())
      }
      const runtime = await pending!
      if (usedFallback) logFallback()
      const warning = workspace && boundDir && !(await matches(workspace, boundDir))
        ? `This Codex session's workspace is ${workspace}, but Room is attached to ${boundDir}; restart the session to switch.\n`
        : ''
      return { runtime, warning }
    },
  }
}
