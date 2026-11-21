/** Submodules are read-only commit exports, never repositories Room must inspect at cleanup. */
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { setImmediate } from 'node:timers/promises'
import { MATERIALIZED_PATH, validRepoPath } from '@room/roomd'

const SETUP_MS = 8_000, MAX_MODULES = 64, MAX_METADATA = 4 * 1024 * 1024
const BATCH_BYTES = 8 * 1024 * 1024, MAX_BLOB = 64 * 1024 * 1024
const quote = (value: string) => "'" + value.replace(/'/g, process.platform === 'win32' ? "''" : "'\\''") + "'"
// Manual archive streams files but honors archive attributes, unlike the automatic raw export.
const guidance = (oid: string, destination: string, repository?: string) =>
  `mkdir -p ${quote(destination)}; ${repository ? `git --git-dir=${quote(repository)}` : `git -C ${quote('<dependency-repository>')}`} archive ${quote(oid)} | tar -x -C ${quote(destination)}`

/** Only built-in object/config reads; never run from a lead working tree or inherit Git overrides. */
function git(cwd: string, args: string[], deadline: number, input?: string, maxBuffer = MAX_METADATA): Promise<Buffer> {
  const timeout = Math.floor(deadline - performance.now())
  if (timeout <= 0) return Promise.reject(new Error('export time limit reached'))
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' }
  return new Promise((resolve, reject) => {
    let requestFailed = false
    const child = childProcess.execFile('git', ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false',
      '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args],
    { cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error || stderr.length) reject(new Error(requestFailed ? 'object request failed' : error?.killed ? 'export time limit reached' : 'local objects unavailable or unreadable'))
      else resolve(stdout)
    })
    child.stdin?.on('error', () => { requestFailed = true; child.kill('SIGKILL') })
    child.stdin?.end(input)
  })
}

/** Nonblocking open prevents a FIFO from occupying an I/O worker indefinitely. */
async function smallFile(file: string, limit: number): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > limit) throw new Error('not a bounded plain file')
    const bytes = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await handle.stat()
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('file changed during export')
    return bytes.subarray(0, length)
  } finally { await handle.close() }
}
async function safe(root: string, relative: string): Promise<string> {
  if (!validRepoPath(relative, MATERIALIZED_PATH)) throw new Error('unsafe export path')
  let at = root
  for (const part of relative.split('/')) {
    at = path.join(at, part)
    const stat = await fs.lstat(at).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (stat?.isSymbolicLink()) throw new Error('linked export path')
  }
  return at
}
async function empty(dir: string): Promise<boolean> {
  try { return (await fs.lstat(dir)).isDirectory() && (await fs.readdir(dir)).length === 0 }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
}
async function sourceGitDir(source: string): Promise<string> {
  const entry = path.join(source, '.git'), stat = await fs.lstat(entry)
  if (stat.isDirectory()) return fs.realpath(entry)
  if (!stat.isFile()) throw new Error('submodule Git directory unavailable')
  const text = (await smallFile(entry, 4096)).toString().trimEnd()
  if (!text.startsWith('gitdir: ') || /[\r\n]/.test(text)) throw new Error('invalid submodule Git entry')
  const gitdir = await fs.realpath(path.resolve(source, text.slice(8)))
  if (!(await fs.lstat(gitdir)).isDirectory()) throw new Error('submodule Git directory unavailable')
  return gitdir
}

interface Entry { mode: string; oid: string; size: number; path: string }
async function tree(cwd: string, gitdir: string, commit: string, deadline: number): Promise<Entry[]> {
  const raw = await git(cwd, ['--git-dir', gitdir, 'ls-tree', '-r', '-z', '-l', '--full-tree', `${commit}^{tree}`], deadline)
  const records = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw).split('\0').filter(Boolean)
  const result: Entry[] = []
  const leaves = new Set<string>(), parents = new Set<string>()
  for (const record of records) {
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64}) +([0-9]+|-)\t([\s\S]+)$/.exec(record)
    if (!match || !validRepoPath(match[5], MATERIALIZED_PATH) || (match[1] === '160000') !== (match[2] === 'commit')) throw new Error('unsupported commit entry')
    const size = match[4] === '-' ? 0 : Number(match[4])
    if (!Number.isSafeInteger(size) || size > MAX_BLOB) throw new Error('blob exceeds 64 MiB export limit')
    if (match[1] === '120000' && size > 4096) throw new Error('symlink target exceeds 4 KiB export limit')
    if (leaves.has(match[5])) throw new Error('duplicate export path')
    leaves.add(match[5])
    const parts = match[5].split('/')
    if (process.platform === 'win32' && parts.some(part => /[<>:"|?*]|[. ]$|^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw new Error('unsupported Windows export path')
    for (let n = 1; n < parts.length; n++) parents.add(parts.slice(0, n).join('/'))
    result.push({ mode: match[1], oid: match[3], size, path: match[5] })
  }
  if ([...leaves].some(leaf => parents.has(leaf))) throw new Error('overlapping export paths')
  return result
}

/** Raw blob batches avoid archive attributes, filters and historical object copies. */
async function exportFiles(cwd: string, gitdir: string, entries: Entry[], destination: string, deadline: number): Promise<number> {
  const blobs = entries.filter(entry => entry.mode !== '160000')
  const dirs = new Set<string>([destination]), links: { entry: Entry; target: string }[] = []
  async function directory(dir: string): Promise<void> {
    if (!dirs.has(dir)) { await fs.mkdir(dir, { recursive: true, mode: 0o755 }); dirs.add(dir) }
  }
  for (let index = 0; index < blobs.length;) {
    if (performance.now() >= deadline) throw new Error('export time limit reached')
    const batch: Entry[] = []
    let total = 0
    while (index < blobs.length && batch.length < 256 && (!batch.length || total + blobs[index].size <= BATCH_BYTES)) {
      const entry = blobs[index++]; batch.push(entry); total += entry.size
    }
    const raw = await git(cwd, ['--git-dir', gitdir, 'cat-file', '--batch'], deadline,
      batch.map(entry => entry.oid + '\n').join(''), total + batch.length * 128)
    let offset = 0
    for (const entry of batch) {
      if (performance.now() >= deadline) throw new Error('export time limit reached')
      const end = raw.indexOf(10, offset)
      if (end < 0 || raw.subarray(offset, end).toString() !== `${entry.oid} blob ${entry.size}`) throw new Error('local blob unavailable')
      offset = end + 1
      const bytes = raw.subarray(offset, offset + entry.size)
      offset += entry.size
      if (bytes.length !== entry.size || raw[offset++] !== 10) throw new Error('incomplete local blob')
      const file = path.join(destination, entry.path)
      await directory(path.dirname(file))
      if (entry.mode === '120000') {
        const target = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
        const resolved = path.resolve(path.dirname(file), target), relative = path.relative(destination, resolved)
        if (path.isAbsolute(target) || /^[a-z]:/i.test(target) || /[\\\0]/.test(target) || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
          throw new Error('symlink leaves export')
        links.push({ entry, target })
      } else {
        await fs.writeFile(file, bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o555 : 0o444 })
        await fs.chmod(file, entry.mode === '100755' ? 0o555 : 0o444)
      }
    }
    if (offset !== raw.length) throw new Error('unexpected object output')
  }
  const targets = new Map(links.map(({ entry, target }) => [entry.path, target]))
  for (const { entry, target } of links) {
    await setImmediate()
    if (performance.now() >= deadline) throw new Error('export time limit reached')
    let todo = [...entry.path.split('/').slice(0, -1), ...target.split('/')], parts: string[] = [], hops = 0
    while (todo.length) {
      const part = todo.shift()!
      if (!part || part === '.') continue
      if (part === '..') { if (!parts.length) throw new Error('symlink chain leaves export'); parts.pop() }
      else {
        parts.push(part)
        const next = targets.get(parts.join('/'))
        if (next !== undefined) {
          if (++hops > 40) throw new Error('cyclic or excessive symlink chain')
          parts.pop(); todo = [...next.split('/'), ...todo]
        }
      }
    }
  }
  for (const { entry, target } of links) {
    if (performance.now() >= deadline) throw new Error('export time limit reached')
    await fs.symlink(target, path.join(destination, entry.path))
  }
  const nested = entries.filter(entry => entry.mode === '160000')
  for (const entry of nested) {
    if (performance.now() >= deadline) throw new Error('export time limit reached')
    await directory(path.join(destination, entry.path))
  }
  return nested.length
}

/** One outcome per path, shared by the spawn reply and worker prompt. */
export async function prepareWorkerSubmodules(leadDir: string, workerDir: string, options: { timeoutMs?: number } = {}): Promise<{ reply: string[]; prompt?: string }> {
  const config = path.join(workerDir, '.gitmodules'), lines: string[] = []
  try {
    try { await fs.lstat(config) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { reply: [] }; throw error }
    const deadline = performance.now() + (options.timeoutMs ?? SETUP_MS)
    const lead = await fs.realpath(leadDir), worker = await fs.realpath(workerDir)
    await smallFile(config, 64 * 1024)
    const raw = (await git(worker, ['config', '--no-includes', '--null', '--file', config, '--list'], deadline)).toString()
    const paths = [...new Set(raw.split('\0').filter(line => /^submodule\..*\.path\n/.test(line)).map(line => line.slice(line.indexOf('\n') + 1)))]
    if (paths.length > MAX_MODULES || paths.some(p => !validRepoPath(p, MATERIALIZED_PATH))) throw new Error('unsupported submodule configuration')
    if (!paths.length) return { reply: [] }
    let nestedBudget = MAX_MODULES - paths.length
    const index = (await git(worker, ['ls-files', '--stage', '-z', '--', ...paths.map(p => ':(literal)' + p)], deadline)).toString()
    for (const record of index.split('\0').filter(Boolean)) {
      const match = /^160000 ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([\s\S]+)$/.exec(record)
      if (!match || !paths.includes(match[2])) continue
      const [, commit, relative] = match
      let stage: string | undefined, gitdir: string | undefined
      try {
        if (performance.now() >= deadline) throw new Error('export time limit reached')
        const target = await safe(worker, relative), source = await safe(lead, relative)
        if (!await empty(target)) { lines.push(`Submodule ${JSON.stringify(relative)}: existing contents kept.`); continue }
        gitdir = await sourceGitDir(source).catch(() => { throw new Error('local objects unavailable (submodule not initialized or Git directory unreadable)') })
        stage = await fs.mkdtemp(path.join(path.dirname(target), '.room-submodule-'))
        const output = path.join(stage, 'export')
        await fs.mkdir(output, { mode: 0o755 })
        const entries = await tree(stage, gitdir, commit, deadline)
        const nestedCount = entries.filter(entry => entry.mode === '160000').length
        if (nestedCount > nestedBudget) throw new Error('nested submodules exceed the 64-module export limit')
        const nested = await exportFiles(stage, gitdir, entries, output, deadline)
        if (performance.now() >= deadline) throw new Error('export time limit reached')
        await safe(worker, relative)
        if (!await empty(target)) throw new Error('worker destination changed during export')
        await fs.rmdir(target).catch(error => { if (error.code !== 'ENOENT') throw error })
        await fs.rename(output, target)
        nestedBudget -= nestedCount
        lines.push(`Submodule ${JSON.stringify(relative)}: read-only copy of ${commit.slice(0, 10)}, not a Git checkout (raw blobs; no filters/LFS/EOL conversion${nested ? `; ${nested} nested submodule folder(s) empty` : ''}).`)
        for (const entry of entries.filter(entry => entry.mode === '160000')) {
          const destination = path.join(target, entry.path)
          lines.push(`Submodule ${JSON.stringify(relative + '/' + entry.path)}: empty (nested submodule); from its own local repository containing ${entry.oid}, run: ${guidance(entry.oid, destination)}.`)
        }
      } catch (error) {
        lines.push(`Submodule ${JSON.stringify(relative)}: export unavailable (${error instanceof Error ? error.message : String(error)}); existing contents kept, otherwise empty. If objects are missing, in its own repository run git fetch <remote> ${commit}; to fill locally run: ${guidance(commit, path.join(worker, relative), gitdir)}.`)
      } finally {
        if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {
          lines.push(`Submodules: temporary export could not be removed at ${JSON.stringify(stage)}; remove it before building.`)
        })
      }
    }
  } catch (error) {
    lines.push(`Submodules: export unavailable (${error instanceof Error ? error.message : String(error)}); folders left as found. To fill an empty folder locally, replace the placeholders and run: ${guidance('<recorded-commit>', '<worker-submodule-folder>')}.`)
  }
  return lines.length ? { reply: lines, prompt: lines.join('\n') } : { reply: [] }
}
