/**
 * The hard cutover against a volume a 0.16 server left behind: a registry keyed by repository with its branch
 * rooms recorded, and one LevelDB document per branch room. A 0.17 server creates no such state itself, so the
 * volume is seeded the way 0.16 wrote it.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as sync from 'y-protocols/sync'
import { LeveldbPersistence } from 'y-leveldb'
import { devServers } from './dev-server.js'

const servers = devServers()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-cutover-'))
let port = 0, base = ''
const repo = 'github.com/cutover/project', main = `${repo}/main`, feature = `${repo}/feature/x`
const other = 'github.com/cutover/project2', otherMain = `${other}/main`
const rejoins = Array.from({ length: 4 }, (_, i) => `github.com/cutover/rejoins${i}`)
const upgradeText = `update Room to 0.17 or later: this repository now has one room for all branches (${repo})`

const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
async function login(fakeLogin: string): Promise<string> {
  const start = await (await post('/auth/device', {})).json() as { device: string }
  return ((await (await post('/auth/poll', { device: start.device, fakeLogin })).json()) as { session: string }).session
}
/** A 0.16 client: no schema, session in the query. A 0.17 client: schema 2, session in the header. */
function open(room: string, session: string, schema2: boolean): Promise<WebSocket | number> {
  return new Promise(resolve => {
    const ws = schema2
      ? new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?schema=2`, { headers: { authorization: `Bearer ${session}` } })
      : new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?session=${session}`)
    ws.once('open', () => resolve(ws))
    ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate() })
    ws.once('error', () => resolve(0))
  })
}
async function readDoc(ws: WebSocket): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const loaded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no sync reply')), 3000)
    ws.on('message', data => {
      const reader = decoding.createDecoder(new Uint8Array(data as Buffer))
      if (decoding.readVarUint(reader) !== 0) return
      if (sync.readSyncMessage(reader, encoding.createEncoder(), doc, null) === sync.messageYjsSyncStep2) { clearTimeout(timer); resolve() }
    })
  })
  const writer = encoding.createEncoder()
  encoding.writeVarUint(writer, 0)
  sync.writeSyncStep1(writer, doc)
  ws.send(encoding.toUint8Array(writer))
  await loaded
  return doc
}
const scope = (by: string, summary: string) => ({ by, byKind: 'agent', area: 'api', summary, paths: ['x.ts'], at: 1 })

beforeAll(async () => {
  const seed = async (name: string, by: string, summary: string) => {
    const doc = new Y.Doc()
    doc.getMap('scopes').set(by, scope(by, summary))
    await ldb.storeUpdate(name, Y.encodeStateAsUpdate(doc))
  }
  const ldb = new LeveldbPersistence(dir)
  await seed(main, 'ben', 'main scope')
  await seed(feature, 'cy', 'feature scope')
  // eve used both branches under one audited GitHub login; fay used both with no login on record.
  for (const name of [main, feature]) { await seed(name, 'eve', `eve on ${name}`); await seed(name, 'fay', `fay on ${name}`) }
  fs.writeFileSync(path.join(dir, 'audit.log'), [main, feature].map(room => JSON.stringify({ at: 1, event: 'join', room, login: 'eve', provider: 'github' }) + '\n').join(''))
  await seed(otherMain, 'dee', 'another repository')
  for (const name of rejoins) {
    const doc = new Y.Doc(); doc.getMap('meta').set('schemaVersion', 2); doc.getText('padding').insert(0, 'x'.repeat(700_000))
    await ldb.storeUpdate(name, Y.encodeStateAsUpdate(doc))
    if (name === rejoins[0]) await ldb.storeUpdate(name, Y.encodeStateAsUpdate(doc)) // healthy logical state, >1 MB stored
    doc.destroy()
  }
  await ldb.destroy()
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({
    [repo]: { by: 'ben', at: Date.now(), branches: [main, feature] },
    ...Object.fromEntries(rejoins.map(name => [name, { at: Date.now(), branches: [], mode: 'repo', migratedAt: Date.now() }])),
    [other]: { by: 'dee', at: Date.now(), branches: [otherMain] },
  }))
  port = await new Promise<number>((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)) })
  })
  base = `http://127.0.0.1:${port}`
  const logs: string[] = []
  const proc = servers.start({ env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ROOM_SERVER: '', GITHUB_CLIENT_ID: 'fake', NODE_ENV: 'test', YPERSISTENCE: dir, ROOM_DOC_MAX_MB: '1', ROOM_LOAD_MAX_MB: '1', ROOM_TEST_STORED_TABLES_DELAY_MS: '150' }, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout!.on('data', d => logs.push(String(d))); proc.stderr!.on('data', d => logs.push(String(d)))
  for (let i = 0; i < 200; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited: ${logs.join('')}`)
    try { if ((await fetch(base + '/health')).ok) return } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`server did not start: ${logs.join('')}`)
}, 40_000)
afterAll(async () => { try { await servers.stopAll() } finally { fs.rmSync(dir, { recursive: true, force: true }) } })

it('serves 0.16 clients until the first 0.17 preflight, then migrates the recorded branches and refuses the old', async () => {
  const session = await login('ben')
  // Before the cutover a 0.16 client still uses its recorded branch room, but cannot add a branch or a repository.
  const old = await open(main, session, false)
  expect(old).toBeInstanceOf(WebSocket)
  expect(await open(`${repo}/never-recorded`, session, false)).toBe(403)
  expect((await post('/rooms', { room: `${repo}/never-recorded`, session })).status).toBe(403)
  expect((await post('/rooms', { room: 'github.com/cutover/brand-new/main', session })).status).toBe(403)
  // A 0.17 socket cannot connect before the repository is cut over; a refused one does not trigger the cutover.
  expect(await open(repo, 'not-a-session', true)).toBe(401)
  expect((old as WebSocket).readyState).toBe(WebSocket.OPEN)

  const closed = new Promise<{ code: number; reason: string }>(resolve => (old as WebSocket).once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  const preflight = await post('/rooms', { room: repo, schema: 2 }, { authorization: `Bearer ${session}` })
  expect(preflight.status).toBe(200)
  expect(await preflight.json()).toMatchObject({ repo, room: repo, hub: 1 })
  expect(await closed).toEqual({ code: 4001, reason: upgradeText })

  // Both recorded branches arrived in the one repository room; the neighbouring repository's did not.
  const current = await open(repo, session, true)
  expect(current).toBeInstanceOf(WebSocket)
  const migrated = await readDoc(current as WebSocket)
  expect(migrated.getMap('meta').get('schemaVersion')).toBe(2)
  expect((migrated.getMap('scopes').get('ben') as { summary: string }).summary).toBe('main scope')
  expect((migrated.getMap('scopes').get('cy') as { summary: string }).summary).toBe('feature scope')
  expect(migrated.getMap('scopes').has('dee')).toBe(false)
  expect((migrated.getMap('scopes').get('eve') as { by: string }).by).toBe('eve')
  expect(migrated.getMap('scopes').has('fay')).toBe(false)
  expect([...migrated.getMap('unresolved').keys()].sort()).toEqual([`${feature}\0fay`, `${main}\0fay`])
  ;(current as WebSocket).close()

  // Old clients now get the upgrade text on every entry point; the branch name with schema 2 is simply invalid.
  expect(await open(main, session, false)).toBe(403)
  const refused = await post('/rooms', { room: main, session })
  expect(refused.status).toBe(403)
  expect(await refused.text()).toBe(upgradeText)
  expect((await post('/rooms', { room: main, schema: 2 }, { authorization: `Bearer ${session}` })).status).toBe(400)

  // The archive lists this repository's branch rooms only, and exports them to a member.
  const archive = await (await fetch(`${base}/archive?repo=${encodeURIComponent(repo)}`, { headers: { authorization: `Bearer ${session}` } })).json() as { legacy: string[] }
  expect(archive.legacy.sort()).toEqual([feature, main].sort())
  const exported = await post('/archive/export', { room: main, schema: 2 }, { authorization: `Bearer ${session}` })
  expect(exported.status).toBe(200)
  const archived = new Y.Doc()
  expect(exported.headers.get('content-type')).toBe('application/vnd.room.updates')
  const framed = Buffer.from(await exported.arrayBuffer())
  for (let at = 0; at < framed.byteLength; at += 4 + framed.readUInt32BE(at)) Y.applyUpdate(archived, framed.subarray(at + 4, at + 4 + framed.readUInt32BE(at)))
  expect((archived.getMap('scopes').get('ben') as { summary: string }).summary).toBe('main scope')
  expect((await post('/archive/export', { room: otherMain, schema: 2 }, { authorization: `Bearer ${session}` })).status).toBe(404)

  // The other repository is untouched: still in branch mode for its own 0.16 clients.
  const neighbour = await open(otherMain, await login('dee'), false)
  expect(neighbour).toBeInstanceOf(WebSocket)
  ;(neighbour as WebSocket).close()
}, 40_000)

async function disconnect(ws: WebSocket): Promise<void> {
  await new Promise<void>(resolve => { ws.once('close', () => resolve()); ws.close() })
}
it('keeps a healthy canonical room joinable across 40 cold joins with a 1 MB cap', async () => {
  const session = await login('repeat')
  for (let i = 0; i < 40; i++) {
    const joined = await open(rejoins[0]!, session, true)
    expect(joined, `cold join ${i}`).toBeInstanceOf(WebSocket)
    const doc = await readDoc(joined as WebSocket)
    expect(doc.getText('padding').length).toBe(700_000); doc.destroy()
    await disconnect(joined as WebSocket)
  }
}, 40_000)
it('shares a single metadata scan across concurrent cold joins of different rooms', async () => {
  const session = await login('parallel')
  const count = async () => ((await (await fetch(base + '/health')).json()) as { tableScans: number }).tableScans
  const before = await count()
  const joined = await Promise.all(rejoins.map(name => open(name, session, true)))
  try {
    for (const ws of joined) expect(ws).toBeInstanceOf(WebSocket)
    expect(await count()).toBe(before + 1)
  } finally { await Promise.all(joined.filter((ws): ws is WebSocket => ws instanceof WebSocket).map(disconnect)) }
})
