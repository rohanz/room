/** Read-only startup guidance. Dependency setup belongs to the worker, never Room. */
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { MATERIALIZED_PATH, validRepoPath } from '@room/roomd'

const DISCOVERY_MS = 3_000, MAX_MODULES = 64, MAX_METADATA = 128 * 1024
const quote = (value: string) => "'" + value.replace(/'/g, process.platform === 'win32' ? "''" : "'\\''") + "'"
function checkDeadline(deadline: number): void {
  if (performance.now() >= deadline) throw new Error('discovery time limit reached')
}

/** Only worker config/tree reads, with no inherited Git redirects or lazy network fetches. */
function git(cwd: string, args: string[], deadline: number, input?: Buffer): Promise<string> {
  const timeout = Math.floor(deadline - performance.now())
  if (timeout <= 0) return Promise.reject(new Error('discovery time limit reached'))
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' }
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile('git', ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false',
      '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args],
    { cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: MAX_METADATA, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(new Error(error.killed ? 'discovery time limit reached' : 'metadata unavailable or exceeds 128 KiB'))
      else resolve(stdout)
    })
    child.stdin?.on('error', () => child.kill('SIGKILL'))
    child.stdin?.end(input)
  })
}

/** Nonblocking, bounded read; do not pass a mutable path or includes to Git's config parser. */
async function modulesFile(file: string): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('.gitmodules is not a plain file of at most 64 KiB')
    const bytes = Buffer.alloc(64 * 1024 + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 64 * 1024) throw new Error('.gitmodules exceeds 64 KiB')
    return bytes.subarray(0, bytesRead)
  } finally { await handle.close() }
}

/** Inspect only ancestors and the first directory entry, never a dependency tree. */
async function emptyFolder(root: string, relative: string, deadline: number): Promise<boolean> {
  let at = root
  for (const part of relative.split('/')) {
    checkDeadline(deadline)
    at = path.join(at, part)
    const stat = await fs.lstat(at).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (!stat) return true
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
  }
  const dir = await fs.opendir(at)
  try { return await dir.read() === null } finally { await dir.close() }
}

/** One brief outcome per configured gitlink, shared by the spawn reply and prompt. */
export async function workerSubmoduleNotes(leadDir: string, workerDir: string, options: { timeoutMs?: number } = {}): Promise<{ reply: string[]; prompt?: string }> {
  const lines: string[] = []
  try {
    const deadline = performance.now() + (options.timeoutMs ?? DISCOVERY_MS)
    let config: Buffer
    try { config = await modulesFile(path.join(workerDir, '.gitmodules')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { reply: [] }; throw error }
    const raw = await git(workerDir, ['config', '--no-includes', '--null', '--file', '-', '--list'], deadline, config)
    const paths = [...new Set(raw.split('\0').filter(line => /^submodule\..*\.path\n/.test(line)).map(line => line.slice(line.indexOf('\n') + 1)))]
    if (paths.length > MAX_MODULES || paths.some(p => !validRepoPath(p, MATERIALIZED_PATH)
      || /^[a-z]:/i.test(p) || (process.platform === 'win32' && p.split('/').some(part => /[<>:"|?*]|[. ]$|^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))))
      throw new Error('unsupported submodule paths or more than 64 modules')
    if (!paths.length) return { reply: [] }
    // No -r: even an incorrect mapping to a large ordinary directory cannot enumerate its contents.
    const tree = await git(workerDir, ['ls-tree', '-z', '--full-tree', 'HEAD', '--', ...paths.map(p => ':(literal)' + p)], deadline)
    for (const record of tree.split('\0')) {
      checkDeadline(deadline)
      const match = /^160000 commit ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(record)
      if (!match || !paths.includes(match[2])) continue
      const [, commit, relative] = match, destination = path.resolve(workerDir, relative), source = path.resolve(leadDir, relative)
      if (!await emptyFolder(workerDir, relative, deadline)) {
        lines.push(`Submodule ${JSON.stringify(relative)}: records ${commit}; existing or linked folder left as found.`)
        continue
      }
      const clone = `git -c protocol.allow=never -c protocol.file.allow=always clone --local --no-hardlinks --no-checkout --template= -- ${quote(source)} ${quote(destination)}`
      // Explicit metadata/worktree paths fail closed if clone failed: -C alone could find the parent repo.
      const checkout = `git --git-dir=${quote(path.join(destination, '.git'))} --work-tree=${quote(destination)} -c protocol.allow=never -c core.hooksPath=${quote(os.devNull)} -c submodule.recurse=false -c filter.lfs.process= -c filter.lfs.smudge= -c filter.lfs.required=false checkout --detach ${quote(commit)}`
      lines.push(`Submodule ${JSON.stringify(relative)}: empty; repository records ${commit}. If needed, fill from the lead's local copy (no network):\n${clone}\n${checkout}`)
    }
    if (lines.some(line => line.includes('clone --local'))) lines.push('If the lead lacks that commit, ask for a local copy containing it, or permission to fetch it into your worker copy. Nested submodules remain empty.')
  } catch (error) {
    lines.push(`Submodule guidance unavailable (${error instanceof Error ? error.message : String(error)}); folders left untouched. Ask the lead for the dependency path, recorded commit and local copy if needed.`)
  }
  return lines.length ? { reply: lines, prompt: lines.join('\n') } : { reply: [] }
}
