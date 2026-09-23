import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import { deterministicPort, ensureLocalRelay, portAnswers, probeRelay, readRelayInfo, relayAnswers, startRelay } from '../src/index.js'
import http from 'node:http'

/** A stand-in for a clone's git common dir: the relay only needs a directory for its discovery file. */
const makeCommonDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'room-relay-'))
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (f: () => boolean | Promise<boolean>, ms = 5000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(50) } }

describe('local relay', () => {
  it('first joiner starts the relay, later joiners reuse it, and a survivor takes over the same port when the owner leaves', async () => {
    const common = await makeCommonDir()
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
    const common = await makeCommonDir()
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
    const common = await makeCommonDir()
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
    const common = await makeCommonDir()
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

it('restores memory in a new relay, excludes live state, and forgets through an authenticated request', async () => {
  const commonDir = await makeCommonDir(), room = 'local/restart/main'
  const { memoryFile, loadMemory } = await import('../src/memory.js')
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined
  let provider: WebsocketProvider | undefined
  const docs: Y.Doc[] = []
  const connect = async () => {
    const doc = new Y.Doc(); docs.push(doc)
    provider = new WebsocketProvider(`ws://127.0.0.1:${relay!.port}`, encodeURIComponent(room), doc, {
      WebSocketPolyfill: WebSocket as never, params: { key: 'test-key' }, disableBc: true,
    })
    await until(() => provider!.synced)
    return doc
  }
  try {
    relay = await startRelay(0, { commonDir, key: 'test-key' })
    const first = await connect()
    for (const type of ['bus', 'retiredWorkers']) first.getArray(type).push([{ id: type }])
    for (const type of ['workers', 'scopes', 'colors', 'meta', 'ledger']) first.getMap(type).set('key', { value: type })
    for (const type of ['overlays', 'deleted', 'basetext', 'graphs', 'claims']) first.getMap(type).set('stale', 'text')
    await until(() => {
      if (!fs.existsSync(memoryFile(commonDir, room))) return false
      const snapshot = loadMemory(commonDir, room)
      try { return snapshot.getArray('bus').length === 1 } finally { snapshot.destroy() }
    })
    // Last client leaving and the relay shutting down must both preserve the snapshot.
    provider!.destroy(); provider = undefined
    await relay.close()
    relay = await startRelay(0, { commonDir, key: 'test-key' })
    const second = await connect()
    expect(second.getArray('bus').toArray()).toEqual([{ id: 'bus' }])
    expect(second.getArray('retiredWorkers').toArray()).toEqual([{ id: 'retiredWorkers' }])
    expect(second.getMap('workers').get('key')).toEqual({ value: 'workers' })
    expect(second.getMap('scopes').get('key')).toEqual({ value: 'scopes' })
    for (const type of ['overlays', 'deleted', 'basetext', 'graphs', 'claims']) expect(second.share.has(type)).toBe(false)
    const url = `http://127.0.0.1:${relay.port}/memory?room=${encodeURIComponent(room)}`
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(403)
    expect(fs.existsSync(memoryFile(commonDir, room))).toBe(true)
    expect((await fetch(url, { method: 'DELETE', headers: { authorization: 'Bearer test-key' } })).status).toBe(204)
    provider!.destroy(); provider = undefined
    await relay.close(); relay = undefined
    expect(fs.existsSync(memoryFile(commonDir, room))).toBe(false)
  } finally {
    provider?.destroy(); await relay?.close()
    for (const doc of docs) doc.destroy()
    fs.rmSync(commonDir, { recursive: true, force: true })
  }
})

describe('relay discovery and takeover', () => {
  it('a discovery file naming another clone\'s live relay is stale: the joiner runs this clone\'s relay instead', async () => {
    const mine = await makeCommonDir(), other = await makeCommonDir()
    const foreign = await ensureLocalRelay(other, 'local/other/main', { watchMs: 100 })
    // e.g. the recorded port was reused by another clone's relay after this clone's owner exited
    await fsp.writeFile(path.join(mine, 'room-local.json'), JSON.stringify({ port: foreign.port, pid: 999999, room: 'local/x/main', startedAt: Date.now(), key: 'stale-key' }))
    const logs: string[] = []
    const a = await ensureLocalRelay(mine, 'local/x/main', { watchMs: 100, log: l => logs.push(l) })
    try {
      expect(a.owned).toBe(true)
      expect(a.port).not.toBe(foreign.port)
      expect(readRelayInfo(mine)?.port).toBe(a.port)
      expect(logs.join('\n')).toMatch(/does not serve this clone with its key; treating the file as stale/)
      expect(await probeRelay(a.port, mine, a.key)).toBe('ours')
      expect(await probeRelay(a.port, mine, 'wrong')).toBe('foreign')
      expect(await probeRelay(a.port, other, a.key)).toBe('foreign')
    } finally { await a.stop(); await foreign.stop() }
  })

  it('a live relay for this clone whose key differs from the discovery file is not adopted', async () => {
    const common = await makeCommonDir()
    const relay = await startRelay(0, { key: 'the-relays-key', commonDir: common })
    await fsp.writeFile(path.join(common, 'room-local.json'), JSON.stringify({ port: relay.port, pid: process.pid, room: 'local/x/main', startedAt: Date.now(), key: 'another-key' }))
    const a = await ensureLocalRelay(common, 'local/x/main', { watchMs: 100 })
    try {
      expect(a.port).not.toBe(relay.port)
      expect(a.owned).toBe(true)
    } finally { await a.stop(); await relay.close() }
  })

  it('publishes the discovery file by rename, leaving no partial or temporary file', async () => {
    const common = await makeCommonDir()
    const file = path.join(common, 'room-local.json')
    await fsp.writeFile(file, 'partial{')
    const before = (await fsp.stat(file)).ino
    const a = await ensureLocalRelay(common, 'local/x/main', { watchMs: 100 })
    try {
      expect((await fsp.stat(file)).ino).not.toBe(before)
      expect(readRelayInfo(common)?.port).toBe(a.port)
      expect((await fsp.readdir(common)).filter(f => f.endsWith('.tmp'))).toEqual([])
    } finally { await a.stop() }
  })

  it('a session whose relay port is taken over by another clone\'s relay is marked lost, so it joins afresh', async () => {
    const common = await makeCommonDir(), other = await makeCommonDir()
    const owner = await ensureLocalRelay(common, 'local/x/main', { watchMs: 30_000 })
    const b = await ensureLocalRelay(common, 'local/x/main', { watchMs: 300 })
    const port = owner.port
    await owner.stop()
    const foreign = await startRelay(port, { key: 'other-key', commonDir: other })
    try {
      await until(() => !!b.lost)
      expect(b.lost).toMatch(/is now another clone's relay/)
      expect(b.owned).toBe(false)
    } finally { await b.stop(); await foreign.close() }
  })

  it('a stopped handle never starts a relay from a takeover attempt that was already in flight', async () => {
    const common = await makeCommonDir()
    const owner = await ensureLocalRelay(common, 'local/x/main', { watchMs: 30_000 })
    const b = await ensureLocalRelay(common, 'local/x/main', { watchMs: 40 })
    const port = owner.port
    await owner.stop()
    // The port now holds a dying owner: /health hangs, then the listener goes away without answering.
    const sockets = new Set<import('node:net').Socket>()
    const dying = http.createServer(() => { /* never answer */ })
    dying.on('connection', s => { sockets.add(s) })
    await new Promise<void>(r => dying.listen(port, '127.0.0.1', r))
    await until(() => sockets.size > 0) // b's takeover probe is now waiting on the dying owner
    const stopping = b.stop()
    dying.close(); for (const s of sockets) s.destroy()
    await stopping
    await wait(300)
    expect(b.owned).toBe(false)
    expect(await portAnswers(port)).toBe(false)
  })
})
