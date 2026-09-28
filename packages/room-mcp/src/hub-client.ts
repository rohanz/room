import type { WebsocketProvider } from 'y-websocket'
import {
  decodeFrame, encodeFrame, HUB_PROTO, LEASE_RENEW_MS, LEASE_TTL_MS, MSG_HUB,
  REQUEST_TIMEOUT_LOCAL_MS, REQUEST_TIMEOUT_TEAM_MS, SETTLE_MS,
  type HolderIn, type PostIn, type Push, type Reply, type Req,
} from '@room/hub-core'

export interface HubTransport {
  send(bytes: Uint8Array): void
  connected(): boolean
  onFrame(fn: (bytes: Uint8Array) => void): () => void
  onReconnect(fn: () => void): () => void
}

/** y-websocket dispatches by provider.messageHandlers (src/y-websocket.js:118-124).
 * Each provider owns a copy (line 358), and an empty encoder sends no reply (line 231). */
export function hubTransport(provider: WebsocketProvider): HubTransport {
  const listeners = new Set<(bytes: Uint8Array) => void>()
  const reconnects = new Set<() => void>()
  const old = provider.messageHandlers[MSG_HUB]
  provider.messageHandlers[MSG_HUB] = (_encoder, decoder) => {
    // The provider has consumed the type. Re-encode it so the transport has one wire format.
    try {
      const frame = decodeFrame(decoder) as Parameters<typeof encodeFrame>[0]
      const bytes = encodeFrame(frame)
      for (const fn of listeners) fn(bytes)
    } catch { /* Malformed hub frames cannot affect Yjs sync. */ }
  }
  const status = (event: { status: string }) => {
    if (event.status === 'connected') for (const fn of reconnects) fn()
  }
  provider.on('status', status)
  return {
    send(bytes) {
      if (!provider.wsconnected || !provider.ws) throw new Error('hub unreachable')
      provider.ws.send(bytes)
    },
    connected: () => provider.wsconnected && !!provider.ws,
    onFrame(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn); if (!listeners.size) provider.messageHandlers[MSG_HUB] = old }
    },
    onReconnect(fn) {
      reconnects.add(fn)
      return () => { reconnects.delete(fn); if (!reconnects.size) provider.off('status', status) }
    },
  }
}

const PAUSED = '[room] hub unreachable; coordination paused. Your files are unaffected; messages and claims resume when it is back.'
const NOT_SENT = 'not sent: hub unreachable'

type Lease = { epoch: number; ttlMs: number; t0: number; w0: number }
type RequestBody = Req extends infer R ? R extends Req ? Omit<R, 'v' | 'id'> : never : never
type Pending = { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
export interface HubClientOptions {
  transport: HubTransport
  client: string
  sessionId: string
  local?: boolean
  mono?: () => number
  wall?: () => number
}

export class HubClient {
  private readonly transport: HubTransport
  private readonly mono: () => number
  private readonly wall: () => number
  private readonly timeoutMs: number
  private readonly leases = new Map<string, Lease>()
  private readonly lostLeases = new Set<string>()
  private readonly pending = new Map<string, Pending>()
  private readonly retryWaits = new Set<{ timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void }>()
  private readonly unsubs: Array<() => void>
  private readonly interval: ReturnType<typeof setInterval>
  private nextId = 0
  private helloOk = false
  private incarnation?: number
  private pauseReason?: string
  private renewing = new Set<string>()
  private closed = false

  constructor(private readonly options: HubClientOptions) {
    this.transport = options.transport
    this.mono = options.mono ?? (() => performance.now())
    this.wall = options.wall ?? (() => Date.now())
    this.timeoutMs = options.local === false ? REQUEST_TIMEOUT_TEAM_MS : REQUEST_TIMEOUT_LOCAL_MS
    this.unsubs = [
      this.transport.onFrame(bytes => this.receive(bytes)),
      this.transport.onReconnect(() => { void this.reconnect() }),
    ]
    this.interval = setInterval(() => { void this.renewAll() }, LEASE_RENEW_MS)
    this.interval.unref?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.helloOk = false
    clearInterval(this.interval)
    for (const unsub of this.unsubs) unsub()
    for (const wait of this.retryWaits) {
      clearTimeout(wait.timer)
      wait.reject(new Error('hub client closed'))
    }
    this.retryWaits.clear()
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('hub client closed'))
      this.pending.delete(id)
    }
  }

  paused(): string | undefined {
    if (this.closed) return PAUSED
    this.dropExpired()
    if (this.pauseReason) return `${PAUSED} ${this.pauseReason}`
    return this.helloOk && this.lostLeases.size === 0 ? undefined : PAUSED
  }

  async hello(): Promise<Reply> {
    try {
      const reply = await this.request({ op: 'hello', proto: HUB_PROTO, schema: 2, client: this.options.client, sessionId: this.options.sessionId })
      const old = this.incarnation
      this.incarnation = Number(reply.incarnation)
      this.helloOk = true
      this.pauseReason = undefined
      if (old !== undefined && old !== this.incarnation) void this.renewAll()
      return reply
    } catch (error) {
      this.helloOk = false
      if (error instanceof HubError && error.reason === 'version') {
        this.pauseReason = error.message
      } else if (error instanceof Error && error.message.includes('did not answer')) {
        this.pauseReason = 'the hub did not answer'
      }
      throw error
    }
  }

  async acquire(name: string, holder: HolderIn, supersedes?: number): Promise<number> {
    let t0 = 0, w0 = 0
    const reply = await this.request({ op: 'acquire', name, holder, ...(supersedes === undefined ? {} : { supersedes }) }, () => { t0 = this.mono(); w0 = this.wall() })
    const epoch = Number(reply.epoch)
    this.leases.set(name, { epoch, ttlMs: Number(reply.ttlMs ?? LEASE_TTL_MS), t0, w0 })
    this.lostLeases.delete(name)
    return epoch
  }

  async renew(name: string): Promise<void> {
    this.assertOpen()
    this.dropExpired()
    const lease = this.leases.get(name)
    if (!lease) throw new Error(NOT_SENT)
    let t0 = 0, w0 = 0
    try {
      const reply = await this.request({ op: 'renew', name, epoch: lease.epoch }, () => {
        if (!this.valid(lease)) {
          if (this.leases.get(name) === lease) this.lose(name)
          throw new Error(NOT_SENT)
        }
        t0 = this.mono(); w0 = this.wall()
      })
      if (this.leases.get(name) !== lease) return
      if (!this.valid(lease)) { this.lose(name); return }
      this.leases.set(name, { ...lease, ttlMs: Number(reply.ttlMs ?? LEASE_TTL_MS), t0, w0 })
    } catch (error) {
      if (error instanceof HubError && error.reason === 'stale' && this.leases.get(name) === lease) this.lose(name)
      throw error
    }
  }

  async release(name: string): Promise<void> {
    this.assertOpen()
    const lease = this.leases.get(name)
    if (!lease) { this.lostLeases.delete(name); return }
    try { await this.request({ op: 'release', name, epoch: lease.epoch }) }
    finally {
      if (this.leases.get(name) === lease) this.leases.delete(name)
      this.lostLeases.delete(name)
    }
  }

  async post(msg: PostIn, options: { lease?: { name: string; epoch: number }; auto?: boolean } = {}): Promise<Reply> {
    this.assertOpen()
    if (this.paused()) throw new Error(NOT_SENT)
    if (options.lease && this.leases.get(options.lease.name)?.epoch !== options.lease.epoch) throw new Error(NOT_SENT)
    try { return await this.request({ op: 'post', msg, ...options }, () => {
      if (this.paused() || (options.lease && this.leases.get(options.lease.name)?.epoch !== options.lease.epoch)) {
        throw new Error(NOT_SENT)
      }
    }) }
    catch (error) {
      if (error instanceof HubError && error.reason === 'stale' && options.lease
        && this.leases.get(options.lease.name)?.epoch === options.lease.epoch) this.lose(options.lease.name)
      throw error
    }
  }

  private valid(lease: Lease): boolean {
    return Math.max(this.mono() - lease.t0, this.wall() - lease.w0) < lease.ttlMs
  }

  private dropExpired(): void {
    for (const [name, lease] of this.leases) if (!this.valid(lease)) this.lose(name)
  }

  private lose(name: string): void {
    this.leases.delete(name)
    this.lostLeases.add(name)
  }

  private async renewAll(): Promise<void> {
    if (!this.helloOk) return
    this.dropExpired()
    for (const name of this.leases.keys()) {
      if (this.renewing.has(name)) continue
      this.renewing.add(name)
      void this.renew(name).catch(() => {}).finally(() => this.renewing.delete(name))
    }
  }

  private async reconnect(): Promise<void> {
    try { await this.hello() } catch { /* The next reconnect or caller can retry. */ }
  }

  private receive(bytes: Uint8Array): void {
    let frame: unknown
    try { frame = decodeFrame(bytes) } catch { return }
    if (!frame || typeof frame !== 'object' || !('v' in frame) || frame.v !== 1) return
    if ('push' in frame && frame.push === 'lease-lost') {
      const push = frame as Push
      const lease = this.leases.get(push.name)
      if (lease?.epoch === push.epoch) this.lose(push.name)
      return
    }
    if (!('re' in frame) || typeof frame.re !== 'string') return
    const pending = this.pending.get(frame.re)
    if (!pending) return
    this.pending.delete(frame.re)
    clearTimeout(pending.timer)
    pending.resolve(frame as Reply)
  }

  private async request(body: RequestBody, onSend?: () => void): Promise<Extract<Reply, { ok: true }>> {
    this.assertOpen()
    const startedMono = this.mono(), startedWall = Date.now()
    const startingBudget = this.timeoutMs + SETTLE_MS
    const elapsed = () => Math.max(this.mono() - startedMono, Date.now() - startedWall)
    for (;;) {
      const t = await this.requestOnce(body, onSend)
      this.assertOpen()
      if (t.ok) return t
      if (t.reason === 'starting') {
        const remaining = startingBudget - elapsed()
        if (remaining <= 0) throw new HubError('starting', t.text)
        await this.retryDelay(Math.min(Math.max(1, t.retryMs ?? 1_000), remaining))
        this.assertOpen()
        if (elapsed() >= startingBudget) throw new HubError('starting', t.text)
        continue
      }
      if (t.reason === 'hello-first' && body.op !== 'hello') {
        await this.hello()
        continue
      }
      throw new HubError(t.reason, t.text)
    }
  }

  private requestOnce(body: RequestBody, onSend?: () => void): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error('hub client closed'))
    if (!this.transport.connected()) return Promise.reject(new Error('hub unreachable'))
    const id = `r${++this.nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('the hub did not answer'))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.assertOpen(); onSend?.(); this.assertOpen(); this.transport.send(encodeFrame({ ...body, v: 1, id } as Req)) }
      catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('hub client closed')
  }

  private retryDelay(ms: number): Promise<void> {
    this.assertOpen()
    return new Promise((resolve, reject) => {
      const wait = { timer: undefined as unknown as ReturnType<typeof setTimeout>, reject }
      wait.timer = setTimeout(() => { this.retryWaits.delete(wait); resolve() }, ms)
      this.retryWaits.add(wait)
    })
  }
}

export class HubError extends Error {
  constructor(readonly reason: string, message: string) { super(message) }
}
