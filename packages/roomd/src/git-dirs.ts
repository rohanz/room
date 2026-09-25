/** Owns Room's worktree-private and common Git directory rules, including carry records. */
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

/** Stop-state calls must remain synchronous and retain boundedGitSync's deadline. */
function gitCommonDirSync(dir: string): string {
  return path.resolve(dir, boundedGitSync(dir, ['rev-parse', '--git-common-dir']).toString().trim())
}

/** Worker ownership compares canonical common directories; carry paths remain lexical. */
export async function realGitCommonDir(dir: string): Promise<string> {
  return fs.realpathSync(await gitCommonDir(dir))
}

function recordAbsent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }

function readRecord<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T }
  catch (error) { if (recordAbsent(error)) return undefined; throw error }
}

/** One accessor for <common git dir>/room-carry/<tag>.json and its atomic reads/writes. */
export async function carryRecord(repoDir: string, tag: string) {
  const file = path.join(await gitCommonDir(repoDir), 'room-carry', tag + '.json')
  return {
    file,
    async read<T>(): Promise<T | undefined> {
      try { return JSON.parse(await fs.promises.readFile(file, 'utf8')) as T }
      catch (error) { if (recordAbsent(error)) return undefined; throw error }
    },
    async write(record: object): Promise<void> {
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      const temp = file + '.' + process.pid + '.tmp'
      try { await fs.promises.writeFile(temp, JSON.stringify(record), { mode: 0o600 }); await fs.promises.rename(temp, file) }
      finally { await fs.promises.rm(temp, { force: true }) }
    },
  }
}

/** Sync carry stop-state operations use the bounded Git deadline and atomic writes. */
export function carryRecordSync(repoDir: string, tag: string) {
  const file = path.join(gitCommonDirSync(repoDir), 'room-carry', tag + '.json')
  return {
    file,
    read: <T>(): T | undefined => readRecord<T>(file),
    write(record: object): void {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temp = file + '.' + process.pid + '.tmp'
      try { fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 }); fs.renameSync(temp, file) }
      finally { try { fs.rmSync(temp, { force: true }) } catch { /* rename already succeeded */ } }
    },
  }
}
