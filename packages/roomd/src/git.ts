import { execFile } from 'node:child_process'

export function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed: ${String(stderr || err.message).trim()}`))
      else resolve(stdout)
    })
  })
}

export const gitHead = (dir: string) => git(dir, ['rev-parse', 'HEAD']).then(s => s.trim())
export const gitBranch = (dir: string) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).then(s => s.trim())

/**
 * Set of syncable paths: git-tracked files plus untracked files that are not ignored
 * (forward-slash, relative to the repo root). Untracked files must sync too: an agent that
 * creates api/notify.py rarely stages it, and a teammate's tests still need it.
 */
export async function gitTracked(dir: string): Promise<Set<string>> {
  const out = await git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  return new Set(out.split('\0').filter(Boolean))
}
