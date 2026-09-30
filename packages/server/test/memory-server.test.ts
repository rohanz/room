/** The real websocket loader must see updates written by an in-memory migration. */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as sync from 'y-protocols/sync'
import { devServers } from './dev-server.js'

const servers = devServers()
let proc: ChildProcess, port: number, base: string
const logs: string[] = []
const post = (route: string, body: unknown) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const url = (room: string, schema?: number) => `ws://127.0.0.1:${port}/${encodeURIComponent(room)}${schema ? `?schema=${schema}` : ''}`

async function connect(room: string, schema?: number): Promise<WebSocket> {
  const ws = new WebSocket(url(room, schema), { headers: { 'x-room-token': 'shared' } })
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  return ws
}
function update(ws: WebSocket, doc: Y.Doc): void {
  const writer = encoding.createEncoder()
  encoding.writeVarUint(writer, 0)
  sync.writeUpdate(writer, Y.encodeStateAsUpdate(doc))
  ws.send(encoding.toUint8Array(writer))
}
async function readDoc(ws: WebSocket): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const loaded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no sync reply')), 2000)
    ws.on('message', data => {
      const reader = decoding.createDecoder(new Uint8Array(data as Buffer))
      if (decoding.readVarUint(reader) !== 0) return
      const writer = encoding.createEncoder()
      const kind = sync.readSyncMessage(reader, writer, doc, null)
      if (kind === sync.messageYjsSyncStep2) { clearTimeout(timer); resolve() }
    })
  })
  const writer = encoding.createEncoder()
  encoding.writeVarUint(writer, 0)
  sync.writeSyncStep1(writer, doc)
  ws.send(encoding.toUint8Array(writer))
  await loaded
  return doc
}

beforeAll(async () => {
  port = await new Promise<number>((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)) })
  })
  base = `http://127.0.0.1:${port}`
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), ROOM_TOKEN: 'shared', GITHUB_CLIENT_ID: '', NODE_ENV: 'test' }
  delete env.YPERSISTENCE
  delete env.DATABASE_URL
  proc = servers.start({
    env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout!.on('data', d => logs.push(String(d))); proc.stderr!.on('data', d => logs.push(String(d)))
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(logs.join(''))
    try { if ((await fetch(`${base}/health`)).ok) return } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`server did not start: ${logs.join('')}`)
}, 15_000)
afterAll(async () => {
  try { await servers.stopAll() }
  finally { if (port) fs.rmSync(path.join(os.tmpdir(), `room-server-hub-${port}`), { recursive: true, force: true }) }
})

// A 0.17 server creates nothing for 0.16 requests, so an in-memory server has no branch rooms to migrate;
// the cutover of a persisted 0.16 volume is in cutover.test.ts.
it('hydrates an initially created schema-2 room in memory', async () => {
  const repo = 'local/fresh-memory'
  expect((await post('/rooms', { room: repo, token: 'shared', schema: 2 })).status).toBe(201)
  const ws = await connect(repo, 2)
  const doc = await readDoc(ws)
  expect(doc.getMap('meta').get('schemaVersion')).toBe(2)
  ws.close()
})
