import fs from 'node:fs'
import path from 'node:path'
import { claimsOverlap } from '@room/shared'
import { git } from '@room/roomd/git'
import { workerOwnedPaths } from '../workers.js'
import { releaseClaimsOnDone } from './claims.js'
import { RW, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [{
  name: 'room_collect', annotations: { ...RW, destructiveHint: true },
  description: 'Collect a finished local worker as its lead. merge (default) commits all non-ignored changes in its worktree and merges its branch; conflicts are aborted and listed. copy copies named files/directories, including ignored artifacts. Releases collected claims first. Refuses a running worker or modified copy destination unless force.',
  inputSchema: { type: 'object', properties: {
    tag: str('worker tag'), mode: { type: 'string', enum: ['merge', 'copy'] },
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

export function handlers(state: HandlerState): Record<string, Handler> {
  return { async room_collect(a) {
    const { rooms } = state
    const lead = state.S()
    if (typeof a.tag !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(a.tag)) return 'error: valid worker tag required'
    if (a.mode !== undefined && a.mode !== 'merge' && a.mode !== 'copy') return 'error: mode must be merge or copy'
    if (a.force !== undefined && typeof a.force !== 'boolean') return 'error: force must be a boolean'
    const mode = a.mode ?? 'merge'
    const s = rooms.holdingWorker(a.tag, lead), w = s.room.workers.get(a.tag)
    if (!w || w.lead !== s.me.name) return 'error: no worker ' + a.tag + ' owned by you'
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
          const summary = w.summary?.split(/\r?\n/)[0].trim() || 'worker output'
          await git(w.dir, [...identity, 'commit', '--author=' + name + ' <' + email + '>', '-m', 'room: collect ' + w.tag + ': ' + summary])
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
      }
      await rooms.retireWorkers()
      return out.join('\n')
    } catch (e) {
      return [...out, 'error: ' + (e instanceof Error ? e.message : String(e))].join('\n')
    } finally { rooms.unreserve(lock) }
  } }
}
