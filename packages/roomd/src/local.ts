/**
 * Local rooms: no server. The first process to join a clone's local room starts a tiny
 * y-websocket relay on 127.0.0.1 (in-memory, no auth, no persistence) and records it in
 * `<git common dir>/room-local.json`. Later processes on the same clone (or any worktree of
 * it) find the file, check the relay answers, and connect. When the relay's owner exits,
 * any remaining client notices within a couple of seconds and races to start a relay on the
 * same port; the losers reconnect to the winner. Every client holds the full document, so a
 * relay restart loses nothing: clients sync their state back into the new one.
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import { git } from './git.js'

// ---- a minimal y-websocket relay (the wire protocol of y-websocket 3.x; no persistence, no auth) ----
const MSG_SYNC = 0, MSG_AWARENESS = 1
interface RelayDoc { doc: Y.Doc; awareness: awarenessProtocol.Awareness; conns: Map<WebSocket, Set<number>> }
function relayDocs(): Map<string, RelayDoc> { return new Map() }
function send(conn: WebSocket, buf: Uint8Array): void {
  if (conn.readyState !== conn.OPEN) return
  try { conn.send(buf) } catch { try { conn.close() } catch { /* gone */ } }
}
function getDoc(docs: Map<string, RelayDoc>, name: string): RelayDoc {
  let d = docs.get(name)
  if (d) return d
  const doc = new Y.Doc({ gc: true })
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalState(null)
  d = { doc, awareness, conns: new Map() }
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
function attach(docs: Map<string, RelayDoc>, conn: WebSocket, req: http.IncomingMessage): void {
  const name = (req.url ?? '/').slice(1).split('?')[0]
  const d = getDoc(docs, name)
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
    const ids = d.conns.get(conn)
    d.conns.delete(conn)
    if (ids?.size) awarenessProtocol.removeAwarenessStates(d.awareness, Array.from(ids), null)
    if (!d.conns.size) { d.awareness.destroy(); d.doc.destroy(); docs.delete(name) }
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

export interface LocalRelayInfo { port: number; pid: number; room: string; startedAt: number }

export interface LocalRelay {
  /** ws://127.0.0.1:<port> */
  url: string
  port: number
  /** True when this process runs the relay. */
  owned: boolean
  stop(): Promise<void>
}

export const LOCAL_FILE = 'room-local.json'

/** The git dir shared by every worktree of a clone; the relay file lives there. */
export async function gitCommonDir(dir: string): Promise<string> {
  const out = (await git(dir, ['rev-parse', '--git-common-dir'])).trim()
  return path.resolve(dir, out)
}

/** The main worktree's checkout (the directory holding the common .git). */
export async function mainWorktree(dir: string): Promise<string> {
  const common = await gitCommonDir(dir)
  return path.basename(common) === '.git' ? path.dirname(common) : path.resolve(dir)
}

/** Local room name: local/<repo basename>/<branch of the main worktree>, so every worktree of a clone shares one room. */
export async function localRoomName(dir: string, localBranch?: string): Promise<string> {
  const main = await mainWorktree(dir)
  let branch = localBranch
  if (!branch) {
    try { branch = (await git(main, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() } catch { branch = 'main' }
    if (!branch || branch === 'HEAD') branch = 'detached'
  }
  return `local/${path.basename(main)}/${branch}`
}

export function relayFile(commonDir: string): string { return path.join(commonDir, LOCAL_FILE) }

export function readRelayInfo(commonDir: string): LocalRelayInfo | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(relayFile(commonDir), 'utf8')) as Partial<LocalRelayInfo>
    return typeof v.port === 'number' && typeof v.pid === 'number' ? { port: v.port, pid: v.pid, room: String(v.room ?? ''), startedAt: Number(v.startedAt ?? 0) } : undefined
  } catch { return undefined }
}

/** Does something accept TCP connections on 127.0.0.1:port? */
export function portAnswers(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { sock.destroy(); resolve(ok) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(timeoutMs, () => done(false))
  })
}

/** Start a relay on 127.0.0.1:port (0 = any free port). Rejects with EADDRINUSE when someone else won the race. */
export function startRelay(port: number): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"local":true}') })
    const wss = new WebSocketServer({ noServer: true })
    const docs = relayDocs()
    wss.on('connection', (conn, req) => attach(docs, conn, req))
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)))
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const bound = typeof addr === 'object' && addr ? addr.port : port
      resolve({
        port: bound,
        close: () => new Promise<void>(done => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => done()) }),
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
 */
export async function ensureLocalRelay(commonDir: string, room: string, opts: { log?: (line: string) => void; watchMs?: number } = {}): Promise<LocalRelay> {
  const log = opts.log ?? (() => {})
  let owned: { port: number; close(): Promise<void> } | null = null
  let port = 0
  const write = () => { try { fs.writeFileSync(relayFile(commonDir), JSON.stringify({ port, pid: process.pid, room, startedAt: Date.now() } satisfies LocalRelayInfo) + '\n') } catch (e) { log(`local relay: could not write ${relayFile(commonDir)}: ${e instanceof Error ? e.message : e}`) } }

  const existing = readRelayInfo(commonDir)
  if (existing && (await portAnswers(existing.port))) {
    port = existing.port
    log(`local room ${room}: relay on 127.0.0.1:${port} (pid ${existing.pid}${pidAlive(existing.pid) ? '' : ', pid gone but port answers'})`)
  } else {
    // Prefer the recorded port so stale URLs keep working; fall back to any free port.
    const want = existing?.port ?? 0
    try { owned = await startRelay(want) } catch { owned = await startRelay(0) }
    port = owned.port
    write()
    log(`local room ${room}: started relay on 127.0.0.1:${port}`)
  }

  let stopped = false
  const tick = async () => {
    if (stopped || owned) return
    if (await portAnswers(port)) return
    // Relay gone: race for its port. EADDRINUSE means another client won; we'll reconnect to it.
    try {
      owned = await startRelay(port)
      write()
      log(`local room ${room}: relay owner left; took over on 127.0.0.1:${port}`)
    } catch { /* someone else did */ }
  }
  const timer = setInterval(() => { void tick() }, opts.watchMs ?? 2000)
  timer.unref?.()

  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    get owned() { return owned !== null },
    async stop() {
      stopped = true
      clearInterval(timer)
      // The file stays: it records the port the survivors will take over on, and new joiners
      // probe the port before trusting it.
      if (owned) { await owned.close(); owned = null }
    },
  }
}
