import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { ServerHubs, type PersistenceProvider } from '../src/hub.js'
import { levelLoad, levelReplace } from '../src/stored.js'

const root = new URL('../../../', import.meta.url).pathname
const dirs: string[] = []
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-empty-')); dirs.push(dir); return dir }
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function fixture(adapter: string) {
  const db = adapter === 'leveldb' ? new LeveldbPersistence(temp()) : undefined
  const stored = new Map<string, Uint8Array>()
  const provider: PersistenceProvider = db ? {
    getYDoc: name => levelLoad(db, name),
    storeUpdate: (name, update) => db.storeUpdate(name, update),
    replace: (name, update) => levelReplace(db, name, update),
  } : {
    getYDoc: async name => { const doc = new Y.Doc(); if (stored.has(name)) Y.applyUpdate(doc, stored.get(name)!); return doc },
    storeUpdate: async (name, update) => { const before = stored.get(name); stored.set(name, before ? Y.mergeUpdates([before, update]) : update) },
    replace: async (name, update) => { stored.set(name, update) },
  }
  const hubs = () => new ServerHubs({ registered: () => true, full: () => false, log: () => {},
    store: { advance: async floor => floor }, compaction: { minDeleted: 1, generation: () => 'compacted' } })
  return { provider, hubs, close: () => db?.destroy() }
}

it.each(['memory', 'leveldb'])('preserves the causal meaning of out-of-order structs and delete-only updates after %s persistence', async adapter => {
  const f = fixture(adapter)
  const source = new Y.Doc(), live = new Y.Doc(), deleted = new Y.Doc(), liveDeletes = new Y.Doc()
  try {
    source.getMap('old').set('first', 'base')
    const base = Y.encodeStateAsUpdate(source), vector = Y.encodeStateVector(source)
    source.getMap('old').set('second', 'pending')
    await f.provider.storeUpdate('pending', Y.encodeStateAsUpdate(source, vector))
    deleted.getMap('old').set('gone', 'must stay deleted')
    const deleteBase = Y.encodeStateAsUpdate(deleted), deleteVector = Y.encodeStateVector(deleted)
    deleted.getMap('old').delete('gone')
    await f.provider.storeUpdate('deletes', Y.encodeStateAsUpdate(deleted, deleteVector))
    for (const [name, doc, missing] of [['pending', live, base], ['deletes', liveDeletes, deleteBase]] as const) {
      const hubs = f.hubs()
      await hubs.persistence(f.provider).bindState(name, doc); await hubs.flush(doc)
      expect(Y.decodeStateVector(Y.encodeStateVector(doc)).size).toBe(0)
      expect(doc.getMap('meta').get('schemaVersion')).toBeUndefined()
      const reloaded = await f.provider.getYDoc(name)
      try {
        Y.applyUpdate(reloaded, missing)
        expect(reloaded.getMap('old').toJSON()).toEqual(name === 'pending' ? { first: 'base', second: 'pending' } : {})
        expect(reloaded.store.pendingStructs).toBeNull()
        expect(reloaded.store.pendingDs).toBeNull()
        expect(reloaded.getMap('meta').get('schemaVersion')).toBeUndefined()
      } finally { reloaded.destroy() }
    }
  } finally { for (const d of [source, live, deleted, liveDeletes]) d.destroy(); await f.close() }
})

it.each(['memory', 'leveldb'])('does not stamp tombstone-only or unmarked legacy state, including after %s compaction', async adapter => {
  const f = fixture(adapter)
  try {
    for (const kind of ['tombstones', 'legacy']) {
      const source = new Y.Doc(), live = new Y.Doc()
      try {
        source.getMap('old').set('record', 'retained')
        if (kind === 'tombstones') source.getMap('old').delete('record')
        await f.provider.storeUpdate(kind, Y.encodeStateAsUpdate(source))
        const hubs = f.hubs()
        await hubs.persistence(f.provider).bindState(kind, live); await hubs.flush(live)
        expect(live.getMap('meta').get('schemaVersion')).toBeUndefined()
        expect(live.getMap('old').toJSON()).toEqual(kind === 'legacy' ? { record: 'retained' } : {})
        if (kind === 'tombstones') expect(live.getMap('meta').get('generation')).toBe('compacted')
      } finally { source.destroy(); live.destroy() }
    }
  } finally { await f.close() }
})

it.each(['memory', 'leveldb'])('recovers a failed first %s snapshot without duplicating the schema marker', async adapter => {
  const f = fixture(adapter), live = new Y.Doc(), reloaded = new Y.Doc()
  const replace = f.provider.replace!
  let fail = true
  f.provider.replace = async (name, update) => { if (fail) throw new Error('first persist failed'); await replace(name, update) }
  const hubs = f.hubs(), p = hubs.persistence(f.provider)
  try {
    await p.bindState('new', live)
    await expect(hubs.flush(live)).rejects.toThrow('first persist failed')
    const absent = await f.provider.getYDoc('new')
    try { expect(Y.decodeStateVector(Y.encodeStateVector(absent)).size).toBe(0) } finally { absent.destroy() }
    const once = Y.encodeStateAsUpdate(live)
    fail = false
    await vi.waitFor(() => expect(hubs.storageFailure('new')).toBeUndefined(), { timeout: 1500 })
    await hubs.flush(live)
    await p.bindState('new', reloaded); await hubs.flush(reloaded)
    expect(reloaded.getMap('meta').get('schemaVersion')).toBe(2)
    expect(Y.encodeStateAsUpdate(reloaded)).toEqual(once)
  } finally { fail = false; await hubs.flushName('new'); live.destroy(); reloaded.destroy(); await f.close() }
})

it('initializes a genuinely absent document after restart following a failed first persist', async () => {
  const dir = temp(), script = path.join(dir, 'restart.mts'), name = 'local/restart'
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({ [name]: { mode: 'repo', migratedAt: 1, branches: [], at: 1 } }))
  fs.writeFileSync(script, `
import fs from 'node:fs';
import * as Y from ${JSON.stringify(path.join(root, 'node_modules/yjs/dist/yjs.mjs'))};
import { LeveldbPersistence } from ${JSON.stringify(path.join(root, 'node_modules/y-leveldb/src/y-leveldb.js'))};
import { ServerHubs } from ${JSON.stringify(path.join(root, 'packages/server/src/hub.ts'))};
import { levelLoad, levelReplace, levelDbOf, levelDocumentExists } from ${JSON.stringify(path.join(root, 'packages/server/src/stored.ts'))};
const dir = ${JSON.stringify(dir)}, name = ${JSON.stringify(name)}, fail = process.argv[2] === 'fail';
const db = new LeveldbPersistence(dir), doc = new Y.Doc(), registry = JSON.parse(fs.readFileSync(dir + '/rooms.json', 'utf8'));
const hubs = new ServerHubs({ registered: key => !!registry[key], store: { advance: async floor => floor }, full: () => false, log: () => {} });
const provider = { getYDoc: key => levelLoad(db, key), storeUpdate: (key, data) => db.storeUpdate(key, data), replace: async (key, data) => { if (fail) throw new Error('disk failed'); await levelReplace(db, key, data) } };
await hubs.persistence(provider).bindState(name, doc);
let error; try { await hubs.flush(doc) } catch (e) { error = e.message }
console.log(JSON.stringify({ error, exists: await levelDocumentExists(await levelDbOf(db), name), marker: doc.getMap('meta').get('schemaVersion') }));
await db.destroy(); process.exit(0);
`)
  const run = async (mode: string) => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', script, mode], { cwd: root, timeout: 10000 })
    return JSON.parse(stdout.trim())
  }
  expect(await run('fail')).toEqual({ error: expect.stringContaining('disk failed'), exists: false, marker: 2 })
  expect(await run('ok')).toEqual({ exists: true, marker: 2 })
})
