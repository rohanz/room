import { afterEach, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { keyEncoding, LeveldbPersistence } from 'y-leveldb'
import { levelDbOf, levelStoredTables, levelStoredSize, levelStoredUpdates, levelCopyRaw, levelReplace, levelReadTables } from '../src/stored.js'
import { migrateRepo, type MigrationIO } from '../src/migrate.js'
import type { OpenRepo } from '../src/store.js'
import { takeInventory, formatInventory } from '../src/inventory.js'

const cleanups: (() => Promise<void>)[] = []
it('opens each higher-level successor even when the global one-past-end key is in another level', () => {
  const key = (clock: number) => keyEncoding.encode(['v1', 'room', 'update', clock])
  const table = (level: number, file: number, first: number, last: number) => ({ level, file, bytes: 100, first: key(first), last: key(last) })
  const tables = [table(0, 1, 99, 100), table(1, 2, 0, 1), table(1, 3, 2, 5), table(1, 4, 20, 30), table(1, 5, 31, 40),
    table(2, 6, 6, 10), table(2, 7, 41, 50), table(3, 8, 60, 70), table(3, 9, 80, 90)]
  expect(levelReadTables(tables, key(2), key(6)).map(t => t.file)).toEqual([1, 3, 4, 6, 7, 8])
})
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-stored-')), provider = new LeveldbPersistence(dir)
  cleanups.push(async () => { await provider.destroy(); fs.rmSync(dir, { recursive: true, force: true }) })
  const doc = new Y.Doc(), updates: Uint8Array[] = []
  doc.on('update', update => { updates.push(update) })
  for (let i = 0; i < 12; i++) doc.getText('text').insert(doc.getText('text').length, `${i}-`)
  for (const update of updates) await provider.storeUpdate('from', update)
  return { provider, db: await levelDbOf(provider), doc, updates }
}
it('replaces snapshots with a matching discovery vector, preserving content across interrupted clear and replay', async () => {
  const f = await fixture(), snapshot = Y.encodeStateAsUpdate(f.doc)
  const clear = vi.spyOn(f.db, 'clear').mockRejectedValueOnce(new Error('interrupted clear'))
  await expect(levelReplace(f.provider, 'from', snapshot)).rejects.toThrow('interrupted clear')
  expect((await levelStoredSize(f.db, 'from')).updates).toBe(f.updates.length + 1)
  let loaded = await f.provider.getYDoc('from')
  expect(Y.encodeStateAsUpdate(loaded)).toEqual(snapshot); loaded.destroy()
  expect(await f.provider.getAllDocNames()).toContain('from')
  await levelReplace(f.provider, 'from', snapshot)
  expect(await levelStoredSize(f.db, 'from')).toEqual({ bytes: snapshot.byteLength, updates: 1, over: false })
  expect(await f.provider.getStateVector('from')).toEqual(Y.encodeStateVectorFromUpdate(snapshot))
  loaded = await f.provider.getYDoc('from')
  expect(Y.encodeStateAsUpdate(loaded)).toEqual(snapshot)
  expect(await f.provider.getAllDocNames()).toContain('from')
  loaded.destroy(); f.doc.destroy(); clear.mockRestore()
})
it.each([undefined, 'a-longer-name'])('rejects one large reopened SST record without an update iterator (next doc: %s)', async next => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-stored-large-'))
  let provider = new LeveldbPersistence(dir)
  cleanups.push(async () => { await provider.destroy(); fs.rmSync(dir, { recursive: true, force: true }) })
  const before = new Y.Doc(); before.getMap('fixture').set('value', 'before')
  await provider.storeUpdate('a', Y.encodeStateAsUpdate(before)); before.destroy()
  await provider.destroy(); provider = new LeveldbPersistence(dir)
  const doc = new Y.Doc()
  doc.getMap('padding').set('random', new Uint8Array(crypto.randomBytes(48 * 1048576)))
  await provider.storeUpdate('large', Y.encodeStateAsUpdate(doc)); doc.destroy()
  let smallUpdate: Uint8Array | undefined
  if (next) {
    const small = new Y.Doc(); small.getMap('fixture').set('value', 'small')
    smallUpdate = Y.encodeStateAsUpdate(small); await provider.storeUpdate(next, smallUpdate); small.destroy()
  }
  // Recovery flushes the log to SSTs; approximateSize deliberately excludes the live memtable.
  await provider.destroy(); provider = new LeveldbPersistence(dir)
  const names = await provider.getAllDocNames(), db = await levelDbOf(provider), tables = await levelStoredTables(db, names)
  const largeTable = tables!.tables.find(table => table.bytes >= 48 * 1048576)!
  expect(largeTable).toBeDefined()
  expect(keyEncoding.decode(largeTable.first)).toEqual(['v1', 'large', 'update', 0])
  const streams = vi.spyOn(db, 'createReadStream')
  const measured = await levelStoredSize(db, 'large', 8 * 1048576, tables)
  expect(measured.over).toBe(true)
  expect(measured.bytes).toBeGreaterThanOrEqual(48 * 1048576)
  expect(streams.mock.calls).toEqual([])
  expect(measured.updates).toBe(0)
  expect(measured.reason).toBe('an oversized LevelDB table would be read')
  // L0 merging seeks the huge table even for a small earlier doc in a different table.
  expect(await levelStoredSize(db, 'a', 8 * 1048576, tables)).toMatchObject({ over: true, updates: 0, reason: measured.reason })
  // The next prefix is ordered by encoded varstring length, not lexically by doc name.
  if (next) {
    expect(smallUpdate!.byteLength).toBeLessThan(100)
    // Its key lies inside the huge L0 table's span through v1_sv despite living in another SST.
    expect(await levelStoredSize(db, next, 8 * 1048576, tables)).toMatchObject({ over: true, updates: 0, reason: measured.reason })
  }
  expect(streams.mock.calls).toEqual([])
}, 60_000)
it('measures exact stored bytes and stops before all records when over the limit', async () => {
  const f = await fixture()
  const bytes = f.updates.reduce((sum, update) => sum + update.byteLength, 0)
  expect(await levelStoredSize(f.db, 'from')).toEqual({ bytes, updates: f.updates.length, over: false })
  const bounded = await levelStoredSize(f.db, 'from', f.updates[0].byteLength)
  expect(bounded.over).toBe(true); expect(bounded.updates).toBeLessThan(f.updates.length)
  expect(bounded.bytes).toBeGreaterThan(f.updates[0].byteLength)
  f.doc.destroy()
})
it('sums a small reopened document exactly below the table gate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-stored-small-'))
  let provider = new LeveldbPersistence(dir)
  cleanups.push(async () => { await provider.destroy(); fs.rmSync(dir, { recursive: true, force: true }) })
  const doc = new Y.Doc(); doc.getText('text').insert(0, 'small')
  const update = Y.encodeStateAsUpdate(doc); await provider.storeUpdate('small', update); doc.destroy()
  await provider.destroy(); provider = new LeveldbPersistence(dir)
  expect(await levelStoredSize(await levelDbOf(provider), 'small', 8 * 1048576)).toEqual({ bytes: update.byteLength, updates: 1, over: false })
})
it('reports the known final-block residual of an oversized update-only level-0 table', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-stored-last-block-'))
  let provider = new LeveldbPersistence(dir)
  cleanups.push(async () => { await provider.destroy(); fs.rmSync(dir, { recursive: true, force: true }) })
  const doc = new Y.Doc(); doc.getMap('fixture').set('value', 'small')
  const update = Y.encodeStateAsUpdate(doc)
  for (const name of ['large', 'a-longer-name']) await provider.storeUpdate(name, update)
  doc.destroy(); await provider.destroy(); provider = new LeveldbPersistence(dir)
  const large = new Y.Doc(); large.getMap('padding').set('random', new Uint8Array(crypto.randomBytes(48 * 1048576)))
  await provider.storeUpdate('large', Y.encodeStateAsUpdate(large)); large.destroy()
  await provider.destroy(); provider = new LeveldbPersistence(dir)
  const names = await provider.getAllDocNames(), db = await levelDbOf(provider), tables = await levelStoredTables(db, names)
  const huge = tables!.tables.find(table => table.bytes > 48 * 1048576)!
  expect(huge.level).toBe(0)
  expect(keyEncoding.decode(huge.last)).toEqual(['v1', 'large', 'update', 1])
  expect(Buffer.compare(huge.last, keyEncoding.encode(['v1', 'a-longer-name', 'update', 0]))).toBeLessThan(0)
  const streams = vi.spyOn(db, 'createReadStream')
  expect(await levelStoredSize(db, 'large', 8 * 1048576, tables)).toMatchObject({ over: true, updates: 0, reason: 'an oversized LevelDB table would be read' })
  expect(streams.mock.calls).toEqual([])
  // Later names may still read the huge final block via an L0 index successor; pre-flight flags the table.
  const inventory = await takeInventory(['large'], {}, (name, limit) => levelStoredSize(db, name, limit, tables), 8 * 1048576, tables)
  expect(inventory.tables).toContainEqual({ level: 0, file: huge.file, bytes: huge.bytes, smallest: 'large', largest: 'large' })
  expect(formatInventory(inventory)).toContain('tables over budget:')
}, 60_000)
it('streams all records in clock order and reproduces the document', async () => {
  const f = await fixture(), doc = new Y.Doc(), updates: Uint8Array[] = []
  for await (const update of levelStoredUpdates(f.db, 'from')) { updates.push(update); Y.applyUpdate(doc, update) }
  expect(updates.map(update => [...update])).toEqual(f.updates.map(update => [...update]))
  expect(doc.getText('text').toString()).toBe(f.doc.getText('text').toString())
  f.doc.destroy(); doc.destroy()
})
it('copies raw records and the discovery state vector without loading, and replays idempotently', async () => {
  const f = await fixture()
  await levelCopyRaw(f.db, 'from', 'to')
  await levelCopyRaw(f.db, 'from', 'to')
  expect(await f.provider.getAllDocNames()).toContain('to')
  expect(await levelStoredSize(f.db, 'to')).toEqual(await levelStoredSize(f.db, 'from'))
  const copy = await f.provider.getYDoc('to')
  expect(copy.getText('text').toString()).toBe(f.doc.getText('text').toString())
  copy.destroy(); f.doc.destroy()
})
it('migrates a single 40 MB canonical snapshot through the real raw-copy path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-stored-migrate-')), repo = 'github.com/o/r'
  let provider = new LeveldbPersistence(dir)
  cleanups.push(async () => { await provider.destroy(); fs.rmSync(dir, { recursive: true, force: true }) })
  const old = new Y.Doc(); old.getMap('padding').set('random', new Uint8Array(crypto.randomBytes(40 * 1048576)))
  await provider.storeUpdate(repo, Y.encodeStateAsUpdate(old)); old.destroy()
  await provider.destroy(); provider = new LeveldbPersistence(dir)
  const db = await levelDbOf(provider), entry: OpenRepo = { at: 1, branches: [], mode: 'branch' }
  const io: MigrationIO = {
    list: () => provider.getAllDocNames(), load: name => provider.getYDoc(name),
    stored: (name, limit) => levelStoredSize(db, name, limit), copyRaw: (from, to) => levelCopyRaw(db, from, to),
    write: (name, update) => provider.storeUpdate(name, update), clear: name => provider.clearDocument(name),
    freeze: async () => {}, revoke: async () => {}, save: async () => {},
  }
  await migrateRepo(repo, entry, io)
  expect(entry.migratedAt).toBeGreaterThan(0)
  expect(entry.step).toBe('written')
  expect(entry.legacy).toContain(entry.plan!.moved)
  expect(await levelStoredSize(db, entry.plan!.moved!)).toMatchObject({ updates: 1, over: false })
  const archived = await provider.getYDoc(entry.plan!.moved!)
  expect((archived.getMap('padding').get('random') as Uint8Array).byteLength).toBe(40 * 1048576)
  archived.destroy()
}, 60_000)
