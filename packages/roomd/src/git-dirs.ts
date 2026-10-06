/** Owns Room's worktree-private and common Git directory rules. */
import fs from 'node:fs'
import path from 'node:path'
import { boundedGitSync } from './baseline.js'
import { git } from './git.js'

/** Hooks must resolve without starting Git and fall back to <dir>/.git when metadata is absent. */
export function worktreeGitDirFromDotGit(dir: string): string {
  let gitDir = path.join(dir, '.git')
  try {
    if (fs.statSync(gitDir).isFile()) {
      const target = fs.readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/)?.[1].trim()
      if (target) gitDir = path.resolve(dir, target)
    }
  } catch { /* hook metadata may not exist yet */ }
  return gitDir
}

/** room.json requires Git's actual private directory and keeps boundedGitSync's errors. */
export function worktreeGitDirSync(dir: string): string {
  return boundedGitSync(dir, ['rev-parse', '--absolute-git-dir']).toString().trim()
}

/** Exclude-file setup has historically followed commondir from the gitfile, with a plain-path fallback. */
export function commonGitDirFromDotGit(dir: string): string {
  let gitDir = worktreeGitDirFromDotGit(dir)
  try {
    if (gitDir !== path.join(dir, '.git')) {
      const common = path.join(gitDir, 'commondir')
      if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, 'utf8').trim())
    }
  } catch { /* fall back to the plain path */ }
  return gitDir
}

/** Async callers retain git()'s deadline and error text; result is lexical, not realpathed. */
export async function gitCommonDir(dir: string): Promise<string> {
  return path.resolve(dir, (await git(dir, ['rev-parse', '--git-common-dir'])).trim())
}

/** Worker ownership compares canonical common directories. */
export async function realGitCommonDir(dir: string): Promise<string> {
  const common = await gitCommonDir(dir)
  // Git expands Windows 8.3 names (RUNNER~1 -> runneradmin), while JS realpath
  // can retain the short spelling. Compare the OS-resolved directory names.
  return process.platform === 'win32' ? fs.realpathSync.native(common) : fs.realpathSync(common)
}
