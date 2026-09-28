/** Retirement keyed by worker ID (registry §12): the registry records it, each room's projector cleans up. */
import fs from 'node:fs'
import path from 'node:path'
import type { RetiredWorker } from '@room/shared'
import { PolicyStore } from './policy-store.js'
import type { Rooms } from './registry.js'
import type { Session } from './session.js'
import { registryForDir } from './worker-registry.js'
import { realStateInput, type WorkerRecord } from './worker-status.js'
import { decideRetire, processExited, workerRealState } from './worker-state.js'
import { cleanupWorker, ignoredWorkerArtifacts, pruneMissingWorkerWorktree } from './worker-git.js'

/**
 * Remove the worker's local sharing authority, write `retiring` with its archive entry and a pending cleanup
 * for every room it joined or was projected into, then run this process's projectors so the rooms we hold are
 * cleaned now. A room we are not in stays pending until its projector runs (§12 step 3).
 */
export async function retireWorker(rooms: Rooms, s: Session, id: string, archive: RetiredWorker, extra: Pick<WorkerRecord, 'keptWorktree'> = {}): Promise<void> {
  const registry = await registryForDir(s.dir)
  const record = registry.read(id)
  if (!record) return
  if (fs.existsSync(path.join(record.dir, '.git'))) PolicyStore.retire(record.dir, record.room, record.name, new URL(s.roomUrl).origin)
  await registry.beginRetirement(id, archive, extra)
  await rooms.project()
}

/**
 * decideRetire's rules over this lead's workers in the session's room, from registry facts. A finished host
 * session stays addressable until an explicit collect or discard; a stopped worker waits for its lead.
 */
export async function autoRetire(s: Session, rooms: Rooms): Promise<void> {
  const registry = await registryForDir(s.dir)
  const probe = rooms.probe.bind(rooms)
  for (const record of registry.list()) {
    if (record.lead.participant !== s.me.name || record.room !== s.roomName || record.phase !== 'active') continue
    const status = registry.status(record.id)
    if (!status) continue
    const w = realStateInput(record, status)
    // The next lead must be able to explain and resume intentionally stopped work.
    if (w.stopReason) continue
    if (w.status === 'done' && w.hostSessionId) continue
    if (rooms.hasHandle(s, w)) continue
    const state = await workerRealState(s.dir, w, { process: true, probe })
    if (!processExited(state)) continue
    if (w.status === 'running') { await registry.reconcile(); continue }
    if (w.status !== 'done' && !state.dismissed) continue
    // Git awaits must not let an old evaluation retire a newer run or a session that left.
    const current = () => registry.read(record.id)?.seq === record.seq && !rooms.hasHandle(s, w) && rooms.tracking(s)
    const retiredAt = Date.now()
    if (state.worktree === 'vanished') {
      try { await pruneMissingWorkerWorktree(s.dir, w) } catch { continue }
      if (!current()) continue
      await retireWorker(rooms, s, record.id, registry.archiveOf(record, { summary: 'worktree was already gone', finishedAt: w.finishedAt ?? retiredAt,
        retiredAt, disposition: 'discarded' }))
      continue
    }
    const workers = registry.list().flatMap(other => { const st = registry.status(other.id); return st ? [realStateInput(other, st)] : [] })
    const facts = { ...await workerRealState(s.dir, w, { git: true, leadName: w.lead }), process: state.process }
    const outcome = decideRetire(facts)
    if (!outcome || !current()) continue
    // An ignored artifact has no recovery patch. Keep both its worktree and the live record so
    // the lead can copy it or explicitly discard it, exactly as manual collection does.
    try { if ((await ignoredWorkerArtifacts(w)).length) continue }
    catch { continue }
    const reported = registry.reports(record.id).flatMap(report => report.done?.changed ?? [])
    const files = [...new Set([...s.room.changedPaths(w.name), ...reported])].sort()
    if (facts.clean && w.exitCode === 0) {
      try { if (!await cleanupWorker(s.dir, w, true, false, [], { probe, list: rooms.listCwdProcesses }, s.me.name, [...s.room.retiredWorkers(), ...workers])) continue }
      catch { continue }
    }
    await retireWorker(rooms, s, record.id, registry.archiveOf(record, {
      summary: w.summary ?? '', files, fileCount: files.length, finishedAt: w.finishedAt ?? retiredAt, retiredAt, outcome, disposition: state.dismissed ? 'discarded' : 'collected',
      ...(outcome === 'dismissed' && facts.uncommitted !== undefined ? { uncommitted: facts.uncommitted } : {}),
    }))
  }
}
