import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { claimsOverlap } from '@room/shared'
import { git } from '@room/roomd/git'
import { cleanupWorker, saveDiscardPatch, signalWorker, pidAlive, pidIsOurWorker, workerOwnedPaths } from '../workers.js'
import { buildCombinedTree } from './combined-tree.js'
import { releaseClaimsOnDone } from './claims.js'
import { RW, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [{
  name: 'room_collect', annotations: { ...RW, destructiveHint: true },
  description: 'Collect all done workers (or tag) as unstaged edits, never commits. Any conflict writes nothing. Skips running/failed workers. copy takes named artifacts; discard dismisses one worker. Cleans up fully collected exited workers.',
  inputSchema: { ...{ additionalProperties: false }, type: 'object', properties: {
    tag: str('worker tag'), mode: { type: 'string', enum: ['apply', 'copy'] },
    discard: { type: 'boolean' },
    paths: strs('copy mode: repo-relative files or directories'),
    force: { type: 'boolean', description: 'overwrite modified copy destinations' },
  } },
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
    const { rooms } = state, lead = state.S()
    const unknown = Object.keys(a).find(key => !['tag', 'mode', 'discard', 'paths', 'force'].includes(key))
    if (unknown) return 'error: unknown argument ' + unknown
    if (a.tag !== undefined && (typeof a.tag !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(a.tag))) return 'error: valid worker tag required'
    if (a.mode !== undefined && a.mode !== 'apply' && a.mode !== 'copy') return 'error: mode must be apply or copy'
    for (const key of ['discard', 'force']) if (a[key] !== undefined && typeof a[key] !== 'boolean') return 'error: ' + key + ' must be a boolean'
    if ((a.discard || a.mode === 'copy') && !a.tag) return 'error: tag required for copy or discard'
    if (a.paths !== undefined && a.mode !== 'copy') return 'error: paths is only supported in copy mode'
    if (a.discard) {
      const s = rooms.holdingWorker(a.tag as string, lead)
      const w = s.room.workers.get(a.tag as string)
      if (!w || w.lead !== s.me.name) return 'error: no worker ' + a.tag + ' owned by you'
      const lock = 'discard:' + s.roomName + ':' + w.name
      if (!rooms.reserve(lock)) return 'error: this worker is already being discarded'
      try {
        if (state.workerAlive(s, w) || w.status === 'running') {
          const how = state.dismissWorker(s, w, 'discarded by the lead')
          if (s.room.workers.get(w.tag)?.status === 'running' && (state.workerAlive(s, w) || pidAlive(w.pid))) return 'could not discard ' + w.tag + ': ' + how
          const now = state.now ?? Date.now
          const sleep = state.ctx?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
          const deadline = now() + 5_000
          while (state.workerAlive(s, w) && now() < deadline) await sleep(50)
          if (state.workerAlive(s, w) && (rooms.handle(s, w.id) || pidIsOurWorker(w.pid, w, state.ctx?.probe))) signalWorker(w.pid, 'SIGKILL')
          const hardDeadline = now() + 5_000
          while (state.workerAlive(s, w) && now() < hardDeadline) await sleep(50)
          if (state.workerAlive(s, w)) throw new Error('worker process has not stopped')
        }
        const patch = await saveDiscardPatch(s.dir, w)
        if (!await cleanupWorker(s.dir, w, true, true)) throw new Error('worker is not an owned Room worktree')
        releaseClaimsOnDone(s, () => false, w.name, false)
        const retiredAt = Date.now()
        s.room.retireParticipant(w.name, {
          name: w.name, tag: w.tag, lead: w.lead, host: w.host, task: w.task,
          summary: 'discarded', files: [], fileCount: 0, startedAt: w.startedAt,
          finishedAt: w.finishedAt ?? retiredAt, retiredAt, outcome: 'dismissed',
        })
        return 'discarded ' + w.tag + (patch ? '; recovery patch: ' + patch + ' (kept for a week)' : '')
      } catch (e) { return 'error: ' + (e instanceof Error ? e.message : String(e)) + '; retained ' + w.dir }
      finally { rooms.unreserve(lock) }
    }
    const sessions = a.tag ? [rooms.holdingWorker(a.tag as string, lead)] : rooms.all()
    const candidates = sessions.flatMap(s => [...s.room.workers.values()].filter(w => w.lead === s.me.name && (!a.tag || w.tag === a.tag)).map(w => ({ s, w })))
      .sort((a, b) => (a.w.finishedAt ?? 0) - (b.w.finishedAt ?? 0) || (a.w.tag < b.w.tag ? -1 : a.w.tag > b.w.tag ? 1 : 0))
    if (a.tag && !candidates.length) return 'error: no worker ' + a.tag + ' owned by you'
    const out: string[] = []
    const selected: typeof candidates = []
    const lock = 'collect:' + fs.realpathSync(lead.dir)
    if (!rooms.reserve(lock)) return 'error: another collection is in progress'
    try {
      for (const item of candidates) {
        const { s } = item; let { w } = item
        if (w.status !== 'done') { out.push('skipped ' + w.tag + ': ' + w.status); continue }
        if (!s.local) throw new Error('room_collect requires a local worker')
        const now = state.now ?? Date.now
        const sleep = state.ctx?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
        const deadline = now() + 15_000
        while (state.workerAlive(s, w) && now() < deadline) await sleep(Math.min(250, deadline - now()))
        if (state.workerAlive(s, w)) { out.push('skipped ' + w.tag + ': process has not exited after 15 s'); continue }
        const current = s.room.workers.get(w.tag)
        if (!current || current.id !== w.id || current.startedAt !== w.startedAt || current.status !== 'done') {
          out.push('skipped ' + w.tag + ': changed while waiting'); continue
        }
        w = current
        if (w.exitCode !== undefined && w.exitCode !== 0) { out.push('skipped ' + w.tag + ': failed exit'); continue }
        if (fs.realpathSync(w.dir) === fs.realpathSync(lead.dir)) throw new Error('worker must have a separate worktree')
        await assertNoOperation(w.dir)
        const common = async (dir: string) => fs.realpathSync(path.resolve(dir, (await git(dir, ['rev-parse', '--git-common-dir'])).trim()))
        if (await common(lead.dir) !== await common(w.dir)) throw new Error('worker is not a worktree of this repository')
        if (w.branch !== 'room/' + w.tag || (await git(w.dir, ['branch', '--show-current'])).trim() !== w.branch) throw new Error('worker must be on branch room/' + w.tag)
        selected.push({ s, w })
      }
      if (!selected.length) return out.join('\n') || 'No finished changes to collect.'
      await assertNoOperation(lead.dir)
      if (a.mode === 'copy') {
        const { s, w } = selected[0]
        const releasePaths = (paths: string[]) => releaseClaimsOnDone(s, c => !paths.some(p => claimsOverlap(c, { path: p, from: 1, to: Number.MAX_SAFE_INTEGER })), w.name, false)
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

        // Named artifacts are only a partial collection; keep the worker recoverable.
        return out.join('\n')
      }
      const heads = new Map<string, string>()
      heads.set(lead.me.name, (await git(lead.dir, ['rev-parse', 'HEAD'])).trim())
      for (const { w } of selected) heads.set(w.name, (await git(w.dir, ['rev-parse', 'HEAD'])).trim())
      const run = promisify(execFile)
      // Latin-1 transports bytes losslessly through the text engine, including binary additions.
      const result = await buildCombinedTree({ ...state, baseFor: (_s, person) => heads.get(person)!, shareOf: () => 'full' }, lead,
        selected.map(({ s, w }) => ({ session: s, person: w.name })), {
          diskOnly: true, encoding: 'latin1',
          baseText: async (dir, base, p) => {
            try { return (await run('git', ['show', base + ':' + p], { cwd: dir, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })).stdout.toString('latin1') }
            catch (e) { if (/does not exist|exists on disk, but not in|path .* not in/i.test(String((e as { stderr?: unknown }).stderr))) return undefined; throw e }
          },
        })
      const unsupported = result.ignoredNotes.filter(note => !note.includes('gitignored') && !note.includes('linked input'))
      if (unsupported.length) return [...out, 'Nothing written; files need manual collection: ' + unsupported.join('; ') + '. All selected workers kept.'].join('\n')
      const tags = (names: string[]) => names.map(name => selected.find(x => x.w.name === name)?.w.tag ?? 'your edits').join(', ')
      if (result.conflictingPaths.size) return [...out, 'Nothing written; conflicting files: ' + [...result.conflictingPaths].map(([p, names]) => p + ' (' + tags(names) + ')').join('; '), 'Collect one at a time, or resolve by hand using room_read.'].join('\n')
      const changes: { p: string; file: string; before: Buffer | null; after: Buffer | null; mode: number; oldMode: number }[] = []
      const baseModes = new Map(split(await git(lead.dir, ['ls-tree', '-rz', result.ancestor])).map(entry => { const [meta, p] = entry.split('\t'); return [p, parseInt(meta.split(' ')[0], 8) & 0o777] }))
      for (const [p, text] of result.merged) {
        const file = safePath(lead.dir, p)
        const before = fs.existsSync(file) ? fs.readFileSync(file) : null
        if ((before === null ? null : before.toString('latin1')) !== result.initial.get(p)) throw new Error(p + ' changed during collection; nothing written, retry')
        const oldMode = before !== null ? fs.statSync(file).mode & 0o777 : 0o644
        let mode = oldMode
        const baseMode = baseModes.get(p)
        for (const { w } of selected) {
          if (workerOwnedPaths(w).includes(p)) continue
          const src = safePath(w.dir, p)
          if (!fs.existsSync(src)) continue
          const workerMode = fs.statSync(src).mode & 0o777
          if (workerMode !== baseMode) {
            if (mode !== oldMode && mode !== workerMode) throw new Error('conflicting file modes: ' + p)
            if (baseMode !== undefined && oldMode !== baseMode && oldMode !== workerMode) throw new Error('conflicting file modes: ' + p)
            mode = workerMode
          }
        }
        const after = text === null ? null : Buffer.from(text, 'latin1')
        if ((before?.equals(after ?? Buffer.alloc(0)) && after !== null && mode === oldMode) || (before === null && after === null)) continue
        changes.push({ p, file, before, after, mode, oldMode })
      }
      // Preflight every destination before writes. Restore originals on any write failure.
      const written: typeof changes = []
      try {
        for (const change of changes) {
          written.push(change)
          if (change.after === null) fs.rmSync(change.file, { force: true })
          else { fs.mkdirSync(path.dirname(change.file), { recursive: true }); fs.writeFileSync(change.file, change.after); fs.chmodSync(change.file, change.mode) }
        }
      } catch (e) {
        for (const change of written.reverse()) {
          if (change.before === null) fs.rmSync(change.file, { force: true })
          else { fs.writeFileSync(change.file, change.before); fs.chmodSync(change.file, change.oldMode) }
        }
        throw e
      }
      out.push('Changes from ' + selected.map(x => x.w.tag).join(', ') + ': ' + (changes.map(x => x.p).join(', ') || 'already present') + '. Nothing committed or staged.')
      for (const { s, w } of selected) {
        releaseClaimsOnDone(s, () => false, w.name, false)
        if (state.workerAlive(s, w) || w.exitCode !== 0) { out.push('kept ' + w.tag + ': clean exit not confirmed'); continue }
        try {
          if (await cleanupWorker(s.dir, w, true)) {
            const retiredAt = Date.now()
            const files = result.paths.filter(p => result.owners.get(p)?.includes(w.name))
            // Retire only collected workers; a global sweep could alter skipped workers.
            s.room.retireParticipant(w.name, {
              name: w.name, tag: w.tag, lead: w.lead, host: w.host, ...(w.model ? { model: w.model } : {}),
              task: w.task, summary: w.summary ?? '', files, fileCount: files.length,
              startedAt: w.startedAt, finishedAt: w.finishedAt ?? retiredAt, retiredAt, outcome: 'dismissed',
            })
            out.push('cleaned up ' + w.tag + ': temporary files, branch and logs')
          } else out.push('kept ' + w.tag + ': cleanup incomplete')
        } catch (e) { out.push('cleanup incomplete for ' + w.tag + ': ' + (e instanceof Error ? e.message : String(e))) }
      }
      return out.join('\n')
    } catch (e) { return [...out, 'error: ' + (e instanceof Error ? e.message : String(e))].join('\n') }
    finally { rooms.unreserve(lock) }
  } }
}
