// A real room-mcp process in a team room on a real server that compacts the room when it restarts (doc-history
// spec §5): the refused replica is replaced under the same name and session, its claims and scope stay, the
// workers bridge's persisted mirrors are not duplicated, and a message owed to it is delivered once. Uses loopback.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { RoomDoc, docGeneration, historyOf, roomConnection } from '@room/shared'
import { authorizedWebSocket } from '@room/roomd'
import { joinSession, leaveSession } from '../src/session.js'
import { removeOwnMirrors } from '../src/compacted.js'
import { createTools } from '../src/tools.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const ROOM = 'github.com/ada/x'
let port = 0, data = '', home = '', server: ChildProcess | undefined
const cleanups: (() => unknown)[] = []
const http = () => `http://127.0.0.1:${port}`
const ws = () => `ws://127.0.0.1:${port}`
const post = (p: string, body: unknown) => fetch(`${http()}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const serverLines: string[] = []

async function startServer(): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ROOM_') && k !== 'YPERSISTENCE') env[k] = v
  server = spawn(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'packages/server/src/index.ts')], {
    env: { ...env, HOST: '127.0.0.1', PORT: String(port), GITHUB_CLIENT_ID: 'fake', NODE_ENV: 'test', YPERSISTENCE: data, ROOM_COMPACT_MIN_DELETED: '100' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout!.on('data', (b: Buffer) => serverLines.push(...b.toString().split('\n').filter(Boolean)))
  for (let i = 0; i < 300; i++) { try { if ((await fetch(`${http()}/health`)).ok) return } catch { /* starting */ } await new Promise(r => setTimeout(r, 100)) }
  throw new Error('server did not start')
}
async function stopServer(): Promise<void> {
  const child = server
  if (!child || child.exitCode !== null) return
  await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM') })
}
async function login(who: string): Promise<string> {
  const { device } = await (await post('/auth/device', {})).json() as { device: string }
  return ((await (await post('/auth/poll', { device, fakeLogin: who })).json()) as { session: string }).session
}
function clone(name: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `room-compaction-${name}-`)))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('config', 'user.name', name); git('config', 'user.email', `${name}@x`)
  git('remote', 'add', 'origin', `https://github.com/${ROOM.split('/').slice(1).join('/')}.git`)
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\ny = 2\n'); git('add', '.'); git('commit', '-qm', 'init')
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function credentials(who: string, session: string): string {
  const file = path.join(home, `${who}-credentials.json`)
  fs.writeFileSync(file, JSON.stringify({ [ws()]: { session, login: who, at: Date.now() } }) + '\n', { mode: 0o600 })
  return file
}
/** The room as the server holds it now, through a fresh replica. */
async function observe(session: string): Promise<RoomDoc> {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(ws(), encodeURIComponent(ROOM), doc, { WebSocketPolyfill: authorizedWebSocket({ session }) as never, ...roomConnection(doc) })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('observer did not sync')), 15_000)
    provider.on('sync', (synced: boolean) => { if (synced) { clearTimeout(timer); resolve() } })
  })
  cleanups.push(() => { provider.destroy(); doc.destroy() })
  return new RoomDoc(doc)
}
async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

beforeAll(async () => {
  port = await new Promise<number>((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) }) })
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'room-compaction-data-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'room-compaction-home-'))
  await startServer()
}, 60_000)
afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  await stopServer()
  fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true })
})

it('a refused replica rejoins under the same name and session with its claims, no duplicates, and owed messages delivered once', async () => {
  const adaSession = await login('ada'), bobSession = await login('bob')
  expect((await post('/rooms', { room: ROOM, session: adaSession, schema: 2 })).ok).toBe(true)
  const dir = clone('ada')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ROOM_')) env[k] = v
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), ROOM_DIR: dir, ROOM_SERVER: ws(), ROOM_CREDENTIALS: credentials('ada', adaSession) })
  const lines: string[] = []
  const transport = new StdioClientTransport({ command: path.join(ROOT, 'node_modules/.bin/tsx'), args: [path.join(ROOT, 'packages/room-mcp/src/index.ts')], env, cwd: dir, stderr: 'pipe' })
  transport.stderr?.on('data', d => { lines.push(...String(d).split('\n').filter(Boolean)) })
  const client = new Client({ name: 'test-host', version: '1' })
  await client.connect(transport)
  cleanups.push(() => client.close())
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })).content as { text: string }[])[0]!.text
  await until(() => lines.some(l => /joined github\.com\/ada\/x \(clone/.test(l)), 'ada joined', 60_000).catch(e => { throw new Error(`${e.message}: ${lines.join('\n')}`) })

  // bob, a second participant near app.py, so ada's claim is needed; he also leaves a note owed to ada below.
  let bob = await joinSession({ dir: clone('bob'), server: ws(), sessionId: 'bob-host', credentialsPath: credentials('bob', bobSession) })
  cleanups.push(() => leaveSession(bob).catch(() => {}))
  const bobTools = createTools({ cwd: bob.dir, getSession: () => bob, setSession: s => { if (s) bob = s } })
  cleanups.push(() => bobTools.shutdown())
  expect(await bobTools.call('room_scope', { area: 'app', summary: 'read app', paths: ['app.py'] })).not.toMatch(/^error/)
  expect(await call('room_scope', { area: 'app', summary: 'edit app', paths: ['app.py'] })).not.toMatch(/^error/)
  expect(await call('room_claim', { path: 'app.py', from: 1, to: 1, intent: 'edit x' })).toMatch(/claimed/)
  await until(() => bob.room.openClaims().some(c => c.by === 'ada' && c.path === 'app.py'), "ada's claim reaches bob").catch(e => { throw new Error(`${e.message} ${bob.me.name} ${JSON.stringify(bob.room.claims.toJSON())}`) })
  const adaHolder = await until(() => bob.room.participants.get('ada\u0000holder') as { epoch: number; holder?: { sessionId?: string } } | undefined, "ada's lease")
  // A worker mirror the lead's bridge persisted in the team room (the bridge's own map of it is in memory only).
  bob.room.doc.transact(() => { bob.room.claims.set('mirror-1', { id: 'mirror-1', path: 'app.py', from: 2, to: 2, by: 'ada', byKind: 'agent', intent: '[w1] edit y', mirrorOf: 'w1', at: Date.now() } as never) })
  for (let i = 0; i < 300; i++) bob.room.doc.getMap('scratch').set(`k${i % 10}`, i) // interleaved: tombstones that do not merge
  expect(await bob.post(bob.me, { type: 'note', to: 'ada', text: 'OWED-NOTE', priority: 'notify' })).toMatchObject({ ok: true })
  await new Promise(r => setTimeout(r, 1000))
  await bobTools.shutdown()
  await leaveSession(bob)

  await stopServer()
  await startServer()
  await until(() => serverLines.some(l => /compacted at load/.test(l)), 'the room compacted at load')
  await until(() => lines.some(l => /compacted when the server restarted/.test(l)), 'ada saw the refusal')
  await until(() => lines.filter(l => /joined github\.com\/ada\/x \(clone/.test(l)).length >= 2, 'ada rejoined', 60_000)

  const first = await call('room_state')
  expect(first).toMatch(/^\[inbox 1\]\n.*OWED-NOTE/)
  expect(await call('room_state')).toContain('nothing new for you since your last read')

  const room = await observe(bobSession)
  expect(docGeneration(room.doc)).toMatch(/^[0-9a-f]{32}$/)
  expect(historyOf(room.doc).deleted).toBeLessThan(100)
  const adaClaims = room.openClaims().filter(c => c.by === 'ada')
  expect(adaClaims.map(c => [c.path, c.from, c.to, c.intent])).toEqual([['app.py', 1, 1, 'edit x']]) // kept once; the orphan mirror removed
  expect(room.scope('ada')).toMatchObject({ paths: ['app.py'] })
  expect(room.messages().filter(m => (m as { text?: string }).text === 'OWED-NOTE')).toHaveLength(1)
  const holder = await until(() => room.participants.get('ada\u0000holder') as { epoch: number; holder?: { sessionId?: string } } | undefined, "ada's lease after")
  expect(holder.holder?.sessionId).toBe(adaHolder.holder?.sessionId)
  expect(holder.epoch).toBeGreaterThanOrEqual(adaHolder.epoch)
  expect(await call('room_state')).not.toMatch(/paused/)
}, 180_000)

it('removeOwnMirrors removes only this participant\'s mirrors', () => {
  const room = new RoomDoc()
  const mine = room.addClaim({ path: 'a.py', from: 1, to: 1, by: 'ada', byKind: 'agent' } as never)
  room.addClaim({ path: 'a.py', from: 2, to: 2, by: 'ada', byKind: 'agent', mirrorOf: 'w1' } as never)
  const theirs = room.addClaim({ path: 'a.py', from: 3, to: 3, by: 'bob', byKind: 'agent', mirrorOf: 'w2' } as never)
  expect(removeOwnMirrors({ room, me: { name: 'ada', kind: 'agent' } } as never)).toBe(1)
  expect(room.openClaims().map(c => c.id).sort()).toEqual([mine.id, theirs.id].sort())
})
