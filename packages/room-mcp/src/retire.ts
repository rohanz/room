import { releasePoster } from './post.js'
import { requireWorkerInventory } from './worker-store.js'
import { requireWorkerEvidence } from './worker-store.js'
/** Retirement keyed by worker ID (registry §12): the registry records it, each room's projector cleans up. */
import fs from 'node:fs'
import path from 'node:path'
import { manifestPaths, participantRecord, ROOM_STALE_MS, type RetiredWorker } from '@room/shared'
import { PolicyStore } from './policy-store.js'
import type { Rooms } from './registry.js'
import type { Session } from './session.js'
import { registryForDir } from './worker-registry.js'
import { collectLocalState } from './local-state-gc.js'
import { gitCommonDir } from '@room/roomd'
import { realStateInput, type LocalWorker, type WorkerRecord, type WorkerStatusResult } from './worker-status.js'
import { decideNothingToCollect, decideRetire, processExited, roomWorkerPathMatchesBranch, workerRealState } from './worker-state.js'
import { cleanupWorker, cleanupWorkerLogs, collectHeadRef, ignoredWorkerArtifacts, pruneMissingWorkerWorktree, uncollectedWorkerPaths, type WorkerCleanupPreservation } from './worker-git.js'
import type { CwdProcessLister, ProcessProbe } from './worker-process.js'
import { git } from '@room/roomd/git'
import { projectWorkers } from './worker-projector.js'
import { listCwdProcesses } from './worker-process.js'
import { liveness } from './leases.js'

/**
 * Remove the worker's local sharing authority, write `retiring` with its archive entry and a pending cleanup
 * for every room it joined or was projected into, then run this process's projectors so the rooms we hold are
 * cleaned now. A room we are not in stays pending until its projector runs (§12 step 3).
 */
export async function retireWorker(rooms: Rooms, s: Session, id: string, archive: RetiredWorker, extra: Pick<WorkerRecord, 'keptWorktree'> = {}): Promise<void> {
  const registry = await registryForDir(s.dir)
  const record = (await registry.read(id))
  if (!record) return
  if (!record.outside && fs.existsSync(path.join(record.dir, '.git'))) PolicyStore.retire(record.dir, record.room, record.name)
  await registry.beginRetirement(id, archive, extra)
  await rooms.project()
}

export type CollectedProcesses = { alive: (w: LocalWorker) => boolean | Promise<boolean>; probe?: ProcessProbe; list?: CwdProcessLister }
/** Terminal status rows omit `run`; observation still needs the recorded host identity.
 * Signal permission is separate: these inputs only check liveness before cleanup. */
function cleanupInput(record: WorkerRecord, status: WorkerStatusResult): LocalWorker {
  const run = status.run ?? record.runs.at(-1)
  const w = realStateInput(record, { ...status, run })
  const launch = run?.launch
  if (launch?.outcome === 'launched') return { ...w, pid: launch.pid, processStartTime: launch.process?.startTime }
  // Unknown/imported launch evidence cannot prove that a host is gone. Only a
  // launch explicitly recorded as never started needs no process check.
  return { ...w, pid: launch?.outcome === 'never' ? 0 : -1 }
}
/** The checkout was removed, or the reason it cannot be yet (with extra reply lines for the lead). */
export type CleanupResult = { removed: true; terminated: string[]; recoveryRefs?: string[] } | { removed: false; reason: string; lines?: string[] }
export type RemoveCheckoutOptions = {
  /** Retire a finished worker that still uses this checkout (collect's discard path); throws when it cannot. Without it, any user keeps the checkout. */
  retireUser?: (user: WorkerRecord) => Promise<void>
  /** The output was applied in this same call: the worktree cannot have changed since, and what the merge left
   *  unapplied (scratch, the lead's own later edits) is not uncollected work. Deferred paths leave this unset. */
  justCollected?: boolean
}

/**
 * Remove an already-collected worker's checkout under collect's rules: no other worker using it, no nested worker,
 * no uncopied ignored output, nothing that differs from the lead (written after collection). The caller holds the
 * worker's operation lease and has seen its host process gone. Shared by the collect reply path, a later
 * room_collect of a pending record, the sweep and legacy adoption, so every path keeps the same rules.
 */
export async function removeCollectedCheckout(s: Session, record: WorkerRecord | undefined, w: LocalWorker, processes: CollectedProcesses, o: RemoveCheckoutOptions = {}): Promise<CleanupResult> {
  const registry = await registryForDir(s.dir)
  const evidence = record ? await registry.checkoutUsers(record) : []
  if ('reason' in evidence) return { removed: false, reason: `worker evidence blocked: ${evidence.blockers.join('; ')}` }
  const users = evidence
  if (users.length && !o.retireUser) return { removed: false, reason: `its worktree is shared with ${users.map(user => user.record.tag).join(', ')}` }
  for (const { record: user } of users) await o.retireUser!(user)
  const nested: WorkerRecord[] = []
  for (const other of requireWorkerInventory(await registry.list())) {
    if (other.id === record?.id || other.lead.participant !== w.name || other.collectPending || ['retiring', 'retired', 'abandoned'].includes(other.phase)) continue
    const status = await registry.status(other.id)
    if (!fs.existsSync(other.dir) && status && !await processes.alive(cleanupInput(other, status))) continue
    nested.push(other)
  }
  if (nested.length) return { removed: false, reason: 'nested workers remain: ' + nested.map(other => other.tag).join(', ') }
  const ignored = await ignoredWorkerArtifacts(w, s.dir)
  if (ignored.length) return { removed: false, reason: 'uncopied ignored artifacts', lines: [...ignored.map(p => `kept ${p} at ${path.join(w.dir, p)}`), `retained worktree: ${w.dir}`] }
  if (!o.justCollected) {
    let captured: string | undefined
    try { captured = (await git(s.dir, ['rev-parse', '--verify', collectHeadRef(w.tag, w.id)])).trim() } catch { /* aborted before the ref */ }
    const changed = await uncollectedWorkerPaths(s.dir, w, captured)
    if (changed.length) return { removed: false, reason: `changed since collection: ${changed.join(', ')}; copy it (mode="copy") or discard=true` }
  }
  const workers = (await Promise.all((requireWorkerInventory(await registry.list())).map(async other => { const st = (await registry.status(other.id)); return st ? [realStateInput(other, st)] : [] }))).flat()
  const ownership = [...s.room.retiredWorkers(), ...workers]
  const byName = new Map(ownership.map(other => [other.name, other]))
  let leadName = w.lead
  let ancestor: Pick<LocalWorker, 'name' | 'lead' | 'dir' | 'branch'> = w
  const seen = new Set([w.name])
  // Preserve the existing ownership proof through nested worktrees, but anchor it to
  // the recorded top-level lead rather than the unrelated session running retention.
  while (!roomWorkerPathMatchesBranch(s.dir, ancestor.dir, ancestor.branch)) {
    const parent = byName.get(ancestor.lead)
    if (!parent || seen.has(parent.name)) break
    seen.add(parent.name)
    ancestor = { name: parent.name, lead: parent.lead, dir: 'dir' in parent ? parent.dir : parent.keptWorktree ?? path.resolve(ancestor.dir, '../../..'), branch: 'branch' in parent ? parent.branch : `room/${parent.tag}` }
    leadName = parent.lead
  }
  const terminated: string[] = []
  const preservation: WorkerCleanupPreservation = { ignored: [], uncollected: [] }
  // retireWorker ends sharing only while the checkout exists; end it before the checkout goes.
  if (record && fs.existsSync(path.join(w.dir, '.git'))) PolicyStore.retire(w.dir, record.room, record.name)
  // The exit code may be unknown, not failed: the process is gone and nothing in the worktree differs from what was collected.
  try {
    if (!await cleanupWorker(s.dir, { ...w, status: 'done', exitCode: 0 }, { collected: true, terminatedProcesses: terminated, processOptions: { probe: processes.probe, list: processes.list }, leadName, workers: ownership, preservation })) {
      const details = [
        ...(preservation.ignored.length ? [`ignored files not copied: ${preservation.ignored.join(', ')}`] : []),
        ...(preservation.uncollected.length ? [`uncollected work: ${preservation.uncollected.join(', ')}`] : []),
        ...(preservation.commitsAfterCollection ? [`commits after collection: ${preservation.commitsAfterCollection.sha} ${preservation.commitsAfterCollection.paths.join(', ') || '(no changed paths)'}`] : []),
      ]
      return { removed: false, reason: details.join('; ') || 'its worktree could not be removed safely; discard=true removes it with a recovery patch' }
    }
  } catch (error) { return { removed: false, reason: 'cleanup incomplete: ' + (error instanceof Error ? error.message : String(error)).slice(0, 300) } }
  return { removed: true, terminated, recoveryRefs: preservation.recoveryRefs }
}

/**
 * Finish a collection that applied a worker's output but kept its checkout (`collectPending`): its host's clean
 * exit was unconfirmed, or ignored output, nested workers or a failed cleanup held the worktree. Once the host is
 * gone and nothing holds it, remove the worktree and retire the record; otherwise the record stays live and the
 * reply says why. Shared by a later room_collect and the auto-retire sweep: a kept worktree never outlives its record.
 */
export async function finishPendingCollect(s: Session, rooms: Rooms, id: string, processes: CollectedProcesses): Promise<string | undefined> {
  const registry = await registryForDir(s.dir)
  const record = (await registry.read(id))
  const status = record?.collectPending && record.phase === 'active' ? (await registry.status(id)) : undefined
  if (!record || !status) return undefined
  const w = cleanupInput(record, status)
  const kept = (reason: string) => `kept ${w.tag}: ${reason}`
  if (await processes.alive(w)) return kept('its host process is still running; its changes are already collected, and cleanup follows once it exits')
  try { if (!await registry.beginOperation(id, 'collect')) return kept('already being handled') }
  catch { return kept('already being handled') }
  try {
    const fresh = (await registry.read(id))
    if (!fresh?.collectPending || fresh.seq !== record.seq || fresh.phase !== 'active' || await processes.alive(w)) return kept('changed while finishing; call room_collect again')
    const retiredAt = Date.now()
    const files = [...new Set((await registry.reports(id)).flatMap(report => report.done?.changed ?? []))].sort()
    const archive = async (summary: string) => (await registry.archiveOf(fresh, { summary, files, fileCount: files.length,
      finishedAt: w.finishedAt ?? fresh.collectPending!.at, retiredAt, outcome: 'dismissed', disposition: 'collected' }))
    const borrowed = fresh.sharedWith ?? (await registry.worktreeOwner(fresh))?.tag
    if (borrowed) {
      await retireWorker(rooms, s, id, (await archive(w.summary ?? '')))
      return `detached ${w.tag}; the worktree belongs to ${borrowed}`
    }
    if (!fs.existsSync(w.dir)) {
      await pruneMissingWorkerWorktree(s.dir, w)
      cleanupWorkerLogs(s.dir, fresh)
      await retireWorker(rooms, s, id, (await archive(w.summary ?? '')))
      return `retired ${w.tag}: its worktree was already gone`
    }
    const result = await removeCollectedCheckout(s, fresh, w, processes)
    if (!result.removed) {
      if (result.reason !== fresh.collectPending.reason) await registry.deferCollectCleanup(id, result.reason)
      return [kept(result.reason), ...result.lines ?? []].join('\n')
    }
    await retireWorker(rooms, s, id, (await archive(w.summary ?? '')))
    return `cleaned up ${w.tag}: temporary files and logs; branch disposition is listed by room_state` + (result.terminated.length ? `\nstopped processes from ${w.tag}: ${result.terminated.join(', ')}` : '')
  } finally { await registry.finishOperation(id) }
}

/**
 * Adopt a legacy retired record that kept a worktree after collection: once its
 * process is gone and the worktree holds nothing beyond the collected output, remove the worktree and clear the
 * kept marker from the record and every room's retired entry. Anything else leaves it as it was, for discard.
 */
async function adoptLegacyKept(s: Session, rooms: Rooms, record: WorkerRecord, processes: CollectedProcesses): Promise<string | undefined> {
  const registry = await registryForDir(s.dir)
  const status = (await registry.status(record.id))
  if (!status || !record.keptWorktree) return
  const w = { ...cleanupInput(record, status), dir: record.keptWorktree }
  if (await processes.alive(w)) return
  try { if (!await registry.beginOperation(record.id, 'collect')) return } catch { return }
  try {
    const fresh = (await registry.read(record.id))
    if (fresh?.phase !== 'retired' || fresh.seq !== record.seq || fresh.keptWorktree !== w.dir || await processes.alive(w)) return
    if (fs.existsSync(w.dir)) {
      const result = await removeCollectedCheckout(s, fresh, w, processes)
      if (!result.removed) {
        if (fresh.archive?.keptReason !== result.reason) await registry.command(fresh.id, { type: 'retired-checkout-kept', dir: w.dir, reason: result.reason })
        syncKeptArchive(rooms, (await registry.read(fresh.id))!)
        return `kept ${w.tag}: ${result.reason}`
      }
    } else await pruneMissingWorkerWorktree(s.dir, w)
    cleanupWorkerLogs(s.dir, fresh)
    await registry.command(fresh.id, { type: 'retired-checkout-removed' })
    syncKeptArchive(rooms, (await registry.read(fresh.id))!)
    return `cleaned up ${w.tag}: cleared its kept-worktree marker and removed worker logs`
  } finally { await registry.finishOperation(record.id) }
}

/** Repair room copies too, including after a crash between the registry update and the room transaction. */
function syncKeptArchive(rooms: Rooms, record: WorkerRecord): void {
  for (const s of rooms.all()) {
    if (s.roomName !== record.room && s.roomName !== record.projectedInto) continue
    const list = s.room.doc.getArray<RetiredWorker>('retiredWorkers')
    const index = list.toArray().findIndex(entry => entry.id === record.id)
    if (index < 0) continue
    const { keptWorktree: _kept, keptReason: _reason, ...rest } = list.get(index)
    const next = { ...rest, ...(record.keptWorktree ? { keptWorktree: record.keptWorktree, keptReason: record.archive?.keptReason } : {}) }
    if (JSON.stringify(next) === JSON.stringify(list.get(index))) continue
    s.room.doc.transact(() => { list.delete(index); list.insert(index, [next]) })
  }
}

/** A local-only legacy archive can outlive its registry record. Clear only a stale kept marker;
 * remote rooms cannot establish which machine or clone owns a missing record. Keep its history. */
async function reconcileOrphanArchives(s: Session, dir: string, registry: Registry, rooms: Rooms): Promise<void> {
  if (!s.local || fs.realpathSync(s.dir) !== fs.realpathSync(dir)) return
  const list = s.room.doc.getArray<RetiredWorker>('retiredWorkers')
  for (const entry of list.toArray()) {
    const kept = entry.keptWorktree
    if (!kept || entry.lead !== s.me.name || path.basename(kept) !== entry.tag
      || !roomWorkerPathMatchesBranch(dir, kept, `room/${entry.tag}`, true)) continue
    const records = requireWorkerInventory(await registry.list())
    if (records.some(record => record.id === entry.id || record.name === entry.name || record.tag === entry.tag || path.resolve(record.dir) === path.resolve(kept))) continue
    const absent = () => { try { fs.lstatSync(kept); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' } }
    if (!absent()) continue
    if ((await git(dir, ['for-each-ref', '--format=%(refname)', `refs/heads/room/${entry.tag}`])).trim()) continue
    if ([...s.awareness?.getStates().values() ?? []].some(p => p?.user?.name === entry.name)) continue
    const holder = participantRecord(s.room, entry.name)?.holder
    if (holder && liveness(holder, rooms.probe.bind(rooms)) !== 'dead') continue
    const root = path.resolve(kept)
    if ((rooms.listCwdProcesses ?? listCwdProcesses)().some(p => path.resolve(p.cwd) === root || path.resolve(p.cwd).startsWith(root + path.sep))) continue
    // A new spawn takes the same tag guard before publishing its record and opening its logs.
    // Refuse a reservation (including a corrupt one); never delete a successor's sidecars.
    const sameArchive = () => list.toArray().findIndex(value => value.id === entry.id && value.name === entry.name && value.keptWorktree === kept)
    // Old archives may have no ID: an empty identity deliberately matches no reservation.
    const changed = cleanupWorkerLogs(dir, { id: entry.id ?? '', dir: kept, tag: entry.tag, outside: false }, () =>
      !fs.existsSync(path.join(registry.root, 'tags', entry.tag + '.json')) && absent() && sameArchive() >= 0)
    if (changed) {
      // Clear the marker after deletion, so a crash before here can retry the leftover pass.
      const index = sameArchive()
      if (index >= 0) {
        const { keptWorktree: _kept, keptReason: _reason, ...archive } = list.get(index)
        s.room.doc.transact(() => { list.delete(index); list.insert(index, [archive]) })
      }
      rooms.log(`cleaned up ${entry.tag}: reconciled its orphaned local kept-worktree marker and logs; history retained`)
    }
  }
}

/**
 * decideRetire's rules over this lead's workers in the session's room, from registry facts. A finished host
 * session stays addressable until an explicit collect or discard; a stopped worker waits for its lead.
 */
export async function autoRetire(s: Session, rooms: Rooms): Promise<void> {
  const registry = await registryForDir(s.dir)
  const probe = rooms.probe.bind(rooms)
  await sweepClone(s, registry, rooms)
  for (const record of (requireWorkerInventory(await registry.list()))) {
    if (record.lead.participant !== s.me.name || record.room !== s.roomName) continue
    const processes: CollectedProcesses = { probe, list: rooms.listCwdProcesses, alive: async w =>
      rooms.hasHandle(s, w) || !processExited(await workerRealState(s.dir, w, { process: true, probe })) }
    if (record.phase === 'retired' && record.keptWorktree) {
      await adoptLegacyKept(s, rooms, record, processes).catch(() => {})
      continue
    }
    if (record.phase !== 'active') continue
    if (record.collectPending) {
      // Already collected: finish its cleanup once the host is gone, whatever would otherwise keep it addressable.
      await finishPendingCollect(s, rooms, record.id, processes).catch(() => {})
      continue
    }
    const status = (await registry.status(record.id))
    if (!status) continue
    const w = realStateInput(record, status)
    // The next lead must be able to explain and resume intentionally stopped work.
    if (w.stopReason) continue
    if (w.status === 'done' && w.hostSessionId) continue
    // keep:true explicitly preserves even a finished worker whose host did not record a session.
    if (w.status === 'done' && record.collectedKeep) continue
    // Older records identify keep through their private collection snapshot ref.
    if (w.status === 'done' && w.base) {
      try {
        const ref = (await git(s.dir, ['rev-parse', '--verify', collectHeadRef(w.tag, w.id)])).trim()
        if (ref === w.base && (await git(s.dir, ['log', '-1', '--format=%s', ref])).trim() === 'room: kept collection baseline') continue
      }
      catch { /* no kept collection baseline */ }
    }
    if (rooms.hasHandle(s, w)) continue
    const state = await workerRealState(s.dir, w, { process: true, probe })
    if (!processExited(state)) continue
    if (w.status === 'running') { await registry.reconcile(); continue }
    if (w.status !== 'done' && !state.dismissed) continue
    // Git awaits must not let an old evaluation retire a newer run or a session that left.
    const captured = await registry.freshness(record.id)
    if (!captured || captured.seq !== record.seq) continue
    const current = async () => (await registry.freshness(record.id))?.revision === captured.revision && !rooms.hasHandle(s, w) && rooms.tracking(s)
    const retiredAt = Date.now()
    if (state.worktree === 'vanished') {
      if (!await current()) continue
      try { await registry.beginOperation(record.id, 'collect') } catch { continue }
      try {
        const fresh = await registry.read(record.id)
        if (!fresh || fresh.seq !== record.seq || rooms.hasHandle(s, w) || !rooms.tracking(s)) continue
        await pruneMissingWorkerWorktree(s.dir, w)
        if ((await registry.read(record.id))?.seq !== fresh.seq || rooms.hasHandle(s, w) || !rooms.tracking(s)) continue
        await retireWorker(rooms, s, record.id, (await registry.archiveOf(fresh, { summary: 'worktree was already gone', finishedAt: w.finishedAt ?? retiredAt,
          retiredAt, disposition: 'discarded' })))
      } catch { /* Preserve uncertain checkout/branch facts for a later operation. */ }
      finally { await registry.finishOperation(record.id) }
      continue
    }
    const workers = (await Promise.all((requireWorkerInventory(await registry.list())).map(async other => { const st = (await registry.status(other.id)); return st ? [realStateInput(other, st)] : [] }))).flat()
    const facts = { ...await workerRealState(s.dir, w, { git: true, leadName: w.lead }), process: state.process }
    const outcome = decideRetire(facts)
    if (!outcome || !await current()) continue
    // An ignored artifact has no recovery patch. Keep both its worktree and the live record so
    // the lead can copy it or explicitly discard it, exactly as manual collection does.
    try { if ((await ignoredWorkerArtifacts(w, s.dir)).length) continue }
    catch { continue }
    const reported = (await registry.reports(record.id)).flatMap(report => report.done?.changed ?? [])
    const files = [...new Set([...manifestPaths(s.room, w.name), ...reported])].sort()
    // A run that reported done is finished whatever exit code it later recorded (registry §6): clean its checkout too.
    if (facts.clean && (w.exitCode === 0 || (w.status === 'done' && w.exitCode !== undefined))) {
      // Spawn and resume borrow the owner's operation lane. Hold it through the
      // final checkout-user check, cwd cleanup, and retirement record.
      if (!await current()) continue
      try { await registry.beginOperation(record.id, 'collect') } catch { continue }
      try {
        // Admission changes the operation revision itself. Under its lease, validate the
        // authoritative record again rather than comparing the pre-admission display revision.
        const fresh = (await registry.read(record.id))
        if (!fresh || fresh.seq !== record.seq || rooms.hasHandle(s, w) || !rooms.tracking(s)) continue
        const borrower = !!fresh.sharedWith || !!(await registry.worktreeOwner(fresh))
        const users = borrower ? [] : requireWorkerEvidence(await registry.checkoutUsers(fresh))
        if (!borrower && !users.length) {
          if (!await cleanupWorker(s.dir, { ...w, exitCode: 0 }, { collected: true, processOptions: { probe, list: rooms.listCwdProcesses }, leadName: s.me.name, workers: [...s.room.retiredWorkers(), ...workers] })) continue
        }
        const reason = users.length ? `shared checkout: ${users.map(user => user.record.tag).join(', ')}` : undefined
        await retireWorker(rooms, s, record.id, (await registry.archiveOf(record, {
          summary: w.summary ?? '', files, fileCount: files.length, finishedAt: w.finishedAt ?? retiredAt, retiredAt,
          outcome, disposition: state.dismissed ? 'discarded' : 'collected',
          ...(reason ? { keptWorktree: w.dir, keptReason: reason } : {}),
          ...(outcome === 'dismissed' && facts.uncommitted !== undefined ? { uncommitted: facts.uncommitted } : {}),
        })), reason ? { keptWorktree: w.dir } : {})
      } catch { /* A later pass can retry without losing this checkout. */ }
      finally { await registry.finishOperation(record.id) }
      continue
    }
    await retireWorker(rooms, s, record.id, (await registry.archiveOf(record, {
      summary: w.summary ?? '', files, fileCount: files.length, finishedAt: w.finishedAt ?? retiredAt, retiredAt, outcome, disposition: state.dismissed ? 'discarded' : 'collected',
      ...(outcome === 'dismissed' && facts.uncommitted !== undefined ? { uncommitted: facts.uncommitted } : {}),
    })))
  }
}

type Registry = Awaited<ReturnType<typeof registryForDir>>
/** How a retirement pass sees a worker's host process: this process's handles, then the process table. */
type HostProbe = { probe?: ProcessProbe; hasHandle?: (w: LocalWorker) => boolean }
const NOTHING_TO_COLLECT = 'nothing to collect: its worktree and branch were already gone'

/**
 * A finished outside worker has no import capability; a Room worktree has nothing left once its checkout and
 * branch are gone (decideNothingToCollect). Neither can retire while an active nested worker
 * still names it as its lead. A collection awaiting cleanup belongs to finishPendingCollect.
 */
async function nothingToCollect(leadDir: string, registry: Registry, record: WorkerRecord, host: HostProbe): Promise<LocalWorker | undefined> {
  if (record.phase !== 'active' || record.collectPending) return undefined
  const outside = record.outside && record.capabilities.collect === 'none' && !record.legacy?.unowned
  if (!outside && fs.existsSync(record.dir)) return undefined
  const status = await registry.status(record.id)
  if (!status) return undefined
  const w = realStateInput(record, status)
  const facts = await workerRealState(leadDir, w, { branch: !outside, process: true, hasHandle: host.hasHandle?.(w), probe: host.probe })
  if (outside ? !processExited(facts) || !['done', 'failed'].includes(w.status) : !decideNothingToCollect(facts)) return undefined
  const nested = requireWorkerInventory(await registry.list()).some(other => other.lead.participant === record.name && !['retiring', 'retired', 'abandoned'].includes(other.phase))
  return nested ? undefined : w
}

/**
 * Retire `record` when it has nothing to collect, under its operation lease, rechecked on the fresh record, and
 * remove what it left in the lead's checkout: its logs and, for a Room worktree path, the stale worktree entry and
 * preview cache. Outside checkouts and their branches are never changed. The registry records the retirement; each room's projector removes the worker's live state,
 * including its final publication, so it stops taking part in conflict checks (§12). The caller runs `rooms.project()`.
 */
export async function retireIfNothingToCollect(leadDir: string, registry: Registry, record: WorkerRecord, host: HostProbe): Promise<boolean> {
  if (!await nothingToCollect(leadDir, registry, record, host)) return false
  try { if (!await registry.beginOperation(record.id, 'collect')) return false } catch { return false }
  try {
    const fresh = await registry.read(record.id)
    const w = fresh && fresh.seq === record.seq ? await nothingToCollect(leadDir, registry, fresh, host) : undefined
    if (!fresh || !w) return false
    if (!fresh.outside && roomWorkerPathMatchesBranch(leadDir, w.dir, w.branch, true)) await pruneMissingWorkerWorktree(leadDir, w, false).catch(() => undefined)
    cleanupWorkerLogs(leadDir, fresh)
    await registry.beginRetirement(fresh.id, await registry.archiveOf(fresh, { summary: fresh.outside ? outsideCollectLine(fresh) : NOTHING_TO_COLLECT, disposition: 'discarded' }))
    return true
  } finally { await registry.finishOperation(record.id) }
}

/** No files are imported from an outside checkout, even when its record can be retired. */
export function outsideCollectLine(record: Pick<WorkerRecord, 'tag' | 'dir'>): string {
  return `${record.tag}: changes remain in its own checkout at ${record.dir}; nothing was brought in`
}

/** The reply or log line naming records retired with nothing to collect. */
export function nothingToCollectLine(tags: string[]): string {
  return `retired ${tags.length === 1 ? '1 finished worker' : `${tags.length} finished workers`} with nothing to collect (${tags.length === 1 ? 'its' : 'their'} worktree and branch are gone): ${tags.join(', ')}`
}

/**
 * Every record in this clone with nothing to collect, whichever lead dispatched it: nothing of it can be collected,
 * resumed or recovered, so no lead's decision is pending on it. Nested workers go before their lead. Returns the tags.
 */
async function retireNothingToCollect(dir: string, registry: Registry, host: HostProbe, log: (line: string) => void): Promise<string[]> {
  const retired: string[] = []
  for (let progress = true; progress;) {
    progress = false
    for (const record of requireWorkerInventory(await registry.list())) {
      if (retired.includes(record.tag) || !await retireIfNothingToCollect(dir, registry, record, host)) continue
      if (record.outside) log(`${outsideCollectLine(record)}; retired ${record.tag} (nothing to collect into this checkout)`)
      else retired.push(record.tag)
      progress = true
    }
  }
  return retired
}

const GC_EVERY_MS = 60 * 60 * 1000
const collectedAt = new WeakMap<Registry, number>()
/**
 * The clone's one retention pass, once an hour per process: the worker registry retires finished records with
 * nothing to collect and removes its expired records under its own locks (the room's archive entry is the durable
 * copy), then the local state collector (local-state-gc.ts) applies the ownership table to everything else.
 */
async function sweepClone(session: Session, registry: Registry, rooms: Rooms): Promise<void> {
  if (Date.now() - (collectedAt.get(registry) ?? 0) < GC_EVERY_MS) return
  collectedAt.set(registry, Date.now())
  // A worker's MCP also runs retention. Git's first worktree is this clone's main checkout;
  // never interpret another lead's records relative to the caller's own worker worktree.
  const main = (await git(session.dir, ['worktree', 'list', '--porcelain'])).split('\n').find(line => line.startsWith('worktree '))?.slice(9)
  if (!main) return
  const dir = fs.realpathSync(main) === fs.realpathSync(session.dir) ? session.dir : main
  const s = { ...session, dir } as Session
  const probe = rooms.probe.bind(rooms)
  const processes: CollectedProcesses = { probe, list: rooms.listCwdProcesses, alive: async w =>
    rooms.all().some(held => rooms.hasHandle(held, w)) || !processExited(await workerRealState(dir, w, { process: true, probe })) }
  try {
    for (const record of requireWorkerInventory(await registry.list()).sort((a, b) => b.dir.length - a.dir.length)) {
      const line = record.phase === 'active' && record.collectPending
        ? await finishPendingCollect(s, rooms, record.id, processes)
        : record.phase === 'retired' && record.keptWorktree ? await adoptLegacyKept(s, rooms, record, processes) : undefined
      if (line) rooms.log(`${line}`)
    }
    // Retirement already ended the worker's authority. Any session of this clone in the
    // affected room can run the existing idempotent projector, even after its lead vanished.
    for (const held of rooms.all()) {
      const pending = requireWorkerInventory(await registry.list()).filter(record => record.phase === 'retiring' && record.cleanup?.[held.roomName] === 'pending')
      for (const lead of new Set(pending.map(record => record.lead.participant))) {
        for (const role of ['joined', 'projected'] as const) await projectWorkers(held, registry, lead, role, undefined, () => rooms.tracking(held), true)
      }
      for (const record of pending) if ((await registry.read(record.id))?.phase === 'retired') rooms.log(`finished retirement cleanup for ${record.tag}`)
    }
    for (const record of requireWorkerInventory(await registry.list())) if (record.phase === 'retired') {
      syncKeptArchive(rooms, record)
      if (record.keptWorktree || !await registry.beginOperation(record.id, 'collect')) continue
      try {
        const fresh = await registry.read(record.id), status = await registry.status(record.id)
        if (fresh?.phase === 'retired' && !fresh.keptWorktree && (await registry.reserved(fresh.tag))?.id === fresh.id
          && status && !await processes.alive(cleanupInput(fresh, status))) cleanupWorkerLogs(dir, fresh)
      } finally { await registry.finishOperation(record.id) }
    }
    await reconcileOrphanArchives(session, dir, registry, rooms)
  } catch (error) { rooms.log(`collected worker cleanup: ${error}`) }
  try {
    const retired = await retireNothingToCollect(dir, registry, { probe: rooms.probe.bind(rooms), hasHandle: w => rooms.all().some(s => rooms.hasHandle(s, w)) }, line => rooms.log(line))
    if (retired.length) {
      rooms.log(`${nothingToCollectLine(retired)}`)
    }
    await rooms.project()
  } catch (error) { rooms.log(`nothing-to-collect retirement: ${error}`) }
  // Like the steps around it: a failure here is logged and the rest of the pass still runs.
  try {
    for (const held of rooms.all()) await registry.retireWorkerMail(held.room, held.me.name, held.roomName, releasePoster(held.post))
  } catch (error) { rooms.log(`retired worker mail: ${error}`) }
  await registry.pruneRetired(ROOM_STALE_MS).catch(error => { rooms.log(`retired record retention: ${error}`) })
  try {
    const { removed } = collectLocalState(await gitCommonDir(dir))
    if (removed.length) rooms.log(`local state: removed ${removed.length} stale item${removed.length === 1 ? '' : 's'}`)
  } catch (error) { rooms.log(`local state collector: ${error}`) }
}
