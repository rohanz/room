/** Git publishes a worktree admin as several files, not one atomic entry. */
import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { RepoLocks } from '@room/shared'
import { commonGitDirFromDotGit } from './git-dirs.js'

const locks = new RepoLocks()
const current = new AsyncLocalStorage<{ key: string; active: boolean }>()

function key(dir: string): string {
  const candidate = commonGitDirFromDotGit(dir)
  try { return fs.realpathSync.native(candidate) }
  catch {
    // Destructive callers already hold the common Git directory, not a worktree.
    if (fs.existsSync(path.join(dir, 'HEAD'))) {
      const common = path.join(dir, 'commondir')
      return fs.realpathSync.native(fs.existsSync(common) ? path.resolve(dir, fs.readFileSync(common, 'utf8').trim()) : dir)
    }
    return path.resolve(candidate) // Git itself reports a missing/non-repository cwd.
  }
}

export function isGitWorktreeCommand(args: readonly string[]): boolean {
  const at = args.indexOf('worktree')
  return at >= 0 && !args.slice(0, at).includes('--')
    && ['add', 'list', 'prune', 'remove', 'move', 'repair', 'lock', 'unlock'].includes(args[at + 1])
}

/** Process-local queue only. Acquire before verification; never await after its final check. */
export async function withGitWorktreeOperation<T>(dir: string, work: () => Promise<T> | T): Promise<T> {
  const canonical = key(dir), held = current.getStore()
  if (held?.active && held.key === canonical) return work()
  return locks.run(canonical, async () => {
    const scope = { key: canonical, active: true }
    try { return await current.run(scope, work) }
    finally { scope.active = false }
  })
}

export function assertGitWorktreeOperation(dir: string): void {
  const scope = current.getStore()
  if (!scope?.active || scope.key !== key(dir)) throw new Error('synchronous Git worktree operation requires an awaited worktree-operation scope')
}
