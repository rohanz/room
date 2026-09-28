import fs from 'node:fs'
import path from 'node:path'
import { claimsOverlap, type RetiredWorker, type Worker } from '@room/shared'
import { git, gitWholeTree } from '@room/roomd/git'
import { carriedUnchangedPaths, workerBaseline } from '@room/roomd/baseline'
import { MATERIALIZED_PATH, containedRepoPath, realGitCommonDir, validRepoPath } from '@room/roomd'
import { cleanupWorker, cleanupWorkerLogs, ignoredWorkerArtifacts, pruneMissingWorkerWorktree, saveDiscardPatch, workerOwnedPaths } from '../worker-git.js'
import { signalWorker, pidPresent, terminateWorktreeProcesses, stopWorkerWithEscalation, type CwdProcessLister, type ProcessProbe } from '../worker-process.js'
import { decideCollect, decideDiscard, decideStop, workerRealState } from '../worker-state.js'
import { buildCombinedTree } from './combined-tree.js'
import { addCarriedUntrackedModes, gitTreeModes, materializeMergedFile, mergedFileMode } from './files.js'
import { releaseClaimsOnDone } from './claims.js'
import { RW, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'
import type { Session } from '../session.js'
import { retireCollected } from '../retire.js'
import { registryForDir, registrySnapshotForDir } from '../worker-registry.js'

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

/** Only signal processes after confirming this is still the worker's owned git worktree. */
const ownershipRecords = (s: Session) => [...s.room.retiredWorkers(), ...s.room.workers.values()]

async function stopOwnedWorktreeProcesses(leadDir: string, w: Worker, leadName: string, workers: Iterable<Worker | RetiredWorker>, errors?: string[], probe?: ProcessProbe, list?: CwdProcessLister): Promise<string[]> {
  if (!decideStop(await workerRealState(leadDir, w, { ownership: true, leadName, workers })).cwd) return []
  try { return await terminateWorktreeProcesses(w.dir, { protectedPids: w.pid ? [w.pid] : [], probe, list }) }
  catch (e) {
    errors?.push(`cwd process cleanup failed: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

const failureReason = (w: Worker): string => w.exitCode !== undefined && w.exitCode !== 0
  ? `exit code ${w.exitCode}${w.summary ? `; ${w.summary.replace(/\s+/g, ' ').slice(0, 180)}` : ''}`
  : w.stopReason ?? w.summary?.replace(/\s+/g, ' ').slice(0, 180) ?? 'worker reported failure'

/** Reject symlinks at every component, including dangling destination links. */
function safePath(root: string, rel: string): string {
  if (!validRepoPath(rel, MATERIALIZED_PATH)) throw new Error('unsafe collection path: ' + rel)
  const result = containedRepoPath(root, path.join(root, rel), { leaf: 'reject-link', allowMissing: true })
  if (!result.ok) throw new Error(result.reason === 'link' ? 'symlink collection path refused: ' + rel : 'unsafe collection path: ' + rel)
  return result.path
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
  const missingCapability = (s: Session, w: Worker): string => {
    const records = registrySnapshotForDir(s.dir).list()
    const record = records.find(candidate => candidate.tag === w.tag)
    if (record && record.lead.participant !== s.me.name) {
      const parent = records.find(candidate => candidate.name === record.lead.participant)
      return `${w.tag} belongs to ${record.lead.participant}; collect it through that lead (resume it if needed), or room_collect tag=${parent?.tag ?? 'PARENT'} discard=true force=true to save recovery patches`
    }
    return `${w.tag}: no local worker capability (worktree missing or unmanaged)`
  }
  const holdingWorker = (tag: string, from: Session): Session => {
    const records = registrySnapshotForDir(from.dir).list().filter(record => record.tag === tag)
    return state.rooms.all().find(room => records.some(record => record.room === room.roomName)) ?? from
  }
  const unverifiedLive = async (s: Session, w: Worker): Promise<string | undefined> => {
    if (!pidPresent(w.pid, state.ctx?.probe)) return undefined
    const facts = await workerRealState(s.dir, w, { process: true, hasHandle: !!state.rooms.handle?.(s, w.id), probe: state.ctx?.probe })
    return facts.process === 'ours' ? undefined : `could not verify ${w.tag}'s process (pid ${w.pid}); left running, not stopped`
  }
  const ownership = (s: Session, w: Worker, discarding: Set<string>): { owned: boolean; liveLead?: string } => {
    const known = [...s.room.workers.values(), ...s.room.retiredWorkers()]
    const visited = new Set<string>()
    let lead = w.lead
    let liveLead: string | undefined
    while (lead && !visited.has(lead)) {
      if (lead === s.me.name) return { owned: true, liveLead }
      visited.add(lead)
      const active = [...s.room.workers.values()].find(parent => parent.name === lead)
      if (active && !discarding.has(lead) && !liveLead && (state.workerAlive(s, active) || pidPresent(active.pid, state.ctx?.probe))) liveLead = lead
      lead = known.find(parent => parent.name === lead)?.lead ?? ''
    }
    return { owned: false }
  }
  const descendants = (s: Session, w: Worker): Worker[] => {
    const out: Worker[] = []
    const visit = (parent: Worker) => {
      for (const child of s.room.workers.values()) if (child.lead === parent.name) { visit(child); out.push(child) }
    }
    visit(w)
    return out
  }
  const takeWorkerOperation = async (s: Session, w: Worker, op: 'collect' | 'discard'): Promise<string> => {
    if (!w.id) return 'untrusted'
    const registry = await registryForDir(s.dir)
    const trusted = await registry.trusted({ participant: s.me.name, room: s.roomName, dir: s.dir }, w.tag)
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
        .map(r => ({ s, r }))).find(({ s, r }) => ownership(s, {
          ...r, dir: r.keptWorktree!, branch: 'room/' + r.tag, status: 'done', exitCode: 0, pid: 0,
        } as Worker, discarding).owned)
      if (kept && !kept.s.room.workers.has(a.tag as string)) {
        const { s, r } = kept
        const w = { ...r, dir: r.keptWorktree!, branch: 'room/' + r.tag, status: 'done', exitCode: 0, pid: 0 } as Worker
        const active = registry.list().find(record => record.tag === r.tag && record.keptWorktree === r.keptWorktree)
        if (!active) return 'error: kept worker has no local registry record'
        try { await registry.beginOperation(active.id, 'discard') }
        catch { return 'error: this worker is already being handled or retired' }
        try {
          const missing = decideDiscard(await workerRealState(s.dir, w)) === 'prune'
          const ignored = missing ? [] : await ignoredWorkerArtifacts(w)
          if (ignored.length && a.force !== true) return `error: discard refused; ignored artifacts not covered by a recovery patch: ${ignored.join(', ')}\nretained worktree: ${w.dir}\nrepeat with force=true to delete them`
          await registry.beginDiscard(active.id, a.force === true, [])
          await registry.markDiscardStep(active.id, 'children')
          await registry.beginStop(active.id, 'discarded')
          const cleanupErrors: string[] = []
          const terminated = await stopOwnedWorktreeProcesses(s.dir, w, s.me.name, ownershipRecords(s), cleanupErrors, state.ctx?.probe, state.ctx?.listCwdProcesses)
          // A kept worktree that is no longer an owned Room worktree is refused, not forgotten: cleanupWorker decides.
          const missingDetail = missing ? await pruneMissingWorkerWorktree(s.dir, w) : undefined
          if (missing) cleanupWorkerLogs(s.dir, w)
          await registry.markDiscardStep(active.id, 'stop')
          const patch = missing ? undefined : await saveDiscardPatch(s.dir, w, bytes => registry.recordDiscardPatch(active.id, bytes))
          await registry.markDiscardStep(active.id, 'patch')
          if (!missing && !await cleanupWorker(s.dir, w, true, true, terminated, { probe: state.ctx?.probe, list: state.ctx?.listCwdProcesses }, s.me.name, ownershipRecords(s))) throw new Error('worker is not an owned Room worktree')
          await registry.markDiscardStep(active.id, 'cleanup')
          const archive = s.room.doc.getArray<RetiredWorker>('retiredWorkers')
          const index = archive.toArray().findIndex(item => item.name === r.name && item.startedAt === r.startedAt && item.lead === r.lead)
          if (index >= 0) s.room.doc.transact(() => {
            archive.delete(index)
            const { keptWorktree: _keptWorktree, ...cleared } = r
            archive.insert(index, [{ ...cleared, summary: 'discarded', disposition: 'discarded' }])
          })
          await registry.markDiscardStep(active.id, 'prune')
          await registry.update(active.id, old => ({ ...old, phase: 'retiring', keptWorktree: undefined,
            cleanup: { [old.room]: 'pending' }, seq: old.seq + 1 }))
          return 'discarded ' + r.tag + (missingDetail ? '; its worktree was already gone; ' + missingDetail : '') + (patch ? '; recovery patch: ' + patch + ' (kept for a week)' : '') + (terminated.length ? '; stopped processes: ' + terminated.join(', ') : '') + (ignored.length ? '; deleted without a copy: ' + ignored.join(', ') : '') + (cleanupErrors.length ? '; ' + cleanupErrors.join('; ') : '')
        } catch (e) { await registry.interruptDiscard(active.id, e instanceof Error ? e.message : String(e)).catch(() => {}); return 'error: ' + (e instanceof Error ? e.message : String(e)) + '; retained ' + w.dir }
        finally { await registry.finishOperation(active.id) }
      }
      const s = actingLead ?? holdingWorker(a.tag as string, lead)
      const w = s.room.workers.get(a.tag as string)
      if (!w) return 'error: no worker ' + a.tag + ' owned by you'
      const owner = ownership(s, w, discarding)
      if (!owner.owned) return 'error: no worker ' + a.tag + ' owned by you'
      if (owner.liveLead) return `error: ${w.tag} belongs to ${owner.liveLead}, which is still running; ask it with room_send, or discard ${owner.liveLead}'s worker first`
      const lock = await takeWorkerOperation(s, w, 'discard')
      if (lock === 'untrusted') return `error: ${missingCapability(s, w)}`
      if (lock === 'busy') return 'error: this worker is already being handled or retired'
      try {
        const unsafe = await unverifiedLive(s, w)
        if (unsafe) return unsafe
        const children = descendants(s, w)
        if (children.length && a.force !== true) return `error: ${w.tag} has nested workers: ${children.map(c => c.tag).join(', ')}; collect or discard them first, or repeat with force=true to save recovery patches and discard them`
        const beforePlan = await workerRealState(s.dir, w, { ownership: true, leadName: s.me.name, workers: ownershipRecords(s) })
        const ignoredBefore = decideDiscard(beforePlan) === 'cleanup' ? await ignoredWorkerArtifacts(w) : []
        if (ignoredBefore.length && a.force !== true) return `error: discard refused; ignored artifacts not covered by a recovery patch: ${ignoredBefore.join(', ')}\nretained worktree: ${w.dir}\nrepeat with force=true to delete them`
        await registry.beginDiscard(lock, a.force === true, children.map(child => child.id!).filter(Boolean))
        const childResults: string[] = []
        for (const child of children) {
          if (!s.room.workers.has(child.tag)) continue
          const childLead = { ...s, dir: w.dir, me: { ...s.me, name: w.name } } as Session
          const result = await roomCollect({ tag: child.tag, discard: true, force: true }, new Set([...discarding, w.name]), childLead)
          childResults.push(result)
          if (!result.startsWith('discarded ') && !result.startsWith('stopped ')) return `error: could not dispose of nested worker ${child.tag}: ${result}; retained ${w.dir}`
        }
        await registry.markDiscardStep(lock, 'children')
        // A headless host can take its child server down as it exits. Record and stop
        // worktree processes while they are still observable, before dismissing it.
        const cleanupErrors: string[] = []
        const beforeStop = await workerRealState(s.dir, w, { process: true, hasHandle: !!rooms.handle?.(s, w.id), probe: state.ctx?.probe })
        const verifiedProcess = decideStop(beforeStop).host === 'signal'
        const terminated = await stopOwnedWorktreeProcesses(s.dir, w, s.me.name, ownershipRecords(s), cleanupErrors, state.ctx?.probe, state.ctx?.listCwdProcesses)
        if (state.workerAlive(s, w) || pidPresent(w.pid, state.ctx?.probe)) {
          const how = await state.dismissWorker(s, w, 'discarded by the lead')
          if (s.room.workers.get(w.tag)?.status === 'running' && (state.workerAlive(s, w) || pidPresent(w.pid, state.ctx?.probe))) return 'could not discard ' + w.tag + ': ' + how + (cleanupErrors.length ? '; ' + cleanupErrors.join('; ') : '')
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
        if (unsafeAfterDismissal) return unsafeAfterDismissal
        terminated.push(...await stopOwnedWorktreeProcesses(s.dir, w, s.me.name, ownershipRecords(s), cleanupErrors, state.ctx?.probe, state.ctx?.listCwdProcesses))
        const afterStop = await workerRealState(s.dir, w, { ownership: true, leadName: s.me.name, workers: ownershipRecords(s) })
        const missing = decideDiscard(afterStop) === 'prune'
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
        const ownedWorktree = decideDiscard(afterStop) === 'cleanup'
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
        await registry.markDiscardStep(lock, 'cleanup')
        releaseClaimsOnDone(s, () => false, w.name, false)
        const retiredAt = Date.now()
        retireCollected(s, w, {
          name: w.name, tag: w.tag, lead: w.lead, host: w.host, ...(w.model ? { model: w.model } : {}), task: w.task,
          summary: 'discarded', files: [], fileCount: 0, startedAt: w.startedAt,
          finishedAt: w.finishedAt ?? retiredAt, retiredAt, outcome: 'dismissed', disposition: 'discarded',
        })
        await registry.markDiscardStep(lock, 'prune')
        await registry.update(lock, old => ({ ...old, phase: 'retiring', cleanup: { [old.room]: 'pending' }, seq: old.seq + 1 }))
        return [...childResults, (decideDiscard(afterStop) === 'retain-directory' ? `stopped ${w.tag}; kept ${w.dir} (an existing directory, not a Room worktree)` : 'discarded ' + w.tag) + (missingDetail ? '; its worktree was already gone; ' + missingDetail : '') + (patch ? '; recovery patch: ' + patch + ' (kept for a week)' : '') + (terminated.length ? '; stopped processes: ' + terminated.join(', ') : '') + (ignored.length ? '; deleted without a copy: ' + ignored.join(', ') : '') + (cleanupErrors.length ? '; ' + cleanupErrors.join('; ') : '')].join('\n')
      } catch (e) {
        await registry.interruptDiscard(lock, e instanceof Error ? e.message : String(e)).catch(() => {})
        return 'error: ' + (e instanceof Error ? e.message : String(e)) + '; retained ' + w.dir
      }
      finally { await registry.finishOperation(lock) }
    }
    const sessions = a.tag ? [holdingWorker(a.tag as string, lead)] : rooms.all()
    const candidates = sessions.flatMap(s => [...s.room.workers.values()].filter(w => {
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
    const workerRoots = new Map<Worker, string>()
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
        if (w.branch !== 'room/' + w.tag || (await git(w.dir, ['branch', '--show-current'])).trim() !== w.branch) throw new Error('worker must be on branch room/' + w.tag)
        await gitWholeTree(w.dir, ['ls-files', '-z'])
        const cleanupErrors: string[] = []
        const terminated = await stopOwnedWorktreeProcesses(lead.dir, w, s.me.name, ownershipRecords(s), cleanupErrors, state.ctx?.probe, state.ctx?.listCwdProcesses)
        if (terminated.length) out.push('stopped processes from ' + w.tag + ': ' + terminated.join(', '))
        out.push(...cleanupErrors.map(error => `${w.tag}: ${error}`))
        const now = state.now ?? Date.now
        const sleep = state.ctx?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
        const deadline = now() + 15_000
        while (state.workerAlive(s, w) && now() < deadline) await sleep(Math.min(250, deadline - now()))
        if (state.workerAlive(s, w)) { out.push('skipped ' + w.tag + ': process has not exited after 15 s'); continue }
        const unsafeAfterWait = await unverifiedLive(s, w)
        if (unsafeAfterWait) { out.push(unsafeAfterWait); continue }
        const current = s.room.workers.get(w.tag)
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
        const files = copyFiles(workerRoot, a.paths as string[])
        const modified = new Set(split(await gitWholeTree(lead.dir, ['diff', '--name-only', '-z', 'HEAD', '--'])))
        const tracked = new Set(split(await gitWholeTree(lead.dir, ['ls-files', '-z'])))
        for (const p of files) {
          const dst = safePath(leadRoot, p)
          if (fs.existsSync(dst) && !fs.statSync(dst).isFile()) return 'error: copy destination is not a regular file: ' + p
          if (a.force !== true && (modified.has(p) || (!tracked.has(p) && fs.existsSync(dst)))) {
            if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(fs.readFileSync(safePath(workerRoot, p)))) return 'error: lead has modified ' + p + '; pass force=true to overwrite'
          }
        }
        releasePaths(files)
        for (const p of files) {
          const dst = safePath(leadRoot, p)
          fs.mkdirSync(path.dirname(dst), { recursive: true })
          fs.copyFileSync(safePath(workerRoot, p), dst)
          fs.chmodSync(dst, fs.statSync(safePath(workerRoot, p)).mode & 0o777)
          out.push('copied ' + p)
        }
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
      for (const [p, text] of result.merged) {
        const file = safePath(leadRoot, p)
        const before = fs.existsSync(file) ? fs.readFileSync(file) : null
        if ((before === null ? null : before.toString('latin1')) !== result.initial.get(p)) throw new Error(p + ' changed during collection; nothing written, retry')
        const oldMode = before !== null ? fs.statSync(file).mode & 0o777 : 0o644
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
        let keptDir: string | undefined
        const finishOne = async (success = true) => { if (w.id) { await registry.finishCollect(w.id, success, keptDir); collectStarted.delete(w.id) } }
        releaseClaimsOnDone(s, () => false, w.name, false)
        const retire = (summary: string, keptWorktree?: string, keptReason?: string) => {
          if (keptWorktree) keptDir = keptWorktree
          const retiredAt = Date.now()
          const files = result.paths.filter(p => result.owners.get(p)?.includes(w.name))
          retireCollected(s, w, {
            name: w.name, tag: w.tag, lead: w.lead, host: w.host, ...(w.model ? { model: w.model } : {}),
            task: w.task, summary, ...(keptWorktree ? { keptWorktree, keptReason } : {}), files, fileCount: files.length,
            startedAt: w.startedAt, finishedAt: w.finishedAt ?? retiredAt, retiredAt, outcome: 'dismissed', disposition: 'collected',
          })
        }
        if (state.workerAlive(s, w)) { out.push('kept ' + w.tag + ': clean exit not confirmed'); await finishOne(false); continue }
        if (w.exitCode !== 0) { out.push('kept ' + w.tag + ': clean exit not confirmed'); retire(w.summary ?? '', w.dir, 'clean exit not confirmed'); await finishOne(); continue }
        try {
          const children = descendants(s, w)
          if (children.length) { const reason = 'nested workers remain: ' + children.map(c => c.tag).join(', '); out.push('kept ' + w.tag + ': ' + reason); retire(w.summary ?? '', w.dir, reason); await finishOne(); continue }
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
      for (const id of collectStarted) await registry.finishCollect(id, false).catch(() => {})
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
