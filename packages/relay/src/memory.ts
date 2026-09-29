import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as Y from 'yjs'
import { MAX_MEMORY_BYTES, ROOM_DOC_MAX_BYTES, memoryTypes, memorySnapshot } from '@room/shared'

export { MAX_MEMORY_BYTES }
const stderr = (line: string): void => { process.stderr.write(`${line}\n`) }
const mb = (bytes: number): string => (bytes / 1048576).toFixed(1)
const WARN_EVERY_MS = 60_000
const warnedAt = new Map<string, number>()
/** Saves run every 2–10 s under activity; repeat a standing warning at most once a minute per room. */
function warnLimited(key: string, line: () => string, log: (line: string) => void): void {
  const now = Date.now()
  if (now - (warnedAt.get(key) ?? -Infinity) < WARN_EVERY_MS) return
  warnedAt.set(key, now); log(line())
}
function largestRoots(update: Uint8Array): string {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, update)
    return [...memoryTypes(doc)]
      .map(([name, kind]) => [name, JSON.stringify(kind === 'array' ? doc.getArray(name).toJSON() : doc.getMap(name).toJSON()).length] as const)
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, size]) => `${name} ${mb(size)} MB`).join(', ')
  } finally { doc.destroy() }
}
export function memoryFile(commonDir: string, room: string): string {
  return path.join(commonDir, 'room', 'relay', `${encodeURIComponent(room)}.ydoc`)
}

/** Failure is isolated to a disposable doc; even a partially applied corrupt update is discarded. */
export function loadMemory(commonDir: string, room: string, log = stderr): Y.Doc {
  const doc = new Y.Doc(), file = memoryFile(commonDir, room)
  try {
    if (fs.statSync(file).size > ROOM_DOC_MAX_BYTES) throw new Error(`snapshot exceeds ${ROOM_DOC_MAX_BYTES / 1048576} MB`)
    Y.applyUpdate(doc, fs.readFileSync(file))
    return doc
  } catch (e) {
    doc.destroy()
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`local room memory: cannot load ${file}: ${e}; starting empty`)
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* unreadable directory: keep running */ }
    }
    return new Y.Doc()
  }
}

/** Atomic replacement keeps the previous good snapshot on any write/rename failure. Over the 5 MB target
 * after shedding, the smallest achievable snapshot is still saved, so owed mail survives a restart; only
 * one over the 64 MB ceiling (a document the team server would refuse too) is skipped. */
export function saveMemory(commonDir: string, room: string, doc: Y.Doc, log = stderr): boolean {
  const file = memoryFile(commonDir, room)
  const temp = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    const update = memorySnapshot(doc, { maxBytes: MAX_MEMORY_BYTES, log: line => warnLimited(`${file}\0shed`, () => `local room memory: ${room}: ${line}`, log) })
    if (update.byteLength > ROOM_DOC_MAX_BYTES) {
      warnLimited(`${file}\0over`, () => `local room memory: skipping ${room}: snapshot is ${mb(update.byteLength)} MB, over the ${ROOM_DOC_MAX_BYTES / 1048576} MB ceiling; keeping the last good file`, log)
      return false
    }
    if (update.byteLength > MAX_MEMORY_BYTES) {
      warnLimited(`${file}\0over`, () => `local room memory: ${room}: snapshot is ${mb(update.byteLength)} MB after dropping everything droppable (largest roots: ${largestRoots(update)}); saved anyway; target ${MAX_MEMORY_BYTES / 1048576} MB`, log)
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.dirname(file), 0o700)
    fs.writeFileSync(temp, update, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
    return true
  } catch (e) { log(`local room memory: cannot save ${file}: ${e}`); return false }
  finally { try { fs.unlinkSync(temp) } catch { /* no temp file */ } }
}

/** One owner per active relay room. Testable without opening a socket. */
export class RoomMemory {
  readonly doc: Y.Doc
  private debounce?: ReturnType<typeof setTimeout>
  private deadline?: ReturnType<typeof setTimeout>
  private forgotten = false
  private reconciling = false
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
    clearTimeout(this.debounce)
    this.debounce = setTimeout(() => this.flush(), 2000)
    this.deadline ??= setTimeout(() => this.flush(), 10000)
    this.debounce.unref?.(); this.deadline.unref?.()
  }
  flush(): void {
    clearTimeout(this.debounce); clearTimeout(this.deadline)
    this.debounce = this.deadline = undefined
    if (!this.forgotten) saveMemory(this.commonDir, this.room, this.doc, this.log)
  }
  forget(): void {
    // Do not let a pending debounce or surviving client restore the forgotten snapshot.
    fs.rmSync(memoryFile(this.commonDir, this.room), { force: true })
    this.forgotten = true
    clearTimeout(this.debounce); clearTimeout(this.deadline)
    // Propagate deletions to connected replicas too, so a surviving relay owner cannot
    // restore the forgotten story from its old in-memory copy after taking over.
    this.doc.transact(() => {
      for (const [name, kind] of memoryTypes(this.doc)) {
        if (kind === 'map') this.doc.getMap(name).clear()
        else { const array = this.doc.getArray(name); array.delete(0, array.length) }
      }
    })
  }
  close(): void { this.flush(); this.doc.off('update', this.schedule) }
}
