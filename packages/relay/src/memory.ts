import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { privateStateDirectory, verifyPrivatePath } from './private-state.js'
import * as Y from 'yjs'
import { MAX_MEMORY_BYTES, ROOM_DOC_MAX_BYTES, memoryTypes, memorySnapshot } from '@room/shared'

export { MAX_MEMORY_BYTES }
const stderr = (line: string): void => { process.stderr.write(`${line}\n`) }
const mb = (bytes: number): string => (bytes / 1048576).toFixed(1)
const WARN_EVERY_MS = 60_000
const WARN_KEYS_MAX = 64
/**
 * Saves run every 2–10 s under activity; repeat a standing warning at most once a minute per key.
 * Each RoomMemory owns one, so another relay instance's warnings never suppress its first; expired
 * keys are dropped and at most 64 kept.
 */
export class WarningLimiter {
  // Insertion order is time order: a key is re-inserted only after it expired.
  private readonly warnedAt = new Map<string, number>()
  constructor(private readonly now: () => number = Date.now) {}
  get size(): number { return this.warnedAt.size }
  warn(key: string, line: () => string, log: (line: string) => void): void {
    const now = this.now()
    for (const [old, at] of this.warnedAt) {
      if (now - at < WARN_EVERY_MS) break
      this.warnedAt.delete(old)
    }
    if (this.warnedAt.has(key)) return
    this.warnedAt.set(key, now)
    if (this.warnedAt.size > WARN_KEYS_MAX) this.warnedAt.delete(this.warnedAt.keys().next().value!)
    log(line())
  }
  clear(): void { this.warnedAt.clear() }
}
/** For saves outside a RoomMemory (legacy migration, tools). */
const sharedWarnings = new WarningLimiter()
function largestRoots(update: Uint8Array): string {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, update)
    return [...memoryTypes(doc, true)]
      .map(([name, kind]) => [name, JSON.stringify(kind === 'array' ? doc.getArray(name).toJSON() : doc.getMap(name).toJSON()).length] as const)
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, size]) => `${name} ${mb(size)} MB`).join(', ')
  } finally { doc.destroy() }
}
export function memoryFile(commonDir: string, room: string): string {
  return path.join(commonDir, 'room', 'relay', `${encodeURIComponent(room)}.ydoc`)
}

function syncDirectory(dir: string): void {
  let fd: number | undefined
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd) }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

type MemoryLoadState = 'unreadable' | 'invalid' | 'capacity'
export class MemoryLoadError extends Error {
  constructor(readonly state: MemoryLoadState, readonly file: string, cause: unknown) {
    super(`local room memory ${state}: ${file}: ${cause instanceof Error ? cause.message : String(cause)}; preserve the snapshot and repair it before retrying`)
    this.name = 'MemoryLoadError'
  }
}
/** A failed read never authorizes replacing retained history with an empty room. */
export function loadMemory(commonDir: string, room: string, log = stderr): Y.Doc {
  const file = memoryFile(commonDir, room)
  let bytes: Uint8Array
  try {
    if (fs.statSync(file).size > ROOM_DOC_MAX_BYTES) throw new MemoryLoadError('capacity', file, 'snapshot exceeds load ceiling')
    if (process.platform === 'win32') verifyPrivatePath(file)
    bytes = fs.readFileSync(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Y.Doc()
    const error = e instanceof MemoryLoadError ? e : new MemoryLoadError('unreadable', file, e)
    log(error.message); throw error
  }
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, bytes)
    const schema = doc.getMap('meta').get('schemaVersion')
    if (schema !== undefined && schema !== 2) throw new Error('unsupported snapshot schema')
    return doc
  } catch (e) {
    doc.destroy()
    const error = new MemoryLoadError('invalid', file, e)
    log(error.message); throw error
  }
}

/** Atomic replacement keeps the previous good snapshot on pre-rename failures. A directory-fsync failure
 * after rename reports durability uncertainty: the new file may already be installed. Over the 5 MB target
 * after shedding, the smallest achievable snapshot is still saved, so owed mail survives a restart; only
 * one over the 64 MB ceiling (a document the team server would refuse too) is skipped. */
export function saveMemory(commonDir: string, room: string, doc: Y.Doc, log = stderr, warnings = sharedWarnings): boolean {
  return writeMemory(commonDir, room, doc, log, warnings) === undefined
}

/** saveMemory, returning why the snapshot was not saved (undefined when it was). */
function writeMemory(commonDir: string, room: string, doc: Y.Doc, log: (line: string) => void, warnings: WarningLimiter, failure?: (kind: 'capacity' | 'io', cause: string) => void, generation?: string): string | undefined {
  const file = memoryFile(commonDir, room)
  const temp = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    let shed = false
    let update = memorySnapshot(doc, { onShed: () => { shed = true }, maxBytes: MAX_MEMORY_BYTES, log: line => warnings.warn(`${file}\0shed`, () => `local room memory: ${room}: ${line}`, log) })
    if (generation !== undefined && shed) return 'snapshot would shed content'
    // Compaction and graceful-stop final saves fence survivors. Never change the live
    // replica: failed pre-rename saves retain the generation survivors can resync into.
    if (generation !== undefined) {
      const copy = new Y.Doc()
      try {
        Y.applyUpdate(copy, update)
        copy.getMap('meta').set('generation', generation)
        update = Y.encodeStateAsUpdate(copy)
      } finally { copy.destroy() }
    }
    if (update.byteLength > ROOM_DOC_MAX_BYTES) {
      const cause = `snapshot is ${mb(update.byteLength)} MB, over the ${ROOM_DOC_MAX_BYTES / 1048576} MB ceiling`
      warnings.warn(`${file}\0over`, () => `local room memory: skipping ${room}: ${cause}; keeping the last good file`, log)
      failure?.('capacity', cause)
      return cause
    }
    if (update.byteLength > MAX_MEMORY_BYTES) {
      warnings.warn(`${file}\0over`, () => `local room memory: ${room}: snapshot is ${mb(update.byteLength)} MB after dropping everything droppable (largest roots: ${largestRoots(update)}); saved anyway; target ${MAX_MEMORY_BYTES / 1048576} MB`, log)
    }
    privateStateDirectory(path.dirname(file))
    fs.chmodSync(path.dirname(file), 0o700)
    const fd = fs.openSync(temp, 'wx', 0o600)
    // Keep the writable handle: Windows cannot flush a read-only file handle.
    try { fs.writeFileSync(fd, update); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    if (process.platform === 'win32') verifyPrivatePath(temp, true)
    fs.renameSync(temp, file)
    syncDirectory(path.dirname(file))
    return undefined
  } catch (e) { const cause = e instanceof Error ? e.message : String(e); failure?.('io', cause); if (generation === undefined) warnings.warn(`${file}\0io`, () => `local room memory: cannot save ${file}: ${e}; keeping the replica and retrying`, log); return cause }
  finally { try { fs.unlinkSync(temp) } catch { /* no temp file */ } }
}

/** One owner per active relay room. Testable without opening a socket. */
export interface MemoryStatus { dirtyGeneration: number; savedGeneration: number; lastSavedAt?: number; capacity?: string; io?: string }
export class RoomMemory {
  private readonly state: MemoryStatus = { dirtyGeneration: 0, savedGeneration: 0 }
  get status(): Readonly<MemoryStatus> { return { ...this.state } }
  private retry?: ReturnType<typeof setTimeout>
  private retryDelay = 1000
  readonly doc: Y.Doc
  private debounce?: ReturnType<typeof setTimeout>
  private deadline?: ReturnType<typeof setTimeout>
  private forgotten = false
  private reconciling = false
  private readonly warnings = new WarningLimiter()
  constructor(private commonDir: string, private room: string, private log = stderr) {
    this.doc = loadMemory(commonDir, room, log)
    this.doc.on('update', this.schedule)
  }
  private schedule = () => {
    if (this.reconciling) return
    // A surviving provider can reconnect with the pre-snapshot CRDT identities. The
    // fresh value copy must not make the same historical event appear twice.
    this.reconciling = true
    try {
      this.doc.transact(() => {
        for (const name of ['bus', 'retiredWorkers']) {
          if (!this.doc.share.has(name)) continue
          const array = this.doc.getArray<Record<string, unknown>>(name), seen = new Set<string>()
          const duplicates: number[] = []
          array.toArray().forEach((value, index) => {
            if (!value || typeof value !== 'object') return
            const key = name === 'bus' ? typeof value.id === 'string' ? value.id : undefined
              : typeof value.name === 'string' && typeof value.startedAt === 'number' && typeof value.lead === 'string'
                ? JSON.stringify([value.name, value.startedAt, value.lead]) : undefined
            if (key === undefined) return
            if (seen.has(key)) duplicates.push(index)
            else seen.add(key)
          })
          for (const index of duplicates.reverse()) array.delete(index)
        }
      })
    } finally { this.reconciling = false }
    if (this.forgotten) return
    this.state.dirtyGeneration++
    clearTimeout(this.debounce)
    this.debounce = setTimeout(() => this.flush(), 2000)
    this.deadline ??= setTimeout(() => this.flush(), 10000)
    this.debounce.unref?.(); this.deadline.unref?.()
  }
  flush(): void { this.save() }
  /** Save now; returns why the snapshot was not saved, or undefined (also once forgotten: nothing is owed). */
  save(generation?: string): string | undefined {
    if (generation !== undefined) { clearTimeout(this.retry); this.retry = undefined }
    clearTimeout(this.debounce); clearTimeout(this.deadline)
    this.debounce = this.deadline = undefined
    if (this.forgotten) return undefined
    const cause = writeMemory(this.commonDir, this.room, this.doc, this.log, this.warnings, (kind, why) => { this.state[kind] = why }, generation)
    if (cause === undefined) {
      this.state.savedGeneration = this.state.dirtyGeneration
      this.state.lastSavedAt = Date.now()
      delete this.state.capacity; delete this.state.io
      clearTimeout(this.retry); this.retry = undefined; this.retryDelay = 1000
    } else if (generation === undefined && !this.retry) {
      this.retry = setTimeout(() => { this.retry = undefined; this.save() }, this.retryDelay)
      this.retry.unref?.()
      this.retryDelay = Math.min(60_000, this.retryDelay * 2)
    }
    if (generation !== undefined && cause !== undefined) {
      this.log(`local room memory: generation final save failed for ${this.room}: ${cause}; exiting without reopening`)
    }
    return cause
  }
  /** Compute the real budgeted snapshot before committing to a generation change. */
  canCompact(): boolean {
    let shed = false
    memorySnapshot(this.doc, { onShed: () => { shed = true } })
    return !shed
  }
  /** Stop saving on updates. Call only after a final save() succeeded, or the room's latest state is lost. */
  detach(): void { clearTimeout(this.retry); clearTimeout(this.debounce); clearTimeout(this.deadline); this.doc.off('update', this.schedule); this.warnings.clear() }
  forget(): void {
    // Do not let a pending debounce or surviving client restore the forgotten snapshot.
    fs.rmSync(memoryFile(this.commonDir, this.room), { force: true })
    this.forgotten = true
    clearTimeout(this.retry); this.retry = undefined
    delete this.state.capacity; delete this.state.io
    clearTimeout(this.debounce); clearTimeout(this.deadline)
    // Propagate deletions to connected replicas too, so a surviving relay owner cannot
    // restore the forgotten story from its old in-memory copy after taking over.
    this.doc.transact(() => {
      for (const [name, kind] of memoryTypes(this.doc, true)) {
        if (kind === 'map') this.doc.getMap(name).clear()
        else { const array = this.doc.getArray(name); array.delete(0, array.length) }
      }
    })
  }
  /** Final save, then detach. Rejects with FinalSaveError, still attached, if the save keeps failing. */
  async close(delays: readonly number[] = FINAL_SAVE_RETRY_MS): Promise<void> {
    await finalSave(() => [this], delays)
    this.detach()
  }
}

/**
 * Waits between attempts of a voluntary stop's final save: about 3 s in all. A full disk or an I/O error
 * can clear in that time (a build's temp files removed); longer would hold up a session that is leaving.
 */
export const FINAL_SAVE_RETRY_MS: readonly number[] = [100, 200, 400, 800, 1500]

export class FinalSaveError extends Error {
  constructor(readonly causes: string[]) { super(causes.join('; ')); this.name = 'FinalSaveError' }
}

/**
 * Save every memory in one synchronous pass, retrying the whole pass after each delay until all succeed.
 * On success the caller can tear down in the same tick, so no update lands between the save and teardown.
 * A save without a generation throws FinalSaveError after exhausted retries. A generation save makes one pass,
 * logs each failure and returns so the caller always tears down; nothing is detached here.
 */
export async function finalSave(memories: () => readonly RoomMemory[], delays: readonly number[] = FINAL_SAVE_RETRY_MS, generation?: string): Promise<void> {
  if (generation !== undefined) {
    // Never retry under the old live generation after any file may have been replaced.
    for (const memory of memories()) memory.save(generation)
    return
  }
  for (let attempt = 0; ; attempt++) {
    const causes = memories().map(m => m.save(generation)).filter((cause): cause is string => cause !== undefined)
    if (!causes.length) return
    if (attempt >= delays.length) throw new FinalSaveError([...new Set(causes)])
    await new Promise(resolve => setTimeout(resolve, delays[attempt]))
  }
}
