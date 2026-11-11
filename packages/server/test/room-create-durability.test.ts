import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { levelDbOf, levelDocumentExists, levelStoredUpdates, type LevelDb } from '../src/stored.js'
import { ServerHubs } from '../src/hub.js'

const root = new URL('../../../', import.meta.url).pathname
const dirs: string[] = []
const temporary = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-server-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

async function seed(dir: string, name: string): Promise<Buffer> {
  const db = new LeveldbPersistence(dir), doc = new Y.Doc()
  doc.getMap('legacy').set('private', 'must remain byte-identical')
  const bytes = Buffer.from(Y.encodeStateAsUpdate(doc)); doc.destroy()
  try { await db.storeUpdate(name, bytes) } finally { await db.destroy() }
  return bytes
}
async function raw(dir: string, name: string): Promise<Buffer[]> {
  const db = new LeveldbPersistence(dir), out: Buffer[] = []
  try {
    for await (const update of levelStoredUpdates(await levelDbOf(db), name)) out.push(Buffer.from(update))
    return out
  } finally { await db.destroy() }
}

/** Real server handlers and LevelDB, with only listen replaced by in-process HTTP requests. */
async function probe(dir: string, scenario: string, faults = '', environment: NodeJS.ProcessEnv = {}) {
  const preload = path.join(dir, 'probe.cjs')
  fs.writeFileSync(preload, `
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');
const localRequire = createRequire(${JSON.stringify(path.join(root, 'package.json'))});
const LevelUP = localRequire('levelup');
let valueReads = 0, scans = 0;
const originalRead = LevelUP.prototype.createReadStream;
LevelUP.prototype.createReadStream = function(opts) {
  if (opts?.values !== false) valueReads++;
  if (opts?.gte?.[0] === 'v1_sv') scans++;
  return originalRead.call(this, opts);
};
${faults}
const request = (server, method, url, body, headers = {}) => new Promise(resolve => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method; req.url = url; req.headers = { host: 'localhost', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new EventEmitter(); res.headers = {}; res.writableLength = 0;
  res.setHeader = (key, value) => { res.headers[key] = value }; res.hasHeader = key => key in res.headers;
  res.writeHead = (status, headers) => { res.status = status; Object.assign(res.headers, headers); res.headersSent = true };
  res.destroy = () => { res.destroyed = true; res.emit('close') };
  res.end = body => { res.writableEnded = true; res.writableFinished = true; res.emit('finish'); resolve({ status: res.status, body: String(body) }) };
  server.emit('request', req, res);
});
require('node:net').Server.prototype.listen = function() {
  const server = this;
  setImmediate(async () => {
    try {
      const result = await (async () => { ${scenario} })();
      console.log('RESULT ' + JSON.stringify({ result, valueReads, scans }));
      process.exit(0);
    } catch (error) { console.error(error); process.exit(2) }
  });
  return this;
};
setTimeout(() => process.exit(3), 8000);
`)
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    ['--require', preload, '--import', 'tsx', 'packages/server/src/index.ts'], {
      cwd: root, timeout: 12000, env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'test',
        GITHUB_CLIENT_ID: '', DATABASE_URL: '', OIDC_ISSUER: '', YPERSISTENCE: dir,
        ROOM_IDLE_DAYS: '0', ROOM_TOKEN: '', ROOM_ADMINS: '', PORT: '4405', ...environment },
    })
  const line = stdout.split('\n').find(line => line.startsWith('RESULT '))
  expect(line, stdout + stderr).toBeDefined()
  return JSON.parse(line!.slice(7)) as { result: { status: number; body: string }[]; valueReads: number; scans: number }
}

it('fails closed without touching exact-key legacy bytes when document-name enumeration fails', async () => {
  const dir = temporary(), name = 'local/enumeration-error', before = '{}\n'
  const bytes = await seed(dir, name)
  fs.writeFileSync(path.join(dir, 'rooms.json'), before)
  const observed = await probe(dir,
    `return [await request(server, 'POST', '/rooms', { room: ${JSON.stringify(name)}, schema: 2 })];`, `
const countingRead = LevelUP.prototype.createReadStream;
LevelUP.prototype.createReadStream = function(opts) {
  if (opts?.gte?.[0] === 'v1_sv') {
    scans++;
    const stream = new EventEmitter();
    queueMicrotask(() => stream.emit('error', new Error('injected discovery read failure')));
    return stream;
  }
  return countingRead.call(this, opts);
};`)
  expect.soft(observed.result[0].status, JSON.stringify(observed)).toBe(503)
  expect(observed.result[0].body).toContain('retry')
  expect(observed.valueReads).toBe(0)
  expect.soft(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8')).toBe(before)
  const updates = await raw(dir, name)
  expect.soft(updates).toHaveLength(1)
  expect(updates[0].equals(bytes)).toBe(true)
})

it('leaves no registry entry, document, or temporary registry file after a failed create, including across restart', async () => {
  const dir = temporary(), name = 'local/failed-create', before = '{}\n'
  fs.writeFileSync(path.join(dir, 'rooms.json'), before)
  const first = await probe(dir, `return [await request(server, 'POST', '/rooms', { room: ${JSON.stringify(name)}, schema: 2 })];`, `
const fs = require('node:fs'), rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (String(to) === ${JSON.stringify(path.join(dir, 'rooms.json'))}) throw new Error('registry unavailable');
  return rename.apply(this, arguments);
};`)
  expect(first.result[0].status).toBe(500)
  expect(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8')).toBe(before)
  expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  expect(await raw(dir, name)).toEqual([])
  const retry = await probe(dir, `return [await request(server, 'POST', '/rooms', { room: ${JSON.stringify(name)}, schema: 2 })];`)
  expect(retry.result[0].status).toBe(201)
  expect(await raw(dir, name)).toEqual([])
})

it('supports a restart after registration but before the first document write: listing, cold archive/export, inventory and close', async () => {
  const dir = temporary(), name = 'local/registered-empty'
  fs.writeFileSync(path.join(dir, 'rooms.json'), '{}\n')
  const create = await probe(dir, `return [await request(server, 'POST', '/rooms', { room: ${JSON.stringify(name)}, schema: 2 })];`)
  expect(create.result[0].status).toBe(201)
  expect(await raw(dir, name)).toEqual([])
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ admin: { login: 'admin', provider: 'github', at: Date.now() } }))
  const restarted = await probe(dir, `
const headers = { authorization: 'Bearer admin' }, room = ${JSON.stringify(name)};
return [await request(server, 'GET', '/rooms?schema=2'),
  await request(server, 'GET', '/archive?repo=' + encodeURIComponent(room)),
  await request(server, 'POST', '/archive/export', { room: room + '/main', schema: 2 }),
  await request(server, 'GET', '/admin/inventory', undefined, headers),
  await request(server, 'POST', '/rooms', { room, schema: 2 }),
  await request(server, 'DELETE', '/rooms', { room, schema: 2 })];`, '', { ROOM_ADMINS: 'admin' })
  expect(restarted.result.map(row => row.status)).toEqual([200, 200, 404, 200, 200, 200])
  expect(restarted.result[0].body).toContain(name)
  expect(JSON.parse(restarted.result[1].body)).toMatchObject({ repo: name, legacy: [], unresolved: [], unresolvedTotal: 0 })
  expect(JSON.parse(restarted.result[3].body).docs).toEqual([])
  expect(await raw(dir, name)).toEqual([])
})

it('starts the real hub and persists edits on a cold, registered room with no document', async () => {
  const dir = temporary(), name = 'local/cold-empty'
  const provider = new LeveldbPersistence(dir)
  const hubs = new ServerHubs({ store: { advance: async floor => floor }, log: () => {}, full: () => false })
  const live = new Y.Doc()
  try {
    const persistence = hubs.persistence(provider)
    await persistence.bindState(name, live)
    hubs.ensure(name, live) // no markFresh survives a process restart
    await vi.waitFor(() => expect(hubs.current(name)).toBeDefined())
    live.getMap('scopes').set('worker', { summary: 'after restart' })
    await hubs.flush(live)
    const stored = await provider.getYDoc(name)
    expect(stored.getMap('scopes').get('worker')).toEqual({ summary: 'after restart' })
    expect(stored.getMap('meta').get('hubIncarnation')).toBeTypeOf('number')
    stored.destroy()
  } finally { hubs.stop(name); live.destroy(); await provider.destroy() }
})

it('expires an idle registered room with no document after restarting', async () => {
  const dir = temporary(), name = 'local/empty-expired', now = Date.now()
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({ [name]: {
    at: now - 40 * 86400000, mode: 'repo', branches: [], migratedAt: now - 40 * 86400000,
  } }))
  const result = await probe(dir, `
await new Promise(resolve => setTimeout(resolve, 50));
return [await request(server, 'GET', '/rooms?schema=2')];`, '', { ROOM_IDLE_DAYS: '30' })
  expect(result.result[0].status).toBe(200)
  expect(result.result[0].body).not.toContain(name)
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8'))).toEqual({})
  expect(await raw(dir, name)).toEqual([])
})

it('probes only exact keys, with bounded key-only seeks, including updates missing their discovery record', async () => {
  const dir = temporary(), name = 'local/exact'
  await seed(dir, name)
  await seed(dir, name + '/child')
  const provider = new LeveldbPersistence(dir)
  try {
    const db = await levelDbOf(provider)
    const streams = vi.spyOn(db, 'createReadStream')
    expect(await levelDocumentExists(db, name)).toBe(true)
    expect(streams).toHaveBeenCalledTimes(1)
    await db.batch([{ type: 'del', key: ['v1_sv', name] }])
    streams.mockClear()
    expect(await levelDocumentExists(db, name)).toBe(true)
    expect(streams).toHaveBeenCalledTimes(2)
    expect(await levelDocumentExists(db, name + '/absent')).toBe(false)
    for (const [options] of streams.mock.calls) expect(options).toMatchObject({
      keys: true, values: false, limit: 1, highWaterMark: 1,
    })
    expect(streams.mock.calls.map(([options]) => options.gte)).toEqual([
      ['v1_sv', name], ['v1', name], ['v1_sv', name + '/absent'], ['v1', name + '/absent'],
    ])
    streams.mockRestore()
  } finally { await provider.destroy() }
})

it.each(['error', 'close'])('rejects an uncertain exact-key probe ending with %s', async event => {
  const db = { createReadStream: () => {
    const stream = new EventEmitter()
    queueMicrotask(() => stream.emit(event, new Error('storage failure')))
    return stream
  } } as unknown as LevelDb
  await expect(levelDocumentExists(db, 'local/unknown')).rejects.toThrow()
})

it('can retry a fresh create after one registry save failure without requiring the retired migrator', async () => {
  const dir = temporary(), name = 'local/save-retry'
  fs.writeFileSync(path.join(dir, 'rooms.json'), '{}\n')
  const observed = await probe(dir, `
const first = await request(server, 'POST', '/rooms', { room: ${JSON.stringify(name)}, schema: 2 });
const second = await request(server, 'POST', '/rooms', { room: ${JSON.stringify(name)}, schema: 2 });
return [first, second];`, `
const fs = require('node:fs'), rename = fs.renameSync;
let failed = false;
fs.renameSync = function(from, to) {
  if (!failed && String(to) === ${JSON.stringify(path.join(dir, 'rooms.json'))}) {
    failed = true; throw new Error('injected transient registry rename failure');
  }
  return rename.apply(this, arguments);
};`)
  expect(observed.result[0].status).toBeGreaterThanOrEqual(500)
  expect(observed.result[1].status, JSON.stringify(observed)).toBeLessThan(300)
})

it('does not publish a failed registration through a queued create of another room', async () => {
  const dir = temporary(), failed = 'local/failed', good = 'local/success'
  fs.writeFileSync(path.join(dir, 'rooms.json'), '{}\n')
  const observed = await probe(dir, `return await Promise.all([
request(server, 'POST', '/rooms', { room: ${JSON.stringify(failed)}, schema: 2 }),
request(server, 'POST', '/rooms', { room: ${JSON.stringify(good)}, schema: 2 })]);`, `
const fs = require('node:fs'), rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (String(to) === ${JSON.stringify(path.join(dir, 'rooms.json'))} && fs.readFileSync(from, 'utf8').includes(${JSON.stringify(failed)}))
    throw new Error('failed registration must not be included in other saves');
  return rename.apply(this, arguments);
};`)
  expect(observed.result.map(row => row.status)).toEqual([500, 201])
  expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8')))).toEqual([good])
  expect(await raw(dir, failed)).toEqual([])
})

it('serializes concurrent creates at exactly K and preserves an unregistered descendant across close', async () => {
  const dir = temporary(), name = 'local/concurrent', descendant = `${name}/main`
  const bytes = await seed(dir, descendant)
  fs.writeFileSync(path.join(dir, 'rooms.json'), '{}\n')
  const observed = await probe(dir, `
const body = { room: ${JSON.stringify(name)}, schema: 2 };
const opened = await Promise.all([request(server, 'POST', '/rooms', body), request(server, 'POST', '/rooms', body)]);
return [...opened, await request(server, 'DELETE', '/rooms', body)];`)
  expect(observed.result.slice(0, 2).map(result => result.status).sort()).toEqual([200, 201])
  expect(observed.result[2].status).toBe(200)
  expect(observed.valueReads).toBe(0)
  const updates = await raw(dir, descendant)
  expect(updates).toHaveLength(1)
  expect(updates[0].equals(bytes)).toBe(true)
})
