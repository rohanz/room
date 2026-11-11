import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { ServerHubs, type PersistenceProvider } from '../src/hub.js'
import { docGeneration } from '@room/shared'

const root = new URL('../../../', import.meta.url).pathname
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

/** Real cold-load admission and persistence; only listening and WebSocket transport are replaced. */
async function probe(existing: boolean, registered = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-cold-load-')); dirs.push(dir)
  const name = 'local/cold-load'
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify(!registered ? {} : { [name]: {
    at: Date.now(), mode: 'repo', branches: [], migratedAt: Date.now(),
  } }))
  if (existing) {
    const db = new LeveldbPersistence(dir), doc = new Y.Doc()
    doc.getMap('meta').set('schemaVersion', 2)
    doc.getMap('scopes').set('retained', { summary: 'healthy existing state' })
    try { await db.storeUpdate(name, Y.encodeStateAsUpdate(doc)) }
    finally { doc.destroy(); await db.destroy() }
  }
  const entry = path.join(dir, 'probe.mts')
  fs.writeFileSync(entry, `
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(path.join(root, 'package.json'))});
const room = ${JSON.stringify(name)};
const LevelUP = require('levelup'), original = LevelUP.prototype.createReadStream;
let fail = true, failures = 0, writes = 0;
LevelUP.prototype.createReadStream = function(opts) {
  if (fail && opts?.gte?.[0] === 'v1_sv' && opts.gte.length === 2) {
    failures++;
    const stream = new EventEmitter();
    queueMicrotask(() => stream.emit('error', new Error('transient state-vector key seek failure')));
    return stream;
  }
  return original.call(this, opts);
};
const batch = LevelUP.prototype.batch;
LevelUP.prototype.batch = function(...args) { writes++; return batch.apply(this, args) };
let server;
net.Server.prototype.listen = function() { server = this; return this };
const { WebSocketServer } = require('ws');
WebSocketServer.prototype.handleUpgrade = function(req, socket, head, done) {
  const ws = new EventEmitter(); ws.readyState = 1; ws.bufferedAmount = 0;
  ws.send = (data, ...args) => args.find(arg => typeof arg === 'function')?.(); ws.ping = () => {};
  ws.close = ws.terminate = () => { if (ws.readyState === 3) return; ws.readyState = 3; ws.emit('close') };
  done(ws); socket.completed({ status: 101 });
};
const connect = () => new Promise(resolve => {
  const req = new EventEmitter(); req.url = '/' + encodeURIComponent(room) + '?schema=2';
  req.headers = { host: 'localhost' }; req.socket = { remoteAddress: '127.0.0.1' };
  const socket = new EventEmitter(); socket.remoteAddress = '127.0.0.1'; socket.destroyed = false; socket.completed = resolve;
  socket.end = text => resolve({ status: Number(/^HTTP\\/1.1 (\\d+)/.exec(text)?.[1]), body: text });
  socket.destroy = () => { socket.destroyed = true; socket.emit('close') };
  server.emit('upgrade', req, socket, Buffer.alloc(0));
});
setTimeout(() => process.exit(4), 9000);
await import(${JSON.stringify(path.join(root, 'packages/server/src/index.ts'))});
while (!server) await new Promise(resolve => setTimeout(resolve, 5));
const { getPersistence } = await import(new URL('src/utils.js', 'file://' + require.resolve('@y/websocket-server/package.json')).href);
const first = await connect(), writesAfterFirst = writes;
// The normal document reader does not seek the state-vector namespace and remains healthy.
const readable = await getPersistence().provider.getYDoc(room);
const retained = readable.getMap('scopes').get('retained'); readable.destroy();
fail = false;
const second = await connect();
console.log('RESULT ' + JSON.stringify({ first, second, failures, writesAfterFirst, retained }));
process.exit(0);
`)
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', entry], {
    cwd: root, timeout: 12000,
    env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'test', GITHUB_CLIENT_ID: '', DATABASE_URL: '',
      OIDC_ISSUER: '', YPERSISTENCE: dir, ROOM_IDLE_DAYS: '0', ROOM_TOKEN: '', ROOM_ADMINS: '', PORT: '4405' },
  })
  const line = stdout.split('\n').find(line => line.startsWith('RESULT '))
  expect(line, stdout + stderr).toBeDefined()
  return { ...JSON.parse(line!.slice(7)), log: stdout + stderr }
}

it('loads an existing healthy schema-2 room when only the new existence probe is unavailable', async () => {
  const observed = await probe(true)
  expect(observed.retained).toEqual({ summary: 'healthy existing state' })
  expect(observed.first.status, observed.log).toBe(101)
  expect(observed.failures).toBe(0)
})

it('retries a registered empty room after its transient first-load existence probe recovers', async () => {
  const observed = await probe(false)
  expect(observed.first.status, observed.log).toBe(101)
  expect(observed.failures).toBe(0)
  expect(observed.second.status, observed.log).toBe(101)
})

it.each([false, true])('refuses an unregistered room before probing or writing its document (stored=%s)', async existing => {
  const observed = await probe(existing, false)
  expect(observed.first.status).toBe(404)
  expect(observed.second.status).toBe(404)
  expect(observed.failures).toBe(0)
  expect(observed.writesAfterFirst).toBe(0)
})

function memory() {
  const stored = new Map<string, Uint8Array>()
  const provider: PersistenceProvider = {
    getYDoc: async name => { const doc = new Y.Doc(); if (stored.has(name)) Y.applyUpdate(doc, stored.get(name)!); return doc },
    storeUpdate: async (name, update) => { const before = stored.get(name); stored.set(name, before ? Y.mergeUpdates([before, update]) : update) },
    replace: async (name, update) => { stored.set(name, update) },
  }
  return { stored, provider }
}

it('stores the marker through the normal snapshot path once, retains it on reload, and preserves it through compaction', async () => {
  const { stored, provider } = memory(), name = 'local/marker-order', documents: Y.Doc[] = []
  const options = { store: { advance: async (floor: number) => floor }, log: () => {}, full: () => false,
    registered: (room: string) => room === name }
  const hubs = new ServerHubs(options), p = hubs.persistence(provider)
  try {
    const first = new Y.Doc(); documents.push(first)
    await p.bindState(name, first); await hubs.flush(first)
    const original = stored.get(name)!
    expect(first.getMap('meta').get('schemaVersion')).toBe(2)
    const reloaded = new Y.Doc(); documents.push(reloaded)
    await p.bindState(name, reloaded); await hubs.flush(reloaded)
    expect(stored.get(name)).toEqual(original) // no new Yjs item for a redundant marker write
    for (let n = 0; n < 20; n++) reloaded.getMap('churn').set('one', n)
    await hubs.flush(reloaded)
    const next = new ServerHubs({ ...options, compaction: { minDeleted: 1, generation: () => 'after-compaction' } })
    const compacted = new Y.Doc(); documents.push(compacted)
    await next.persistence(provider).bindState(name, compacted); await next.flush(compacted)
    expect(docGeneration(compacted)).toBe('after-compaction')
    expect(compacted.getMap('meta').get('schemaVersion')).toBe(2)
    expect(compacted.getMap('churn').get('one')).toBe(19)
    const persisted = await provider.getYDoc(name); documents.push(persisted)
    expect(persisted.getMap('meta').get('schemaVersion')).toBe(2)
    expect(docGeneration(persisted)).toBe('after-compaction')
  } finally { for (const doc of documents) doc.destroy() }
})

it('drains a recovered write before checking loaded state and never stamps the recovered unmarked document', async () => {
  const { stored, provider } = memory(), name = 'local/recovered'
  let registered = false, fail = false, probes = 0
  const replace = provider.replace!
  provider.replace = async (room, update) => { if (fail) throw new Error('temporary write failure'); await replace(room, update) }
  // Use the same full-snapshot retry path even for the subsequent edit.
  provider.storeUpdate = async (room, update) => { if (fail) throw new Error('temporary write failure'); await replace(room, update) }
  const hubs = new ServerHubs({ store: { advance: async floor => floor }, log: () => {}, full: () => false,
    registered: () => { probes++; return registered } })
  const p = hubs.persistence(provider), old = new Y.Doc(), current = new Y.Doc()
  try {
    await p.bindState(name, old); await hubs.flush(old)
    expect(Y.decodeStateVector(Y.encodeStateVector(old)).size).toBe(0)
    fail = true; old.getMap('scopes').set('retained', { summary: 'must recover first' })
    await vi.waitFor(() => expect(hubs.storageFailure(name)).toContain('temporary write failure'))
    registered = true
    const loading = p.bindState(name, current)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(probes).toBe(1)
    fail = false
    await loading; await hubs.flush(current)
    expect(probes).toBe(2)
    expect(current.getMap('scopes').get('retained')).toEqual({ summary: 'must recover first' })
    expect(current.getMap('meta').get('schemaVersion')).toBeUndefined()
  } finally { fail = false; await hubs.flushName(name); old.destroy(); current.destroy() }
})

it.each(['memory', 'leveldb'])('decides empty versus retained and pending Yjs state from the normal %s read', async adapter => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-loaded-state-')); dirs.push(dir)
  const level = adapter === 'leveldb' ? new LeveldbPersistence(dir) : undefined
  const provider = level ?? memory().provider
  const hubs = new ServerHubs({ store: { advance: async floor => floor }, log: () => {}, full: () => false,
    registered: room => room !== 'local/unregistered' })
  const persistence = hubs.persistence(provider), documents: Y.Doc[] = []
  const doc = () => { const d = new Y.Doc(); documents.push(d); return d }
  try {
    const tombstones = doc(), pending = doc(), deletes = doc()
    tombstones.getMap('data').set('removed', 1); tombstones.getMap('data').delete('removed')
    pending.getMap('data').set('first', 1)
    const beforePending = Y.encodeStateVector(pending)
    pending.getMap('data').set('second', 2)
    deletes.getMap('data').set('removed', 1)
    const beforeDelete = Y.encodeStateVector(deletes)
    deletes.getMap('data').delete('removed')
    for (const [name, update] of [
      ['tombstones', Y.encodeStateAsUpdate(tombstones)],
      ['pending-structs', Y.encodeStateAsUpdate(pending, beforePending)],
      ['pending-deletes', Y.encodeStateAsUpdate(deletes, beforeDelete)],
    ] as const) await provider.storeUpdate(`local/${name}`, update)
    for (const name of ['empty', 'tombstones', 'pending-structs', 'pending-deletes', 'unregistered']) {
      const key = `local/${name}`, read = await provider.getYDoc(key)
      documents.push(read)
      const vectorEmpty = Y.decodeStateVector(Y.encodeStateVector(read)).size === 0
      expect(read.getMap('meta').size).toBe(0) // no hub incarnation or schema metadata before binding
      expect(vectorEmpty).toBe(name !== 'tombstones')
      expect(!!read.store.pendingStructs).toBe(name === 'pending-structs')
      expect(!!read.store.pendingDs).toBe(name === 'pending-deletes')
      const live = doc()
      await persistence.bindState(key, live); await hubs.flush(live)
      expect(live.getMap('meta').get('schemaVersion'), `${adapter}/${name}`).toBe(name === 'empty' ? 2 : undefined)
      expect(live.getMap('meta').get('hubIncarnation')).toBeUndefined() // ensure/startHub runs later
      const reloaded = await provider.getYDoc(key); documents.push(reloaded)
      expect(reloaded.getMap('meta').get('schemaVersion')).toBe(name === 'empty' ? 2 : undefined)
      expect(!!reloaded.store.pendingStructs).toBe(name === 'pending-structs')
      expect(!!reloaded.store.pendingDs).toBe(name === 'pending-deletes')
    }
  } finally { for (const d of documents) d.destroy(); await level?.destroy() }
})
