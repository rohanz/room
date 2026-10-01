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
  onClose(fn: () => void): () => void
}

/** y-websocket dispatches by provider.messageHandlers (src/y-websocket.js:118-124).
 * Each provider owns a copy (line 358), and an empty encoder sends no reply (line 231). */
export function hubTransport(provider: WebsocketProvider): HubTransport {
  // An in-memory provider (RoomdOptions.providerFactory) has no hub channel: the hub is unreachable over it.
  if (!provider.messageHandlers) return { send() { throw new Error('hub unreachable') }, connected: () => false, onFrame: () => () => {}, onReconnect: () => () => {}, onClose: () => () => {} }
  const listeners = new Set<(bytes: Uint8Array) => void>()
  const reconnects = new Set<() => void>()
  const closes = new Set<() => void>()
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
    if (event.status === 'disconnected') for (const fn of closes) fn()
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
      return () => { reconnects.delete(fn); if (!reconnects.size && !closes.size) provider.off('status', status) }
    },
    onClose(fn) {
      closes.add(fn)
      return () => { closes.delete(fn); if (!reconnects.size && !closes.size) provider.off('status', status) }
    },
  }
}

const PAUSED = '[room] hub unreachable; coordination paused. Your files are unaffected; messages and claims resume when it is back.'
const NOT_SENT = 'not sent: hub unreachable'
const NOT_SENT_LEASE = 'not sent: name lease is no longer held; rejoin to take a new name'
export class NameLeaseUnavailable extends Error {}
/** Distinguishes transport loss from a caller's lease check or a hub refusal. */
class TransportUnavailable extends Error {
  constructor() { super('hub unreachable') }
}

type Lease = { epoch: number; ttlMs: number; t0: number; w0: number }
type Renewal = { promise: Promise<void>; wake?: () => void }
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
  private transport: HubTransport
  private readonly mono: () => number
  private readonly wall: () => number
  private readonly timeoutMs: number
  private readonly leases = new Map<string, Lease>()
  private readonly lostLeases = new Set<string>()
  private readonly pending = new Map<string, Pending>()
  private readonly retryWaits = new Set<{ timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void }>()
  private unsubs: Array<() => void>
  private readonly interval: ReturnType<typeof setInterval>
  private nextId = 0
  private helloOk = false
  private pauseReason?: string
  private readonly renewing = new Map<Lease, Renewal>()
  private closed = false

  constructor(private readonly options: HubClientOptions) {
    this.transport = options.transport
    this.mono = options.mono ?? (() => performance.now())
    this.wall = options.wall ?? (() => Date.now())
    this.timeoutMs = options.local === false ? REQUEST_TIMEOUT_TEAM_MS : REQUEST_TIMEOUT_LOCAL_MS
    this.unsubs = this.subscribe()
    this.interval = setInterval(() => { void this.renewAll() }, LEASE_RENEW_MS)
    this.interval.unref?.()
  }

  private subscribe(): Array<() => void> {
    return [
      this.transport.onFrame(bytes => this.receive(bytes)),
      this.transport.onReconnect(() => { void this.reconnect() }),
      this.transport.onClose(() => this.disconnected()),
    ]
  }

  /**
   * Move to another connection of the same room (the join's probe hands over to the daemon's provider).
   * Leases and their clocks stay; the next renew makes the new connection the one the hub pushes to.
   */
  attach(transport: HubTransport): void {
    this.assertOpen()
    for (const unsub of this.unsubs) unsub()
    this.disconnected()
    this.transport = transport
    this.unsubs = this.subscribe()
    if (transport.connected()) void this.reconnect()
  }

  /** The hub answered hello on the current connection, which is still up. */
  reachable(): boolean { return !this.closed && this.helloOk && this.transport.connected() }

  /** The epoch of `name`'s lease while it is valid by the send-time clock (§4.3). */
  lease(name: string): number | undefined {
    if (this.closed) return undefined
    this.dropExpired()
    return this.leases.get(name)?.epoch
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

  hello(): Promise<Reply> { return this.handshake() }

  private async handshake(budgetMs?: number): Promise<Reply> {
    try {
      const reply = await this.request({ op: 'hello', proto: HUB_PROTO, schema: 2, client: this.options.client, sessionId: this.options.sessionId }, undefined, budgetMs)
      this.helloOk = true
      this.pauseReason = undefined
      this.renewAll(true)
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

  /**
   * A lead's reservation of its worker's name (registry §15 row 3): granted like any acquire, but neither kept nor
   * renewed here. The worker presents the epoch (`supersedes`) when it joins; a reservation it never takes up
   * ends at the hub's TTL.
   */
  async reserve(name: string, holder: HolderIn): Promise<number> {
    const reply = await this.request({ op: 'acquire', name, holder })
    return Number(reply.epoch)
  }

  async renew(name: string): Promise<void> {
    this.assertOpen()
    this.dropExpired()
    const lease = this.leases.get(name)
    if (!lease) throw new Error(NOT_SENT)
    const existing = this.renewing.get(lease)
    if (existing) return existing.promise
    const renewal = {} as Renewal
    this.renewing.set(lease, renewal)
    renewal.promise = this.renewLease(name, lease, renewal).finally(() => this.renewing.delete(lease))
    return renewal.promise
  }

  private async renewLease(name: string, lease: Lease, renewal: Renewal): Promise<void> {
    let backoffMs = 1_000
    for (;;) {
      this.assertOpen()
      this.dropExpired()
      if (this.leases.get(name) !== lease) throw new Error(NOT_SENT)
      let t0 = 0, w0 = 0
      try {
        const reply = await this.request({ op: 'renew', name, epoch: lease.epoch }, () => {
          this.dropExpired()
          if (this.leases.get(name) !== lease) throw new Error(NOT_SENT)
          t0 = this.mono(); w0 = this.wall()
        }, Math.min(this.remainingValidity(lease), this.timeoutMs + SETTLE_MS), renewal)
        if (this.leases.get(name) !== lease) return
        if (!this.valid(lease)) { this.lose(name); return }
        Object.assign(lease, { ttlMs: Number(reply.ttlMs ?? LEASE_TTL_MS), t0, w0 })
        return
      } catch (error) {
        if (error instanceof HubError && (error.reason === 'stale' || error.reason === 'not-yours') && this.leases.get(name) === lease) this.lose(name)
        this.dropExpired()
        if (this.closed || this.leases.get(name) !== lease) throw error
        // The last acknowledged send remains the fence, even if an unacknowledged
        // attempt extended the hub's TTL. Never send or wait past our own window.
        await this.retryDelay(Math.min(backoffMs, this.remainingValidity(lease)), renewal)
        backoffMs = Math.min(backoffMs * 2, 4_000)
      }
    }
  }

  async release(name: string): Promise<void> {
    this.assertOpen()
    const lease = this.leases.get(name)
    if (!lease) { this.lostLeases.delete(name); return }
    await this.request({ op: 'release', name, epoch: lease.epoch })
    if (this.leases.get(name) === lease) {
      this.leases.delete(name)
      this.renewing.get(lease)?.wake?.()
    }
    this.lostLeases.delete(name)
  }

  /** Every post carries the poster's own lease (hub §2.3), valid here by the send-time clock. */
  async post(msg: PostIn, options: { lease: { name: string; epoch: number }; auto?: boolean }): Promise<Reply> {
    this.assertOpen()
    if (this.paused()) throw this.reachable() && this.lostLeases.has(options.lease.name) ? new NameLeaseUnavailable(NOT_SENT_LEASE) : new Error(NOT_SENT)
    if (this.leases.get(options.lease.name)?.epoch !== options.lease.epoch) throw this.reachable() ? new NameLeaseUnavailable(NOT_SENT_LEASE) : new Error(NOT_SENT)
    try { return await this.request({ op: 'post', msg, ...options }, () => {
      if (this.paused() || this.leases.get(options.lease.name)?.epoch !== options.lease.epoch) {
        throw this.reachable() ? new NameLeaseUnavailable(NOT_SENT_LEASE) : new Error(NOT_SENT)
      }
    }) }
    catch (error) {
      if (error instanceof HubError && (error.reason === 'stale' || error.reason === 'not-yours')
        && this.leases.get(options.lease.name)?.epoch === options.lease.epoch) this.lose(options.lease.name)
      throw error
    }
  }

  private valid(lease: Lease): boolean {
    return this.remainingValidity(lease) > 0
  }

  private remainingValidity(lease: Lease): number {
    return lease.ttlMs - Math.max(this.mono() - lease.t0, this.wall() - lease.w0)
  }

  private dropExpired(): void {
    for (const [name, lease] of this.leases) if (!this.valid(lease)) this.lose(name)
  }

  private lose(name: string): void {
    const lease = this.leases.get(name)
    this.leases.delete(name)
    this.lostLeases.add(name)
    if (lease) this.renewing.get(lease)?.wake?.()
  }

  private renewAll(immediate = false): void {
    if (!this.helloOk) return
    this.dropExpired()
    for (const [name, lease] of this.leases) {
      const renewal = this.renewing.get(lease)
      if (renewal) {
        if (immediate) renewal.wake?.()
        continue
      }
      void this.renew(name).catch(() => {})
    }
  }

  private async reconnect(): Promise<void> {
    try { await this.hello() } catch { /* The next reconnect or caller can retry. */ }
  }

  private disconnected(): void {
    this.helloOk = false
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new TransportUnavailable())
    }
    this.pending.clear()
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

  private async request(body: RequestBody, onSend?: () => void, budgetMs?: number, renewal?: Renewal): Promise<Extract<Reply, { ok: true }>> {
    this.assertOpen()
    const startedMono = this.mono(), startedWall = this.wall()
    const startingBudget = budgetMs ?? this.timeoutMs + SETTLE_MS
    const elapsed = () => Math.max(this.mono() - startedMono, this.wall() - startedWall)
    let interrupted = false
    const remaining = () => (interrupted ? this.timeoutMs : startingBudget) - elapsed()
    for (;;) {
      // Posts are deduped by msg.id and replay here. Lease operations leave recovery
      // to their callers, including renew's loop bounded by the validity window.
      if (interrupted) {
        if (remaining() <= 0) throw new TransportUnavailable()
        if (!this.reachable()) {
          await this.retryDelay(Math.min(100, remaining()))
          continue
        }
      }
      let t: Reply
      try { t = await this.requestOnce(body, onSend, Math.min(this.timeoutMs, remaining())) }
      catch (error) {
        if (body.op !== 'post' || !(error instanceof TransportUnavailable)) throw error
        interrupted = true
        continue
      }
      this.assertOpen()
      if (t.ok) return t
      if (t.reason === 'starting' || t.reason === 'unavailable' || t.reason === 'rate-limited') {
        const left = remaining()
        if (left <= 0) throw new HubError(t.reason, t.text)
        await this.retryDelay(Math.min(Math.max(1, t.retryMs ?? 1_000), left), renewal)
        this.assertOpen()
        if (remaining() <= 0) throw new HubError(t.reason, t.text)
        continue
      }
      if (t.reason === 'hello-first' && body.op !== 'hello') {
        if (remaining() <= 0) throw new TransportUnavailable()
        try { await this.handshake(remaining()) }
        catch (error) {
          if (body.op !== 'post' || !(error instanceof TransportUnavailable)) throw error
          interrupted = true
        }
        continue
      }
      throw new HubError(t.reason, t.text)
    }
  }

  private requestOnce(body: RequestBody, onSend?: () => void, timeoutMs = this.timeoutMs): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error('hub client closed'))
    if (!this.transport.connected()) return Promise.reject(new TransportUnavailable())
    const id = `r${++this.nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('the hub did not answer'))
      }, timeoutMs)
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

  private retryDelay(ms: number, renewal?: Renewal): Promise<void> {
    this.assertOpen()
    return new Promise((resolve, reject) => {
      const wait = { timer: undefined as unknown as ReturnType<typeof setTimeout>, reject }
      const done = () => {
        clearTimeout(wait.timer)
        this.retryWaits.delete(wait)
        if (renewal) renewal.wake = undefined
        resolve()
      }
      wait.timer = setTimeout(done, ms)
      this.retryWaits.add(wait)
      if (renewal) renewal.wake = done
    })
  }
}

export class HubError extends Error {
  constructor(readonly reason: string, message: string) { super(message) }
}
