/** Discard's durable sequence, shared by foreground tools and crash recovery. Admission stays with the caller. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { sameStartTime } from '@room/relay/process'
import type { WorkerRegistry } from './worker-registry.js'
import { discardRecoveryDetails, realStateInput, type LivenessProbe, type LocalWorker, type WorkerRecord } from './worker-status.js'
import { cleanupWorker, cleanupWorkerLogs, ignoredWorkerArtifacts, pruneMissingWorkerWorktree, type CleanupWorkerOptions, type WorkerCleanupPreservation } from './worker-git.js'
import { isOwnedWorkerWorktree } from './worker-state.js'
import { verifyWorkerCheckout, retainCheckout } from './worker-preparation.js'
import { pidAlive, probeProcess, quiesceWorktreeProcesses, signalWorker, stopWorkerWithEscalation } from './worker-process.js'
import { recoveryRefCovers, recoveryRefDescription } from './worker-refs.js'
import { requireWorkerInventory } from './worker-store.js'

type DiscardRegistry = Pick<WorkerRegistry, 'root' | 'commonDir' | 'read' | 'list' | 'worktreeOwner' | 'checkoutUsers'
  | 'markDiscardStep' | 'recordDiscardRecovery' | 'ensureDiscardRecovery'>
type ReplayRegistry = DiscardRegistry & Pick<WorkerRegistry, 'status' | 'reports' | 'exits' | 'beginDiscard' | 'beginStop' | 'replayDiscard' | 'archiveOf' | 'beginRetirement'>
type Blocked = { reply?: string }
interface DiscardTarget { owned: boolean; missing: boolean; borrowed: boolean; outside: boolean; verifiedProcess?: boolean }
interface DiscardOutcome {
  record: WorkerRecord; details: string; missingDetail?: string; preservation: WorkerCleanupPreservation
}
interface DiscardOperation {
  id: string; leadDir: string; worker: LocalWorker; registry: DiscardRegistry
  /** Replay honors cleanup checkpoints, verifies legacy artifacts and retains blocked cleanup for retry. */
  replay?: boolean
  children: () => Promise<Blocked | void>
  stop: () => Promise<Blocked | void>
  target: () => Promise<DiscardTarget>
  cleanup: () => Promise<Omit<CleanupWorkerOptions, 'collected' | 'discarded' | 'registry'>>
  retire: (outcome: DiscardOutcome) => Promise<void>
}

/** Only this function orders children, stop, snapshot, removal, cleanup and retirement. */
export async function advanceDiscard(op: DiscardOperation): Promise<{ completed: false; reply?: string } | ({ completed: true } & DiscardOutcome)> {
  const { id, leadDir, worker: w, registry } = op
  if (!(await registry.read(id))!.discard!.steps.children) {
    const childrenBlocked = await op.children()
    if (childrenBlocked) return { completed: false, ...childrenBlocked }
    await registry.markDiscardStep(id, 'children')
  }
  const stopBlocked = await op.stop()
  if (stopBlocked) return { completed: false, ...stopBlocked }
  if (!(await registry.read(id))!.discard!.steps.stop) await registry.markDiscardStep(id, 'stop')
  const target = await op.target()
  if (target.owned) {
    const ignored = await ignoredWorkerArtifacts(w, leadDir)
    if (ignored.length) await registry.recordDiscardRecovery(id, { ignored })
  }
  await registry.ensureDiscardRecovery(id, leadDir, target.owned)
  const record = (await registry.read(id))!
  if (op.replay && !target.owned && record.discard!.patch) {
    const published = record.discard!.patch, expected = path.join(registry.root, 'patches', `${id}.patch`)
    if (published.path !== expected || !fs.lstatSync(expected).isFile()
      || createHash('sha256').update(fs.readFileSync(expected)).digest('hex') !== published.sha256) {
      throw new Error(`legacy discard patch missing or changed after worktree removal: ${expected}`)
    }
  }
  const preservation: WorkerCleanupPreservation = { ignored: [], uncollected: [] }
  let missingDetail: string | undefined
  if (!op.replay || !record.discard!.steps.cleanup) {
    if (target.owned) {
      if (!await cleanupWorker(leadDir, w, { preservation, ...await op.cleanup(), collected: true, discarded: true, registry })) {
        if (op.replay) return { completed: false }
        throw new Error('worker is not an owned Room worktree')
      }
    } else {
      if (target.missing) {
        try { missingDetail = await pruneMissingWorkerWorktree(leadDir, w, true, registry) }
        catch (error) {
          // A verified host can outlive its original lead checkout; that grants no branch-pruning authority here.
          const recordedPath = path.basename(w.dir) === w.tag
            && path.basename(path.dirname(w.dir)) === 'workers'
            && path.basename(path.dirname(path.dirname(w.dir))) === '.room' && w.branch === `room/${w.tag}`
          if (!target.verifiedProcess || !recordedPath || !(error instanceof Error) || !error.message.includes('is not an owned Room worktree')) throw error
        }
      }
      if (target.missing || target.borrowed || target.outside) cleanupWorkerLogs(leadDir, record)
    }
    await registry.markDiscardStep(id, 'cleanup')
  }
  const outcome = { record, details: discardRecoveryDetails(record.discard), missingDetail, preservation }
  await op.retire(outcome)
  return { completed: true, ...outcome }
}

/** Recovery uses only the already-journaled plan and verified durable process identities. */
export async function replayDiscard(registry: ReplayRegistry, id: string, alive: LivenessProbe): Promise<void> {
  let record = (await registry.read(id))!
  if (record?.phase !== 'discarding' || !record.discard) return
  let patches: string[]
  try { patches = fs.readdirSync(path.join(registry.root, 'patches')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; patches = [] }
  for (const name of patches) {
    if (!name.startsWith(`${id}.`) || !/^[0-9a-f]{16}\.tmp$/.test(name.slice(id.length + 1))) continue
    const scratch = path.join(registry.root, 'patches', name)
    if (fs.lstatSync(scratch).isFile()) fs.rmSync(scratch)
  }
  const leadDir = record.outside ? path.dirname(registry.commonDir) : path.dirname(path.dirname(path.dirname(record.dir)))
  const status = await registry.status(id)
  if (!status) return
  const own = realStateInput(record, status)
  const records = requireWorkerInventory(await registry.list())
  const workers: LocalWorker[] = []
  for (const value of records) {
    const current = await registry.status(value.id)
    if (current) workers.push(realStateInput(value, current))
  }
  const borrowed = !!record.sharedWith || !!await registry.worktreeOwner(record)
  const shared = !record.outside && !borrowed && fs.existsSync(record.dir) ? records.filter(value => value.id !== id && !['retiring', 'retired', 'abandoned'].includes(value.phase)
    && path.resolve(value.dir) === path.resolve(record.dir)) : []
  for (const user of shared) {
    const userStatus = await registry.status(user.id)
    if (!userStatus || (user.phase !== 'discarding' && !['done', 'failed', 'stopped'].includes(userStatus.status))) return
    if (user.phase !== 'discarding') await registry.beginDiscard(user.id, [])
    await registry.replayDiscard(user.id)
    if (!['retiring', 'retired'].includes((await registry.read(user.id))?.phase ?? '')) return
  }
  if (!record.outside && !borrowed && fs.existsSync(record.dir)) {
    try { verifyWorkerCheckout(registry.commonDir, record, true) }
    catch (error) { throw new Error(retainCheckout(registry.commonDir, record, String(error))) }
  }
  const owned = !record.outside && !borrowed && await isOwnedWorkerWorktree(leadDir, own, record.lead.participant, workers, true)
  if (!record.outside && !borrowed && !owned && fs.existsSync(record.dir)) throw new Error(`discard replay lost ownership of ${record.dir}`)
  await advanceDiscard({ id, leadDir, worker: own, registry, replay: true,
    children: async () => {
      for (const childId of record.discard!.children) {
        const child = await registry.read(childId)
        if (!child || ['retiring', 'retired'].includes(child.phase)) continue
        if (child.phase !== 'discarding') await registry.beginDiscard(childId, [])
        await registry.replayDiscard(childId)
        if (!['retiring', 'retired'].includes((await registry.read(childId))?.phase ?? '')) return {}
      }
    },
    stop: async () => {
      record = (await registry.read(id))!
      // Admission's chain is MCP first, host second. Stop the verified host, never just its MCP.
      const run = record.runs.at(-1)!, launch = run.launch
      const report = (await registry.reports(id)).find(value => value.run === run.n && value.nonce === run.nonce)
      const chain = report?.chain ?? []
      const reportedHost = launch?.outcome === 'launched' ? chain.find(value => value.pid === launch.pid) : undefined
      if (launch?.outcome === 'launched' && launch.process && reportedHost
        && (!sameStartTime(launch.process.startTime, reportedHost.startTime) || launch.process.executable !== reportedHost.executable)) return {}
      const host = launch?.outcome === 'launched' ? launch.process ?? reportedHost : undefined
      const identities = [host, ...(record.outside ? [] : chain.filter(value => value.pid !== host?.pid))]
        .filter((value): value is NonNullable<typeof value> => !!value)
      if (!record.discard!.steps.stop) await registry.beginStop(id, 'discarded')
      if (launch?.outcome === 'launched' && !host && !(await registry.exits(id)).some(value => value.run === run.n) && pidAlive(launch.pid)) return {}
      for (const identity of identities) {
        const state = alive(identity)
        if (state === 'unknown') return {}
        if (state !== 'alive') continue
        if (!record.capabilities.signal || record.discard!.steps.stop) return {}
        const signalOwn = { ...own, pid: identity.pid, processStartTime: identity.startTime }
        const stopped = await stopWorkerWithEscalation({
          terminate: () => signalWorker(identity.pid, 'SIGTERM', record.outside ? undefined : record.dir, undefined, signalOwn, probeProcess),
          exited: () => alive(identity) === 'dead',
          force: () => signalWorker(identity.pid, 'SIGKILL', record.outside ? undefined : record.dir, undefined, signalOwn, probeProcess),
        })
        if (!stopped) return {}
      }
      if (identities.some(value => alive(value) !== 'dead')) return {}
      if (owned && !await quiesceWorktreeProcesses(record.dir)) return {}
    },
    target: async () => ({ owned, borrowed, outside: record.outside, missing: !owned && !borrowed && !record.outside }),
    // Recovery keeps cleanupWorker's existing branch-pin diagnostics; tools return them in their reply.
    cleanup: async () => ({ leadName: record.lead.participant, workers, preservation: undefined }),
    retire: async () => {
      const completed = (await registry.read(id))!
      const summary = borrowed ? 'detached' : 'discarded' + discardRecoveryDetails(completed.discard)
        + (completed.branchCleanup?.recoveryRef && !recoveryRefCovers(registry.commonDir, completed.discard?.recoveryRef, completed.branchCleanup.recoveryRef)
          ? '; branch recovery ref: ' + recoveryRefDescription(registry.commonDir, completed.branchCleanup.recoveryRef) : '')
      await registry.beginRetirement(id, await registry.archiveOf(completed, { summary, disposition: 'discarded' }))
    },
  })
}
