/** Legacy-archive expiry rewrites a cold canonical room without growing its stored records. Uses loopback sockets. */
import { afterAll, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { levelDbOf, levelStoredSize } from '../src/stored.js'
import { devServers } from './dev-server.js'

const servers = devServers()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-expiry-'))
const repo = 'github.com/expire/project', legacy = `${repo}/main`
afterAll(async () => { try { await servers.stopAll() } finally { fs.rmSync(dir, { recursive: true, force: true }) } })

it('replaces the canonical snapshot when expiry clears unresolved entries of a cold room', async () => {
  let db = new LeveldbPersistence(dir)
  const canonical = new Y.Doc(), updates: Uint8Array[] = []
  canonical.on('update', update => { updates.push(update) })
  canonical.getMap('meta').set('schemaVersion', 2)
  for (let i = 0; i < 6; i++) canonical.getMap('unresolved').set(`key-${i}`, { placeholder: `?${i}`, claims: [], pad: 'x'.repeat(64 * 1024) })
  // Past y-leveldb's 500-record trim: loading must not append its own snapshot beside these records.
  for (let i = 0; i < 600; i++) canonical.getMap('meta').set(`touch-${i}`, i)
  for (const update of updates) await db.storeUpdate(repo, update)
  await db.storeUpdate(legacy, Y.encodeStateAsUpdate(new Y.Doc()))
  canonical.destroy(); await db.destroy()
  const migratedAt = Date.now() - 40 * 86400000
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({
    [repo]: { at: migratedAt, lastSeen: Date.now(), branches: [legacy], legacy: [legacy], mode: 'repo', step: 'written', migratedAt, unresolved: 6 },
  }))
  const port = await new Promise<number>((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => { const address = socket.address() as net.AddressInfo; socket.close(() => resolve(address.port)) })
  })
  const proc = servers.start({ env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ROOM_SERVER: '',
    GITHUB_CLIENT_ID: 'fake', NODE_ENV: 'test', YPERSISTENCE: dir }, stdio: 'ignore' })
  // Startup expiry clears the archive, then records it in the registry.
  for (let i = 0; ; i++) {
    if (proc.exitCode !== null) throw new Error('expiry test server exited')
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8'))[repo]
    if (saved?.legacy?.length === 0) break
    if (i > 300) throw new Error('legacy archive was not expired')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await servers.stop(proc)
  db = new LeveldbPersistence(dir)
  try {
    expect((await levelStoredSize(await levelDbOf(db as never), repo)).updates).toBe(1)
    const doc = await db.getYDoc(repo)
    expect(doc.getMap('unresolved').size).toBe(0)
    expect(doc.getMap('meta').get('schemaVersion')).toBe(2)
    expect(await db.getAllDocNames()).not.toContain(legacy)
    doc.destroy()
  } finally { await db.destroy() }
}, 60_000)
