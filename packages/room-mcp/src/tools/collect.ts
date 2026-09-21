import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { claimsOverlap } from '@room/shared'
import { git } from '@room/roomd/git'
import { cleanupWorker, workerOwnedPaths } from '../workers.js'
import { releaseClaimsOnDone } from './claims.js'
import { RW, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [{
  name: 'room_collect', annotations: { ...RW, destructiveHint: true },
  description: 'Apply finished worker changes unstaged (default); conflicts change nothing. commit=true commits and merges only when requested by the human. copy takes artifacts; discard stops/dismisses a worker. Successful collection cleans up exited workers.',
  inputSchema: { type: 'object', properties: {
    tag: str('worker tag'), mode: { type: 'string', enum: ['apply', 'copy'] },
    commit: { type: 'boolean' }, discard: { type: 'boolean' },
    paths: strs('copy mode: repo-relative files or directories'),
    force: { type: 'boolean', description: 'allow a running worker or overwrite modified copy destinations' },
  }, required: ['tag'] },
}]

const split = (value: string) => value.split('\0').filter(Boolean)

/** Reject symlinks at every component, including dangling destination links. */
function safePath(root: string, rel: string): string {
  if (!rel || path.isAbsolute(rel) || rel.includes('\\') || rel.includes('\0') || rel.split('/').some(p => !p || p === '..' || p === '.' || p.toLowerCase() === '.git')) throw new Error('unsafe collection path: ' + rel)
  let file = fs.realpathSync(root)
  for (const part of rel.split('/')) {
    file = path.join(file, part)
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('symlink collection path refused: ' + rel) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
  return file
}

function copyFiles(root: string, paths: string[]): string[] {
  const files = new Set<string>()
  const visit = (rel: string) => {
    const file = safePath(root, rel), stat = fs.statSync(file)
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(rel + '/' + name)
    else if (stat.isFile()) files.add(rel)
    else throw new Error('not a regular file: ' + rel)
  }
  paths.forEach(visit)
  return [...files].sort()
}

async function assertNoOperation(dir: string): Promise<void> {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const file = (await git(dir, ['rev-parse', '--git-path', name])).trim()
    if (fs.existsSync(path.resolve(dir, file))) throw new Error('finish the existing Git operation in ' + dir + ' before collecting')
  }
}


/** Isolated indexes preserve both real indexes; merge-tree never writes working files. */
async function applyWorker(lead: string, worker: string, exclusions: string[], release: (paths: string[]) => void): Promise<{ paths: string[]; conflicts: string[] }> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'room-apply-'))
  const run = promisify(execFile)
  const base = (await git(lead, ['merge-base', 'HEAD', (await git(worker, ['rev-parse', 'HEAD'])).trim()])).trim()
  const snapshot = async (dir: string, name: string, omit: string[]) => {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, name) }
    const command = async (args: string[]) => (await run('git', args, { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 })).stdout.trim()
    await command(['read-tree', 'HEAD'])
    await command(['add', '-A', '--', '.', ...omit])
    const tree = await command(['write-tree'])
    const commit = await command(['-c', 'user.name=Room', '-c', 'user.email=room@localhost', 'commit-tree', tree, '-p', base, '-m', 'collection snapshot'])
    return { tree, commit }
  }
  try {
    const ours = await snapshot(lead, 'lead', []), theirs = await snapshot(worker, 'worker', exclusions)
    let merged: string
    try { merged = (await git(lead, ['merge-tree', '--write-tree', ours.commit, theirs.commit])).split('\n')[0] }
    catch (error) {
      const result = await run('git', ['merge-tree', '--write-tree', '--name-only', ours.commit, theirs.commit], { cwd: lead }).catch(e => ({ stdout: String(e.stdout) }))
      const conflicts = result.stdout.split('\n\n')[0].split('\n').slice(1).filter(Boolean)
      if (!conflicts.length) throw error
      return { paths: [], conflicts }
    }
    const paths = split(await git(lead, ['diff', '--name-only', '-z', ours.tree, merged]))
    for (const p of paths) safePath(lead, p)
    const patch = (await run('git', ['diff', '--binary', '--no-renames', ours.tree, merged], { cwd: lead, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })).stdout
    if (patch.length) {
      const file = path.join(scratch, 'changes.patch'); fs.writeFileSync(file, patch)
      await git(lead, ['apply', '--check', file])
      release(paths)
      await git(lead, ['apply', file])
    }
    return { paths, conflicts: [] }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}

export function handlers(state: HandlerState): Record<string, Handler> {
  return { async room_collect(a) {
    const { rooms } = state
    const lead = state.S()
    if (typeof a.tag !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(a.tag)) return 'error: valid worker tag required'
    if (a.mode !== undefined && a.mode !== 'apply' && a.mode !== 'copy') return 'error: mode must be apply or copy'
    if (a.force !== undefined && typeof a.force !== 'boolean') return 'error: force must be a boolean'
    for (const key of ['commit', 'discard']) if (a[key] !== undefined && typeof a[key] !== 'boolean') return 'error: ' + key + ' must be a boolean'
    if (a.commit && (a.discard || a.mode === 'copy')) return 'error: commit cannot combine with copy or discard'
    const mode = a.mode ?? 'apply'
    const s = rooms.holdingWorker(a.tag, lead)
    let w = s.room.workers.get(a.tag)
    if (!w || w.lead !== s.me.name) return 'error: no worker ' + a.tag + ' owned by you'
    if (a.discard === true) {
      try {
        if (state.workerAlive(s, w) || w.status === 'running') {
          const how = state.dismissWorker(s, w, 'discarded by the lead')
          if (s.room.workers.get(w.tag)?.status === 'running') return 'could not discard ' + w.tag + ': ' + how
          if (state.workerAlive(s, w)) return 'discarded ' + w.tag + '; ' + how + '; retained ' + w.dir + ' until exit'
        }
        let dirty = 'unknown'
        try { dirty = (await git(w.dir, ['status', '--porcelain', '--untracked-files=all', '--', '.', ...workerOwnedPaths(w).exclusions])).trim() } catch { /* Retire the record but preserve unknown disk state. */ }
        const cleaned = !dirty && w.exitCode === 0 && await cleanupWorker(s.dir, w, true)
        s.room.updateWorker(w.tag, { dismissedAt: Date.now() }, w.id)
        await rooms.retireWorkers()
        return 'discarded ' + w.tag + '; ' + (cleaned ? 'cleaned up' : 'retained ' + w.dir)
      } catch (e) { return 'error: ' + (e instanceof Error ? e.message : String(e)) + '; retained ' + w.dir }
    }
    if (!s.local) return 'error: room_collect requires a local worker'
    if (a.force !== true) {
      if (w.status === 'running') return 'error: worker ' + w.tag + ' is still running; stop it or pass force=true'
      const now = state.now ?? Date.now
      const sleep = state.ctx?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
      const deadline = now() + 15_000
      while (state.workerAlive(s, w)) {
        const remaining = deadline - now()
        if (remaining <= 0) return `error: worker ${w.tag} reported ${w.status} but its process has not exited after 15 s; force=true overrides`
        await sleep(Math.min(250, remaining))
      }
      // A new spawn must not be collected using the old record after the wait.
      const current = s.room.workers.get(w.tag)
      if (current && (current.id !== w.id || current.startedAt !== w.startedAt || current.status === 'running')) return 'error: worker changed while waiting; retry collection'
      if (current) w = current
    }
    if (fs.realpathSync(w.dir) === fs.realpathSync(lead.dir)) return 'error: worker must have a separate worktree'
    const lock = 'collect:' + fs.realpathSync(lead.dir)
    if (!rooms.reserve(lock)) return 'error: another collection is in progress'
    const out: string[] = []
    const releasePaths = (paths: string[]) => releaseClaimsOnDone(s, c => !paths.some(p => claimsOverlap(c, { path: p, from: 1, to: Number.MAX_SAFE_INTEGER })), w.name, false)
    try {
      if (mode === 'copy') {
        if (!Array.isArray(a.paths) || !a.paths.length || a.paths.some(p => typeof p !== 'string')) return 'error: copy requires non-empty paths'
        const files = copyFiles(w.dir, a.paths as string[])
        const modified = new Set(split(await git(lead.dir, ['diff', '--name-only', '-z', 'HEAD', '--'])))
        const tracked = new Set(split(await git(lead.dir, ['ls-files', '-z'])))
        for (const p of files) {
          const dst = safePath(lead.dir, p)
          if (fs.existsSync(dst) && !fs.statSync(dst).isFile()) return 'error: copy destination is not a regular file: ' + p
          if (a.force !== true && (modified.has(p) || (!tracked.has(p) && fs.existsSync(dst)))) {
            if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(fs.readFileSync(safePath(w.dir, p)))) return 'error: lead has modified ' + p + '; pass force=true to overwrite'
          }
        }
        releasePaths(files)
        for (const p of files) {
          const dst = safePath(lead.dir, p)
          fs.mkdirSync(path.dirname(dst), { recursive: true })
          fs.copyFileSync(safePath(w.dir, p), dst)
          fs.chmodSync(dst, fs.statSync(safePath(w.dir, p)).mode & 0o777)
          out.push('copied ' + p)
        }
        if (!files.length) out.push('nothing copied (empty directories)')
      } else {
        if (a.paths !== undefined) return 'error: paths is only supported in copy mode'
        await assertNoOperation(lead.dir)
        await assertNoOperation(w.dir)
        const common = async (dir: string) => fs.realpathSync(path.resolve(dir, (await git(dir, ['rev-parse', '--git-common-dir'])).trim()))
        if (await common(lead.dir) !== await common(w.dir)) return 'error: worker is not a worktree of this repository'
        if (w.branch !== 'room/' + w.tag || (await git(w.dir, ['branch', '--show-current'])).trim() !== w.branch) return 'error: worker must be on branch room/' + w.tag
        if (!a.commit) {
          const result = await applyWorker(lead.dir, w.dir, workerOwnedPaths(w).exclusions, releasePaths)
          if (result.conflicts.length) return 'not applied; conflicting files: ' + result.conflicts.join(', ')
          out.push('applied ' + w.tag + ' (unstaged): ' + (result.paths.join(', ') || 'already up to date'))
          if (!state.workerAlive(s, w) && w.exitCode === 0 && w.status === 'done') {
            await cleanupWorker(s.dir, w, true)
            s.room.updateWorker(w.tag, { dismissedAt: Date.now() }, w.id)
          }
          await rooms.retireWorkers()
          return out.join('\n')
        }
        if ((await git(lead.dir, ['diff', '--name-only', 'HEAD', '--'])).trim()) return 'error: commit or stash the lead tracked changes before merging'
        const owned = workerOwnedPaths(w)
        const staged = split(await git(w.dir, ['diff', '--cached', '--name-only', '-z']))
        if (staged.some(owned.includes)) return 'error: linked inputs are staged; unstage them before collecting'
        const name = (await git(lead.dir, ['config', 'user.name'])).trim()
        const email = (await git(lead.dir, ['config', 'user.email'])).trim()
        const identity = ['-c', 'user.name=' + name, '-c', 'user.email=' + email]
        await git(w.dir, ['add', '-A', '--', '.', ...owned.exclusions])
        const committed = split(await git(w.dir, ['diff', '--cached', '--name-only', '-z']))
        const landed = split(await git(w.dir, ['diff', '--name-only', '-z', 'HEAD', (await git(lead.dir, ['rev-parse', 'HEAD'])).trim(), '--']))
        releasePaths([...new Set([...committed, ...landed])])
        if (committed.length) {
          const summary = w.summary?.trim() || 'worker output'
          await git(w.dir, [...identity, 'commit', '--author=' + name + ' <' + email + '>', '-m', ('room: collect ' + w.tag).slice(0, 72), '-m', summary])
          out.push('committed ' + (await git(w.dir, ['rev-parse', 'HEAD'])).trim() + ': ' + committed.join(', '))
        } else out.push('nothing to commit')
        const before = (await git(lead.dir, ['rev-parse', 'HEAD'])).trim()
        try {
          await git(lead.dir, [...identity, 'merge', '--no-edit', '--no-overwrite-ignore', w.branch])
        } catch (e) {
          const conflicts = split(await git(lead.dir, ['diff', '--name-only', '--diff-filter=U', '-z']))
          const mergeHead = (await git(lead.dir, ['rev-parse', '--git-path', 'MERGE_HEAD'])).trim()
          if (fs.existsSync(path.resolve(lead.dir, mergeHead))) await git(lead.dir, ['merge', '--abort'])
          out.push(conflicts.length ? 'merge aborted; conflicting files: ' + conflicts.join(', ') : 'merge not applied: ' + (e instanceof Error ? e.message : String(e)))
          await rooms.retireWorkers()
          return out.join('\n')
        }
        const merged = split(await git(lead.dir, ['diff', '--name-only', '-z', before, 'HEAD']))
        out.push('merged ' + w.branch + ': ' + (merged.join(', ') || 'already up to date'))
        if (!state.workerAlive(s, w) && w.exitCode === 0 && w.status === 'done') {
          await cleanupWorker(s.dir, w, true)
          s.room.updateWorker(w.tag, { dismissedAt: Date.now() }, w.id)
        }
      }
      await rooms.retireWorkers()
      return out.join('\n')
    } catch (e) {
      if (!fs.existsSync(w.dir)) {
        s.room.updateWorker(w.tag, { dismissedAt: Date.now() }, w.id)
        await rooms.retireWorkers()
      }
      return [...out, 'error: ' + (e instanceof Error ? e.message : String(e))].join('\n')
    } finally { rooms.unreserve(lock) }
  } }
}
