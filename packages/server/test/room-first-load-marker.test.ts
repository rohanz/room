import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { levelDbOf, levelDocumentExists } from '../src/stored.js'

const root = new URL('../../../', import.meta.url).pathname
const dirs: string[] = []
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-round2-')); dirs.push(dir); return dir }
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

/** Execute real server handlers with controlled asynchronous store failures, never a listening socket. */
async function run(dir: string, scenario: string, setup = '', environment: NodeJS.ProcessEnv = {}) {
  const entry = path.join(dir, 'probe.mts')
  fs.writeFileSync(entry, `
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import net from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(path.join(root, 'package.json'))});
const { FileStore } = await import(${JSON.stringify(path.join(root, 'packages/server/src/store.ts'))});
const save = FileStore.prototype.saveRooms;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, check) => { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() > deadline) throw new Error('timed out waiting for ' + condition); await sleep(5) } };
// Wait for the hub's first normal persistence of a room instead of a fixed delay.
const persisted = async room => {
  const { getPersistence } = await import(new URL('src/utils.js', 'file://' + require.resolve('@y/websocket-server/package.json')).href);
  for (let n = 0; ; n++) {
    const stored = await getPersistence().provider.getYDoc(room);
    const saved = typeof stored.getMap('meta').get('hubIncarnation') === 'number'; stored.destroy();
    if (saved) return;
    if (n > 400) throw new Error('room was not persisted in time');
    await sleep(25);
  }
};
const pathToRegistry = ${JSON.stringify(path.join(dir, 'rooms.json'))};
const registry = () => JSON.parse(fs.readFileSync(pathToRegistry, 'utf8'));
${setup}
let server;
net.Server.prototype.listen = function() { server = this; return this };
const request = (method, url, body, headers = {}) => new Promise(resolve => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { host: 'localhost', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const res = new EventEmitter(); res.headers = {}; res.writableLength = 0; const chunks = [];
  res.setHeader = (key, value) => { res.headers[key] = value }; res.hasHeader = key => key in res.headers;
  res.writeHead = (status, headers) => { res.status = status; Object.assign(res.headers, headers); res.headersSent = true };
  res.write = chunk => { chunks.push(Buffer.from(chunk)); return true };
  res.destroy = () => { res.destroyed = true; res.emit('close') };
  res.end = body => { if (body !== undefined) chunks.push(Buffer.from(body)); res.writableEnded = true; res.writableFinished = true; res.emit('finish'); resolve({ status: res.status, body: Buffer.concat(chunks).toString('utf8') }) };
  server.emit('request', req, res);
});
const create = room => request('POST', '/rooms', { room, schema: 2 });
const close = room => request('DELETE', '/rooms', { room, schema: 2 });
const list = () => request('GET', '/rooms?schema=2');
const { installNegotiatingUpgrade } = await import(${JSON.stringify(path.join(root, 'packages/server/test/helpers/negotiating-upgrade.ts'))});
installNegotiatingUpgrade();
const connect = (room, schema = 2) => new Promise(resolve => {
  const req = new EventEmitter(); req.url = '/' + encodeURIComponent(room) + (schema ? '?schema=' + schema + '&negotiate=1' : '');
  req.headers = { host: 'localhost' }; req.socket = { remoteAddress: '127.0.0.1' };
  const socket = new EventEmitter(); socket.remoteAddress = '127.0.0.1'; socket.destroyed = false; socket.completed = resolve;
  socket.end = text => resolve({ status: Number(/^HTTP\\/1.1 (\\d+)/.exec(text)?.[1]), body: text });
  socket.destroy = () => { socket.destroyed = true; socket.emit('close') };
  server.emit('upgrade', req, socket, Buffer.alloc(0));
});
setTimeout(() => process.exit(4), 9000);
await import(${JSON.stringify(path.join(root, 'packages/server/src/index.ts'))});
await until('server startup', () => server);
try { const result = await (async () => { ${scenario} })(); console.log('RESULT ' + JSON.stringify(result)); process.exit(0) }
catch (error) { console.error(error); process.exit(2) }
`)
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', entry], {
    cwd: root, timeout: 12000,
    env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'test', GITHUB_CLIENT_ID: '',
      OIDC_ISSUER: '', YPERSISTENCE: dir, ROOM_IDLE_DAYS: '0', ROOM_TOKEN: '', ROOM_ADMINS: '', PORT: '4405', ...environment },
  })
  const line = stdout.split('\n').find(line => line.startsWith('RESULT '))
  expect(line, stdout + stderr).toBeDefined()
  return { ...JSON.parse(line!.slice(7)), log: stdout + stderr }
}

it('distinguishes exact keys from prefixes and unusual UTF-8 names with real LevelDB encoding', async () => {
  const db = new LeveldbPersistence(temp())
  try {
    const handle = await levelDbOf(db)
    const names = ['local/K', 'local/a:b', 'local/a b', 'local/é', 'local/中', 'local/🚀', 'local/' + 'a'.repeat(122)]
    for (const name of names) {
      await handle.batch([{ type: 'put', key: ['v1', name + '/main', 'update', 0], value: Buffer.from([0, 0]) },
        { type: 'put', key: ['v1_sv', name + '2'], value: Buffer.from([0]) }])
      expect(await levelDocumentExists(handle, name), name).toBe(false)
      expect(await levelDocumentExists(handle, name + '/main')).toBe(true)
      expect(await levelDocumentExists(handle, name + '2')).toBe(true)
      await handle.batch([{ type: 'put', key: ['v1', name, 'update', 0], value: Buffer.from([0, 0]) }])
      expect(await levelDocumentExists(handle, name)).toBe(true)
    }
  } finally { await db.destroy() }
})

it('keeps pending rooms invisible, reserves their capacity, and publishes only after durable save', async () => {
  const dir = temp(); fs.writeFileSync(path.join(dir, 'rooms.json'), '{}')
  const observed = await run(dir, `
const a = create('local/a'); await until('registry save held', () => release);
const during = await list(), diskDuring = registry(), excess = await create('local/b');
release(); const opened = await a, after = await list(), diskAfter = registry();
return { during, diskDuring, excess, opened, after, diskAfter };`, `
let release;
FileStore.prototype.saveRooms = async function(all) { await new Promise(resolve => { release = resolve }); return save.call(this, all) };`, { ROOM_MAX_ROOMS: '1' })
  expect(observed.during.body).not.toContain('local/a')
  expect(observed.diskDuring).toEqual({})
  expect(observed.excess.status).toBe(503)
  expect(observed.opened.status).toBe(201)
  expect(observed.after.body).toContain('local/a')
  expect(Object.keys(observed.diskAfter)).toEqual(['local/a'])
})

it('keeps a concurrent close and second create when an earlier registration save resumes', async () => {
  const dir = temp(), old = 'local/old'
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({ [old]: { at: Date.now(), branches: [], mode: 'repo', migratedAt: Date.now() } }))
  const observed = await run(dir, `
const a = create('local/a'); await until('registry save held', () => release);
const closed = close('local/old'), b = create('local/b');
await until('second create exact-key probes completed', () => secondProbe);
release(); const responses = await Promise.all([a, closed, b]);
return { responses, keys: Object.keys(registry()).sort(), listing: await list() };`, `
let release, first = true, secondProbe = false;
const LevelUP = require('levelup'), read = LevelUP.prototype.createReadStream;
LevelUP.prototype.createReadStream = function(opts) { const stream = read.call(this, opts); if (opts?.gte?.[0] === 'v1' && opts.gte[1] === 'local/b' && opts.gte.length === 2) stream.on('end', () => { secondProbe = true }); return stream };
FileStore.prototype.saveRooms = async function(all) { if (first) { first = false; await new Promise(resolve => { release = resolve }) }; return save.call(this, all) };`)
  expect(observed.responses.map((r: { status: number }) => r.status)).toEqual([201, 200, 201])
  expect(observed.keys).toEqual(['local/a', 'local/b'])
  expect(observed.listing.body).not.toContain('local/old')
})

it('does not resurrect failed registrations or erase a queued success when the one-second retry runs', async () => {
  const dir = temp(); fs.writeFileSync(path.join(dir, 'rooms.json'), '{}')
  const observed = await run(dir, `
const responses = await Promise.all([create('local/fail'), create('local/good')]);
await until('one-second registry retry scheduled', () => retry); retry();
await until('registry retry persisted', () => saved === 2);
return { responses, saves, keys: Object.keys(registry()), listing: await list() };`, `
let saves = 0, saved = 0, retry;
// Drive the production one-second retry timer without advancing wall time or LevelDB IO.
const schedule = globalThis.setTimeout;
globalThis.setTimeout = function(callback, ms, ...args) { if (ms === 1000) { retry = () => callback(...args); return { unref() {} } }; return schedule(callback, ms, ...args) };
FileStore.prototype.saveRooms = async function(all) { if (++saves === 1) throw new Error('first save failed'); await save.call(this, all); saved++ };`)
  // The two requests race to the server; whichever saves first meets the failing save.
  const rooms = ['local/fail', 'local/good']
  const statuses: number[] = observed.responses.map((r: { status: number }) => r.status)
  expect([...statuses].sort()).toEqual([201, 500])
  const failed = rooms[statuses.indexOf(500)], succeeded = rooms[statuses.indexOf(201)]
  expect(observed.saves).toBe(3)
  expect(observed.keys).toEqual([succeeded])
  expect(observed.listing.body).not.toContain(failed)
  expect(observed.listing.body).toContain(succeeded)
})

it('holds a first connection until registration is durable, then admits it', async () => {
  const dir = temp(); fs.writeFileSync(path.join(dir, 'rooms.json'), '{}')
  const observed = await run(dir, `
const opening = create('local/pending'); await until('registry save held', () => release);
let connection; const joining = connect('local/pending').then(result => { connection = result; return result });
// A blocked connection has no completion event; observe non-admission for this named window.
const NON_ADMISSION_WINDOW_MS = 40; await sleep(NON_ADMISSION_WINDOW_MS); const before = connection ?? null, diskBefore = registry();
release(); return { before, diskBefore, opening: await opening, joining: await joining, diskAfter: registry() };`, `
let release, first = true;
FileStore.prototype.saveRooms = async function(all) { if (first) { first = false; await new Promise(resolve => { release = resolve }) }; return save.call(this, all) };`)
  expect(observed.before).toBeNull()
  expect(observed.diskBefore).toEqual({})
  expect(observed.opening.status).toBe(201)
  expect(observed.joining.status, observed.log).toBe(101)
  expect(Object.keys(observed.diskAfter)).toEqual(['local/pending'])
})

it('opens and connects memory-only rooms, and reopens their existing in-memory document', async () => {
  const observed = await run(temp(), `
const opened = await create('local/memory'), joined = await connect('local/memory');
const reopened = await create('local/memory'); return { opened, joined, reopened };`, '', { YPERSISTENCE: undefined })
  expect([observed.opened.status, observed.joined.status, observed.reopened.status], observed.log).toEqual([201, 101, 200])
})

it('fails closed for an unknown persistence provider without invoking its reads or writes', async () => {
  const dir = temp(); fs.writeFileSync(path.join(dir, 'rooms.json'), '{}')
  const observed = await run(dir, `
const { setPersistence } = await import(new URL('src/utils.js', 'file://' + require.resolve('@y/websocket-server/package.json')).href); let accesses = 0;
setPersistence({ provider: { getAllDocNames: async () => { accesses++; return [] }, getYDoc: async () => { accesses++; throw new Error('must not load') }, storeUpdate: async () => { accesses++ } } });
const opened = await create('local/unknown'); return { opened, accesses, disk: registry() };`)
  expect(observed.opened.status).toBe(503)
  expect(observed.accesses).toBe(0)
  expect(observed.disk).toEqual({})
})

it.each([false, true])('first connection persists a schema-2 document after registry-only creation (restart=%s)', async restart => {
  const dir = temp(), name = 'local/schema-marker'; fs.writeFileSync(path.join(dir, 'rooms.json'), '{}')
  if (restart) expect((await run(dir, `return await create(${JSON.stringify(name)});`)).status).toBe(201)
  const connected = await run(dir, `
const room = ${JSON.stringify(name)};
const opened = ${restart ? 'undefined' : 'await create(room)'};
const oldPeer = await connect(room, 0), accepted = await connect(room);
await persisted(room); return { opened, oldPeer, accepted };`)
  if (!restart) expect(connected.opened.status).toBe(201)
  expect(connected.accepted.status, connected.log).toBe(101)
  expect(connected.oldPeer.status).toBe(426)
  expect(connected.oldPeer.body).toContain('Room requires negotiated admission; reconnect with negotiate=1')
  const db = new LeveldbPersistence(dir)
  try {
    const doc = await db.getYDoc(name)
    try {
      expect(doc.getMap('meta').get('hubIncarnation')).toBeTypeOf('number')
      expect(doc.getMap('meta').get('schemaVersion')).toBe(2)
    } finally { doc.destroy() }
  } finally { await db.destroy() }
})

it('does not add a schema marker to a pre-existing unmarked registered document', async () => {
  const dir = temp(), name = 'local/unmarked', doc = new Y.Doc()
  doc.getMap('scopes').set('retained', { summary: 'already persisted' })
  let db = new LeveldbPersistence(dir)
  try { await db.storeUpdate(name, Y.encodeStateAsUpdate(doc)) } finally { doc.destroy(); await db.destroy() }
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({ [name]: {
    at: Date.now(), branches: [], mode: 'repo', migratedAt: Date.now(),
  } }))
  const connected = await run(dir, `const accepted = await connect(${JSON.stringify(name)}); await persisted(${JSON.stringify(name)}); return accepted;`)
  expect(connected.status, connected.log).toBe(101)
  db = new LeveldbPersistence(dir)
  try {
    const stored = await db.getYDoc(name)
    try {
      expect(stored.getMap('scopes').get('retained')).toEqual({ summary: 'already persisted' })
      expect(stored.getMap('meta').get('schemaVersion')).toBeUndefined()
    } finally { stored.destroy() }
  } finally { await db.destroy() }
})

it('initializes from loaded state without any exact-key probe at first persistence', async () => {
  const dir = temp(), name = 'local/uncertain-first-load'
  fs.writeFileSync(path.join(dir, 'rooms.json'), '{}')
  const observed = await run(dir, `
const opened = await create(${JSON.stringify(name)}), before = fs.readFileSync(pathToRegistry, 'utf8');
failProbe = true;
const accepted = await connect(${JSON.stringify(name)}); await persisted(${JSON.stringify(name)});
return { opened, accepted, valueReads, before, after: fs.readFileSync(pathToRegistry, 'utf8'), probes };`, `
let failProbe = false, valueReads = 0, probes = 0;
const LevelUP = require('levelup'), read = LevelUP.prototype.createReadStream;
LevelUP.prototype.createReadStream = function(opts) {
  if (failProbe && opts?.gte?.[0] === 'v1_sv' && opts.gte.length === 2) {
    probes++;
    const stream = new EventEmitter();
    queueMicrotask(() => stream.emit('error', new Error('injected first-load probe failure')));
    return stream;
  }
  const stream = read.call(this, opts);
  if (failProbe && opts?.values !== false) stream.on('data', () => { valueReads++ });
  return stream;
};`)
  expect(observed.opened.status).toBe(201)
  expect(observed.accepted.status, observed.log).toBe(101)
  expect(observed.probes).toBe(0)
  expect(Object.keys(JSON.parse(observed.after))).toEqual(Object.keys(JSON.parse(observed.before)))
  const db = new LeveldbPersistence(dir)
  try {
    const doc = await db.getYDoc(name)
    try { expect(doc.getMap('meta').get('schemaVersion')).toBe(2) }
    finally { doc.destroy() }
  }
  finally { await db.destroy() }
})

it('preserves a pre-existing schema-2 document created before lazy initialization', async () => {
  const dir = temp(), name = 'local/already-schema2', doc = new Y.Doc()
  doc.getMap('meta').set('schemaVersion', 2)
  doc.getMap('meta').set('custom', 'retained')
  doc.getMap('scopes').set('retained', { summary: 'created before this change' })
  let db = new LeveldbPersistence(dir)
  try { await db.storeUpdate(name, Y.encodeStateAsUpdate(doc)) }
  finally { doc.destroy(); await db.destroy() }
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({ [name]: {
    at: Date.now(), branches: [], mode: 'repo', migratedAt: Date.now(),
  } }))
  const connected = await run(dir, `const accepted = await connect(${JSON.stringify(name)}); await persisted(${JSON.stringify(name)}); return accepted;`)
  expect(connected.status, connected.log).toBe(101)
  db = new LeveldbPersistence(dir)
  try {
    const stored = await db.getYDoc(name)
    try {
      expect(stored.getMap('meta').get('schemaVersion')).toBe(2)
      expect(stored.getMap('meta').get('custom')).toBe('retained')
      expect(stored.getMap('scopes').get('retained')).toEqual({ summary: 'created before this change' })
    } finally { stored.destroy() }
  } finally { await db.destroy() }
})

it.each(['close', 'expiry'])('refuses reconnect after %s removed the room, then initializes it when explicitly recreated', async removal => {
  const dir = temp(), name = 'local/recreated', now = Date.now()
  fs.writeFileSync(path.join(dir, 'rooms.json'), '{}')
  if (removal === 'expiry') {
    const db = new LeveldbPersistence(dir), doc = new Y.Doc()
    doc.getMap('meta').set('schemaVersion', 2)
    try { await db.storeUpdate(name, Y.encodeStateAsUpdate(doc)) }
    finally { doc.destroy(); await db.destroy() }
    fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({ [name]: {
      at: now - 40 * 86400000, mode: 'repo', branches: [], migratedAt: now - 40 * 86400000,
    } }))
  }
  const observed = await run(dir, `
const room = ${JSON.stringify(name)};
${removal === 'close' ? 'await create(room); await connect(room); await close(room);' : "await until('expired room removed from registry', () => !registry()[room]);"}
const refused = await connect(room), disk = registry();
const opened = await create(room), accepted = await connect(room);
await persisted(room); return { refused, disk, opened, accepted };`, '', { ROOM_IDLE_DAYS: removal === 'expiry' ? '30' : '0' })
  expect(observed.refused.status, observed.log).toBe(404)
  expect(observed.disk).toEqual({})
  expect(observed.opened.status).toBe(201)
  expect(observed.accepted.status, observed.log).toBe(101)
  const db = new LeveldbPersistence(dir)
  try {
    const doc = await db.getYDoc(name)
    try { expect(doc.getMap('meta').get('schemaVersion')).toBe(2) }
    finally { doc.destroy() }
  } finally { await db.destroy() }
})
