import path from 'node:path'
import { writeAtomic } from '../../src/leases.js'
import type { WorkerRecord } from '../../src/worker-status.js'

/**
 * Fault/legacy-fixture injection only. Arbitrary record edits are deliberately absent from the
 * production facade. Behavior tests use named commands; this helper manufactures persisted evidence
 * such as old ownership, malformed history or an interrupted phase before the operation under test.
 */
export async function mutateWorkerFixture(registry: {
  root: string; read(id: string): WorkerRecord | undefined | Promise<WorkerRecord | undefined>
}, id: string, edit: (record: WorkerRecord) => WorkerRecord | Promise<WorkerRecord>): Promise<WorkerRecord> {
  const prior = await registry.read(id)
  if (!prior) throw new Error(`unknown fixture worker ${id}`)
  const next = await edit(prior)
  if (next.id !== prior.id || next.seq !== prior.seq + 1) throw new Error('fixture edit must retain id and advance seq')
  writeAtomic(path.join(registry.root, 'workers', `${id}.json`), next)
  return next
}
