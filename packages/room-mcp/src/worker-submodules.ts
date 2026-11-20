/** Worker submodules have their own Git metadata; never run submodule init/update in the lead. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { containedRepoPath, MATERIALIZED_PATH, validRepoPath } from '@room/roomd'

const MAX_SUBMODULES = 64
const SETUP_MS = 8_000
const RECEIPT = 'room-submodules.json'
const MAX_CONFIG_BYTES = 64 * 1024
const MAX_STATE_BYTES = 4 * 1024 * 1024
const quote = (value: string) => "'" + value.replace(/'/g, process.platform === 'win32' ? "''" : "'\\''") + "'"

// Discovery/status must not refresh the lead's index, invoke fsmonitor or lazily fetch objects.
// Global config is excluded from cloning/checking out: filters, templates and URL rewrites can run code/network.
function run(dir: string, args: string[], deadline: number, input?: string): Promise<string> {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
  const timeout = Math.floor(deadline - performance.now())
  if (timeout <= 0) return Promise.reject(new Error('submodule setup time limit reached'))
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile('git', ['-c', `core.hooksPath=${os.devNull}`,
    '-c', 'init.defaultBranch=room-submodule',
    '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
    ...args], { cwd: dir, env, timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
  (error, stdout, stderr) => error || stderr.trim()
    ? reject(new Error(error?.killed ? 'submodule setup time limit reached' : 'local Git inspection or checkout failed')) : resolve(stdout))
    // Read-only commands can close unused stdin; failed index input must never certify cleanup.
    child.stdin?.on('error', () => { if (input !== undefined) reject(new Error('submodule inspection input failed')) })
    child.stdin?.end(input)
  })
}

interface Gitlink { path: string; oid: string }
function parseLinks(raw: string): Gitlink[] {
  return raw.split('\0').flatMap(line => {
    const match = /^160000 ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([\s\S]+)$/.exec(line)
    return match ? [{ oid: match[1], path: match[2] }] : []
  })
}
/** .gitmodules is the fast gate: ordinary repositories never spawn Git for this feature. */
async function configuredPaths(dir: string, deadline: number): Promise<string[]> {
  const file = path.join(dir, '.gitmodules')
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat) return []
  if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error('submodule configuration is not a small plain file')
  if (!stat.size) return []
  const raw = await run(dir, ['config', '--null', '--file', file, '--list'], deadline)
  const paths = raw.split('\0').filter(line => /^submodule\..*\.path\n/.test(line)).map(line => line.slice(line.indexOf('\n') + 1))
  if (paths.length > MAX_SUBMODULES || paths.some(p => !validRepoPath(p, MATERIALIZED_PATH))) throw new Error('unsupported submodule configuration or more than 64 submodules')
  return [...new Set(paths)]
}
async function links(dir: string, paths: string[], deadline: number): Promise<Gitlink[]> {
  if (!paths.length) return []
  // Enumerate only configured gitlinks, never the ordinary repository's full index.
  const raw = await run(dir, ['ls-files', '--stage', '-z', '--', ...paths.map(p => ':(literal)' + p)], deadline)
  if (raw.split('\0').some(line => /^160000 [a-f0-9]+ [123]\t/.test(line))) throw new Error('unmerged submodule gitlink')
  return parseLinks(raw)
}

interface Creation { refs: string; reflogs: string; dev: string; ino: string }
interface Receipt { v: 1; modules: { path: string; creation?: Creation }[] }
function smallPlainFile(file: string, limit: number): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile() || before.size > limit) throw new Error('submodule state exceeds inspection limit or is not a plain file')
    const bytes = Buffer.alloc(before.size + 1)
    let size = 0, n: number
    while ((n = fs.readSync(fd, bytes, size, bytes.length - size, size)) > 0) {
      size += n
      if (size > before.size) throw new Error('submodule state changed during read')
    }
    const after = fs.fstatSync(fd)
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('submodule state changed during read')
    return bytes.subarray(0, size)
  } finally { fs.closeSync(fd) }
}
function adminDirectory(root: string): string {
  const dotGit = path.join(root, '.git'), stat = fs.lstatSync(dotGit)
  if (stat.isDirectory()) return dotGit
  if (!stat.isFile()) throw new Error('not a plain Git entry')
  const marker = smallPlainFile(dotGit, 4096).toString().trim()
  if (!marker.startsWith('gitdir: ')) throw new Error('not a worktree Git entry')
  const admin = path.resolve(root, marker.slice(8))
  if (!fs.lstatSync(admin).isDirectory()) throw new Error('not a plain Git admin directory')
  return admin
}
function readReceipt(file: string): Receipt | undefined {
  try {
    const value = JSON.parse(smallPlainFile(file, MAX_STATE_BYTES).toString()) as Receipt
    if (value.v !== 1 || !Array.isArray(value.modules) || value.modules.length > MAX_SUBMODULES
      || value.modules.some(entry => !validRepoPath(entry.path, MATERIALIZED_PATH)
        || entry.creation && (!/^[a-f0-9]{64}$/.test(entry.creation.refs) || !/^[a-f0-9]{64}$/.test(entry.creation.reflogs)
          || typeof entry.creation.dev !== 'string' || typeof entry.creation.ino !== 'string'))) throw new Error('invalid submodule creation receipt')
    return value
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}
function saveReceipt(file: string, value: Receipt): void {
  const temp = file + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
  try { fs.renameSync(temp, file) } finally { fs.rmSync(temp, { force: true }) }
}
/** Ref tips and every reflog (including HEAD and deleted refs); never walk/hash the object store. */
async function creationState(dir: string, deadline: number): Promise<Creation> {
  const dotGit = path.join(dir, '.git'), stat = fs.lstatSync(dotGit, { bigint: true })
  if (!stat.isDirectory()) throw new Error('submodule Git metadata is not private')
  const refs = createHash('sha256').update(smallPlainFile(path.join(dotGit, 'HEAD'), 4096))
    .update(await run(dir, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)'], deadline)).digest('hex')
  const logs = createHash('sha256')
  let entries = 0, bytes = 0
  async function walk(at: string, rel: string): Promise<void> {
    if (performance.now() >= deadline || ++entries > 4096) throw new Error('submodule reflog inspection limit reached')
    const info = await fs.promises.lstat(at)
    logs.update(JSON.stringify([rel, info.mode]))
    if (info.isDirectory()) {
      const names: string[] = []
      for await (const child of await fs.promises.opendir(at)) {
        if (names.length + entries >= 4096 || performance.now() >= deadline) throw new Error('submodule reflog inspection limit reached')
        names.push(child.name)
      }
      for (const name of names.sort()) await walk(path.join(at, name), rel + '/' + name)
    } else if (info.isFile()) {
      const data = smallPlainFile(at, MAX_STATE_BYTES - bytes)
      bytes += data.length; logs.update(JSON.stringify(data.length)); logs.update(data)
    } else throw new Error('submodule reflog is not a plain file or directory')
  }
  const logDir = path.join(dotGit, 'logs')
  if (fs.existsSync(logDir)) await walk(logDir, '')
  return { refs, reflogs: logs.digest('hex'), dev: String(stat.dev), ino: String(stat.ino) }
}

/** Inspect staged + on-disk bytes without trusting the clone's index visibility or configuration. */
async function unhiddenStatus(dir: string, deadline: number): Promise<string> {
  // Export entries, not the index file: assume-unchanged/skip-worktree bits, sparse-index layout,
  // stat caches, fsmonitor and untracked-cache extensions must not survive into the inspection.
  const entries = await run(dir, ['ls-files', '--stage', '-z'], deadline)
  const [format, objects, head, ...extra] = (await run(dir,
    ['rev-parse', '--show-object-format', '--git-path', 'objects', 'HEAD'], deadline)).trimEnd().split('\n')
  if (extra.length || !['sha1', 'sha256'].includes(format) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)
    || !objects || /[\r\n]/.test(objects)) throw new Error('unverifiable submodule object location')
  const objectDir = path.resolve(dir, objects)
  if (/[\r\n]/.test(objectDir) || !containedRepoPath(dir, objectDir, { leaf: 'reject-link' }).ok || !fs.lstatSync(objectDir).isDirectory())
    throw new Error('submodule objects are not private')
  const probe = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'room-submodule-status-'))
  try {
    await run(dir, ['init', '--quiet', '--bare', '--template=', `--object-format=${format}`, probe], deadline)
    await fs.promises.writeFile(path.join(probe, 'objects/info/alternates'), objectDir + '\n')
    await fs.promises.writeFile(path.join(probe, 'HEAD'), head + '\n')
    await fs.promises.mkdir(path.join(probe, 'info'), { recursive: true })
    // Highest-priority attributes disable conversions, including arbitrary clean-filter commands.
    // A checkout with normalized bytes different from its Git blobs is conservatively retained.
    await fs.promises.writeFile(path.join(probe, 'info/attributes'), '* -text -eol -crlf -working-tree-encoding -ident -filter\n')
    const context = ['--git-dir', probe, '--work-tree', dir,
      '-c', 'core.ignoreCase=false', '-c', 'core.fileMode=true', '-c', 'core.symlinks=true']
    await run(dir, [...context, 'update-index', '-z', '--index-info'], deadline, entries)
    return await run(dir, [...context, 'status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'], deadline)
  } finally { await fs.promises.rm(probe, { recursive: true, force: true }) }
}
function safe(root: string, rel: string): string {
  if (!validRepoPath(rel, MATERIALIZED_PATH) || rel.split('/')[0].toLowerCase() === '.room') throw new Error('unsafe submodule path')
  const target = path.join(root, rel)
  if (!containedRepoPath(root, target, { leaf: 'reject-link', allowMissing: true }).ok) throw new Error('linked submodule path')
  return target
}
function empty(dir: string): boolean {
  try { return fs.lstatSync(dir).isDirectory() && fs.readdirSync(dir).length === 0 }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
}
async function repository(dir: string, deadline: number): Promise<void> {
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error('lead submodule is not initialized')
  const root = (await run(dir, ['rev-parse', '--show-toplevel'], deadline)).trim()
  if (fs.realpathSync(root) !== fs.realpathSync(dir)) throw new Error('not a submodule checkout')
}

/** Short outcomes for the lead and worker; detailed behavior belongs in the reference. */
export async function prepareWorkerSubmodules(leadDir: string, workerDir: string, options: { timeoutMs?: number } = {}): Promise<{ reply: string[]; prompt?: string }> {
  if (!fs.existsSync(path.join(workerDir, '.gitmodules'))) return { reply: [] }
  const lines: string[] = [], deadline = performance.now() + (options.timeoutMs ?? SETUP_MS)
  const lead = fs.realpathSync(leadDir), worker = fs.realpathSync(workerDir)
  const receipt: Receipt = { v: 1, modules: [] }
  let receiptFile: string | undefined
  let count = 0
  async function visit(sourceRoot: string, targetRoot: string, prefix = '', depth = 0): Promise<void> {
    const paths = await configuredPaths(targetRoot, deadline)
    const entries = await links(targetRoot, paths, deadline)
    const recorded = new Map((await links(sourceRoot, paths, deadline)).map(entry => [entry.path, entry.oid]))
    for (const entry of entries) {
      const rel = prefix + entry.path
      if (++count > MAX_SUBMODULES || depth >= 8) {
        lines.push('Submodules: remaining paths not prepared (setup limit); initialize needed dependencies locally.')
        return
      }
      let source: string | undefined, target: string | undefined
      let stage: string | undefined
      const lineStart = lines.length
      try {
        const record: Receipt['modules'][number] = { path: rel }
        receipt.modules.push(record)
        saveReceipt(receiptFile!, receipt)
        source = safe(sourceRoot, entry.path); target = safe(targetRoot, entry.path)
        if (!empty(target)) {
          lines.push(`Submodule ${JSON.stringify(rel)}: existing worker contents left untouched; inspect before building.`)
          continue
        }
        await repository(source, deadline)
        const head = (await run(source, ['rev-parse', 'HEAD'], deadline)).trim()
        if (head !== recorded.get(entry.path)) throw new Error(`lead checkout differs from its recorded gitlink (${recorded.get(entry.path) ?? 'absent'}); worker requires ${entry.oid}; lead checkout is not carried`)
        if (head !== entry.oid) throw new Error(`lead checkout is at ${head}, worker records ${entry.oid}; lead checkout is not carried`)
        const dirty = await run(source, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], deadline)
        if (dirty) throw new Error('lead submodule has local changes; those changes are not carried')
        const objects = (await run(source, ['rev-parse', '--git-path', 'objects'], deadline)).trim()
        const alternate = path.resolve(source, objects, 'info/alternates')
        if (fs.existsSync(alternate) && fs.statSync(alternate).size) throw new Error('lead object store borrows alternates; automatic setup would depend on their lifetime')
        // Explicit --local fails when hardlinks are unavailable instead of copying a large object store.
        // Stage only Room-owned output before the worker starts. A failed/timed-out checkout never
        // publishes partial dependency contents, and cleanup cannot destroy a worker's later edits.
        // Keep staging on the destination filesystem: hardlink failure is cheap, and publication
        // is a rename on that filesystem even when the Git common directory lives elsewhere.
        stage = fs.mkdtempSync(path.join(path.dirname(target), '.room-submodule-'))
        const checkout = path.join(stage, 'checkout')
        await run(targetRoot, ['clone', '--quiet', '--local', '--no-checkout', '--template=', '--', source, checkout], deadline)
        // A normal push in the worker must not target the lead's submodule repository.
        await run(checkout, ['remote', 'remove', 'origin'], deadline)
        await run(checkout, ['checkout', '--quiet', '--detach', entry.oid], deadline)
        await visit(source, checkout, rel + '/', depth + 1)
        record.creation = await creationState(checkout, deadline)
        saveReceipt(receiptFile!, receipt)
        if (performance.now() >= deadline) throw new Error('submodule setup time limit reached')
        target = safe(targetRoot, entry.path)
        if (!empty(target)) throw new Error('worker destination changed during setup')
        if (fs.existsSync(target)) fs.rmdirSync(target)
        fs.renameSync(checkout, target)
        lines.push(`Submodule ${JSON.stringify(rel)}: ready at ${entry.oid.slice(0, 10)}.`)
      } catch (error) {
        if (stage) lines.splice(lineStart) // Nested results in a discarded stage were never published.
        const reason = error instanceof Error ? error.message : String(error)
        const hasContents = target && !empty(target)
        const outcome = `Submodule ${JSON.stringify(rel)}: ${hasContents ? 'kept; inspect contents' : 'empty'} (${reason})`
        if (!hasContents && source && target) {
          const local = quote(path.relative(worker, source)), destination = quote(rel)
          lines.push(`${outcome}; in worker run: git -c core.hooksPath=${quote(os.devNull)} clone --local --no-checkout --template= -- ${local} ${destination}; then git -C ${destination} remote remove origin; then git -C ${destination} -c core.hooksPath=${quote(os.devNull)} -c submodule.recurse=false checkout --detach ${entry.oid}.`)
        } else lines.push(`${outcome}; ask the lead for a usable local checkout.`)
      } finally { if (stage) await fs.promises.rm(stage, { recursive: true, force: true }) }
    }
  }
  try {
    receiptFile = path.join(adminDirectory(worker), RECEIPT)
    if (fs.existsSync(receiptFile)) throw new Error('submodule setup already has a creation receipt; existing contents kept')
    await visit(lead, worker)
  }
  catch (error) { lines.push(`Submodules: setup unavailable (${error instanceof Error ? error.message : String(error)}); inspect dependencies before building.`) }
  if (count || lines.length) lines.push('Submodule cleanup keeps changed refs/reflogs, non-clean status, or unverifiable state.')
  return lines.length ? { reply: lines, prompt: lines.join('\n') } : { reply: [] }
}

/** A superproject recovery commit cannot recover nested files/commits; retain them even on discard. */
export function changedWorkerSubmodules(workerDir: string): Promise<string[]> {
  return changedSubmodules(workerDir, performance.now() + SETUP_MS)
}
async function changedSubmodules(workerDir: string, deadline: number): Promise<string[]> {
  const root = fs.realpathSync(workerDir)
  const file = path.join(adminDirectory(root), RECEIPT)
  const receipt = readReceipt(file)
  // Check a receipt even if a worker removed .gitmodules. Otherwise absence costs no Git/index scan.
  if (!receipt && !fs.existsSync(path.join(root, '.gitmodules'))) return []
  const records = new Map((receipt?.modules ?? []).map(entry => [entry.path, entry.creation]))
  for (const rel of await configuredPaths(root, deadline)) if (!records.has(rel)) records.set(rel, undefined)
  const changed: string[] = []
  for (const [rel, creation] of records) {
    const at = safe(root, rel)
    if (empty(at)) continue
    if (!creation) { changed.push(rel); continue }
    try {
      const current = await creationState(at, deadline)
      const status = await unhiddenStatus(at, deadline)
      if (JSON.stringify(current) !== JSON.stringify(creation) || status) changed.push(rel)
    } catch { changed.push(rel) }
  }
  return changed
}
