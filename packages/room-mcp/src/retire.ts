/** Retirement keyed by worker ID (registry §12): the registry records it, each room's projector cleans up. */
import fs from 'node:fs'
import path from 'node:path'
import { manifestPaths, ROOM_STALE_MS, type RetiredWorker } from '@room/shared'
import { PolicyStore } from './policy-store.js'
import type { Rooms } from './registry.js'
import type { Session } from './session.js'
import { registryForDir } from './worker-registry.js'
import { realStateInput, type LocalWorker, type WorkerRecord } from './worker-status.js'
import { decideRetire, processExited, workerRealState } from './worker-state.js'
import { cleanupWorker, collectHeadRef, ignoredWorkerArtifacts, pruneMissingWorkerWorktree, uncollectedWorkerPaths, type WorkerCleanupPreservation } from './worker-git.js'
import type { CwdProcessLister, ProcessProbe } from './worker-process.js'
import { git } from '@room/roomd/git'

/**
 * Remove the worker's local sharing authority, write `retiring` with its archive entry and a pending cleanup
 * for every room it joined or was projected into, then run this process's projectors so the rooms we hold are
 * cleaned now. A room we are not in stays pending until its projector runs (§12 step 3).
 */
export async function retireWorker(rooms: Rooms, s: Session, id: string, archive: RetiredWorker, extra: Pick<WorkerRecord, 'keptWorktree'> = {}): Promise<void> {
  const registry = await registryForDir(s.dir)
  const record = (await registry.read(id))
  if (!record) return
  if (fs.existsSync(path.join(record.dir, '.git'))) PolicyStore.retire(record.dir, record.room, record.name, new URL(s.roomUrl).origin)
  await registry.beginRetirement(id, archive, extra)
  await rooms.project()
}

export type CollectedProcesses = { alive: (w: LocalWorker) => boolean | Promise<boolean>; probe?: ProcessProbe; list?: CwdProcessLister }
/** The checkout was removed, or the reason it cannot be yet (with extra reply lines for the lead). */
export type CleanupResult = { removed: true; terminated: string[]; recoveryRef?: string } | { removed: false; reason: string; lines?: string[] }
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
  const users = record ? (await registry.checkoutUsers(record)) : []
  if (users.length && !o.retireUser) return { removed: false, reason: `its worktree is shared with ${users.map(user => user.record.tag).join(', ')}` }
  for (const { record: user } of users) await o.retireUser!(user)
  const nested = (await registry.list()).filter(other => other.lead.participant === w.name && !['retiring', 'retired', 'abandoned'].includes(other.phase))
  if (nested.length) return { removed: false, reason: 'nested workers remain: ' + nested.map(other => other.tag).join(', ') }
  const ignored = await ignoredWorkerArtifacts(w, s.dir)
  if (ignored.length) return { removed: false, reason: 'uncopied ignored artifacts', lines: [...ignored.map(p => `kept ${p} at ${path.join(w.dir, p)}`), `retained worktree: ${w.dir}`] }
  if (!o.justCollected) {
    let captured: string | undefined
    try { captured = (await git(s.dir, ['rev-parse', '--verify', collectHeadRef(w.tag, w.id)])).trim() } catch { /* aborted before the ref */ }
    const changed = await uncollectedWorkerPaths(s.dir, w, captured)
    if (changed.length) return { removed: false, reason: `changed since collection: ${changed.join(', ')}; copy it (mode="copy") or discard=true` }
  }
  const workers = (await Promise.all((await registry.list()).map(async other => { const st = (await registry.status(other.id)); return st ? [realStateInput(other, st)] : [] }))).flat()
  const terminated: string[] = []
  const preservation: WorkerCleanupPreservation = { ignored: [], uncollected: [] }
  // retireWorker ends sharing only while the checkout exists; end it before the checkout goes.
  if (record && fs.existsSync(path.join(w.dir, '.git'))) PolicyStore.retire(w.dir, record.room, record.name, new URL(s.roomUrl).origin)
  // The exit code may be unknown, not failed: the process is gone and nothing in the worktree differs from what was collected.
  try {
    if (!await cleanupWorker(s.dir, { ...w, status: 'done', exitCode: 0 }, { collected: true, terminatedProcesses: terminated, processOptions: { probe: processes.probe, list: processes.list }, leadName: s.me.name, workers: [...s.room.retiredWorkers(), ...workers], preservation })) {
      const details = [
        ...(preservation.ignored.length ? [`ignored files not copied: ${preservation.ignored.join(', ')}`] : []),
        ...(preservation.uncollected.length ? [`uncollected work: ${preservation.uncollected.join(', ')}`] : []),
        ...(preservation.commitsAfterCollection ? [`commits after collection: ${preservation.commitsAfterCollection.sha} ${preservation.commitsAfterCollection.paths.join(', ') || '(no changed paths)'}`] : []),
      ]
      return { removed: false, reason: details.join('; ') || 'its worktree could not be removed safely; discard=true removes it with a recovery patch' }
    }
  } catch (error) { return { removed: false, reason: 'cleanup incomplete: ' + (error instanceof Error ? error.message : String(error)).slice(0, 300) } }
  return { removed: true, terminated, ...(preservation.recoveryRef ? { recoveryRef: preservation.recoveryRef } : {}) }
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
  const w = realStateInput(record, status)
  const kept = (reason: string) => `kept ${w.tag}: ${reason}`
  if (await processes.alive(w)) return kept('its host process is still running; its changes are already collected, and cleanup follows once it exits')
  try { if (!await registry.beginOperation(id, 'collect')) return kept('already being handled') }
  catch { return kept('already being handled') }
  try {
    const fresh = (await registry.read(id))
    if (!fresh?.collectPending || fresh.phase !== 'active' || await processes.alive(w)) return kept('changed while finishing; call room_collect again')
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
      await retireWorker(rooms, s, id, (await archive(w.summary ?? '')))
      return `retired ${w.tag}: its worktree was already gone`
    }
    const result = await removeCollectedCheckout(s, fresh, w, processes)
    if (!result.removed) {
      if (result.reason !== fresh.collectPending.reason) await registry.deferCollectCleanup(id, result.reason)
      return [kept(result.reason), ...result.lines ?? []].join('\n')
    }
    await retireWorker(rooms, s, id, (await archive(w.summary ?? '')))
    return `cleaned up ${w.tag}: temporary files, branch and logs` + (result.terminated.length ? `\nstopped processes from ${w.tag}: ${result.terminated.join(', ')}` : '')
  } finally { await registry.finishOperation(id) }
}

/** 0.17.30 retired a collected worker whose exit was unconfirmed while keeping its worktree (keptReason below). */
const LEGACY_UNCONFIRMED = 'clean exit not confirmed'

/**
 * Adopt one of 0.17.30's retired records that kept a worktree because its clean exit was unconfirmed: once its
 * process is gone and the worktree holds nothing beyond the collected output, remove the worktree and clear the
 * kept marker from the record and every room's retired entry. Anything else leaves it as it was, for discard.
 */
async function adoptLegacyKept(s: Session, rooms: Rooms, record: WorkerRecord, processes: CollectedProcesses): Promise<void> {
  const registry = await registryForDir(s.dir)
  const status = (await registry.status(record.id))
  if (!status || !record.keptWorktree || !fs.existsSync(record.keptWorktree)) return
  const w = { ...realStateInput(record, status), dir: record.keptWorktree }
  if (await processes.alive(w)) return
  try { if (!await registry.beginOperation(record.id, 'collect')) return } catch { return }
  try {
    const fresh = (await registry.read(record.id))
    if (fresh?.phase !== 'retired' || fresh.keptWorktree !== w.dir || fresh.archive?.keptReason !== LEGACY_UNCONFIRMED) return
    if (!(await removeCollectedCheckout(s, fresh, w, processes)).removed) return
    await registry.command(fresh.id, { type: 'retired-checkout-removed' })
    for (const room of rooms.all()) {
      const list = room.room.doc.getArray<RetiredWorker>('retiredWorkers')
      const index = list.toArray().findIndex(entry => entry.id === fresh.id)
      if (index >= 0) room.room.doc.transact(() => {
        const { keptWorktree: _kept, keptReason: _reason, ...entry } = list.get(index)
        list.delete(index)
        list.insert(index, [entry])
      })
    }
  } finally { await registry.finishOperation(record.id) }
}

/**
 * decideRetire's rules over this lead's workers in the session's room, from registry facts. A finished host
 * session stays addressable until an explicit collect or discard; a stopped worker waits for its lead.
 */
export async function autoRetire(s: Session, rooms: Rooms): Promise<void> {
  const registry = await registryForDir(s.dir)
  const probe = rooms.probe.bind(rooms)
  // Retired records otherwise accumulate for the clone's lifetime; the room's archive entry outlives them.
  await registry.pruneRetired(ROOM_STALE_MS).catch(error => { process.stderr.write(`[room] retired record retention: ${error}\n`) })
  for (const record of (await registry.list())) {
    if (record.lead.participant !== s.me.name || record.room !== s.roomName) continue
    const processes: CollectedProcesses = { probe, list: rooms.listCwdProcesses, alive: async w =>
      rooms.hasHandle(s, w) || !processExited(await workerRealState(s.dir, w, { process: true, probe })) }
    if (record.phase === 'retired' && record.keptWorktree && record.archive?.keptReason === LEGACY_UNCONFIRMED) {
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
      try { await pruneMissingWorkerWorktree(s.dir, w) } catch { continue }
      if (!await current()) continue
      await retireWorker(rooms, s, record.id, (await registry.archiveOf(record, { summary: 'worktree was already gone', finishedAt: w.finishedAt ?? retiredAt,
        retiredAt, disposition: 'discarded' })))
      continue
    }
    const workers = (await Promise.all((await registry.list()).map(async other => { const st = (await registry.status(other.id)); return st ? [realStateInput(other, st)] : [] }))).flat()
    const facts = { ...await workerRealState(s.dir, w, { git: true, leadName: w.lead }), process: state.process }
    const outcome = decideRetire(facts)
    if (!outcome || !await current()) continue
    // An ignored artifact has no recovery patch. Keep both its worktree and the live record so
    // the lead can copy it or explicitly discard it, exactly as manual collection does.
    try { if ((await ignoredWorkerArtifacts(w, s.dir)).length) continue }
    catch { continue }
    const reported = (await registry.reports(record.id)).flatMap(report => report.done?.changed ?? [])
    const files = [...new Set([...manifestPaths(s.room, w.name), ...reported])].sort()
    if (facts.clean && w.exitCode === 0) {
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
        const users = borrower ? [] : (await registry.checkoutUsers(fresh))
        if (!borrower && !users.length) {
          if (!await cleanupWorker(s.dir, w, { collected: true, processOptions: { probe, list: rooms.listCwdProcesses }, leadName: s.me.name, workers: [...s.room.retiredWorkers(), ...workers] })) continue
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
