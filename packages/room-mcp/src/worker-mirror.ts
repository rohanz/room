/** Transition only: wave 3 `project` deletes this legacy tag-keyed document mirror. */
import type { Session } from './session.js'
import type { WorkerRegistry } from './worker-registry.js'
import { realStateInput } from './worker-status.js'
import { releasePoster } from './post.js'

export function mirrorRegistryWorkerRecord(s: Session, registry: WorkerRegistry, id: string): void {
  const record = registry.read(id), status = registry.status(id)
  if (!record || !status) return
  const legacy = realStateInput(record, status)
  if (!legacy.summary) legacy.summary = registry.reports(id).filter(report => report.done).at(-1)?.done?.summary
  legacy.spawnedAfter = status.run?.busFrontier.at(-1)
  const launch = status.run?.launch
  if (launch?.outcome === 'launched') {
    legacy.pid = launch.pid
    legacy.processStartTime = launch.process?.startTime
  }
  const current = s.room.workers.get(record.tag)
  if (current?.id === id) s.room.updateWorker(record.tag, legacy, id)
  else if (current && current.name === record.name && current.startedAt === record.createdAt
    && (!current.id || !current.id.startsWith('w_'))) s.room.updateWorker(record.tag, legacy)
  else if (!current) s.room.setWorker(legacy, releasePoster(s.post))
}

/**
 * Every store transition (stop, report, exit, reconcile, another instance's write) reaches the
 * session's Worker entries. Spawn creates the entry and retirement removes it; this only updates
 * entries already there.
 */
export function followRegistry(s: Session, registry: WorkerRegistry): () => void {
  return registry.onChange(id => {
    for (const record of id ? [registry.read(id)] : registry.list()) {
      if (record && record.room === s.roomName && s.room.workers.has(record.tag)) mirrorRegistryWorkerRecord(s, registry, record.id)
    }
  })
}
