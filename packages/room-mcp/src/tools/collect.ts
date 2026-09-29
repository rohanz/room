import fs from 'node:fs'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { claimsOverlap, type RetiredWorker } from '@room/shared'
import { git, gitWholeTree } from '@room/roomd/git'
import { carriedUnchangedPaths, workerBaseline } from '@room/roomd/baseline'
import { MATERIALIZED_PATH, containedRepoPath, realGitCommonDir, validRepoPath } from '@room/roomd'
import { cleanupWorker, cleanupWorkerLogs, ignoredWorkerArtifacts, pruneMissingWorkerWorktree, saveDiscardPatch, workerOwnedPaths, type WorkerCleanupPreservation } from '../worker-git.js'
import { signalWorker, pidPresent, terminateWorktreeProcesses, stopWorkerWithEscalation, type CwdProcessLister, type ProcessProbe } from '../worker-process.js'
import { decideCollect, decideDiscard, decideStop, workerRealState } from '../worker-state.js'
import { buildCombinedTree } from './combined-tree.js'
import { addCarriedUntrackedModes, gitTreeModes, materializeMergedFile, mergedFileMode } from './files.js'
import { releaseClaimsOnDone } from './claims.js'
import { RW, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'
import type { Session } from '../session.js'
import { retireWorker } from '../retire.js'
import { localWorkers, registryForDir, registrySnapshotForDir } from '../worker-registry.js'
import { realStateInput, type LocalWorker } from '../worker-status.js'

export const defs: ToolDef[] = [{
  name: 'room_collect', annotations: { ...RW, destructiveHint: true },
  description: 'Collect workers as unstaged edits. Tag a stopped worker for partial edits; collect-all skips it. Conflicts write nothing. Skips live/failed workers. copy takes named files; discard dismisses one and can recover nested workers. Keeps worktrees with uncopied ignored artifacts.',
  inputSchema: { ...{ additionalProperties: false }, type: 'object', properties: {
    tag: str('worker tag'), mode: { type: 'string', enum: ['apply', 'copy'] },
    discard: { type: 'boolean' },
    paths: strs('copy mode: repo-relative files or directories'),
    force: { type: 'boolean', description: 'overwrite modified copy destinations; discard ignored artifacts too' },
  } },
}]

const split = (value: string) => value.split('\0').filter(Boolean)
const COLLECT_TEXT_LIMIT = 512 * 1024
const COLLECT_YIELD_EVERY = 32
const COPY_INSTALL_LIMIT = 4_096

type FileIdentity = { size: number; mtimeMs: number; ino: number; dev: number; mode: number } | null

function fileIdentity(file: string): FileIdentity {
  let stat: fs.Stats
  try { stat = fs.lstatSync(file) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  if (!stat.isFile()) throw new Error('collection destination is not a regular file: ' + file)
  return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev, mode: stat.mode & 0o777 }
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a === null || b === null ? a === b
    : a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev && a.mode === b.mode
}

/** The descriptor is checked both before and after the bounded read. */
function boundedCollectText(file: string, expected: FileIdentity): Buffer | null {
  if (expected === null) return null
  if (expected.size > COLLECT_TEXT_LIMIT) throw new Error(file + ' exceeds collection text limit; nothing written')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!sameIdentity(expected, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev, mode: stat.mode & 0o777 })) throw new Error(file + ' changed during collection; nothing written, retry')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error(file + ' changed during collection; nothing written, retry')
      offset += count
    }
    if (!sameIdentity(expected, fileIdentity(file))) throw new Error(file + ' changed during collection; nothing written, retry')
    return bytes
  } finally { fs.closeSync(fd) }
}

/** Compare without loading either whole file into JS memory. */
async function sameFileBytes(a: string, b: string, size: number): Promise<boolean> {
  const left = await fs.promises.open(a, 'r')
  let right: fs.promises.FileHandle | undefined
  try {
    right = await fs.promises.open(b, 'r')
    const one = Buffer.alloc(Math.min(64 * 1024, size)), two = Buffer.alloc(one.length)
    for (let offset = 0; offset < size; offset += one.length) {
      await setImmediate()
      const length = Math.min(one.length, size - offset)
      const [x, y] = await Promise.all([left.read(one, 0, length, offset), right.read(two, 0, length, offset)])
      if (x.bytesRead !== length || y.bytesRead !== length || !one.subarray(0, length).equals(two.subarray(0, length))) return false
    }
    return true
  } finally { await Promise.all([left.close(), right?.close()]) }
}

/** Only signal processes after confirming this is still the worker's owned git worktree. */
const ownershipRecords = (s: Session) => [...s.room.retiredWorkers(), ...localWorkers(s.dir)]

async function stopOwnedWorktreeProcesses(leadDir: string, w: LocalWorker, leadName: string, workers: Iterable<LocalWorker | RetiredWorker>, errors?: string[], probe?: ProcessProbe, list?: CwdProcessLister): Promise<string[]> {
  if (!decideStop(await workerRealState(leadDir, w, { ownership: true, leadName, workers })).cwd) return []
  if (w.id) {
    const registry = await registryForDir(leadDir)
    const record = registry.read(w.id)
    if (!record || record.sharedWith || registry.worktreeOwner(record) || registry.checkoutUsers(record).length) return []
  }
  try { return await terminateWorktreeProcesses(w.dir, { protectedPids: w.pid ? [w.pid] : [], probe, list }) }
  catch (e) {
    errors?.push(`cwd process cleanup failed: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

const failureReason = (w: LocalWorker): string => w.exitCode !== undefined && w.exitCode !== 0
  ? `exit code ${w.exitCode}${w.summary ? `; ${w.summary.replace(/\s+/g, ' ').slice(0, 180)}` : ''}`
  : w.stopReason ?? w.summary?.replace(/\s+/g, ' ').slice(0, 180) ?? 'worker reported failure'

/** Reject symlinks at every component, including dangling destination links. */
function safePath(root: string, rel: string): string {
  if (!validRepoPath(rel, MATERIALIZED_PATH)) throw new Error('unsafe collection path: ' + rel)
  const result = containedRepoPath(root, path.join(root, rel), { leaf: 'reject-link', allowMissing: true })
  if (!result.ok) throw new Error(result.reason === 'link' ? 'symlink collection path refused: ' + rel : 'unsafe collection path: ' + rel)
  return result.path
}

async function copyFiles(root: string, paths: string[]): Promise<string[]> {
  const files = new Set<string>()
  let count = 0
  const visit = async (rel: string): Promise<void> => {
    if (count++ % COLLECT_YIELD_EVERY === 0) await setImmediate()
    const file = safePath(root, rel), stat = fs.statSync(file)
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) await visit(rel + '/' + name)
    else if (stat.isFile()) files.add(rel)
    else throw new Error('not a regular file: ' + rel)
  }
  for (const rel of paths) await visit(rel)
  return [...files].sort()
}

async function assertNoOperation(dir: string): Promise<void> {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const file = (await git(dir, ['rev-parse', '--git-path', name])).trim()
    if (fs.existsSync(path.resolve(dir, file))) throw new Error('finish the existing Git operation in ' + dir + ' before collecting')
  }
}

export function handlers(state: HandlerState): Record<string, Handler> {
  const cleanRetiredSharedOwner = async (s: Session, borrower: LocalWorker): Promise<string | undefined> => {
    const registry = await registryForDir(s.dir)
    const current = registry.read(borrower.id)
    const owner = current && registry.worktreeOwner(current)
    if (!owner || owner.phase !== 'retired' || !owner.keptWorktree
      || !owner.archive?.keptReason?.startsWith('shared checkout: ')) return
    try { await registry.beginOperation(owner.id, 'collect') } catch { return }
    try {
      const fresh = registry.read(owner.id)
      if (!fresh || fresh.phase !== 'retired' || !fresh.keptWorktree || registry.checkoutUsers(fresh).length) return
      const status = registry.status(fresh.id)
      if (!status) return
      const w = { ...realStateInput(fresh, status), status: 'done' as const, exitCode: 0 }
      const preservation: WorkerCleanupPreservation = { ignored: [], uncollected: [] }
      if (!await cleanupWorker(s.dir, w, true, false, [], { probe: state.ctx?.probe, list: state.ctx?.listCwdProcesses }, s.me.name, ownershipRecords(s), preservation)) {
        const details = [
          ...(preservation.ignored.length ? [`ignored files not copied: ${preservation.ignored.join(', ')}`] : []),
          ...(preservation.uncollected.length ? [`uncollected work: ${preservation.uncollected.join(', ')}`] : []),
        ]
        if (!details.length) return `kept ${fresh.tag}'s worktree: cleanup incomplete`
        const reason = `shared checkout: no borrowers; ${details.join('; ')}`
        await registry.update(fresh.id, old => ({ ...old, archive: { ...old.archive!, keptWorktree: w.dir, keptReason: reason }, keptWorktree: w.dir, seq: old.seq + 1 }))
        for (const room of state.rooms.all()) {
          const list = room.room.doc.getArray<RetiredWorker>('retiredWorkers')
          const index = list.toArray().findIndex(entry => entry.id === fresh.id)
          if (index >= 0) room.room.doc.transact(() => { const entry = list.get(index); list.delete(index); list.insert(index, [{ ...entry, keptWorktree: w.dir, keptReason: reason }]) })
        }
        return `kept ${fresh.tag}'s worktree at ${w.dir}: ${details.join('; ')}. Copy what you need from there, then room_collect(tag="${fresh.tag}", discard=true) (add force=true to delete ignored files too)`
      }
      await registry.update(fresh.id, old => {
        const { keptWorktree: _kept, keptReason: _reason, ...archive } = old.archive ?? {}
        return { ...old, keptWorktree: undefined, archive: archive as RetiredWorker, seq: old.seq + 1 }
      })
      for (const room of state.rooms.all()) {
        const list = room.room.doc.getArray<RetiredWorker>('retiredWorkers')
        const index = list.toArray().findIndex(entry => entry.id === fresh.id)
        if (index >= 0) room.room.doc.transact(() => {
          const { keptWorktree: _kept, keptReason: _reason, ...entry } = list.get(index)
          list.delete(index)
          list.insert(index, [entry])
        })
      }
    } finally { await registry.finishOperation(owner.id) }
  }
  const missingCapability = (s: Session, w: LocalWorker): string => {
    const registry = registrySnapshotForDir(s.dir)
    const record = registry.reserved(w.tag)
    if (record && record.lead.participant !== s.me.name) {
      const parent = registry.reservedByTagOrName(record.lead.participant)
      return `${w.tag} belongs to ${record.lead.participant}; collect it through that lead (resume it if needed), or room_collect tag=${parent?.tag ?? 'PARENT'} discard=true force=true to save recovery patches`
    }
    return `${w.tag}: no local worker capability (worktree missing or unmanaged)`
  }
  const holdingWorker = (tag: string, from: Session): Session => {
    const record = registrySnapshotForDir(from.dir).reserved(tag)
    return state.rooms.all().find(room => record?.room === room.roomName) ?? from
  }
  const unverifiedLive = async (s: Session, w: LocalWorker): Promise<string | undefined> => {
    if (!pidPresent(w.pid, state.ctx?.probe)) return undefined
    const facts = await workerRealState(s.dir, w, { process: true, hasHandle: !!state.rooms.handle?.(s, w.id), probe: state.ctx?.probe })
    return facts.process === 'ours' ? undefined : `could not verify ${w.tag}'s process (pid ${w.pid}); left running, not stopped`
  }
  const ownership = (s: Session, w: Pick<LocalWorker, 'lead'>, discarding: Set<string>): { owned: boolean; liveLead?: string } => {
    const live = localWorkers(s.dir)
    const known = [...live, ...s.room.retiredWorkers()]
    const visited = new Set<string>()
    let lead = w.lead
    let liveLead: string | undefined
    while (lead && !visited.has(lead)) {
      if (lead === s.me.name) return { owned: true, liveLead }
      visited.add(lead)
      const active = live.find(parent => parent.name === lead)
      if (active && !discarding.has(lead) && !liveLead && (state.workerAlive(s, active) || pidPresent(active.pid, state.ctx?.probe))) liveLead = lead
      lead = known.find(parent => parent.name === lead)?.lead ?? ''
    }
    return { owned: false }
  }
  const descendants = (s: Session, w: LocalWorker): LocalWorker[] => {
    const out: LocalWorker[] = []
    const visit = (parent: LocalWorker) => {
      for (const child of localWorkers(s.dir)) if (child.lead === parent.name) { visit(child); out.push(child) }
    }
    visit(w)
    return out
  }
  const takeWorkerOperation = async (s: Session, w: LocalWorker, op: 'collect' | 'discard'): Promise<string> => {
    if (!w.id) return 'untrusted'
    const registry = await registryForDir(s.dir)
    const trusted = await registry.trusted({ participant: s.me.name, room: s.roomName, dir: s.dir }, w.tag, op === 'discard')
    if (!trusted || trusted.record.id !== w.id) return 'untrusted'
    try { await registry.beginOperation(w.id, op); return w.id }
    catch { return 'busy' }
  }
  const roomCollect = async (a: Record<string, unknown>, discarding = new Set<string>(), actingLead?: Session): Promise<string> => {
    const { rooms } = state, lead = actingLead ?? state.S()
    const registry = await registryForDir(lead.dir)
    const unknown = Object.keys(a).find(key => !['tag', 'mode', 'discard', 'paths', 'force'].includes(key))
    if (unknown) return 'error: unknown argument ' + unknown
    if (a.tag !== undefined && (typeof a.tag !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(a.tag))) return 'error: valid worker tag required'
    if (a.mode !== undefined && a.mode !== 'apply' && a.mode !== 'copy') return 'error: mode must be apply or copy'
    for (const key of ['discard', 'force']) if (a[key] !== undefined && typeof a[key] !== 'boolean') return 'error: ' + key + ' must be a boolean'
    if ((a.discard || a.mode === 'copy') && !a.tag) return 'error: tag required for copy or discard'
    if (a.paths !== undefined && a.mode !== 'copy') return 'error: paths is only supported in copy mode'
    if (a.discard) {
      const kept = rooms.all().flatMap(s => s.room.retiredWorkers()
        .filter(r => r.tag === a.tag && r.keptWorktree)
        .map(r => ({ s, r }))).find(({ s, r }) => ownership(s, r, discarding).owned)
      if (kept && !localWorkers(kept.s.dir).some(live => live.tag === a.tag)) {
        const { s, r } = kept
        const active = registry.list().find(record => record.tag === r.tag && record.keptWorktree === r.keptWorktree)
        const activeStatus = active && registry.status(active.id)
        if (!active || !activeStatus) return 'error: kept worker has no local registry record'
        const borrowedOwner = registry.worktreeOwner(active)
        const borrowed = !!active.sharedWith || !!borrowedOwner
        const w: LocalWorker = { ...realStateInput(active, activeStatus), dir: r.keptWorktree!, branch: 'room/' + r.tag, status: 'done', exitCode: 0, pid: 0 }
        try { await registry.beginOperation(active.id, 'discard') }
        catch { return 'error: this worker is already being handled or retired' }
        try {
          const shared = !borrowed && fs.existsSync(r.keptWorktree!) && registry.checkoutUsers(active)[0]
          if (shared) return `error: discard refused; ${shared.record.tag} still uses ${r.tag}'s worktree: ${r.keptWorktree}`
          const missing = !borrowed && decideDiscard(await workerRealState(s.dir, w)) === 'prune'
          const ignored = missing || borrowed ? [] : await ignoredWorkerArtifacts(w)
          if (ignored.length && a.force !== true) return `error: discard refused; ignored artifacts not covered by a recovery patch: ${ignored.join(', ')}\nretained worktree: ${w.dir}\nrepeat with force=true to delete them`
          await registry.beginDiscard(active.id, a.force === true, [])
          await registry.markDiscardStep(active.id, 'children')
          await registry.beginStop(active.id, 'discarded')
          const cleanupErrors: string[] = []
          const terminated = borrowed ? [] : await stopOwnedWorktreeProcesses(s.dir, w, s.me.name, ownershipRecords(s), cleanupErrors, state.ctx?.probe, state.ctx?.listCwdProcesses)
          // A kept worktree that is no longer an owned Room worktree is refused, not forgotten: cleanupWorker decides.
          const missingDetail = missing ? await pruneMissingWorkerWorktree(s.dir, w) : undefined
          if (missing || borrowed) cleanupWorkerLogs(s.dir, w)
          await registry.markDiscardStep(active.id, 'stop')
          const patch = missing || borrowed ? undefined : await saveDiscardPatch(s.dir, w, bytes => registry.recordDiscardPatch(active.id, bytes))
          await registry.markDiscardStep(active.id, 'patch')
          if (!missing && !borrowed && !await cleanupWorker(s.dir, w, true, true, terminated, { probe: state.ctx?.probe, list: state.ctx?.listCwdProcesses }, s.me.name, ownershipRecords(s))) throw new Error('worker is not an owned Room worktree')
          await registry.markDiscardStep(active.id, 'cleanup')
          const archive = s.room.doc.getArray<RetiredWorker>('retiredWorkers')
          const index = archive.toArray().findIndex(item => item.id === active.id)
          if (index >= 0) s.room.doc.transact(() => {
            archive.delete(index)
            const { keptWorktree: _keptWorktree, ...cleared } = r
            archive.insert(index, [{ ...cleared, summary: 'discarded', disposition: 'discarded' }])
          })
          await registry.markDiscardStep(active.id, 'prune')
          await retireWorker(rooms, s, active.id, { ...r, summary: 'discarded', disposition: 'discarded', keptWorktree: undefined }, { keptWorktree: undefined })
          return (borrowed ? `detached ${r.tag}; the worktree belongs to ${borrowedOwner?.tag ?? active.sharedWith}` : 'discarded ' + r.tag) + (missingDetail ? '; its worktree was already gone; ' + missingDetail : '') + (patch ? '; recovery patch: ' + patch + ' (kept for a week)' : '') + (terminated.length ? '; stopped processes: ' + terminated.join(', ') : '') + (ignored.length ? '; deleted without a copy: ' + ignored.join(', ') : '') + (cleanupErrors.length ? '; ' + cleanupErrors.join('; ') : '')
        } catch (e) { await registry.interruptDiscard(active.id, e instanceof Error ? e.message : String(e)).catch(() => {}); return 'error: ' + (e instanceof Error ? e.message : String(e)) + '; retained ' + w.dir }
        finally { await registry.finishOperation(active.id) }
      }
      const s = actingLead ?? holdingWorker(a.tag as string, lead)
      const w = localWorkers(s.dir, record => record.tag === a.tag)[0]
      if (!w) return 'error: no worker ' + a.tag + ' owned by you'
      const owner = ownership(s, w, discarding)
      if (!owner.owned) return 'error: no worker ' + a.tag + ' owned by you'
      if (owner.liveLead) return `error: ${w.tag} belongs to ${owner.liveLead}, which is still running; ask it with room_send, or discard ${owner.liveLead}'s worker first`
      const workerRecord = registry.read(w.id)
      const borrowedOwner = workerRecord && registry.worktreeOwner(workerRecord)
      const borrowed = !!w.sharedWith || !!borrowedOwner
      const lock = await takeWorkerOperation(s, w, 'discard')
      if (lock === 'untrusted') return `error: ${missingCapability(s, w)}`
      if (lock === 'busy') return 'error: this worker is already being handled or retired'
      try {
      const sharedResults: string[] = []
      if (!borrowed) {
        const users = registry.checkoutUsers(registry.read(w.id)!)
        const running = users.find(({ status }) => !['done', 'failed', 'stopped'].includes(status.status))
        if (running && fs.existsSync(w.dir)) return `error: discard refused; ${running.record.tag} is still running in ${w.tag}'s worktree: ${w.dir}`
        for (const { record: user } of users) {
          const result = await roomCollect({ tag: user.tag, discard: true }, discarding, s)
          if (!result.startsWith('detached ')) return `error: could not detach ${user.tag} before discarding ${w.tag}: ${result}`
          sharedResults.push(result)
        }
      }
        const unsafe = await unverifiedLive(s, w)
        if (unsafe) return unsafe
        const children = descendants(s, w)
        if (children.length && a.force !== true) return `error: ${w.tag} has nested workers: ${children.map(c => c.tag).join(', ')}; collect or discard them first, or repeat with force=true to save recovery patches and discard them`
        const beforePlan = await workerRealState(s.dir, w, { ownership: true, leadName: s.me.name, workers: ownershipRecords(s) })
        const ignoredBefore = !borrowed && decideDiscard(beforePlan) === 'cleanup' ? await ignoredWorkerArtifacts(w) : []
        if (ignoredBefore.length && a.force !== true) return `error: discard refused; ignored artifacts not covered by a recovery patch: ${ignoredBefore.join(', ')}\nretained worktree: ${w.dir}\nrepeat with force=true to delete them`
        await registry.beginDiscard(lock, a.force === true, children.map(child => child.id!).filter(Boolean))
        const childResults: string[] = []
        for (const child of children) {
          if (!localWorkers(s.dir).some(live => live.id === child.id)) continue
          const childLead = { ...s, dir: w.dir, me: { ...s.me, name: w.name } } as Session
          const result = await roomCollect({ tag: child.tag, discard: true, force: true }, new Set([...discarding, w.name]), childLead)
          childResults.push(result)
          if (!result.startsWith('discarded ') && !result.startsWith('stopped ')) {
            await registry.interruptDiscard(lock, `could not dispose of nested worker ${child.tag}: ${result}`)
            return `error: could not dispose of nested worker ${child.tag}: ${result}; retained ${w.dir}`
          }
        }
        await registry.markDiscardStep(lock, 'children')
        // A headless host can take its child server down as it exits. Record and stop
        // worktree processes while they are still observable, before dismissing it.
        const cleanupErrors: string[] = []
        const beforeStop = await workerRealState(s.dir, w, { process: true, hasHandle: !!rooms.handle?.(s, w.id), probe: state.ctx?.probe })
        const verifiedProcess = decideStop(beforeStop).host === 'signal'
        const terminated = borrowed ? [] : await stopOwnedWorktreeProcesses(s.dir, w, s.me.name, ownershipRecords(s), cleanupErrors, state.ctx?.probe, state.ctx?.listCwdProcesses)
        if (state.workerAlive(s, w) || pidPresent(w.pid, state.ctx?.probe)) {
          const how = await state.dismissWorker(s, w, 'discarded by the lead')
          if (localWorkers(s.dir, record => record.id === w.id)[0]?.status === 'running' && (state.workerAlive(s, w) || pidPresent(w.pid, state.ctx?.probe))) {
            await registry.interruptDiscard(lock, `could not discard ${w.tag}: ${how}`)
            return 'could not discard ' + w.tag + ': ' + how + (cleanupErrors.length ? '; ' + cleanupErrors.join('; ') : '')
          }
          if (how.includes('cwd process cleanup failed:')) cleanupErrors.push(how)
          const stopped = await stopWorkerWithEscalation({
            terminate: () => true, exited: () => !state.workerAlive(s, w),
            force: async () => decideStop(await workerRealState(s.dir, w, { process: true, hasHandle: !!rooms.handle?.(s, w.id), probe: state.ctx?.probe })).host === 'signal'
              && signalWorker(w.pid, 'SIGKILL', undefined, undefined, w, state.ctx?.probe),
            now: state.now, sleep: state.ctx?.sleep,
          })
          if (!stopped) throw new Error('worker process has not stopped')
        }
        await registry.markDiscardStep(lock, 'stop')
        const unsafeAfterDismissal = await unverifiedLive(s, w)
        if (unsafeAfterDismissal) {
          await registry.interruptDiscard(lock, unsafeAfterDismissal)
          return unsafeAfterDismissal
        }
        if (!borrowed) terminated.push(...await stopOwnedWorktreeProcesses(s.dir, w, s.me.name, ownershipRecords(s), cleanupErrors, state.ctx?.probe, state.ctx?.listCwdProcesses))
        const afterStop = await workerRealState(s.dir, w, { ownership: true, leadName: s.me.name, workers: ownershipRecords(s) })
        const missing = !borrowed && decideDiscard(afterStop) === 'prune'
        let missingDetail: string | undefined
        if (missing) {
          try { missingDetail = await pruneMissingWorkerWorktree(s.dir, w) }
          catch (error) {
            // A persisted worker may outlive a lead that rejoins from another checkout.
            // Its verified process can still be dismissed, but the new checkout must not
            // prune a branch for a worktree path that is outside its own repository.
            const recordedPath = path.basename(w.dir) === w.tag
              && path.basename(path.dirname(w.dir)) === 'workers'
              && path.basename(path.dirname(path.dirname(w.dir))) === '.room'
              && w.branch === `room/${w.tag}`
            if (!verifiedProcess || !recordedPath || !(error instanceof Error) || !error.message.includes('is not an owned Room worktree')) throw error
          }
          cleanupWorkerLogs(s.dir, w)
        }
        const ownedWorktree = !borrowed && decideDiscard(afterStop) === 'cleanup'
        const ignored = ownedWorktree ? await ignoredWorkerArtifacts(w) : []
        if (ignored.length && a.force !== true) {
          await registry.interruptDiscard(lock, `ignored artifacts appeared: ${ignored.join(', ')}`)
          return [
            `error: discard refused; ignored artifacts not covered by a recovery patch: ${ignored.join(', ')}`,
            ...ignored.map(p => `kept ${p} at ${path.join(w.dir, p)}`),
            `retained worktree: ${w.dir}`,
            ...(terminated.length ? ['stopped processes: ' + terminated.join(', ')] : []),
            ...cleanupErrors,
            'copy what you need (mode="copy", paths=[...]), then repeat with force=true to delete the rest',
          ].join('\n')
        }
        const patch = ownedWorktree ? await saveDiscardPatch(s.dir, w, bytes => registry.recordDiscardPatch(lock, bytes)) : undefined
        await registry.markDiscardStep(lock, 'patch')
        if (ownedWorktree && !await cleanupWorker(s.dir, w, true, true, terminated, { probe: state.ctx?.probe, list: state.ctx?.listCwdProcesses }, s.me.name, ownershipRecords(s))) throw new Error('worker is not an owned Room worktree')
        if (borrowed) cleanupWorkerLogs(s.dir, w)
        await registry.markDiscardStep(lock, 'cleanup')
        releaseClaimsOnDone(s, () => false, w.name, false)
        await registry.markDiscardStep(lock, 'prune')
        const retiredAt = Date.now()
        await retireWorker(rooms, s, lock, {
          name: w.name, tag: w.tag, lead: w.lead, host: w.host, ...(w.model ? { model: w.model } : {}), task: w.task,
          summary: borrowed ? 'detached' : 'discarded', files: [], fileCount: 0, startedAt: w.startedAt,
          finishedAt: w.finishedAt ?? retiredAt, retiredAt, outcome: 'dismissed', disposition: 'discarded',
        })
        return [...sharedResults, ...childResults, (borrowed
          ? `detached ${w.tag}; the worktree belongs to ${borrowedOwner?.tag ?? w.sharedWith}`
          : decideDiscard(afterStop) === 'retain-directory' ? `stopped ${w.tag}; kept ${w.dir} (an existing directory, not a Room worktree)` : 'discarded ' + w.tag) + (missingDetail ? '; its worktree was already gone; ' + missingDetail : '') + (patch ? '; recovery patch: ' + patch + ' (kept for a week)' : '') + (terminated.length ? '; stopped processes: ' + terminated.join(', ') : '') + (ignored.length ? '; deleted without a copy: ' + ignored.join(', ') : '') + (cleanupErrors.length ? '; ' + cleanupErrors.join('; ') : '')].join('\n')
      } catch (e) {
        await registry.interruptDiscard(lock, e instanceof Error ? e.message : String(e)).catch(() => {})
        return 'error: ' + (e instanceof Error ? e.message : String(e)) + '; retained ' + w.dir
      }
      finally { await registry.finishOperation(lock) }
    }
    const sessions = a.tag ? [holdingWorker(a.tag as string, lead)] : rooms.all()
    const candidates = sessions.flatMap(s => localWorkers(s.dir, record => record.room === s.roomName).filter(w => {
      if (a.tag && w.tag !== a.tag) return false
      const owner = ownership(s, w, discarding)
      return owner.owned && (!owner.liveLead || !!a.tag)
    }).map(w => ({ s, w })))
      .sort((a, b) => (a.w.finishedAt ?? 0) - (b.w.finishedAt ?? 0) || (a.w.tag < b.w.tag ? -1 : a.w.tag > b.w.tag ? 1 : 0))
    if (a.tag && !candidates.length) return 'error: no worker ' + a.tag + ' owned by you'
    if (a.tag) {
      const { s, w } = candidates[0]
      const owner = ownership(s, w, discarding)
      if (owner.liveLead) return `error: ${w.tag} belongs to ${owner.liveLead}, which is still running; ask it with room_send, or discard ${owner.liveLead}'s worker first`
    }
    const out: string[] = []
    const selected: typeof candidates = []
    const leadRoot = fs.realpathSync(lead.dir)
    const workerRoots = new Map<LocalWorker, string>()
    const workerLocks: string[] = []
    const collectStarted = new Set<string>()
    try {
      for (const item of candidates) {
        const { s } = item; let { w } = item
        const unsafe = await unverifiedLive(s, w)
        if (unsafe) { out.push(unsafe); continue }
        const stopped = w.pid > 0 && !state.workerAlive(s, w) && !pidPresent(w.pid, state.ctx?.probe)
        const decision = decideCollect(await workerRealState(lead.dir, w), !!a.tag, stopped)
        if (decision === 'skip-status') { out.push('skipped ' + w.tag + ': ' + w.status + (w.status === 'failed' ? ` (${failureReason(w)})` : '')); continue }
        if (decision === 'skip-partial') {
          const why = w.stopReason === 'lead-session-ended' ? "the lead's session ended" : 'its process exited'
          out.push(`skipped ${w.tag}: stopped before finishing (${why}); room_collect tag=${w.tag} to take its partial edits, mode=copy for named files, or discard=true`)
          continue
        }
        const workerLock = await takeWorkerOperation(s, w, 'collect')
        if (workerLock === 'untrusted') { out.push(`skipped ${missingCapability(s, w)}`); continue }
        if (workerLock === 'busy') { out.push(`skipped ${w.tag}: already being handled`); continue }
        workerLocks.push(workerLock)
        try {
        const unsafeAfterLock = await unverifiedLive(s, w)
        if (unsafeAfterLock) { out.push(unsafeAfterLock); continue }
        // Reserving can wait for retirement; judge the checkout again once this worktree is locked.
        if (decideCollect(await workerRealState(lead.dir, w), !!a.tag, stopped) === 'missing') {
          await pruneMissingWorkerWorktree(lead.dir, w, false)
          out.push(`${a.tag ? 'nothing to collect' : 'skipped ' + w.tag}: worktree ${w.dir} is gone`)
          continue
        }
        const workerRoot = fs.realpathSync(w.dir)
        if (workerRoot === leadRoot) throw new Error('worker must have a separate worktree')
        await assertNoOperation(w.dir)
        if (await realGitCommonDir(lead.dir) !== await realGitCommonDir(w.dir)) throw new Error('worker is not a worktree of this repository')
        const worktreeRecord = registry.read(w.id)
        const ownerRecord = worktreeRecord && registry.worktreeOwner(worktreeRecord)
        const expectedBranch = ownerRecord?.branch ?? w.branch
        if ((!ownerRecord && w.branch !== 'room/' + w.tag) || (await git(w.dir, ['branch', '--show-current'])).trim() !== expectedBranch) throw new Error('worker must be on its recorded Room branch')
        await gitWholeTree(w.dir, ['ls-files', '-z'])
        const cleanupErrors: string[] = []
        const terminated = await stopOwnedWorktreeProcesses(lead.dir, w, s.me.name, ownershipRecords(s), cleanupErrors, state.ctx?.probe, state.ctx?.listCwdProcesses)
        if (terminated.length) out.push('stopped processes from ' + w.tag + ': ' + terminated.join(', '))
        out.push(...cleanupErrors.map(error => `${w.tag}: ${error}`))
        const now = state.now ?? Date.now
        const sleep = state.ctx?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
        const deadline = now() + 15_000
        while (state.workerAlive(s, w) && now() < deadline) await sleep(Math.min(250, deadline - now()))
        if (state.workerAlive(s, w)) { out.push(`skipped ${w.tag}: process still exiting after 15 s; call room_collect tag=${w.tag} again in a few seconds`); continue }
        const unsafeAfterWait = await unverifiedLive(s, w)
        if (unsafeAfterWait) { out.push(unsafeAfterWait); continue }
        const current = localWorkers(s.dir, record => record.id === w.id)[0]
        if (!current || current.id !== w.id || current.startedAt !== w.startedAt || (current.status !== 'done' && !(stopped && (current.status === 'running' || current.status === 'dismissed')))) {
          out.push('skipped ' + w.tag + ': changed while waiting'); continue
        }
        w = current.status === 'done' ? current : { ...current, status: 'done', exitCode: current.exitCode ?? 0 }
        if (w.exitCode !== undefined && w.exitCode !== 0) { out.push('skipped ' + w.tag + ': failed exit (' + failureReason(w) + ')'); continue }
        selected.push({ s, w })
        workerRoots.set(w, workerRoot)
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e)
          if (a.tag) throw e
          out.push(`skipped ${w.tag}: ${(await workerRealState(lead.dir, w)).worktree === 'vanished' ? 'worktree missing; ' : ''}${reason}`)
        }
      }
      if (!selected.length) return out.join('\n') || 'No finished changes to collect.'
      await assertNoOperation(lead.dir)
      if (a.mode === 'copy') {
        const { s, w } = selected[0]
        const releasePaths = (paths: string[]) => releaseClaimsOnDone(s, c => !paths.some(p => claimsOverlap(c, { path: p, from: 1, to: Number.MAX_SAFE_INTEGER })), w.name, false)
        if (!Array.isArray(a.paths) || !a.paths.length || a.paths.some(p => typeof p !== 'string')) return 'error: copy requires non-empty paths'
        const workerRoot = workerRoots.get(w)!
        const files = await copyFiles(workerRoot, a.paths as string[])
        // Installation must have no await between its final gate and last rename.
        if (files.length > COPY_INSTALL_LIMIT) return `error: copy has more than ${COPY_INSTALL_LIMIT} files; split the selection`
        const modified = new Set(split(await gitWholeTree(lead.dir, ['diff', '--name-only', '-z', 'HEAD', '--'])))
        const tracked = new Set(split(await gitWholeTree(lead.dir, ['ls-files', '-z'])))
        const copyPlan: { p: string; source: NonNullable<FileIdentity>; destination: FileIdentity }[] = []
        for (const [index, p] of files.entries()) {
          if (index % COLLECT_YIELD_EVERY === 0) await setImmediate()
          const src = safePath(workerRoot, p), source = fileIdentity(src)
          if (!source) throw new Error('copy source vanished: ' + p)
          const dst = safePath(leadRoot, p)
          const destination = fileIdentity(dst)
          if (a.force !== true && (modified.has(p) || (!tracked.has(p) && destination !== null))) {
            // Large matching files are a conservative conflict. Explicit force can
            // still copy them without bringing their bytes into JS for comparison.
            if (destination === null || destination.size !== source.size || source.size > COLLECT_TEXT_LIMIT || !await sameFileBytes(dst, src, source.size)) return 'error: lead has modified ' + p + '; pass force=true to overwrite'
            if (!sameIdentity(source, fileIdentity(src)) || !sameIdentity(destination, fileIdentity(dst))) throw new Error(p + ' changed during collection; nothing written, retry')
          }
          copyPlan.push({ p, source, destination })
        }
        const stagedRoot = fs.mkdtempSync(path.join(leadRoot, '.room', 'collect-copy-'))
        let keepRecovery = false
        try {
          const prepared = [] as (typeof copyPlan[number] & { staged: string; backup: string })[]
          for (const [index, plan] of copyPlan.entries()) {
            if (index % COLLECT_YIELD_EVERY === 0) await setImmediate()
            const staged = path.join(stagedRoot, `${index}.new`)
            await fs.promises.copyFile(safePath(workerRoot, plan.p), staged)
            fs.chmodSync(staged, plan.source.mode)
            prepared.push({ ...plan, staged, backup: path.join(stagedRoot, `${index}.old`) })
          }
          // Recheck every source and destination after all asynchronous preparation.
          for (const { p, source, destination } of prepared) {
            if (!sameIdentity(source, fileIdentity(safePath(workerRoot, p))) || !sameIdentity(destination, fileIdentity(safePath(leadRoot, p)))) throw new Error(p + ' changed during collection; nothing written, retry')
          }
          const installed: { dst: string; staged: string; backup: string; hadOriginal: boolean; copied: boolean }[] = []
          try {
            // Only bounded, synchronous metadata operations occur from the gate through
            // the final rename. Retain old leaves for rollback if a later rename fails.
            for (const { p, destination, staged, backup } of prepared) {
              const dst = safePath(leadRoot, p)
              if (!sameIdentity(destination, fileIdentity(dst))) throw new Error(p + ' changed during collection; nothing written, retry')
              fs.mkdirSync(path.dirname(dst), { recursive: true })
              const checked = safePath(leadRoot, p)
              if (!sameIdentity(destination, fileIdentity(checked))) throw new Error(p + ' changed during collection; nothing written, retry')
              const entry = { dst: checked, staged, backup, hadOriginal: destination !== null, copied: false }
              if (entry.hadOriginal) fs.renameSync(checked, backup)
              installed.push(entry)
              fs.renameSync(staged, checked)
              entry.copied = true
            }
          } catch (error) {
            const rollbackErrors: string[] = []
            for (const entry of installed.reverse()) {
              try {
                if (entry.copied) fs.unlinkSync(entry.dst)
                if (entry.hadOriginal) fs.renameSync(entry.backup, entry.dst)
              } catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)) }
            }
            if (rollbackErrors.length) {
              keepRecovery = true
              throw new Error(`copy failed; rollback incomplete; originals kept in ${stagedRoot}: ${rollbackErrors.join('; ')}`, { cause: error })
            }
            throw error
          }
          for (const { p } of prepared) out.push('copied ' + p)
        } finally {
          if (!keepRecovery) await fs.promises.rm(stagedRoot, { recursive: true, force: true })
        }
        releasePaths(files)
        if (!files.length) out.push('nothing copied (empty directories)')

        // Named artifacts are only a partial collection; keep the worker recoverable.
        return out.join('\n')
      }
      const heads = new Map<string, string>()
      heads.set(lead.me.name, (await git(lead.dir, ['rev-parse', 'HEAD'])).trim())
      for (const { w } of selected) heads.set(w.name, (await git(w.dir, ['rev-parse', 'HEAD'])).trim())
      // Latin-1 transports bytes losslessly through the text engine, including binary additions.
      const result = await buildCombinedTree({ ...state, baseFor: (_s, person) => heads.get(person)!, shareOf: () => 'full' }, lead,
        selected.map(({ s, w }) => ({ session: s, person: w.name })), {
          diskOnly: true, diskWorkers: new Set(selected.map(({ w }) => w.name)), encoding: 'latin1', skipCallerOnly: true,
          roots: new Map([[path.resolve(lead.dir), leadRoot], ...selected.map(({ w }) => [path.resolve(w.dir), workerRoots.get(w)!] as const)]),
        })
      const unsupported = result.ignoredNotes.filter(note => !note.includes('gitignored') && !note.includes('linked input'))
      if (unsupported.length) return [...out, 'Nothing written; files need manual collection: ' + unsupported.join('; ') + '. All selected workers kept.'].join('\n')
      const tags = (names: string[]) => names.map(name => selected.find(x => x.w.name === name)?.w.tag ?? 'your edits').join(', ')
      if (result.conflictingPaths.size) return [...out, 'Nothing written; conflicting files: ' + [...result.conflictingPaths].map(([p, names]) => p + ' (' + tags(names) + ')').join('; '), 'Collect one at a time, or resolve by hand using room_read.'].join('\n')
      const changes: { p: string; file: string; before: Buffer | null; after: Buffer | null; mode: number; oldMode: number }[] = []
      // A worker's mode change is judged against its own base, like its text.
      const baseModes = new Map<string, Map<string, number>>()
      const unchangedCarried = new Map<string, Set<string>>()
      for (const { w } of selected) {
        const base = result.deltaBases.get(w.name)!
        baseModes.set(w.name, addCarriedUntrackedModes(await gitTreeModes(lead.dir, base), w))
        unchangedCarried.set(w.name, carriedUnchangedPaths(workerBaseline(w)))
      }
      const destinations: { p: string; identity: FileIdentity }[] = []
      let preparedCount = 0
      for (const [p, text] of result.merged) {
        if (preparedCount++ % COLLECT_YIELD_EVERY === 0) await setImmediate()
        const file = safePath(leadRoot, p)
        const identity = fileIdentity(file)
        destinations.push({ p, identity })
        const before = boundedCollectText(file, identity)
        if ((before === null ? null : before.toString('latin1')) !== result.initial.get(p)) throw new Error(p + ' changed during collection; nothing written, retry')
        const oldMode = identity?.mode ?? 0o644
        const mode = mergedFileMode(p, oldMode, selected.map(({ w }) => ({ dir: workerRoots.get(w)!, baseModes: baseModes.get(w.name)!, ownedPaths: workerOwnedPaths(w), unchangedCarried: unchangedCarried.get(w.name), carriedPaths: new Set(w.carriedUntracked?.map(entry => entry.path) ?? []) })))
        const after = text === null ? null : Buffer.from(text, 'latin1')
        if ((before?.equals(after ?? Buffer.alloc(0)) && after !== null && mode === oldMode) || (before === null && after === null)) continue
        changes.push({ p, file, before, after, mode, oldMode })
      }
      // Preflight every destination before writes. Restore originals on any write failure.
      for (const { w } of selected) if (w.id) {
        await registry.beginCollect(w.id)
        collectStarted.add(w.id)
      }
      for (const { p, identity } of destinations) {
        if (!sameIdentity(identity, fileIdentity(safePath(leadRoot, p)))) throw new Error(p + ' changed during collection; nothing written, retry')
      }
      const written: typeof changes = []
      try {
        for (const change of changes) {
          written.push(change)
          materializeMergedFile(leadRoot, change.p, change.after, change.mode)
        }
      } catch (e) {
        for (const change of written.reverse()) {
          materializeMergedFile(leadRoot, change.p, change.before, change.oldMode)
        }
        throw e
      }
      out.push('Changes from ' + selected.map(x => x.w.tag).join(', ') + ': ' + (changes.map(x => x.p).join(', ') || 'already present') + '. Nothing committed or staged.')
      for (const { s, w } of selected) {
        let archived: { entry: RetiredWorker; keptWorktree?: string } | undefined
        const finishOne = async (success = true) => {
          if (success && archived) {
            await retireWorker(rooms, s, w.id, archived.entry, archived.keptWorktree ? { keptWorktree: archived.keptWorktree } : {})
            const note = await cleanRetiredSharedOwner(s, w)
            if (note) out.push(note)
          }
          else await registry.abortCollect(w.id)
          collectStarted.delete(w.id)
        }
        releaseClaimsOnDone(s, () => false, w.name, false)
        const retire = (summary: string, keptWorktree?: string, keptReason?: string) => {
          const retiredAt = Date.now()
          const files = result.paths.filter(p => result.owners.get(p)?.includes(w.name))
          archived = { keptWorktree, entry: {
            name: w.name, tag: w.tag, lead: w.lead, host: w.host, ...(w.model ? { model: w.model } : {}),
            task: w.task, summary, ...(keptWorktree ? { keptWorktree, keptReason } : {}), files, fileCount: files.length,
            startedAt: w.startedAt, finishedAt: w.finishedAt ?? retiredAt, retiredAt, outcome: 'dismissed', disposition: 'collected',
          } }
        }
        if (state.workerAlive(s, w)) { out.push('kept ' + w.tag + ': clean exit not confirmed'); await finishOne(false); continue }
        if (w.exitCode !== 0) { out.push('kept ' + w.tag + ': clean exit not confirmed'); retire(w.summary ?? '', w.dir, 'clean exit not confirmed'); await finishOne(); continue }
        try {
          const record = registry.read(w.id)
          const owner = record && registry.worktreeOwner(record)
          if (record && (record.sharedWith || owner)) {
            retire(w.summary ?? '')
            out.push(`detached ${w.tag}; the worktree belongs to ${owner?.tag ?? record.sharedWith}`)
            await finishOne()
            continue
          }
          const children = descendants(s, w)
          if (children.length) { const reason = 'nested workers remain: ' + children.map(c => c.tag).join(', '); out.push('kept ' + w.tag + ': ' + reason); retire(w.summary ?? '', w.dir, reason); await finishOne(); continue }
          if (record) {
            const users = registry.checkoutUsers(record)
            const running = users.find(({ status }) => !['done', 'failed', 'stopped'].includes(status.status))
            if (running) {
              out.push(`kept ${w.tag}'s worktree: ${running.record.tag} is still running in it`)
              retire(w.summary ?? '', w.dir, `shared checkout: ${running.record.tag}`)
              await finishOne()
              continue
            }
            for (const { record: user } of users) {
              const result = await roomCollect({ tag: user.tag, discard: true }, discarding, s)
              if (!result.startsWith('detached ')) throw new Error(`could not retire ${user.tag} before cleaning ${w.tag}: ${result}`)
              out.push(`retired ${user.tag} with ${w.tag}`)
            }
          }
          const ignored = await ignoredWorkerArtifacts(w)
          if (ignored.length) {
            out.push('kept ' + w.tag + ': uncopied ignored artifacts')
            out.push(...ignored.map(p => `kept ${p} at ${path.join(w.dir, p)}`))
            out.push(`retained worktree: ${w.dir}`)
            retire(`kept for ignored output at ${w.dir}`, w.dir, 'uncopied ignored artifacts')
            await finishOne()
            continue
          }
          const terminated: string[] = []
          if (await cleanupWorker(s.dir, w, true, false, terminated, { probe: state.ctx?.probe, list: state.ctx?.listCwdProcesses }, s.me.name, ownershipRecords(s))) {
            retire(w.summary ?? '')
            out.push('cleaned up ' + w.tag + ': temporary files, branch and logs')
            if (terminated.length) out.push('stopped processes from ' + w.tag + ': ' + terminated.join(', '))
          } else { out.push('kept ' + w.tag + ': cleanup incomplete'); retire(w.summary ?? '', w.dir, 'cleanup incomplete') }
        } catch (e) { out.push('cleanup incomplete for ' + w.tag + ': ' + (e instanceof Error ? e.message : String(e))); retire(w.summary ?? '', w.dir, 'cleanup incomplete') }
        await finishOne()
      }
      return out.join('\n')
    } catch (e) {
      for (const id of collectStarted) await registry.abortCollect(id).catch(() => {})
      return [...out, 'error: ' + (e instanceof Error ? e.message : String(e))].join('\n')
    }
    finally { for (const workerLock of workerLocks) await registry.finishOperation(workerLock) }
  }
  return { room_collect: async a => {
    const registry = await registryForDir(state.S().dir)
    if (a.discard) return roomCollect(a)
    try { return await registry.withCollectLease(state.S().dir, () => roomCollect(a)) }
    catch (error) { return `error: ${error instanceof Error ? error.message : String(error)}` }
  } }
}
