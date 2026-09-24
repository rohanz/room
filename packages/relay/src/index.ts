/**
 * @room/relay — the local room relay. No server: the first process to join a clone's local
 * room starts a tiny y-websocket relay on 127.0.0.1 (with private memory snapshots) and records it in
 * `<git common dir>/room-local.json` (mode 0600, with a random key every websocket must
 * present). The relay binds a port derived from the common dir, so two processes starting at
 * the same moment cannot end up in two rooms: one binds, the other gets EADDRINUSE and joins.
 * Later processes find the file, check the relay answers as a room relay, and connect. When
 * the owner exits, any remaining client notices within a couple of seconds and races to start
 * a relay on the same port; the losers reconnect to the winner. Every client holds the full
 * document, so a relay restart loses nothing: clients sync their state back into the new one.
 */
import { RoomMemory, memoryFile } from './memory.js'
export { RoomMemory, memoryFile, loadMemory, saveMemory } from './memory.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'

/** Convert a takeover failure into a reported, settled operation for the interval owner. */
export async function observeTakeover(work: () => Promise<void>, report: (error: unknown) => void): Promise<void> {
  try { await work() } catch (error) { try { report(error) } catch { /* reporting must not reject the interval */ } }
}

// ---- a minimal y-websocket relay (the wire protocol of y-websocket 3.x; private memory persistence) ----
const MSG_SYNC = 0, MSG_AWARENESS = 1
interface RelayDoc { doc: Y.Doc; awareness: awarenessProtocol.Awareness; conns: Map<WebSocket, Set<number>>; memory?: RoomMemory }
function relayDocs(): Map<string, RelayDoc> { return new Map() }
function send(conn: WebSocket, buf: Uint8Array): void {
  if (conn.readyState !== conn.OPEN) return
  try { conn.send(buf) } catch { try { conn.close() } catch { /* gone */ } }
}
function getDoc(docs: Map<string, RelayDoc>, name: string, opts: { commonDir?: string; log?: (line: string) => void }): RelayDoc {
  let d = docs.get(name)
  if (d) return d
  const memory = opts.commonDir ? new RoomMemory(opts.commonDir, decodeURIComponent(name), opts.log) : undefined
  const doc = memory?.doc ?? new Y.Doc({ gc: true })
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalState(null)
  d = { doc, awareness, conns: new Map(), memory }
  doc.on('update', (update: Uint8Array) => {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeUpdate(enc, update)
    const buf = encoding.toUint8Array(enc)
    for (const c of d!.conns.keys()) send(c, buf)
  })
  awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const changed = [...added, ...updated, ...removed]
    if (origin && d!.conns.has(origin as WebSocket)) {
      const ids = d!.conns.get(origin as WebSocket)!
      for (const id of added) ids.add(id)
      for (const id of removed) ids.delete(id)
    }
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_AWARENESS)
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed))
    const buf = encoding.toUint8Array(enc)
    for (const c of d!.conns.keys()) send(c, buf)
  })
  docs.set(name, d)
  return d
}
function attach(docs: Map<string, RelayDoc>, conn: WebSocket, req: http.IncomingMessage, opts: { commonDir?: string; log?: (line: string) => void }): void {
  const name = encodeURIComponent(decodeURIComponent((req.url ?? '/').slice(1).split('?')[0]))
  const d = getDoc(docs, name, opts)
  d.conns.set(conn, new Set())
  conn.binaryType = 'arraybuffer'
  conn.on('message', (raw: ArrayBuffer | Buffer | Buffer[]) => {
    const buf = raw instanceof ArrayBuffer ? new Uint8Array(raw) : Array.isArray(raw) ? new Uint8Array(Buffer.concat(raw)) : new Uint8Array(raw)
    try {
      const dec = decoding.createDecoder(buf)
      const enc = encoding.createEncoder()
      switch (decoding.readVarUint(dec)) {
        case MSG_SYNC:
          encoding.writeVarUint(enc, MSG_SYNC)
          syncProtocol.readSyncMessage(dec, enc, d.doc, conn)
          if (encoding.length(enc) > 1) send(conn, encoding.toUint8Array(enc))
          break
        case MSG_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(d.awareness, decoding.readVarUint8Array(dec), conn)
          break
      }
    } catch { /* malformed message: ignore */ }
  })
  const bye = () => {
    if (!d.conns.has(conn)) return
    const ids = d.conns.get(conn)
    d.conns.delete(conn)
    if (ids?.size) awarenessProtocol.removeAwarenessStates(d.awareness, Array.from(ids), null)
    if (!d.conns.size) d.memory?.flush()
  }
  conn.on('close', bye); conn.on('error', bye)
  // Sync step 1 and the current awareness states, as y-websocket's server does.
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_SYNC)
  syncProtocol.writeSyncStep1(enc, d.doc)
  send(conn, encoding.toUint8Array(enc))
  const states = d.awareness.getStates()
  if (states.size) {
    const aenc = encoding.createEncoder()
    encoding.writeVarUint(aenc, MSG_AWARENESS)
    encoding.writeVarUint8Array(aenc, awarenessProtocol.encodeAwarenessUpdate(d.awareness, Array.from(states.keys())))
    send(conn, encoding.toUint8Array(aenc))
  }
}

export interface LocalRelayInfo { port: number; pid: number; room: string; startedAt: number; key: string }

export interface LocalRelay {
  /** ws://127.0.0.1:<port> */
  url: string
  /** http://127.0.0.1:<port>: the browser view (same machine only). */
  httpUrl: string
  port: number
  /** Secret every websocket to this relay must carry as ?key=; lives in room-local.json (0600). */
  key: string
  /** True when this process runs the relay. */
  owned: boolean
  /** Set when this clone's relay port is now served by another relay: the session must join afresh. */
  readonly lost?: string
  /** Forget this room's saved memory until the relay next restarts. */
  forget?(): Promise<void>
  stop(): Promise<void>
}

export const LOCAL_FILE = 'room-local.json'

export function relayFile(commonDir: string): string { return path.join(commonDir, LOCAL_FILE) }

export function readRelayInfo(commonDir: string): LocalRelayInfo | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(relayFile(commonDir), 'utf8')) as Partial<LocalRelayInfo>
    return typeof v.port === 'number' && typeof v.pid === 'number' && typeof v.key === 'string' && v.key
      ? { port: v.port, pid: v.pid, room: String(v.room ?? ''), startedAt: Number(v.startedAt ?? 0), key: v.key }
      : undefined
  } catch { return undefined }
}

/** The port a clone's relay binds: derived from the common git dir, so racers collide on purpose (40000-59999). */
export function deterministicPort(commonDir: string): number {
  let real = commonDir
  try { real = fs.realpathSync.native(commonDir) } catch { /* use as given */ }
  const h = crypto.createHash('sha1').update(real).digest()
  return 40000 + (h.readUInt32BE(0) % 20000)
}

/** Which clone a relay serves: a hash of its git common dir (the path itself is never sent). */
export function cloneId(commonDir: string): string {
  let real = commonDir
  try { real = fs.realpathSync.native(commonDir) } catch { /* use as given */ }
  return crypto.createHash('sha256').update(real).digest('hex')
}

/**
 * Who answers on 127.0.0.1:port: 'ours' is a relay for this clone that accepts `key`; 'foreign' is a
 * room relay for another clone or with another key (a stale or inconsistent discovery file); 'none' is
 * nothing, or something that is not a room relay.
 */
export async function probeRelay(port: number, commonDir: string, key: string, timeoutMs = 800): Promise<'ours' | 'foreign' | 'none'> {
  const h = await health(port, key, timeoutMs)
  if (h?.local !== true) return 'none'
  return h.clone === cloneId(commonDir) && h.key === true ? 'ours' : 'foreign'
}

function health(port: number, key: string | undefined, timeoutMs: number): Promise<{ local?: unknown; clone?: unknown; key?: unknown } | undefined> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs, ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}) }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : undefined) } catch { resolve(undefined) } })
    })
    req.on('timeout', () => { req.destroy(); resolve(undefined) })
    req.on('error', () => resolve(undefined))
  })
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json' }

/**
 * Where the built browser view lives: ROOM_WEB_DIST, else `web/` next to the plugin bundle's
 * `server/` dir (plugins/room/web), else packages/web/dist for source runs. Undefined when none exists.
 */
export function findWebDist(): string | undefined {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const candidates = [
    process.env.ROOM_WEB_DIST,
    path.resolve(here, '..', 'web'),            // plugins/room/server/room-mcp.mjs -> plugins/room/web
    path.resolve(here, '..', '..', 'web', 'dist'), // packages/relay/src -> packages/web/dist
    path.resolve(here, '..', '..', '..', 'web', 'dist'),
  ]
  for (const c of candidates) if (c && fs.existsSync(path.join(c, 'index.html'))) return c
  return undefined
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
function isLoopback(addr: string | undefined): boolean { return !!addr && LOOPBACK.has(addr) }

/** Start a relay on 127.0.0.1:port (0 = any free port). Rejects with EADDRINUSE when someone else won the race.
 *  Also serves the browser view (staticDir, default findWebDist()) at / and a /health line, so a local
 *  room has a projector link like a hosted one. Websockets are accepted from loopback only, and when
 *  `key` is set they must carry it as ?key= (the /health line stays open so joiners can recognise a relay). */
export function startRelay(port: number, opts: { staticDir?: string; key?: string; commonDir?: string; log?: (line: string) => void } = {}): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const staticDir = opts.staticDir ? path.resolve(opts.staticDir) : findWebDist()
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/health') {
        // Open to joiners; with the clone's key it also confirms the key, so a stale discovery file is never trusted.
        const keyOk = !!opts.key && isLoopback(req.socket.remoteAddress) && req.headers.authorization === 'Bearer ' + opts.key
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, local: true, ...(opts.commonDir ? { clone: cloneId(opts.commonDir) } : {}), ...(keyOk ? { key: true } : {}) }))
        return
      }
      if (req.method === 'DELETE' && url.pathname === '/memory') {
        if (!opts.key || req.headers.authorization !== 'Bearer ' + opts.key || !isLoopback(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return }
        try {
          const room = url.searchParams.get('room') ?? ''
          const d = docs.get(encodeURIComponent(room))
          if (d?.memory) d.memory.forget()
          else if (opts.commonDir) fs.rmSync(memoryFile(opts.commonDir, room), { force: true })
          res.writeHead(204); res.end()
        } catch { res.writeHead(500); res.end('could not forget local memory') }
        return
      }
      if (staticDir) {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
        const file = path.resolve(staticDir, rel)
        if (file.startsWith(staticDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
          fs.createReadStream(file).pipe(res)
          return
        }
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(staticDir ? 'room local relay\n' : 'room local relay (no browser view built: run npm run build -w @room/web)\n')
    })
    const wss = new WebSocketServer({ noServer: true })
    const docs = relayDocs()
    wss.on('connection', (conn, req) => attach(docs, conn, req, opts))
    server.on('upgrade', (req, socket, head) => {
      const refuse = (code: number, why: string) => { socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`); socket.destroy() }
      if (!isLoopback(req.socket.remoteAddress)) return refuse(403, 'Forbidden')
      try { decodeURIComponent((req.url ?? '/').split('?')[0]) } catch { return refuse(400, 'Bad Request') }
      if (opts.key) {
        const given = new URL(req.url ?? '/', 'http://x').searchParams.get('key') ?? ''
        const a = Buffer.from(given), b = Buffer.from(opts.key)
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return refuse(403, 'Forbidden: local room key missing or wrong')
      }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    })
    const signals = ['SIGTERM', 'SIGINT'] as const
    let closing: Promise<void> | undefined
    const onSignal = () => { void close() }
    const close = (): Promise<void> => closing ??= new Promise<void>(done => {
      for (const signal of signals) process.off(signal, onSignal)
      for (const d of docs.values()) d.memory?.close()
      for (const c of wss.clients) c.terminate()
      wss.close(); server.close(() => {
        for (const d of docs.values()) { d.awareness.destroy(); d.doc.destroy() }
        docs.clear(); done()
      })
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const bound = typeof addr === 'object' && addr ? addr.port : port
      for (const signal of signals) process.on(signal, onSignal)
      resolve({
        port: bound,
        close,
      })
    })
  })
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * Find the clone's local relay or become it. Then keep watching: if the relay dies and this
 * process is still around, take over on the same port so connected providers reconnect
 * without a URL change.
 *
 * Starting is race-free: the port is derived from the common dir, so of two processes that
 * start together exactly one binds; the other sees EADDRINUSE, waits for the winner's file,
 * and joins. If that port is held by something that is not a room relay, any free port is used
 * instead, and a short re-check afterwards adopts a relay another racer may have recorded.
 */
export async function ensureLocalRelay(commonDir: string, room: string, opts: { log?: (line: string) => void; watchMs?: number; staticDir?: string } = {}): Promise<LocalRelay> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  let owned: { port: number; close(): Promise<void> } | null = null
  let port = 0
  let key = ''
  /** Publish the discovery file atomically: readers see the old file or the new one, never a partial one. */
  const write = () => {
    const file = relayFile(commonDir), tmp = `${file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify({ port, pid: process.pid, room, startedAt: Date.now(), key } satisfies LocalRelayInfo) + '\n', { mode: 0o600 })
      fs.chmodSync(tmp, 0o600)
      fs.renameSync(tmp, file)
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* nothing to clean */ }
      log(`local relay: could not write ${file}: ${e instanceof Error ? e.message : e}`)
    }
  }
  /** The relay recorded in the file, if it serves this clone and accepts the recorded key; otherwise the file is stale. */
  const recorded = async (): Promise<LocalRelayInfo | undefined> => {
    const info = readRelayInfo(commonDir)
    if (!info) return undefined
    const who = await probeRelay(info.port, commonDir, info.key)
    if (who === 'foreign') log(`local room ${room}: ${relayFile(commonDir)} names a relay on 127.0.0.1:${info.port} that does not serve this clone with its key; treating the file as stale`)
    return who === 'ours' ? info : undefined
  }
  const adopt = (info: LocalRelayInfo, how: string) => {
    port = info.port; key = info.key
    log(`local room ${room}: ${how} relay on 127.0.0.1:${port} (pid ${info.pid}${pidAlive(info.pid) ? '' : ', pid gone but relay answers'})`)
  }

  const existing = await recorded()
  if (existing) adopt(existing, 'joined')
  else {
    key = readRelayInfo(commonDir)?.key ?? crypto.randomBytes(16).toString('hex')
    const want = deterministicPort(commonDir)
    try {
      owned = await startRelay(want, { key, staticDir: opts.staticDir, commonDir, log })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
      // Someone else bound our port: a racer (give it a moment to write the file) or an unrelated service.
      let winner: LocalRelayInfo | undefined
      for (let i = 0; i < 20 && !winner; i++) { await new Promise(r => setTimeout(r, 100)); winner = await recorded() }
      if (winner) adopt(winner, 'lost the start race; joined')
      else { owned = await startRelay(0, { key, staticDir: opts.staticDir, commonDir, log }); log(`local room ${room}: port ${want} is taken by something else; using a free port`) }
    }
    if (owned) {
      port = owned.port
      write()
      log(`local room ${room}: started relay on 127.0.0.1:${port}`)
      // Another racer that also fell back to a free port may have written after us: keep one relay.
      await new Promise(r => setTimeout(r, 150))
      const other = readRelayInfo(commonDir)
      if (other && other.port !== port && other.pid !== process.pid && (await probeRelay(other.port, commonDir, other.key)) === 'ours') {
        await owned.close(); owned = null
        adopt(other, 'two relays started together; closed ours and joined the')
      } else if (other?.port !== port) write()
    }
  }

  let stopped = false
  let lost: string | undefined
  let ticking: Promise<void> | null = null
  const tick = async () => {
    if (stopped || owned || lost) return
    const who = await probeRelay(port, commonDir, key)
    if (stopped || who === 'ours') return
    if (who === 'foreign') {
      lost = `127.0.0.1:${port} is now another clone's relay`
      log(`local room ${room}: ${lost}; the session will join afresh`)
      return
    }
    // Relay gone: race for its port. EADDRINUSE means another client won; we'll reconnect to it.
    let started: Awaited<ReturnType<typeof startRelay>>
    try { started = await startRelay(port, { key, staticDir: opts.staticDir, commonDir, log }) } catch { return /* someone else did */ }
    if (stopped) { await started.close(); return }
    owned = started
    write()
    log(`local room ${room}: relay owner left; took over on 127.0.0.1:${port}`)
  }
  // One takeover attempt at a time; stop() waits for the one in flight.
  const timer = setInterval(() => {
    if (ticking) return
    const work = observeTakeover(tick, error => log(`local room ${room}: relay takeover failed: ${error instanceof Error ? error.message : String(error)}`))
    ticking = work
    void work.then(() => { if (ticking === work) ticking = null })
  }, opts.watchMs ?? 2000)
  timer.unref?.()

  return {
    url: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    port,
    key,
    get owned() { return owned !== null },
    get lost() { return lost },
    async forget() {
      const response = await fetch('http://127.0.0.1:' + port + '/memory?room=' + encodeURIComponent(room), {
        method: 'DELETE', headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error('could not forget local room memory: ' + response.status)
    },
    async stop() {
      stopped = true
      clearInterval(timer)
      await ticking
      // The file stays: it records the port and key the survivors will take over with, and new
      // joiners probe the port before trusting it.
      if (owned) { await owned.close(); owned = null }
    },
  }
}
