import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import { deterministicPort, ensureLocalRelay, gitCommonDir, localRoomName, portAnswers, readRelayInfo, relayAnswers, startRelay } from '../src/local.js'
import http from 'node:http'

const sh = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim()

async function makeRepo(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'room-local-'))
  sh(dir, ['init', '-q', '-b', 'main'])
  sh(dir, ['config', 'user.email', 't@t']); sh(dir, ['config', 'user.name', 'Test'])
  await fsp.writeFile(path.join(dir, 'a.txt'), 'a\n')
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-q', '-m', 'init'])
  return dir
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (f: () => boolean | Promise<boolean>, ms = 5000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(50) } }

describe('local rooms', () => {
  it('names the room after the main worktree so every worktree of a clone shares it', async () => {
    const dir = await makeRepo()
    const wt = path.join(dir, '.room', 'workers', 'x')
    sh(dir, ['worktree', 'add', '-q', '-b', 'room/x', wt, 'HEAD'])
    expect(await localRoomName(dir)).toBe(`local/${path.basename(dir)}/main`)
    expect(await localRoomName(wt)).toBe(`local/${path.basename(dir)}/main`)
    expect(await localRoomName(wt, 'feature')).toBe(`local/${path.basename(dir)}/feature`)
    expect(fs.realpathSync(await gitCommonDir(wt))).toBe(fs.realpathSync(path.join(dir, '.git')))
  })

  it('first joiner starts the relay, later joiners reuse it, and a survivor takes over the same port when the owner leaves', async () => {
    const dir = await makeRepo()
    const common = await gitCommonDir(dir)
    const a = await ensureLocalRelay(common, 'local/x/main', { watchMs: 100 })
    expect(a.owned).toBe(true)
    expect(readRelayInfo(common)?.port).toBe(a.port)
    const b = await ensureLocalRelay(common, 'local/x/main', { watchMs: 100 })
    expect(b.owned).toBe(false)
    expect(b.port).toBe(a.port)
    // Two providers through the relay converge.
    const d1 = new Y.Doc(), d2 = new Y.Doc()
    expect(b.key).toBe(a.key)
    const p1 = new WebsocketProvider(a.url, 'local%2Fx%2Fmain', d1, { WebSocketPolyfill: WebSocket as never, params: { key: a.key } })
    const p2 = new WebsocketProvider(b.url, 'local%2Fx%2Fmain', d2, { WebSocketPolyfill: WebSocket as never, params: { key: b.key } })
    await until(() => p1.synced && p2.synced)
    d1.getText('t').insert(0, 'hello')
    await until(() => d2.getText('t').toString() === 'hello')
    // Owner leaves: b notices the dead port and takes it over; providers reconnect and still converge.
    await a.stop()
    await until(() => b.owned, 8000)
    expect(readRelayInfo(common)?.port).toBe(a.port)
    await until(async () => portAnswers(b.port))
    await until(() => p1.wsconnected && p2.wsconnected, 15000)
    d2.getText('t').insert(5, ' world')
    await until(() => d1.getText('t').toString() === 'hello world', 15000)
    p1.destroy(); p2.destroy()
    await b.stop()
    expect(fs.existsSync(path.join(common, 'room-local.json'))).toBe(true)
  })
})

describe('local relay browser view', () => {
  const get = (url: string) => new Promise<{ status: number; body: string; type: string }>((resolve, reject) => {
    http.get(url, res => { let body = ''; res.on('data', c => { body += c }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body, type: String(res.headers['content-type']) })) }).on('error', reject)
  })
  it('serves index.html and /health, and accepts a keyless websocket from loopback', async () => {
    const dist = await fsp.mkdtemp(path.join(os.tmpdir(), 'room-dist-'))
    await fsp.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Room</title>')
    await fsp.writeFile(path.join(dist, 'app.js'), 'console.log(1)')
    const relay = await startRelay(0, { staticDir: dist })
    try {
      const root = await get(`http://127.0.0.1:${relay.port}/`)
      expect(root.status).toBe(200); expect(root.type).toContain('text/html'); expect(root.body).toContain('<title>Room</title>')
      const js = await get(`http://127.0.0.1:${relay.port}/app.js`)
      expect(js.type).toContain('javascript')
      const health = await get(`http://127.0.0.1:${relay.port}/health`)
      expect(JSON.parse(health.body)).toEqual({ ok: true, local: true })
      const outside = await get(`http://127.0.0.1:${relay.port}/../../etc/passwd`)
      expect(outside.body).not.toContain('root:')
      const doc = new Y.Doc()
      const provider = new WebsocketProvider(`ws://127.0.0.1:${relay.port}`, encodeURIComponent('local/x/main'), doc, { WebSocketPolyfill: WebSocket as never })
      await until(() => provider.synced)
      provider.destroy()
      // a sibling directory that merely shares the prefix is not served
      const sibling = `${dist}-private`
      await fsp.mkdir(sibling); await fsp.writeFile(path.join(sibling, 'secret.txt'), 'shh')
      const leak = await get(`http://127.0.0.1:${relay.port}/../${path.basename(sibling)}/secret.txt`)
      expect(leak.body).not.toContain('shh')
    } finally { await relay.close() }
  })
})

describe('local relay hardening', () => {
  it('two sessions starting at the same moment end up in one relay on the deterministic port', async () => {
    const dir = await makeRepo()
    const common = await gitCommonDir(dir)
    const want = deterministicPort(common)
    expect(want).toBeGreaterThanOrEqual(40000); expect(want).toBeLessThan(60000)
    expect(deterministicPort(common)).toBe(want)
    const [a, b] = await Promise.all([ensureLocalRelay(common, 'local/x/main', { watchMs: 100 }), ensureLocalRelay(common, 'local/x/main', { watchMs: 100 })])
    expect(a.port).toBe(b.port)
    expect([a.owned, b.owned].filter(Boolean)).toHaveLength(1)
    expect(a.key).toBe(b.key)
    expect(readRelayInfo(common)?.port).toBe(a.port)
    await a.stop(); await b.stop()
  })

  it('a stale file whose port is held by something that is not a relay is ignored', async () => {
    const dir = await makeRepo()
    const common = await gitCommonDir(dir)
    // an unrelated HTTP server squats on the recorded port
    const squatter = http.createServer((_q, res) => { res.writeHead(200); res.end('not a relay') })
    await new Promise<void>(r => squatter.listen(0, '127.0.0.1', r))
    const squat = (squatter.address() as { port: number }).port
    await fsp.writeFile(path.join(common, 'room-local.json'), JSON.stringify({ port: squat, pid: process.pid, room: 'local/x/main', startedAt: Date.now(), key: 'k' }))
    expect(await portAnswers(squat)).toBe(true)
    expect(await relayAnswers(squat)).toBe(false)
    const a = await ensureLocalRelay(common, 'local/x/main', { watchMs: 100 })
    expect(a.owned).toBe(true)
    expect(a.port).not.toBe(squat)
    expect(await relayAnswers(a.port)).toBe(true)
    await a.stop(); squatter.close()
  })

  it('websockets need the key from room-local.json; /health stays open', async () => {
    const dir = await makeRepo()
    const common = await gitCommonDir(dir)
    const a = await ensureLocalRelay(common, 'local/x/main', { watchMs: 100 })
    const mode = (await fsp.stat(path.join(common, 'room-local.json'))).mode & 0o777
    expect(mode).toBe(0o600)
    expect(readRelayInfo(common)?.key).toBe(a.key)
    expect(await relayAnswers(a.port)).toBe(true)
    const refused = await new Promise<number>(resolve => {
      const ws = new WebSocket(`${a.url}/local%2Fx%2Fmain`)
      ws.on('unexpected-response', (_q, res) => { resolve(res.statusCode ?? 0); ws.terminate() })
      ws.on('open', () => { resolve(101); ws.close() })
      ws.on('error', () => {})
    })
    expect(refused).toBe(403)
    const doc = new Y.Doc()
    const ok = new WebsocketProvider(a.url, 'local%2Fx%2Fmain', doc, { WebSocketPolyfill: WebSocket as never, params: { key: a.key } })
    await until(() => ok.synced)
    ok.destroy()
    await a.stop()
  })
})
