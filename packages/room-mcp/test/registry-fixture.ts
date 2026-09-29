import fs from 'node:fs'
import path from 'node:path'
import { manifestPaths } from '@room/shared'
import { gitCommonDir } from '@room/roomd'
import type { Session } from '../src/session.js'
import { localWorkers, registryForDir, type WorkerRegistry } from '../src/worker-registry.js'
import { projectWorkers } from '../src/worker-projector.js'
import type { LocalWorker, WorkerRecord } from '../src/worker-status.js'
import { stampFixtureWorker } from './fixtures/manifest.js'
import { finishFixtureProcess, fixtureProcess } from './fixtures/process-liveness.js'

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

/** A worker as tests describe it (the 0.16 tag-keyed shape); `registerWorkers` turns it into registry facts only. */
export interface FixtureWorker {
  id?: string; tag: string; name: string; lead: string; host: 'claude' | 'codex'; model?: string; effort?: string
  hostSessionId?: string; budget?: { threads: number; memGb: number; nice: number }; port?: number; share?: WorkerRecord['share']
  link?: string[]; task: string; dir: string; branch: string; base?: string; carriedBase?: string
  carriedUntracked?: { path: string; sha: string; mode?: number }[]; pid: number; processStartTime?: string; startedAt: number
  status: 'running' | 'done' | 'failed' | 'dismissed'; summary?: string; exitCode?: number; finishedAt?: number
  stopReason?: 'lead-session-ended' | 'message-delivered-cancelled' | 'message-delivered-failed'; mode?: 'here' | 'local'
}

async function migrated(dir: string): Promise<WorkerRegistry> {
  const common = await gitCommonDir(dir)
  const migration = path.join(common, 'room', 'registry', 'migration.json')
  if (!fs.existsSync(migration)) {
    fs.mkdirSync(path.dirname(migration), { recursive: true })
    fs.writeFileSync(migration, JSON.stringify({ v: 1, sources: {}, done: true }))
  }
  return registryForDir(dir)
}

/** The registry ID a fixture worker is written under. */
export const fixtureId = (w: Pick<FixtureWorker, 'id' | 'tag'>): string => w.id?.startsWith('w_') ? w.id : `w_${(w.id ?? w.tag).replace(/[^A-Za-z0-9_-]/g, '_')}`

/**
 * Write each fixture worker's registry record in `session`'s room (with its exit, done report or stop for a
 * finished status), then project the leads' views, as the lead session's projector would.
 */
export async function registerWorkers(session: Session, workers: readonly FixtureWorker[]): Promise<WorkerRegistry> {
  const registry = await migrated(session.dir)
  for (const w of workers) {
    const id = fixtureId(w)
    let record = registry.read(id)
    if (!record) {
      const run = { n: 1, mode: 'fresh' as const, intentAt: w.startedAt ?? Date.now(), nonce: `fixture:${id}`,
        busFrontier: 0, promptMsgIds: [], launcher: registry.instance, logStart: 0 }
      const initial: WorkerRecord = {
        v: 1, id, tag: w.tag, name: w.name, mode: w.mode ?? 'local', room: session.roomName,
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
      const process = w.pid ? fixtureProcess(w.pid, w.processStartTime ?? `fixture:${id}`, w.host, w.status === 'running') : undefined
      record = await registry.update(id, old => ({ ...old, phase: 'active',
        runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: w.pid ?? 0,
          ...(process ? { process } : {}) } }], seq: old.seq + 1 }))
      await registry.finishOperation(id)
    }
    stampFixtureWorker(session.room, w.name, id)
    if (w.status !== 'running') await finishWorker(session, w.tag, w)
  }
  await projectAll(session, registry)
  return registry
}

/** A fixture worker's run ends: its exit, a done report for `done`, a stop for `dismissed`. */
export async function finishWorker(session: Session, tag: string, facts: Partial<Pick<FixtureWorker, 'status' | 'exitCode' | 'summary' | 'finishedAt' | 'stopReason'>> = {}): Promise<void> {
  const registry = await migrated(session.dir)
  const record = registry.list().find(r => r.tag === tag && !['retired', 'abandoned'].includes(r.phase))
  if (!record) throw new Error(`no fixture worker ${tag}`)
  const status = facts.status ?? 'done', run = record.runs.at(-1)!
  if (run.launch?.outcome === 'launched') finishFixtureProcess(run.launch.pid)
  if (!registry.exits(record.id).some(exit => exit.run === run.n)) await registry.writeExit(record.id,
    { run: run.n, code: facts.exitCode ?? (status === 'failed' ? 1 : 0), at: facts.finishedAt ?? Date.now(), witnessed: true })
  if (status === 'done' && !registry.reports(record.id).some(report => report.done)) {
    await registry.writeReport(record.id, { run: run.n, nonce: run.nonce, chain: [], joinedAt: record.createdAt,
      done: { at: facts.finishedAt ?? Date.now(), summary: facts.summary ?? '', changed: manifestPaths(session.room, record.name) } })
  }
  // A dismissal without a stated reason is the lead's own discard (0.16's `dismissedAt`).
  if (status === 'dismissed' && !record.stop) await registry.beginStop(record.id, facts.stopReason ?? 'discarded')
  await projectAll(session, registry)
}

/** Every lead's views in `session`'s room, written as its projector would. */
async function projectAll(session: Session, registry: WorkerRegistry): Promise<void> {
  const leads = new Set(registry.list().filter(r => r.room === session.roomName).map(r => r.lead.participant))
  for (const lead of leads) await projectWorkers(session, registry, lead, 'joined')
}

/** The registry's current (not retiring) worker under a tag, as the lifecycle helpers see it. */
export function workerByTag(dir: string, tag: string): LocalWorker | undefined {
  return localWorkers(dir, record => record.tag === tag)[0]
}
