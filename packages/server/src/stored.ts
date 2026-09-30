/** Stored document sizes and raw updates, read without building a Y.Doc.
 *  y-leveldb keeps each update under ['v1', name, 'update', clock] and one state-vector record under ['v1_sv', name]. */
export interface StoredSize { bytes: number; updates: number; over: boolean }

type Key = (string | number)[]
interface ReadStream {
  on(event: 'data', fn: (value: { key: Key; value: Uint8Array } | Uint8Array | Key) => void): ReadStream
  on(event: 'end' | 'close', fn: () => void): ReadStream
  on(event: 'error', fn: (error: Error) => void): ReadStream
  pause(): void; resume(): void; destroy(): void
}
/** The levelup handle y-leveldb opens with its own key and value encodings. */
export interface LevelDb {
  createReadStream(opts: { gte: Key; lt: Key; keys: boolean; values: boolean; limit?: number; highWaterMark?: number }): ReadStream
  get(key: Key): Promise<Uint8Array>
  batch(ops: { type: 'put'; key: Key; value: Uint8Array }[]): Promise<unknown>
}
/** y-leveldb's LeveldbPersistence exposes its db only through `_transact`. */
export interface LevelProvider { _transact<T>(f: (db: LevelDb) => Promise<T>): Promise<T> }

const BITS32 = 0xffffffff
const updateRange = (name: string) => ({ gte: ['v1', name, 'update', 0] as Key, lt: ['v1', name, 'update', BITS32] as Key })

export function isLevelProvider(provider: unknown): provider is LevelProvider {
  return !!provider && typeof (provider as LevelProvider)._transact === 'function'
}

/** Grab the db handle; a LevelDB iterator reads a consistent snapshot, so no transaction is held while streaming. */
export async function levelDbOf(provider: LevelProvider): Promise<LevelDb> {
  let db: LevelDb | undefined
  await provider._transact(async handle => { db = handle })
  if (!db) throw new Error('LevelDB handle unavailable')
  return db
}

/** Sum stored update bytes, stopping as soon as the total passes `limit`: `bytes` is then a lower bound. */
export function levelStoredSize(db: LevelDb, name: string, limit = Infinity): Promise<StoredSize> {
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

/** Copy frozen raw records in bounded batches. Publish discovery last so a partial copy is replayed. */
export async function levelCopyRaw(db: LevelDb, from: string, to: string): Promise<void> {
  if (from === to) throw new Error('raw copy requires distinct document names')
  let batch: { type: 'put'; key: Key; value: Uint8Array }[] = [], bytes = 0
  const flush = async () => { if (batch.length) await db.batch(batch); batch = []; bytes = 0 }
  for await (const { key, value } of records(db, from)) {
    if (value.byteLength > Number(process.env.ROOM_MAX_MESSAGE_MB ?? 16) * 1048576) throw new Error('stored update too large to copy')
    if (bytes + value.byteLength > 1048576) await flush()
    batch.push({ type: 'put', key: ['v1', to, 'update', key[3]], value }); bytes += value.byteLength
    if (batch.length >= 64) await flush()
  }
  await flush()
  const vector = await db.get(['v1_sv', from])
  await db.batch([{ type: 'put', key: ['v1_sv', to], value: vector }])
}
