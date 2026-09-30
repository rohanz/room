// Room moves with real sessions and relays: a target that fails after the old room was left sends the session back.
import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { relayProof } from '@room/relay'
import { LOCAL, joinSession, leaveSession, type Session } from '../src/session.js'
import { createTools } from '../src/tools.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

/** Two clones of one project in folders of the same name, so both host local/shop. */
function clone(name: string): string {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `room-move-real-${name}-`)))
  cleanups.push(() => fs.rmSync(parent, { recursive: true, force: true }))
  const dir = path.join(parent, 'shop')
  fs.mkdirSync(dir)
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'Ada')
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  return dir
}

async function inRoom(dir: string) {
  let session: Session | null = await joinSession({ dir, server: LOCAL })
  const tools = createTools({ cwd: dir, getSession: () => session, setSession: s => { session = s } })
  cleanups.push(async () => { await tools.shutdown(); if (session) await leaveSession(session).catch(() => {}) })
  return { tools, session: () => session }
}

/** A relay owner for the clone whose websockets never open: the target join connects, then times out syncing. */
async function wedgedRelay(commonDir: string): Promise<{ upgrades: () => number; open: () => number }> {
  const clone = crypto.createHash('sha256').update(fs.realpathSync(commonDir)).digest('hex')
  const key = crypto.randomBytes(16).toString('hex')
  const sockets = new Set<net.Socket>()
  let upgrades = 0
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, local: true, schema: 2, hub: 1, clone, ...(typeof req.headers['x-room-nonce'] === 'string' ? { proof: relayProof(key, req.headers['x-room-nonce'], port) } : {}) }))
  })
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  const upgraded = new Set<net.Socket>()
  // A client that gives up ends its side; an upgraded server socket reports 'end', not 'close'.
  server.on('upgrade', (_req, socket) => { upgrades++; upgraded.add(socket as net.Socket); socket.on('end', () => upgraded.delete(socket as net.Socket)); socket.resume() })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  fs.mkdirSync(path.join(commonDir, 'room'), { recursive: true })
  fs.writeFileSync(path.join(commonDir, 'room', 'relay.json'), JSON.stringify({ schema: 2, port, pid: process.pid, room: 'x', startedAt: Date.now(), key }) + '\n', { mode: 0o600 })
  cleanups.push(() => { for (const s of sockets) s.destroy(); server.close() })
  return { upgrades: () => upgrades, open: () => upgraded.size }
}

it('moves between two clones that both host local/shop, and goes back when the target clone cannot join', async () => {
  const a = clone('a'), b = clone('b')
  const t = await inRoom(a)
  const before = t.session()!
  execFileSync('git', ['-C', b, 'config', 'user.name', 'Ada\tB']) // an invalid participant name: the target join fails after the preflight
  expect(await t.tools.call('room_join', { where: 'local', dir: b })).toBe("couldn't join local/shop (participant name must be nonempty and contain no control characters); back in local/shop.")
  expect(t.session()).not.toBe(before)
  expect(t.session()!.dir).toBe(a)
  expect(t.session()!.me.name).toBe('Ada')
  expect(before.provider.wsconnected).toBe(false) // the old session was left, then the room rejoined
  await vi.waitFor(() => expect(t.session()!.provider.wsconnected).toBe(true))
  expect(await t.tools.call('room_state')).toContain('room: local/shop')

  execFileSync('git', ['-C', b, 'config', 'user.name', 'Ada'])
  const moved = await t.tools.call('room_join', { where: 'local', dir: b })
  expect(moved).toContain('moved from local/shop to local/shop')
  expect(moved).toContain(`clone ${b}`)
  expect(t.session()!.dir).toBe(b)
}, 60_000)

it('a target that connects but never syncs is cleaned up, and the session goes back to its room', async () => {
  const a = clone('a'), b = clone('b')
  const t = await inRoom(a)
  const wedged = await wedgedRelay(path.join(b, '.git'))
  const reply = await t.tools.call('room_join', { where: 'local', dir: b })
  expect(reply).toMatch(/^couldn't join local\/shop\ \(.*could not sync with ws:\/\/127\.0\.0\.1:\d+\/local%2Fshop within 15000ms\); back in local\/shop\.$/)
  expect(wedged.upgrades()).toBeGreaterThan(0)
  await new Promise(r => setTimeout(r, 300))
  expect(wedged.open()).toBe(0) // the half-joined target closed its websockets
  expect(t.session()!.dir).toBe(a)
  await vi.waitFor(() => expect(t.session()!.provider.wsconnected).toBe(true))
}, 60_000)
