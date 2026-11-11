import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { safeRoomRegistry, archiveDocumentNames, closeDocumentNames } from '../src/registry.js'
import { classifyDoc } from '../src/inventory.js'
import { levelDbOf, levelStoredUpdates } from '../src/stored.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-retire-server-')); dirs.push(dir); return dir }
const root = new URL('../../../', import.meta.url).pathname
const now = 1794441600000, day = 86400000

async function rawUpdates(db: LeveldbPersistence, name: string): Promise<Buffer[]> {
  const stored: Buffer[] = []
  for await (const update of levelStoredUpdates(await levelDbOf(db), name)) stored.push(Buffer.from(update))
  return stored
}

async function expectRawUpdate(db: LeveldbPersistence, name: string, expected: Buffer): Promise<void> {
  const updates = await rawUpdates(db, name)
  expect(updates).toHaveLength(1)
  expect(updates[0]!.equals(expected)).toBe(true)
}

async function openWithoutSockets(dir: string, room: string) {
  const probe = path.join(dir, 'open-probe.cjs')
  fs.writeFileSync(probe, `
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');
const localRequire = createRequire(${JSON.stringify(path.join(root, 'package.json'))});
const LevelUP = localRequire('levelup'), original = LevelUP.prototype.createReadStream;
let valueReads = 0;
LevelUP.prototype.createReadStream = function (opts) { if (opts?.values !== false) valueReads++; return original.call(this, opts); };
require('node:net').Server.prototype.listen = function (...args) {
  const server = this;
  setImmediate(() => {
    const req = Readable.from([Buffer.from(JSON.stringify({ room: ${JSON.stringify(room)}, schema: 2 }))]);
    req.url = '/rooms'; req.method = 'POST'; req.headers = {host:'localhost'};
    req.socket = {remoteAddress:'127.0.0.1'};
    const res = new EventEmitter(); res.headers = {};
    res.setHeader = (k,v) => {res.headers[k] = v}; res.hasHeader = k => k in res.headers;
    res.writeHead = (status, headers) => {res.status = status; Object.assign(res.headers,headers); res.headersSent = true};
    res.destroy = () => {res.destroyed = true; res.emit('close')};
    res.end = body => {res.writableEnded = true; res.writableFinished = true; res.emit('finish');
      console.log('RESULT ' + JSON.stringify({status:res.status, body:String(body), valueReads}));
      setImmediate(() => process.exit(0));
    };
    server.emit('request', req, res);
  }); return this;
};
setTimeout(() => process.exit(2), 6000);
`)
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--require', probe, '--import', 'tsx', 'packages/server/src/index.ts'], {
    cwd: root, timeout: 10000, env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'test', GITHUB_CLIENT_ID: '', DATABASE_URL: '',
      OIDC_ISSUER: '', YPERSISTENCE: dir, ROOM_IDLE_DAYS: '0', ROOM_TOKEN: '', PORT: '4404' },
  })
  const result = stdout.split('\n').find(line => line.startsWith('RESULT '))
  expect(result, stdout + stderr).toBeDefined()
  return JSON.parse(result!.slice(7)) as { status: number; body: string; valueReads: number }
}

it('preserves completed registries and their historical archive ownership fields exactly', () => {
  const repo = 'github.com/o/r', branch = `${repo}/main`, historical = `${repo}/topic%2Fbranch`
  const moved = `archive:${repo}:12345678-1234-1234-1234-123456789abc`
  const entry = { at: 1, by: 'o', lastSeen: 2, branches: [branch, historical], legacy: [branch, historical, moved],
    mode: 'repo' as const, step: 'written' as const, migratedAt: 3, unresolved: 4,
    plan: { id: 'plan', sources: [branch, historical, moved], moved },
    migrationSkippedSources: 2, migrationSkippedRecords: 3, migrationSkippedRecordCountsUnknown: 1,
    quarantined: [{ name: historical, bytes: 100000, over: true, reason: 'old oversized archive' }] }
  const all = { [repo]: entry }, before = JSON.stringify(all), safe = safeRoomRegistry(all)
  expect(safe).toEqual(all)
  expect(JSON.stringify(all)).toBe(before)
  expect(archiveDocumentNames(repo, entry, [], new Set([repo]))).toEqual([branch, historical, moved])
  expect(closeDocumentNames(repo, entry, new Set([repo]))).toEqual([repo, branch, historical, moved])
  expect(classifyDoc(moved, safe).kind).toBe('archive')
  expect(classifyDoc(historical, safe).kind).toBe('served')
})

it.each([29, 30, 31, 40])('keeps the unset-ROOM_LEGACY_DAYS expiry boundary at age %i days', async age => {
  const dir = tmp(), repo = 'local/repo', legacy = `${repo}/main`
  let db = new LeveldbPersistence(dir)
  const doc = new Y.Doc(); doc.getMap('meta').set('schemaVersion', 2)
  doc.getMap('unresolved').set('old', { placeholder: '?old', claims: [] })
  await db.storeUpdate(repo, Y.encodeStateAsUpdate(doc)); doc.destroy()
  const old = new Y.Doc(); old.getMap('scope').set('legacy', 'retained')
  await db.storeUpdate(legacy, Y.encodeStateAsUpdate(old)); old.destroy(); await db.destroy()
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({ [repo]: { at: now, lastSeen: now,
    mode: 'repo', branches: [legacy], legacy: [legacy], migratedAt: now - age * day, unresolved: 1 } }))
  const probe = path.join(dir, 'probe.cjs')
  // Exercise the real startup expiry without binding sockets; the fixed clock tests the exact boundary.
  fs.writeFileSync(probe, `
Date.now = () => ${now};
require('node:net').Server.prototype.listen = function (...args) {
  const done = args.find(a => typeof a === 'function'); if (done) setImmediate(done);
  // Younger archives must remain untouched: expiry has no completion signal in that case.
  const NO_ARCHIVE_EXPIRY_WINDOW_MS = 700;
  if (${age} <= 30) setTimeout(() => process.exit(0), NO_ARCHIVE_EXPIRY_WINDOW_MS);
  else {
    const deadline = performance.now() + 5000;
    const check = () => {
      const saved = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(path.join(dir, 'rooms.json'))}, 'utf8'));
      if (saved[${JSON.stringify(repo)}].legacy.length === 0) return process.exit(0);
      if (performance.now() > deadline) { console.error('timed out waiting for archive expiry persistence'); return process.exit(2) }
      setTimeout(check, 5);
    };
    setImmediate(check);
  }
  return this;
};
`)
  const env = { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'test', GITHUB_CLIENT_ID: '', DATABASE_URL: '',
    OIDC_ISSUER: '', YPERSISTENCE: dir, ROOM_IDLE_DAYS: '0', ROOM_TOKEN: '', PORT: '4404' }
  delete env.ROOM_LEGACY_DAYS
  const { stdout } = await promisify(execFile)(process.execPath, ['--require', probe, '--import', 'tsx', 'packages/server/src/index.ts'],
    { cwd: root, timeout: 10000, env })
  expect(stdout).toContain('room server listening')
  expect(stdout).not.toContain('room expiry failed')
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8'))[repo]
  expect(saved.legacy).toEqual(age > 30 ? [] : [legacy])
  db = new LeveldbPersistence(dir)
  try {
    expect((await db.getAllDocNames()).includes(legacy)).toBe(age <= 30)
    const current = await db.getYDoc(repo)
    expect(current.getMap('unresolved').has('old')).toBe(age <= 30)
    expect(current.getMap('meta').get('schemaVersion')).toBe(2); current.destroy()
  } finally { await db.destroy() }
})

it('refuses an unregistered oversized old document before reading or rewriting its values', async () => {
  const dir = tmp(), repo = 'local/old', source = repo, before = '{}\n'
  let db = new LeveldbPersistence(dir)
  const old = new Y.Doc(); old.getMap('old').set('data', new Uint8Array(2 * 1048576))
  const update = Y.encodeStateAsUpdate(old); old.destroy()
  await db.storeUpdate(source, update); await db.destroy()
  fs.writeFileSync(path.join(dir, 'rooms.json'), before)
  expect(await openWithoutSockets(dir, repo)).toMatchObject({ status: 409, body: expect.stringMatching(/v0\.17\.47/), valueReads: 0 })
  expect(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8')).toBe(before)
  db = new LeveldbPersistence(dir)
  try {
    expect(await db.getAllDocNames()).toEqual([source])
    await expectRawUpdate(db, source, Buffer.from(update))
    const doc = await db.getYDoc(source)
    expect(doc.getMap('meta').get('schemaVersion')).toBeUndefined()
    expect((doc.getMap('old').get('data') as Uint8Array).byteLength).toBe(2 * 1048576); doc.destroy()
  } finally { await db.destroy() }
})

it('opens a new parent custom room beside a registered child room with a retained 0.17 archive', async () => {
  const dir = tmp(), parent = 'local/repo', child = `${parent}/custom`, archive = `${child}/main`
  const db = new LeveldbPersistence(dir)
  const doc = new Y.Doc(); doc.getMap('meta').set('schemaVersion', 2)
  await db.storeUpdate(child, Y.encodeStateAsUpdate(doc)); doc.destroy()
  const old = new Y.Doc(); old.getMap('old').set('data', 'retained')
  const originalArchive = Buffer.from(Y.encodeStateAsUpdate(old))
  await db.storeUpdate(archive, originalArchive); old.destroy(); await db.destroy()
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({ [child]: {
    at: Date.now(), mode: 'repo', migratedAt: Date.now(), branches: [archive], legacy: [archive],
  } }))
  const result = await openWithoutSockets(dir, parent)
  expect(result).toMatchObject({ status: 201, valueReads: 0 })
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8'))[child].legacy).toEqual([archive])
  const reopened = new LeveldbPersistence(dir)
  try {
    await expectRawUpdate(reopened, archive, originalArchive)
    const retained = await reopened.getYDoc(archive)
    expect(retained.getMap('old').get('data')).toBe('retained'); retained.destroy()
    // Creating the parent durably registers it; its document is written on first connection.
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8'))[parent]).toMatchObject({ mode: 'repo' })
    expect(await reopened.getAllDocNames()).toEqual(expect.arrayContaining([child, archive]))
  } finally { await reopened.destroy() }
})

it('ships the offline inventory command advertised by the current self-hosting guide', () => {
  const guide = fs.readFileSync(path.join(root, 'deploy/self-hosting.md'), 'utf8')
  for (const match of guide.matchAll(/`(scripts\/room-inventory\.mts)`/g))
    expect(fs.existsSync(path.join(root, match[1])), `documented command ${match[1]} must exist or its instructions must be retired`).toBe(true)
})

it.each([false, true])('refuses opening a new room at an existing parent archive key without changing legacy data (oversized=%s)', async oversized => {
  const dir = tmp(), parent = 'local/repo', archive = `${parent}/topic`
  let db = new LeveldbPersistence(dir)
  const canonical = new Y.Doc(); canonical.getMap('meta').set('schemaVersion', 2)
  await db.storeUpdate(parent, Y.encodeStateAsUpdate(canonical)); canonical.destroy()
  const old = new Y.Doc(); old.getMap('old').set('private', oversized ? new Uint8Array(33 * 1048576) : 'retained archive')
  const originalArchive = Buffer.from(Y.encodeStateAsUpdate(old))
  await db.storeUpdate(archive, originalArchive); old.destroy(); await db.destroy()
  const before = JSON.stringify({ [parent]: { at: Date.now(), mode: 'repo', migratedAt: Date.now(), branches: [archive], legacy: [archive] } })
  fs.writeFileSync(path.join(dir, 'rooms.json'), before)
  const result = await openWithoutSockets(dir, archive)
  db = new LeveldbPersistence(dir)
  try {
    await expectRawUpdate(db, archive, originalArchive)
    const retained = await db.getYDoc(archive)
    try { expect(retained.getMap('meta').get('schemaVersion'), `opening the archive returned ${result.status}; legacy source must not acquire schema-2 metadata`).toBeUndefined() }
    finally { retained.destroy() }
  } finally { await db.destroy() }
  expect(result).toMatchObject({ status: 409, valueReads: 0 })
  expect(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8')).toBe(before)
})

it('reopens the same registered document at K without reading or rewriting stored values', async () => {
  const dir = tmp(), room = 'local/reopen'
  let db = new LeveldbPersistence(dir)
  const doc = new Y.Doc(); doc.getMap('meta').set('schemaVersion', 2)
  const original = Buffer.from(Y.encodeStateAsUpdate(doc)); doc.destroy()
  await db.storeUpdate(room, original); await db.destroy()
  const before = JSON.stringify({ [room]: { at: Date.now(), mode: 'repo', migratedAt: Date.now(), branches: [] } })
  fs.writeFileSync(path.join(dir, 'rooms.json'), before)
  expect(await openWithoutSockets(dir, room)).toMatchObject({ status: 200, valueReads: 0 })
  expect(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8')).toBe(before)
  db = new LeveldbPersistence(dir)
  try { await expectRawUpdate(db, room, original) }
  finally { await db.destroy() }
})
