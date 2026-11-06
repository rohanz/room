// Cross-root process fixture. All production modules come from the selected release bundle.
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import { writeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { cleanEnv, timed } from './compat-process.mts'

const self = fileURLToPath(import.meta.url)
const [mode, authorityRoot, clientRoot, extra] = process.argv.slice(2)
const fixture = (root: string) => import(pathToFileURL(path.join(root, '.compat-exports.bundle.mjs')).href)
const pause = () => new Promise(resolve => setTimeout(resolve, 20))
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 8_000
  while (!check()) { if (Date.now() > deadline) throw new Error(`timed out: ${label}`); await pause() }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 1000)
  await closed
  clearTimeout(timer)
}

async function hosted(root: string) {
  // Historical CLIs print configured PORT (0), so observe the actual bound port
  // without changing their source or reserving-and-releasing a racy free port.
  const { Server } = await import('node:http')
  const listen = Server.prototype.listen
  Server.prototype.listen = function(...args: any[]) {
    this.once('listening', () => {
      const address = this.address()
      assert(address && typeof address === 'object')
      console.log(`COMPAT_READY ${address.port}`)
    })
    return listen.apply(this, args as any)
  } as typeof listen
  await import(pathToFileURL(path.join(root, 'packages/server/dist/server.mjs')).href)
}

async function relay(root: string, dir: string, key: string) {
  const { startRelay, AuthorityLock } = await fixture(root)
  const lock = AuthorityLock.take(dir)
  assert(lock, 'fixture owns relay authority')
  const server = await startRelay(0, { commonDir: dir, key, hub: { lock } })
  console.log(`COMPAT_READY ${server.port}`)
  process.once('SIGTERM', () => { void server.close().finally(() => process.exit(0)) })
}

/** Run the genuine standalone runtime, with its own key/discovery and existing authority lock. */
async function daemon(root: string, dir: string) {
  const api = (await fixture(root)).daemon
  assert.equal(typeof api?.startLocalDaemon, 'function', 'authority fixture implements the standalone daemon')
  execFileSync('git', ['init', '--bare', dir], { stdio: 'ignore' })
  const runtime = await api.startLocalDaemon({ commonDir: dir, room: 'local/compat', idleMs: 60_000 })
  assert(runtime, 'fixture owns standalone daemon authority')
  const info = runtime.info
  assert.equal(info.runtime, 'daemon')
  // This test harness passes the private key over an inherited pipe only, never argv or logs.
  writeSync(3, info.key)
  console.log(`COMPAT_READY ${info.port}`)
  process.once('SIGTERM', () => { void runtime.close().then(() => process.exit(0), (error: unknown) => { console.error(error); process.exit(1) }) })
  await runtime.closed
}

/** Use the exercised release's kernel process identity, as local holder liveness does. */
export function fixtureHolder(processes: { probeProcessNow(pid: number): { startTime?: string; executable?: string } | undefined }, sessionId: string) {
  const identity = processes.probeProcessNow(process.pid)
  assert(identity, 'fixture process is alive')
  return { sessionId, pid: process.pid, startTime: identity.startTime ?? '', executable: identity.executable ?? '' }
}

/** Observe raw inbound frames before AuthorizedWebSocket consumes bootstrap replies. */
export function observeSocketMessages(Socket: { prototype: { emit: (event: string, ...args: any[]) => boolean } }, observe: (data: any, source: object) => void) {
  const emit = Socket.prototype.emit
  Socket.prototype.emit = function(event: string, ...args: any[]) {
    if (event === 'message') observe(args[0], this)
    return emit.call(this, event, ...args)
  }
}

type WireFrame = { connection: number; direction: string; type: number; op?: string; id?: string; re?: string; ok?: boolean; reason?: string; retryMs?: number }

/** A relay waits for prior replicas during SETTLE_MS; this is not holder-probe retry. */
export function validateAcquireTrace(trace: WireFrame[], settleMs: number, retryMs: number) {
  const requests = trace.filter(frame => frame.direction === 'out' && frame.op === 'acquire')
  assert(requests.length > 0, 'acquire appears in the wire trace')
  const replies = requests.map(request => {
    const reply = trace.find(frame => frame.direction === 'in' && frame.connection === request.connection && frame.re === request.id)
    assert(reply, `acquire ${request.id} has a reply`)
    return reply
  })
  assert(replies.at(-1)?.ok === true, 'the final acquire succeeds')
  const refused = replies.slice(0, -1)
  assert(refused.every(reply => reply.ok === false && reply.reason === 'starting' && reply.retryMs === retryMs),
    `acquire retries must be startup settling, not identity failures: ${JSON.stringify(refused)}`)
  assert(refused.length <= Math.ceil(settleMs / retryMs), 'acquire starting retries exceed the hub settle budget')
  return { attempts: requests.length, startingRefusals: refused.length, retryWaitBudgetMs: settleMs }
}

async function client(root: string, endpoint: string, key?: string) {
  const { HubClient, hubTransport, authorizedWebSocket, RoomDoc, roomConnection, WebsocketProvider, Doc, contracts, SecureSession, WebSocket, processes, clientCompat } = await fixture(root)
  const health = await (await fetch(endpoint.replace('ws:', 'http:') + '/health')).json()
  assert.equal(health.schema, 2, 'legacy schema remains advertised')
  assert.equal(health.hub, 1, 'legacy hub remains advertised')
  const trace: WireFrame[] = []
  const connections = new WeakMap<object, number>()
  let nextConnection = 0
  const record = (direction: string, data: any, source: object) => {
    if (!connections.has(source)) connections.set(source, ++nextConnection)
    const connection = connections.get(source)!
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Buffer.from(data)
    const type = bytes[0]
    if (![0, 1, 2, 3, 7].includes(type)) return // encrypted handshake, recorded separately
    const frame = type === 7 ? contracts.decodeFrame(bytes) : undefined
    trace.push({ connection, direction, type, ...(frame?.op ? { op: frame.op, id: frame.id } : {}), ...(typeof frame?.ok === 'boolean' ? { ok: frame.ok } : {}), ...(frame?.re ? { re: frame.re } : {}), ...(typeof frame?.reason === 'string' ? { reason: frame.reason } : {}), ...(typeof frame?.retryMs === 'number' ? { retryMs: frame.retryMs } : {}) })
  }
  // Instrument the actual wire beneath the production negotiation queue. Relay traces are
  // captured at authenticated encryption boundaries, before encrypt / after decrypt.
  if (key) {
    const encrypt = SecureSession.prototype.encrypt
    SecureSession.prototype.encrypt = function(data: any) { record('out', data, this); return encrypt.call(this, data) }
    const decrypt = SecureSession.prototype.decrypt
    SecureSession.prototype.decrypt = function(data: any) { const plain = decrypt.call(this, data); record('in', plain, this); return plain }
  } else {
    const send = WebSocket.prototype.send
    WebSocket.prototype.send = function(data: any, ...args: any[]) { record('out', data, this); return send.call(this, data, ...args) }
  }
  const selections: any[] = []
  const offer = (health.runtime === 'daemon' ? clientCompat?.LOCAL_CLIENT_COMPAT : undefined) ?? contracts.CURRENT_COMPAT
  const daemonAuthority = health.runtime === 'daemon'
  const daemonCapable = !!offer?.capabilities?.['room.daemon']?.includes(1)
  const expectRefusal = daemonAuthority && !daemonCapable
  const refusals: string[] = []
  const negotiating = !!health.compat && !!contracts.CURRENT_COMPAT
  const Socket = authorizedWebSocket({ ...(key ? { key } : {}), ...(negotiating ? {
    negotiation: { offer, sessionId: `compat-${process.pid}`, onSelection: (selection: any) => selections.push(selection), onRefusal: (text: string) => refusals.push(text) },
  } : {}) })
  if (expectRefusal) {
    const emit = Socket.prototype.emit
    Socket.prototype.emit = function(event: string, ...args: any[]) {
      if (event === 'unexpected-response' && args[1]?.statusCode === 426) refusals.push('HTTP 426: unsupported local daemon runtime')
      if (event === 'close' && args[0] === 4406) refusals.push(`4406: ${String(args[1])}`)
      return emit.call(this, event, ...args)
    }
  }
  if (!key) observeSocketMessages(Socket, (data, source) => record('in', data, source))
  const room = `local/compat-${process.pid}`
  if (!key) {
    const created = await fetch(endpoint.replace('ws:', 'http:') + '/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, schema: 2 }) })
    assert(created.ok, `create fixture room: ${created.status} ${await created.text()}`)
  }
  const docs = [new Doc(), new Doc()]
  const providers = docs.map(doc => new WebsocketProvider(endpoint, encodeURIComponent(room), doc, { ...roomConnection(doc), WebSocketPolyfill: Socket }))
  const hubs = providers.map(provider => new HubClient({ transport: hubTransport(provider), client: 'room-mcp', sessionId: `compat-${process.pid}`, local: !!key }))
  try {
    if (expectRefusal) {
      await until(() => refusals.length > 0, 'explicit legacy-client daemon refusal')
      assert(providers.every(provider => !provider.synced), 'legacy providers never sync with daemon')
      assert(!trace.some(frame => frame.direction === 'in' && [0, 1, 3].includes(frame.type)), 'daemon sends no Yjs/awareness before refusal')
      assert(docs.every(doc => new RoomDoc(doc).messages().length === 0), 'no false successful room state')
      console.log(JSON.stringify({ daemonAuthority, assertion: 'legacy runtime refused before sync; drain old clients and restart updated plugin', refusals, trace }))
      return
    }
    await until(() => providers.every(provider => provider.synced), 'both providers sync')
    await Promise.all(hubs.map(hub => hub.hello()))
    // Relays conservatively settle for 5 seconds; HubClient retries 'starting'
    // under its existing request timeout + SETTLE_MS budget. Hosted fresh rooms skip settling.
    const acquireStarted = performance.now()
    const epoch = await hubs[0].acquire('compat', fixtureHolder(processes, `compat-${process.pid}`))
    assert(epoch > 0)
    const acquire = { ...validateAcquireTrace(trace, contracts.SETTLE_MS, contracts.STARTING_RETRY_MS),
      requestBudgetMs: (key ? contracts.REQUEST_TIMEOUT_LOCAL_MS : contracts.REQUEST_TIMEOUT_TEAM_MS) + contracts.SETTLE_MS,
      ms: Math.round(performance.now() - acquireStarted) }
    const writer = new RoomDoc(docs[0])
    const reader = new RoomDoc(docs[1])
    const claim = writer.addClaim({ by: 'compat', path: 'fixture.ts', from: 1, to: 1, intent: 'compatibility fixture', fence: String(epoch) })
    await until(() => reader.openClaims().some(item => item.id === claim.id && item.fence === String(epoch)), 'claim fence replicates')
    const ids = [`compat-${process.pid}-1`, `compat-${process.pid}-2`]
    for (const id of ids) await hubs[0].post({ id, type: 'note', from: 'compat', text: 'compatibility fixture' }, { lease: { name: 'compat', epoch } })
    await until(() => ids.every(id => reader.messages().some(msg => msg.id === id)), 'posted message IDs replicate')
    const messages = reader.messages().filter(msg => ids.includes(msg.id))
    assert.deepEqual(messages.map(msg => msg.id), ids)
    assert(messages[0].seq < messages[1].seq, 'hub assigns ordered message sequence')
    await hubs[0].release('compat')
    if (negotiating) {
      assert.equal(selections.length, 2, 'both providers selected a contract')
      for (const connection of new Set(trace.map(frame => frame.connection))) {
        const frames = trace.filter(frame => frame.connection === connection)
        const firstSync = frames.findIndex(frame => [0, 1, 3].includes(frame.type))
        const ack = frames.findIndex(frame => frame.op === 'compat-ack' && frame.direction === 'out')
        const confirmed = frames.findIndex(frame => frame.direction === 'in' && frame.re === frames[ack]?.id && frame.ok === true)
        assert(ack >= 0 && confirmed > ack && firstSync > confirmed, `positive compatibility ACK precedes all Yjs/awareness frames on each connection: ${JSON.stringify(frames)}`)
      }
    } else assert(!trace.some(frame => frame.op === 'compat-hello'), 'legacy path sends no extended hello')
    console.log(JSON.stringify({ negotiating, assertion: 'hello, lease, fenced claim, ordered posts and independent reader', observed: { acquire, messageIds: messages.map(msg => msg.id), messageSeq: messages.map(msg => msg.seq), claimId: claim.id, claimFence: String(epoch) }, trace }))
  } finally {
    hubs.forEach(hub => hub.close())
    providers.forEach(provider => { provider.destroy(); provider.awareness.destroy() })
    docs.forEach(doc => doc.destroy())
  }
}

async function pair(transport: string, authority: string, currentClient: string) {
  assert(['server', 'relay', 'daemon'].includes(transport))
  const dir = await fs.mkdtemp(path.join(extra || os.tmpdir(), 'room-compat-pair-'))
  let key = transport === 'relay' ? randomBytes(32).toString('hex') : ''
  const startup = performance.now()
  const server = transport === 'daemon'
    ? spawn(process.execPath, ['--import', import.meta.resolve('tsx'), self, '--daemon', authority, dir], { cwd: dir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
    : transport === 'relay'
    ? spawn(process.execPath, ['--import', import.meta.resolve('tsx'), self, '--relay', authority, dir, key], { cwd: dir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, ['--import', import.meta.resolve('tsx'), self, '--server', authority], { cwd: dir, env: { ...cleanEnv(), PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', port = 0, serverError: Error | undefined
  if (transport === 'daemon') {
    server.stdio[3]!.on('data', (data: Buffer) => {
      key += data.toString()
      if (key.length > 128 || !/^[a-f0-9]*$/.test(key)) { serverError = new Error('invalid daemon key pipe'); server.kill('SIGKILL') }
    })
  }
  server.on('error', error => { serverError = error })
  server.stdout!.on('data', data => {
    output += data.toString()
    const match = output.match(/COMPAT_READY (\d+)/)
    if (match) port = Number(match[1])
    if (output.length > 64_000) { serverError = new Error('authority exceeded output budget'); server.kill('SIGKILL') }
  })
  server.stderr!.on('data', data => { output = (output + data.toString()).slice(-64_000) })
  let peer: ChildProcess | undefined
  try {
    try { await until(() => { if (serverError || server.exitCode !== null) throw serverError ?? new Error(`authority exited: ${output}`); return port > 0 && (transport !== 'daemon' || key.length === 64) }, 'authority readiness') }
    finally { console.log(`TIMING ${transport} startup ms=${Math.round(performance.now() - startup)}`) }
    await timed('exchange', async () => {
      peer = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), self, '--client', currentClient, `ws://127.0.0.1:${port}`], { cwd: dir, env: cleanEnv(), stdio: ['pipe', 'inherit', 'inherit'] })
      peer.stdin!.end(key)
      await new Promise<void>((resolve, reject) => {
        peer!.once('error', reject)
        peer!.once('close', code => code === 0 ? resolve() : reject(new Error(`client exited ${code}`)))
      })
    })
  } finally {
    await timed('teardown', async () => {
      if (peer) await stop(peer)
      await stop(server)
      // Windows can release a just-exited process's directory handles after its exit event (EBUSY on rmdir).
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  try {
    if (mode === '--server') await hosted(authorityRoot)
    else if (mode === '--relay') await relay(authorityRoot, clientRoot, extra)
    else if (mode === '--daemon') await daemon(authorityRoot, clientRoot)
    else if (mode === '--client') {
      let key = ''
      for await (const chunk of process.stdin) { key += chunk; assert(key.length <= 128, 'local key input budget') }
      await client(authorityRoot, clientRoot, key || undefined)
    }
    else await pair(mode, authorityRoot, clientRoot)
  } catch (error) { console.error(error); process.exitCode = 1 }
}
