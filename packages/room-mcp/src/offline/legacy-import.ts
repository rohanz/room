/** Offline-only owner of pre-registry discovery and durable source assignments. */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { RoomDoc, ROOM_DOC_MAX_BYTES } from '@room/shared'
import { legacyWorkerHost } from '../hosts/lifecycle.js'
import type { HostId } from '../hosts/types.js'
import type { WorkerRecord } from '../worker-status.js'
import { roomWorkerPathMatchesBranch } from '../worker-state.js'
import { safeTag, recordShape } from '../worker-codecs.js'
import { createExclusive, writeAtomic, type InstanceToken } from '@room/local-state/leases'
import { StorageRefused, type GateStatus } from '@room/local-state/protocol'
export interface LegacySource {
  key: string; tag: string; dir: string; branch: string; host: HostId
  oldId?: string; model?: string; task?: string; said?: string; keptWorktree?: string; share?: WorkerRecord['share']
}
export interface MigrationMap { v: 1; sources: Record<string, { id: string; state: 'assigned' | 'imported' }>; done: boolean }
const readJson = <T>(file: string): T | undefined => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T }
  catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return undefined; throw e }
}
const files = (dir: string, suffix: string): string[] => {
  try { return fs.readdirSync(dir).filter(n => n.endsWith(suffix)).map(n => path.join(dir, n)) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
}
function commitExists(commonDir: string, oid: unknown): oid is string {
  if (typeof oid !== 'string' || !/^[0-9a-f]{40,64}$/.test(oid)) return false
  try { execFileSync('git', ['--git-dir', commonDir, 'cat-file', '-e', `${oid}^{commit}`], { stdio: 'ignore' }); return true }
  catch { return false }
}
function legacySession(dir: string, oldId: string | undefined, host: LegacySource['host']): string | undefined {
  if (!oldId) return undefined
  try {
    const gitDir = execFileSync('git', ['-C', dir, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim()
    const local = readJson<{ worker_id?: string; host?: string; session_id?: string }>(path.join(gitDir, 'room-session.json'))
    return local?.worker_id === oldId && local.host === host && typeof local.session_id === 'string' ? local.session_id : undefined
  } catch { return undefined }
}

class LegacySnapshotUnavailable extends Error {}
/** The display fields of a 0.16 snapshot's tag-keyed `workers` entry. */
interface LegacyWorkerEntry { id?: string; dir?: string; host: HostId; model?: string; task?: string; summary?: string }
/** The old CRDT is display evidence only: it never supplies pid, session, base or capability. */
function legacyDisplay(commonDir: string): Map<string, Pick<LegacySource, 'oldId' | 'host' | 'model' | 'task' | 'said' | 'keptWorktree'>> {
  const found = new Map<string, Pick<LegacySource, 'oldId' | 'host' | 'model' | 'task' | 'said' | 'keptWorktree'>>()
  const canonical = (dir: string): string => { try { return fs.realpathSync(dir) } catch { return path.resolve(dir) } }
  for (const file of files(path.join(commonDir, 'room-local'), '.ydoc')) {
    const doc = new Y.Doc()
    try {
      if (fs.statSync(file).size > ROOM_DOC_MAX_BYTES) throw new Error(`snapshot exceeds ${ROOM_DOC_MAX_BYTES / 1048576} MiB`)
      Y.applyUpdate(doc, fs.readFileSync(file))
      const room = new RoomDoc(doc)
      for (const worker of doc.getMap<LegacyWorkerEntry>('workers').values()) {
        if (!worker.dir || !worker.id) continue
        found.set(canonical(worker.dir), { oldId: worker.id, host: worker.host, model: worker.model,
          task: worker.task, said: worker.summary })
      }
      for (const retired of room.retiredWorkers()) {
        if (!retired.keptWorktree) continue
        const prior = found.get(canonical(retired.keptWorktree))
        found.set(canonical(retired.keptWorktree), { ...prior, host: retired.host, model: retired.model,
          task: retired.task, said: retired.summary, keptWorktree: retired.keptWorktree })
      }
    } catch (error) {
      throw new LegacySnapshotUnavailable(`unreadable legacy snapshot: ${file}`)
    }
    finally { doc.destroy() }
  }
  return found
}

/** Conservative local discovery: only Git's own worktree list and canonical Room paths are imported. */
export function discoverLegacyWorktrees(commonDir: string): LegacySource[] {
  let output: string
  try { output = execFileSync('git', ['--git-dir', commonDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }) }
  catch { throw new StorageRefused('unavailable', 'legacy worktree inventory failed') }
  const registered = new Set([...output.matchAll(/^worktree (.+)$/gm)].map(match => {
    try { return fs.realpathSync(match[1]) } catch { return path.resolve(match[1]) }
  }))
  const display = legacyDisplay(commonDir)
  const out: LegacySource[] = []
  for (const block of output.split(/\n\s*\n/)) {
    const dir = /^worktree (.+)$/m.exec(block)?.[1]
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
    if (!dir || !branch?.startsWith('room/')) continue
    const tag = branch.slice(5)
    if (path.basename(dir) !== tag || !dir.includes(`${path.sep}.room${path.sep}workers${path.sep}`)) continue
    let canonical: string
    try { canonical = fs.realpathSync(dir) } catch { continue }
    const ownerCheckout = path.dirname(path.dirname(path.dirname(canonical)))
    if (!registered.has(ownerCheckout) || !roomWorkerPathMatchesBranch(ownerCheckout, canonical, branch)) continue
    const prior = display.get(canonical)
    out.push({ key: `worktree:${canonical}`, tag, dir: canonical, branch,
      host: legacyWorkerHost(prior?.host), ...(prior ?? {}) })
  }
  return out
}

function importLegacy(commonDir: string, identity: InstanceToken, now: () => number, source: LegacySource, workerId: string): void {
    const file = path.join(commonDir, 'room/registry/workers', `${workerId}.json`)
    const carryFile = path.join(commonDir, 'room-carry', `${source.tag}.json`)
    const migratedCarryFile = `${carryFile}.migrated`
    if (fs.existsSync(file)) {
      if (fs.existsSync(carryFile) && !fs.existsSync(migratedCarryFile)) fs.renameSync(carryFile, migratedCarryFile)
      return
    }
    const token = identity
    const carryRecord = readJson<{ base?: unknown; carriedBase?: unknown }>(carryFile)
    const base = commitExists(commonDir, carryRecord?.base) ? carryRecord.base : undefined
    const carriedBase = commitExists(commonDir, carryRecord?.carriedBase) ? carryRecord.carriedBase : undefined
    const carry = base && (!carryRecord?.carriedBase || carriedBase) ? 'delta' : 'copy'
    const hostSessionId = legacySession(source.dir, source.oldId, source.host)
    const record: WorkerRecord = {
      v: 1, id: workerId, tag: source.tag, name: '', mode: 'local', room: '',
      lead: { participant: '', room: '', instance: token }, host: source.host, model: source.model,
      budget: { threads: 1, memGb: 1, nice: 10 }, share: source.share ?? 'intent', task: source.task ?? 'legacy worker',
      dir: source.dir, outside: false, branch: source.branch, prep: { step: 'prepared' }, base,
      carriedBase, hostSessionId,
      capabilities: { resume: !!hostSessionId, signal: false, collect: carry },
      phase: source.keptWorktree ? 'retired' : 'active', keptWorktree: source.keptWorktree,
      cleanup: source.keptWorktree ? { legacy: 'done' } : undefined,
      runs: [{ n: 1, mode: 'fresh', intentAt: now(), nonce: `imported:${workerId}`, busFrontier: 0, promptMsgIds: [], launcher: token, launch: { outcome: 'imported' }, logStart: 0 }],
      legacy: { id: source.key, source: source.dir, said: source.said, unowned: true }, createdAt: now(), seq: 1,
    }
    createExclusive(path.join(commonDir, 'room/registry/tags', `${source.tag}.json`), { id: workerId, holder: token, at: now() })
    createExclusive(file, record)
    if (fs.existsSync(carryFile) && !fs.existsSync(migratedCarryFile)) fs.renameSync(carryFile, migratedCarryFile)
  }

export const legacyImportRemedy = (commonDir: string): string =>
  `node <plugin>/server/room-state.mjs import-legacy --common-dir ${JSON.stringify(commonDir)}`

/** Absence of a checkpoint is safe only when no pre-registry evidence remains. Never decode task text here. */
export function legacyImportRequired(commonDir: string, status: GateStatus['legacyImport']): boolean {
  if (status === 'done') return false
  if (status !== 'absent') return true
  try {
    if (files(path.join(commonDir, 'room-local'), '.ydoc').length || files(path.join(commonDir, 'room-carry'), '.json').length) return true
    const records = files(path.join(commonDir, 'room/registry/workers'), '.json').map(file => {
      try { const value = readJson<unknown>(file); return recordShape(value, path.basename(file, '.json')) ? value : undefined }
      catch { return undefined } // Corrupt registry evidence belongs to lifecycle recovery, not the legacy importer.
    })
    const output = execFileSync('git', ['--git-dir', commonDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024 })
    return output.split(/\n\s*\n/).some(block => {
      const dir = /^worktree (.+)$/m.exec(block)?.[1], branch = /^branch refs\/heads\/(room\/.+)$/m.exec(block)?.[1]
      return !!dir && !!branch && dir.includes(`${path.sep}.room${path.sep}workers${path.sep}`)
        && path.basename(dir) === branch.slice(5) && !records.some(record => record && path.resolve(record.dir) === path.resolve(dir))
    })
  } catch { return true }
}

/** Called only by the maintenance owner after a complete drain. The assignment is durable before each import. */
export async function importLegacyWorkers(commonDir: string, identity: InstanceToken,
  options: { sources?: (commonDir: string) => LegacySource[]; now?: () => number; verify: () => Promise<void> }): Promise<void> {
  const file = path.join(commonDir, 'room/registry/migration.json')
  const map = readJson<MigrationMap>(file) ?? { v: 1 as const, sources: {}, done: false }
  if (map.v !== 1 || typeof map.done !== 'boolean' || !map.sources || typeof map.sources !== 'object'
    || Object.values(map.sources).some(value => !value || typeof value.id !== 'string' || !/^w_[A-Za-z0-9_-]+$/.test(value.id) || !['assigned', 'imported'].includes(value.state)))
    throw new StorageRefused('unavailable', 'legacy assignment map is unreadable', legacyImportRemedy(commonDir))
  if (map.done) return
  const sources = (options.sources ?? discoverLegacyWorktrees)(commonDir)
  for (const source of sources) {
    if (!safeTag(source.tag)) throw new StorageRefused('unavailable', 'invalid legacy worker tag')
    await options.verify()
    if (!map.sources[source.key]) {
      map.sources[source.key] = { id: `w_${randomBytes(16).toString('hex')}`, state: 'assigned' }
      writeAtomic(file, map)
    }
    const target = map.sources[source.key]
    if (target.state === 'imported') continue
    importLegacy(commonDir, identity, options.now ?? Date.now, source, target.id)
    target.state = 'imported'
    writeAtomic(file, map)
  }
  await options.verify()
  map.done = true
  writeAtomic(file, map)
}
