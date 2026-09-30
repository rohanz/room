/** Stored document sizes and raw updates, read without building a Y.Doc.
 *  y-leveldb keeps each update under ['v1', name, 'update', clock] and one state-vector record under ['v1_sv', name]. */
// @ts-expect-error y-leveldb's exports omit its generated declarations.
import { getAllDocs, getCurrentUpdateClock, keyEncoding } from 'y-leveldb'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
export interface StoredSize { bytes: number; updates: number; over: boolean; reason?: string }

type Key = (string | number)[]
interface ReadStream {
  on(event: 'data', fn: (value: { key: Key; value: Uint8Array } | Uint8Array | Key) => void): ReadStream
  on(event: 'end' | 'close', fn: () => void): ReadStream
  on(event: 'error', fn: (error: Error) => void): ReadStream
  pause(): void; resume(): void; destroy(): void
}
/** The levelup handle y-leveldb opens with its own key and value encodings. */
export interface LevelDb {
  open?(): Promise<void>
  db?: { db?: { getProperty?(name: string): string } }
  createReadStream(opts: { gte: Key; lt: Key; keys: boolean; values: boolean; limit?: number; highWaterMark?: number }): ReadStream
  get(key: Key): Promise<Uint8Array>
  clear(opts: { gte: Key; lt: Key }): Promise<unknown>
  batch(ops: { type: 'put'; key: Key; value: Uint8Array }[]): Promise<unknown>
}
/** y-leveldb's LeveldbPersistence exposes its db only through `_transact`. */
export interface LevelProvider { _transact<T>(f: (db: LevelDb) => Promise<T>): Promise<T> }

const BITS32 = 0xffffffff
const updateRange = (name: string) => ({ gte: ['v1', name, 'update', 0] as Key, lt: ['v1', name, 'update', BITS32] as Key })

export function isLevelProvider(provider: unknown): provider is LevelProvider {
  return !!provider && typeof (provider as LevelProvider)._transact === 'function'
}

/** Publish the snapshot and discovery vector before clearing old records: interrupted clears keep a superset. */
export async function levelReplace(provider: LevelProvider, name: string, snapshot: Uint8Array): Promise<void> {
  // y-leveldb swallows callback errors; carry them out so hub retries still work.
  const result = await provider._transact(async db => {
    try {
      const clock = await getCurrentUpdateClock(db, name) + 1
      const vector = encoding.createEncoder()
      encoding.writeVarUint(vector, clock)
      encoding.writeVarUint8Array(vector, Y.encodeStateVectorFromUpdate(snapshot))
      await db.batch([{ type: 'put', key: ['v1', name, 'update', clock], value: Buffer.from(snapshot) },
        { type: 'put', key: ['v1_sv', name], value: Buffer.from(encoding.toUint8Array(vector)) }])
      await db.clear({ gte: updateRange(name).gte, lt: ['v1', name, 'update', clock] })
    } catch (error) { return { error } }
  })
  if (result) throw result.error
}

/** Grab the db handle; a LevelDB iterator reads a consistent snapshot, so no transaction is held while streaming. */
export async function levelDbOf(provider: LevelProvider): Promise<LevelDb> {
  let db: LevelDb | undefined
  await provider._transact(async handle => { db = handle })
  if (!db) throw new Error('LevelDB handle unavailable')
  return db
}

interface StoredTable { level: number; file: number; bytes: number; first: Buffer; last: Buffer }
interface StoredTables { tables: StoredTable[]; names: Buffer[]; firstVector: Buffer }
const escapedKey = (text: string): Buffer => {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && /^x[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 4))) { bytes.push(parseInt(text.slice(i + 2, i + 4), 16)); i += 3 }
    else bytes.push(text.charCodeAt(i))
  }
  const key = Buffer.from(bytes)
  // EscapeString does not escape printable backslashes; reject ambiguous/malformed key encodings.
  if (!keyEncoding.encode(keyEncoding.decode(key)).equals(key)) throw new Error('invalid LevelDB table key metadata')
  return key
}
/** Native table metadata uses no data-block reads; cache this snapshot for an inventory/migration pass. */
export async function levelStoredTables(db: LevelDb, names?: readonly string[]): Promise<StoredTables | undefined> {
  await db.open?.()
  const native = db.db?.db
  if (!native?.getProperty) return undefined // Other adapters fall back to the early-exit value scan.
  const tables: StoredTable[] = []
  let level = -1
  for (const line of native.getProperty('leveldb.sstables').split('\n')) {
    if (!line.trim()) continue
    const header = /^--- level (\d+) ---$/.exec(line)
    if (header) { level = Number(header[1]); continue }
    const file = /^\s*(\d+):(\d+)\['(.*)' @ \d+ : \d+ \.\. '(.*)' @ \d+ : \d+\]$/.exec(line)
    if (!file || level < 0) throw new Error('invalid LevelDB table metadata')
    const bytes = Number(file[2]), first = escapedKey(file[3]!), last = escapedKey(file[4]!)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || Buffer.compare(first, last) > 0) throw new Error('invalid LevelDB table range')
    tables.push({ level, file: Number(file[1]), bytes, first, last })
  }
  if (level < 0) throw new Error('missing LevelDB table metadata')
  // Discovery keys occupy the small v1_sv space; never seek keys inside an update block.
  const knownNames: readonly string[] = names ?? (await getAllDocs(db, false, true) as Key[]).map(key => key[1] as string)
  const firstVector = knownNames.map(name => keyEncoding.encode(['v1_sv', name]) as Buffer).sort(Buffer.compare)[0] ?? keyEncoding.encode(['v1_sv'])
  return { tables, names: knownNames.map(name => keyEncoding.encode(['v1', name]) as Buffer).sort(Buffer.compare), firstVector }
}

/** Operator visibility for large final blocks that L0 can read even when seeking beyond a table. */
export function levelOversizedTables(snapshot: StoredTables | undefined, limit: number) {
  const docName = (key: Buffer): string => {
    const parts = keyEncoding.decode(key)
    return (parts[0] === 'v1' || parts[0] === 'v1_sv') && typeof parts[1] === 'string' ? parts[1] : key.toString('hex')
  }
  return (snapshot?.tables ?? []).filter(table => table.bytes > limit).map(table =>
    ({ level: table.level, file: table.file, bytes: table.bytes, smallest: docName(table.first), largest: docName(table.last) }))
}

/** Tables opened by the merge/concatenating iterators, including initial seeks. */
export function levelReadTables(tables: readonly StoredTable[], start: Buffer, end: Buffer): StoredTable[] {
  const opened = new Set<number>(), advancing = new Set<number>()
  return tables.filter(table => {
    if (Buffer.compare(table.last, start) < 0) return false
    const intersects = Buffer.compare(table.first, end) <= 0
    // Concatenation opens the successor before the outer iterator checks its range.
    const reads = table.level === 0 || !opened.has(table.level) || intersects || advancing.has(table.level)
    opened.add(table.level)
    if (intersects) advancing.add(table.level); else advancing.delete(table.level)
    return reads
  })
}

/** Gate on tables an iterator can read, then sum raw bytes with early exit.
 *  Memtables and compression can undercount; reopening recovers legacy logs into SSTs. */
export async function levelStoredSize(db: LevelDb, name: string, limit = Infinity, snapshot?: StoredTables): Promise<StoredSize> {
  if (Number.isFinite(limit)) {
    const metadata = snapshot ?? await levelStoredTables(db)
    if (metadata) {
      const start = keyEncoding.encode(updateRange(name).gte), prefix = keyEncoding.encode(['v1', name])
      let lo = 0, hi = metadata.names.length
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (Buffer.compare(metadata.names[mid]!, prefix) <= 0) lo = mid + 1; else hi = mid }
      // Include the next doc's whole prefix: an iterator reads one key past the requested range.
      const end = Buffer.concat([metadata.names[lo] ?? metadata.firstVector, Buffer.from([0xff])])
      const bytes = levelReadTables(metadata.tables, start, end).reduce((max, table) => table.bytes > limit ? Math.max(max, table.bytes) : max, 0)
      if (bytes) return { bytes, updates: 0, over: true, reason: 'an oversized LevelDB table would be read' }
    }
  }
  return new Promise((resolve, reject) => {
    let bytes = 0, updates = 0, done = false
    const stream = db.createReadStream({ ...updateRange(name), keys: false, values: true, highWaterMark: 1 })
    const finish = (over: boolean) => { if (done) return; done = true; resolve({ bytes, updates, over }) }
    stream.on('data', value => {
      if (done) return
      bytes += (value as Uint8Array).byteLength; updates++
      if (bytes > limit) { finish(true); stream.destroy() }
    })
    stream.on('error', error => { if (!done) { done = true; reject(error) } })
    stream.on('end', () => finish(false))
    stream.on('close', () => finish(bytes > limit))
  })
}

/** Stream a document's stored updates one at a time, in clock order, with backpressure from the consumer. */
async function* records(db: LevelDb, name: string): AsyncGenerator<{ key: Key; value: Uint8Array }> {
  const queue: { key: Key; value: Uint8Array }[] = []
  let ended = false, failure: Error | undefined, wake: (() => void) | undefined
  const stream = db.createReadStream({ ...updateRange(name), keys: true, values: true, highWaterMark: 1 })
  stream.on('data', value => { queue.push(value as { key: Key; value: Uint8Array }); stream.pause(); wake?.() })
  stream.on('error', error => { failure = error; wake?.() })
  stream.on('end', () => { ended = true; wake?.() })
  stream.on('close', () => { ended = true; wake?.() })
  try {
    for (;;) {
      if (queue.length) { const next = queue.shift()!; yield next; stream.resume(); continue }
      if (failure) throw failure
      if (ended) return
      await new Promise<void>(resolve => { wake = resolve })
      wake = undefined
    }
  } finally { stream.destroy() }
}

/** Consumer demand controls the iterator, keeping only one raw record queued. */
export async function* levelStoredUpdates(db: LevelDb, name: string): AsyncGenerator<Uint8Array> {
  for await (const record of records(db, name)) yield record.value
}

/** Copy frozen raw records in bounded batches. Publish discovery last so a partial copy is replayed.
 *  Export and copy read each stored record whole: memory is bounded by the largest record, not the message cap. */
export async function levelCopyRaw(db: LevelDb, from: string, to: string): Promise<void> {
  if (from === to) throw new Error('raw copy requires distinct document names')
  let batch: { type: 'put'; key: Key; value: Uint8Array }[] = [], bytes = 0
  const flush = async () => { if (batch.length) await db.batch(batch); batch = []; bytes = 0 }
  for await (const { key, value } of records(db, from)) {
    if (bytes + value.byteLength > 1048576) await flush()
    batch.push({ type: 'put', key: ['v1', to, 'update', key[3]], value }); bytes += value.byteLength
    if (bytes >= 1048576 || batch.length >= 64) await flush()
  }
  await flush()
  const vector = await db.get(['v1_sv', from])
  await db.batch([{ type: 'put', key: ['v1_sv', to], value: vector }])
}
