import fs from 'node:fs'
import path from 'node:path'
import { gitCommonDir } from '@room/roomd'
import type { Worker } from '@room/shared'
import type { Session } from '../src/session.js'
import { registryForDir, type WorkerRegistry } from '../src/worker-registry.js'
import { mirrorRegistryWorkerRecord } from '../src/worker-mirror.js'
import type { WorkerRecord } from '../src/worker-status.js'
import { probeProcess } from '../src/worker-process.js'

/** A local artifact sink for direct saveDiscardPatch tests. */
export function patchPublisher(dir: string, tag: string): (bytes: Buffer) => Promise<string> {
  return async bytes => {
    const file = path.join(dir, '.room', 'discarded', `${tag}.patch`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
    return file
  }
}

/** Seed a durable record for tests of operations formerly stored in room-carry JSON. */
export async function seedRegistryWorker(dir: string, tag: string, patch: Partial<WorkerRecord> = {}): Promise<{ registry: WorkerRegistry; record: WorkerRecord }> {
  const common = await gitCommonDir(dir)
  const migration = path.join(common, 'room', 'registry', 'migration.json')
  if (!fs.existsSync(migration)) {
    fs.mkdirSync(path.dirname(migration), { recursive: true })
    fs.writeFileSync(migration, JSON.stringify({ v: 1, sources: {}, done: true }))
  }
  const registry = await registryForDir(dir)
  const id = registry.newId(), now = Date.now()
  const record: WorkerRecord = {
    v: 1, id, tag, name: `lead+${tag}`, mode: 'local', room: 'local/test/main',
    lead: { participant: 'lead', room: 'local/test/main', instance: registry.instance }, host: 'claude',
    budget: { threads: 1, memGb: 1, nice: 10 }, share: 'full', task: 'test',
    dir: path.join(dir, '.room', 'workers', tag), outside: false, branch: `room/${tag}`,
    prep: { step: 'plan' }, capabilities: { resume: false, signal: false, collect: 'delta' }, phase: 'intent',
    runs: [{ n: 1, mode: 'fresh', intentAt: now, nonce: `fixture:${id}`, busFrontier: 0, promptMsgIds: [],
      launcher: registry.instance, logStart: 0 }],
    createdAt: now, seq: 1, ...patch,
  }
  await registry.writeIntent(record)
  const active = await registry.update(id, old => ({ ...old, prep: { step: 'prepared' }, phase: 'active',
    runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: 0 } }], seq: old.seq + 1 }))
  await registry.finishOperation(id)
  return { registry, record: active }
}

/** Test-only adapter: older fixtures describe workers in a RoomDoc, then exercise tool calls. */
export async function syncDocumentWorkers(session: Session): Promise<WorkerRegistry> {
  const common = await gitCommonDir(session.dir)
  const migration = path.join(common, 'room', 'registry', 'migration.json')
  if (!fs.existsSync(migration)) {
    fs.mkdirSync(path.dirname(migration), { recursive: true })
    fs.writeFileSync(migration, JSON.stringify({ v: 1, sources: {}, done: true }))
  }
  const registry = await registryForDir(session.dir)
  for (const legacy of [...session.room.workers.values()]) {
    const id = legacy.id?.startsWith('w_') ? legacy.id : `w_${(legacy.id ?? legacy.tag).replace(/[^A-Za-z0-9_-]/g, '_')}`
    let record = registry.read(id)
    if (!record) {
      const w = legacy as Worker
      const run = { n: 1, mode: 'fresh' as const, intentAt: w.startedAt ?? Date.now(), nonce: `fixture:${id}`,
        busFrontier: 0, promptMsgIds: [], launcher: registry.instance, logStart: 0 }
      const initial: WorkerRecord = {
        v: 1, id, tag: w.tag, name: w.name, mode: 'local', room: session.roomName,
        lead: { participant: w.lead, room: session.roomName, instance: registry.instance },
        host: w.host, model: w.model, effort: w.effort, budget: w.budget ?? { threads: 1, memGb: 1, nice: 10 },
        share: w.share ?? 'full', link: w.link, task: w.task, dir: w.dir, outside: false, branch: w.branch,
        prep: { step: 'prepared' }, base: w.base, carriedBase: w.carriedBase,
        carriedUntracked: w.carriedUntracked, port: w.port, hostSessionId: w.hostSessionId,
        capabilities: { resume: !!w.hostSessionId, signal: !!w.pid, collect: w.base ? 'delta' : 'copy' },
        phase: 'prepared', runs: [run], createdAt: w.startedAt ?? Date.now(), seq: 1,
      }
      try { await registry.writeIntent(initial) }
      catch { continue }
      record = await registry.update(id, old => ({ ...old, phase: 'active',
        runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: w.pid ?? 0,
          ...(w.pid ? { process: { pid: w.pid, startTime: w.processStartTime ?? 'fixture:unknown',
            executable: probeProcess(w.pid)?.executable ?? w.host } } : {}) } }], seq: old.seq + 1 }))
      await registry.finishOperation(id)
    }
    if (legacy.status === 'done' || legacy.status === 'failed' || legacy.status === 'dismissed') {
      if (!registry.exits(id).some(exit => exit.run === record!.runs.at(-1)!.n)) await registry.writeExit(id,
        { run: record.runs.at(-1)!.n, code: legacy.exitCode ?? (legacy.status === 'failed' ? 1 : 0), at: legacy.finishedAt ?? Date.now(), witnessed: true })
      if (legacy.status === 'done' && !registry.reports(id).some(report => report.done)) {
        await registry.writeReport(id, { run: record.runs.at(-1)!.n, nonce: record.runs.at(-1)!.nonce,
          chain: [], joinedAt: record.createdAt, done: { at: legacy.finishedAt ?? Date.now(),
            summary: legacy.summary ?? '', changed: session.room.changedPaths(legacy.name) } })
      }
      if (legacy.status === 'dismissed' && !record.stop) await registry.beginStop(id, legacy.stopReason ?? 'lead-session-ended')
    }
    mirrorRegistryWorkerRecord(session, registry, id)
  }
  return registry
}
