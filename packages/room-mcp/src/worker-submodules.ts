/** Worker submodules have their own Git metadata; never run submodule init/update in the lead. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { containedRepoPath, MATERIALIZED_PATH, validRepoPath } from '@room/roomd'

const MAX_SUBMODULES = 64
const SETUP_MS = 30_000
const quote = (value: string) => "'" + value.replace(/'/g, process.platform === 'win32' ? "''" : "'\\''") + "'"

// Discovery/status must not refresh the lead's index, invoke fsmonitor or lazily fetch objects.
// Global config is excluded from cloning/checking out: filters, templates and URL rewrites can run code/network.
function run(dir: string, args: string[], deadline: number): Promise<string> {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
  const timeout = Math.floor(deadline - performance.now())
  if (timeout <= 0) return Promise.reject(new Error('submodule setup time limit reached'))
  return new Promise((resolve, reject) => childProcess.execFile('git', ['-c', `core.hooksPath=${os.devNull}`,
    '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
    ...args], { cwd: dir, env, timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
  (error, stdout) => error ? reject(new Error(error.killed ? 'submodule setup time limit reached' : 'local Git inspection or checkout failed')) : resolve(stdout)))
}

interface Gitlink { path: string; oid: string }
function parseLinks(raw: string): Gitlink[] {
  return raw.split('\0').flatMap(line => {
    const match = /^160000 ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([\s\S]+)$/.exec(line)
    return match ? [{ oid: match[1], path: match[2] }] : []
  })
}
async function links(dir: string, deadline: number): Promise<Gitlink[]> {
  const raw = await run(dir, ['ls-files', '--stage', '-z'], deadline)
  if (raw.split('\0').some(line => /^160000 [a-f0-9]+ [123]\t/.test(line))) throw new Error('unmerged submodule gitlink')
  return parseLinks(raw)
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

/** The same notes go to the lead and worker, including exact pinned, local-only recovery commands. */
export async function prepareWorkerSubmodules(leadDir: string, workerDir: string): Promise<{ reply: string[]; prompt?: string }> {
  const lines: string[] = [], deadline = performance.now() + SETUP_MS
  const lead = fs.realpathSync(leadDir), worker = fs.realpathSync(workerDir)
  let count = 0
  async function visit(sourceRoot: string, targetRoot: string, prefix = '', depth = 0): Promise<void> {
    const entries = await links(targetRoot, deadline)
    const recorded = new Map((await links(sourceRoot, deadline)).map(entry => [entry.path, entry.oid]))
    for (const entry of entries) {
      const rel = prefix + entry.path
      if (++count > MAX_SUBMODULES || depth >= 8) {
        lines.push(`Submodules: remaining directories were not prepared; automatic setup limit (${MAX_SUBMODULES} submodules / 8 levels) reached. Inspect and initialize only needed dependencies in this worker.`)
        return
      }
      let source: string | undefined, target: string | undefined
      let started = false
      try {
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
        if (fs.existsSync(alternate) && fs.readFileSync(alternate, 'utf8').trim()) throw new Error('lead object store borrows alternates; automatic setup would depend on their lifetime')
        // Explicit --local fails when hardlinks are unavailable instead of copying a large object store.
        // Clone into the empty gitlink directory, with its own .git, without modifying shared superproject config.
        started = true
        await run(targetRoot, ['clone', '--quiet', '--local', '--no-checkout', '--template=', '--', source, target], deadline)
        // A normal push in the worker must not target the lead's submodule repository.
        await run(target, ['remote', 'remove', 'origin'], deadline)
        await run(target, ['checkout', '--quiet', '--detach', entry.oid], deadline)
        lines.push(`Submodule ${JSON.stringify(rel)}: ready at ${entry.oid}; local object hardlinks, independent checkout and Git metadata; no network.`)
        await visit(source, target, rel + '/', depth + 1)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const state = target && !empty(target) ? 'setup incomplete; inspect existing worker contents' : 'empty'
        // Do not delete partial clone/checkouts: a timeout or concurrent writer can leave useful output.
        lines.push(`Submodule ${JSON.stringify(rel)}: ${state} (${reason}).`)
        if (source && target) {
          lines.push(`Cheap local setup (${process.platform === 'win32' ? 'PowerShell' : 'POSIX shell'}; only when the destination is empty): git -c core.hooksPath=${quote(os.devNull)} clone --local --no-checkout --template= -- ${quote(source)} ${quote(target)}; then git -C ${quote(target)} remote remove origin; then git -C ${quote(target)} -c core.hooksPath=${quote(os.devNull)} -c submodule.recurse=false checkout --detach ${entry.oid}. This uses the recorded commit, not the lead's local changes. --local fails if hardlinks are unavailable; do not replace it with a full copy without choosing that cost.`)
        } else lines.push('Ask the lead for a usable local submodule checkout; do not follow linked paths or initialize submodules in the lead checkout.')
        if (started) lines.push('Keep partial setup for inspection; do not overwrite it to retry.')
      }
    }
  }
  try { await visit(lead, worker) }
  catch (error) { lines.push(`Submodules: could not inspect gitlinks (${error instanceof Error ? error.message : String(error)}); dependencies may be empty. Ask the lead for a local checkout before building.`) }
  if (count || lines.length) lines.push('Submodules are build inputs: Room does not preview or collect their contents or gitlink changes. Export any submodule work separately; cleanup retains changed submodules because superproject recovery refs cannot save them. Never edit hardlinked Git object files.')
  return lines.length ? { reply: lines, prompt: lines.join('\n') } : { reply: [] }
}

/** A superproject recovery commit cannot recover nested files/commits; retain them even on discard. */
export function changedWorkerSubmodules(workerDir: string): Promise<string[]> {
  return changedSubmodules(workerDir, performance.now() + SETUP_MS, 0)
}
async function changedSubmodules(workerDir: string, deadline: number, depth: number): Promise<string[]> {
  if (depth > 8) throw new Error('submodule inspection depth limit; checkout retained')
  const root = fs.realpathSync(workerDir)
  const indexed = await links(root, deadline)
  const tree = await run(root, ['ls-tree', '-r', '-z', 'HEAD'], deadline)
  const committed = tree.split('\0').flatMap(line => {
    const match = /^160000 commit ([a-f0-9]+)\t([\s\S]+)$/.exec(line)
    return match ? [{ oid: match[1], path: match[2] }] : []
  })
  const expected = new Map(committed.map(entry => [entry.path, entry.oid]))
  const entries = new Map([...committed, ...indexed].map(entry => [entry.path, entry]))
  const changed: string[] = []
  for (const entry of entries.values()) {
    const at = safe(root, entry.path)
    if (empty(at)) continue
    try {
      await repository(at, deadline)
      const head = (await run(at, ['rev-parse', 'HEAD'], deadline)).trim()
      // Include ignored files: they are not in the superproject discard snapshot either.
      const status = await run(at, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'], deadline)
      if (head !== expected.get(entry.path) || entry.oid !== expected.get(entry.path) || status
        || (await changedSubmodules(at, deadline, depth + 1)).length) changed.push(entry.path)
    } catch { changed.push(entry.path) }
  }
  return changed
}
