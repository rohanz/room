/**
 * Owns repo-relative lexical validation and containment; callers choose their link-leaf policy.
 * These paths are inside the user's checkout and Room worktrees, which only the user's own processes write.
 * Callers capture the canonical root once per operation, and containment refuses a root that has since become a symlink.
 * A directory swap between a check and its use remains possible: Node's fs has no openat/O_NOFOLLOW directory-relative operations, and a process able to make that swap already has the user's write access.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface RepoPathSyntax {
  /** Backslashes can be path separators for validation, literal filename characters, or forbidden outright. */
  backslash: 'separator' | 'literal' | 'reject'
  empty: 'allow' | 'reject'
  blank?: 'allow' | 'reject'
  dot: 'allow' | 'reject'
  git: 'allow' | 'first' | 'any'
  room?: 'allow' | 'first'
  nul?: 'allow' | 'reject'
}

/** Paths copied or materialized as regular files forbid links' dangerous lexical neighbors. */
export const MATERIALIZED_PATH = { backslash: 'reject', empty: 'reject', dot: 'reject', git: 'any', nul: 'reject' } as const satisfies RepoPathSyntax
/** Disk reads allow dot and empty components but reject traversal on either separator. */
export const DISK_READ_PATH = { backslash: 'separator', empty: 'allow', dot: 'allow', git: 'allow' } as const satisfies RepoPathSyntax
/** Worker link inputs forbid dot components and private first components. */
export const LINK_INPUT_PATH = { backslash: 'separator', empty: 'reject', dot: 'reject', git: 'first', room: 'first' } as const satisfies RepoPathSyntax
/** Recovery records and worker-name components treat backslashes as literal characters. */
export const RECORDED_PATH = { backslash: 'literal', empty: 'reject', dot: 'reject', git: 'allow' } as const satisfies RepoPathSyntax
/** Carried paths forbid backslashes but permit .git components. */
export const CARRIED_PATH = { backslash: 'reject', empty: 'reject', dot: 'reject', git: 'allow' } as const satisfies RepoPathSyntax

export function validRepoPath(rel: string, policy: RepoPathSyntax): boolean {
  if ((policy.blank ?? 'reject') === 'reject' && !rel) return false
  if (path.isAbsolute(rel)) return false
  if (policy.backslash === 'reject' && rel.includes('\\')) return false
  if ((policy.nul ?? 'allow') === 'reject' && rel.includes('\0')) return false
  const parts = rel.split(policy.backslash === 'separator' ? /[\\/]/ : '/')
  if (policy.empty === 'reject' && parts.some(part => !part)) return false
  if (policy.dot === 'reject' && parts.some(part => part === '.' || part === '..')) return false
  // Callers that permit dot components still reject traversal.
  if (policy.dot === 'allow' && parts.includes('..')) return false
  if (policy.git === 'first' && parts[0] === '.git') return false
  if (policy.git === 'any' && parts.some(part => part.toLowerCase() === '.git')) return false
  if (policy.room === 'first' && parts[0] === '.room') return false
  return true
}

export type RepoLeafPolicy = 'reject-link' | 'read-contained-link' | 'replace-link'
export type Containment = { ok: true; path: string } | { ok: false; reason: 'outside' | 'link' }

export interface RepoContainmentOptions {
  leaf: RepoLeafPolicy
  allowRoot?: boolean
  allowMissing?: boolean
}

/** Lexical containment only; neither path is read from disk. */
export function isInsideRoot(rootInput: string, targetInput: string, options: { allowRoot?: boolean } = {}): boolean {
  const root = path.resolve(rootInput), target = path.resolve(targetInput)
  const rel = path.relative(root, target)
  return (!!options.allowRoot || rel !== '') && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

export function containedRepoPath(rootInput: string, targetInput: string, options: RepoContainmentOptions): Containment {
  // Callers supply the boundary they validated. Resolving it again would silently move
  // that boundary if the directory has since been replaced with a symlink.
  const root = path.resolve(rootInput)
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root) return { ok: false, reason: 'link' }
  const target = path.resolve(targetInput)
  if (!isInsideRoot(root, target, options)) return { ok: false, reason: 'outside' }
  if (options.leaf === 'read-contained-link') {
    const real = fs.realpathSync(target)
    return isInsideRoot(root, real, options) ? { ok: true, path: real } : { ok: false, reason: 'outside' }
  }
  const checkThrough = options.leaf === 'reject-link' ? target : path.dirname(target)
  if (options.leaf === 'replace-link') {
    const real = fs.realpathSync(checkThrough)
    return isInsideRoot(root, real, { allowRoot: true }) ? { ok: true, path: target } : { ok: false, reason: 'outside' }
  }
  let at = root
  for (const part of path.relative(root, checkThrough).split(path.sep).filter(Boolean)) {
    at = path.join(at, part)
    try {
      if (fs.lstatSync(at).isSymbolicLink()) return { ok: false, reason: 'link' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !options.allowMissing) throw error
    }
  }
  return { ok: true, path: target }
}
