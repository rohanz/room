import crypto from 'node:crypto'

export type Credential = { kind: 'session' | 'view' | 'token'; value: string }
export interface ClosableSocket { close(code: number, reason: string): void; once(event: 'close', listener: () => void): void }

/** Credentials, rather than IP addresses, own live connections and one-use upgrade tickets. */
export class CredentialSockets {
  private readonly live = new Map<string, Set<ClosableSocket>>()
  private readonly generations = new Map<string, number>()
  private readonly rooms = new WeakMap<ClosableSocket, string>()
  private readonly tickets = new Map<string, { credential: Credential; room: string; readOnly: boolean; expires: number }>()
  constructor(private readonly now: () => number = Date.now, private readonly maxTickets = 10000, private readonly ttlMs = 60_000) {}
  private key(c: Credential): string { return `${c.kind}:${c.value}` }
  private bump(c: Credential): void {
    const key = this.key(c)
    this.generations.set(key, this.generation(c) + 1)
    // Credentials are random opaque values; a reused value after eviction is infeasible.
    if (this.generations.size > 20000) this.generations.delete(this.generations.keys().next().value!)
  }
  generation(c: Credential): number { return this.generations.get(this.key(c)) ?? 0 }
  unchanged(c: Credential, generation: number): boolean { return this.generation(c) === generation }
  track(c: Credential, socket: ClosableSocket, room = ''): void {
    const key = this.key(c)
    let group = this.live.get(key)
    if (!group) { group = new Set(); this.live.set(key, group) }
    group.add(socket)
    this.rooms.set(socket, room)
    socket.once('close', () => { group!.delete(socket); this.rooms.delete(socket); if (!group!.size) this.live.delete(key) })
  }
  close(c: Credential, code: number, reason: string): void {
    this.bump(c)
    for (const socket of this.live.get(this.key(c)) ?? []) socket.close(code, reason)
    for (const [ticket, value] of this.tickets) if (this.key(value.credential) === this.key(c)) this.tickets.delete(ticket)
  }
  closeRoom(c: Credential, room: string, code: number, reason: string): void {
    this.bump(c)
    for (const socket of this.live.get(this.key(c)) ?? []) if (this.rooms.get(socket) === room) socket.close(code, reason)
    for (const [ticket, value] of this.tickets) if (this.key(value.credential) === this.key(c) && value.room === room) this.tickets.delete(ticket)
  }
  mint(room: string, credential: Credential, readOnly: boolean): { ticket: string; expiresIn: number } {
    this.sweep()
    if (this.tickets.size >= this.maxTickets) throw new Error('too many pending websocket tickets')
    const ticket = crypto.randomBytes(16).toString('hex')
    this.tickets.set(ticket, { room, credential, readOnly, expires: this.now() + this.ttlMs })
    return { ticket, expiresIn: Math.ceil(this.ttlMs / 1000) }
  }
  take(ticket: string, room: string): { credential: Credential; readOnly: boolean } | undefined {
    const value = this.tickets.get(ticket)
    if (!value) return undefined
    this.tickets.delete(ticket)
    if (value.expires <= this.now() || value.room !== room) return undefined
    return { credential: value.credential, readOnly: value.readOnly }
  }
  sweep(): void { for (const [ticket, value] of this.tickets) if (value.expires <= this.now()) this.tickets.delete(ticket) }
}

/** Reserve before asynchronous admission; the release closure is safe on every exit path. */
export class ConnectionReservations {
  readonly room = new Map<string, number>()
  readonly principal = new Map<string, number>()
  readonly address = new Map<string, number>()
  total = 0
  pending = 0
  constructor(readonly limits: { total: number; room: number; principal: number; pending: number; pendingAddress: number }) {}
  reserve(room: string, principal: string, address: string): (() => void) & { admitted(): void } | undefined {
    if (this.total >= this.limits.total || (this.room.get(room) ?? 0) >= this.limits.room ||
      (this.principal.get(principal) ?? 0) >= this.limits.principal || this.pending >= this.limits.pending ||
      (this.address.get(address) ?? 0) >= this.limits.pendingAddress) return undefined
    this.total++; this.pending++
    this.room.set(room, (this.room.get(room) ?? 0) + 1)
    this.principal.set(principal, (this.principal.get(principal) ?? 0) + 1)
    this.address.set(address, (this.address.get(address) ?? 0) + 1)
    let released = false, admitted = false
    const finishPending = () => { this.pending--; decrement(this.address, address) }
    const release = (() => {
      if (released) return
      released = true
      if (!admitted) finishPending()
      this.total--
      decrement(this.room, room); decrement(this.principal, principal)
    }) as (() => void) & { admitted(): void }
    release.admitted = () => { if (!admitted) { admitted = true; finishPending() } }
    return release
  }
}
function decrement(map: Map<string, number>, key: string): void { const n = (map.get(key) ?? 1) - 1; if (n) map.set(key, n); else map.delete(key) }

export interface BufferedSocket extends ClosableSocket {
  bufferedAmount: number
  send(data: unknown, ...args: unknown[]): void
  terminate(): void
}
/** Wrap send, so all producers (including the stock Yjs broadcaster) share one ceiling. */
export class OutboundBudget {
  private readonly sockets = new Set<BufferedSocket>()
  constructor(private readonly perSocket: number, private readonly total: number) {}
  track(socket: BufferedSocket): void {
    const send = socket.send.bind(socket)
    socket.send = ((data: unknown, ...args: unknown[]) => {
      if (!this.sockets.has(socket)) return
      const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data instanceof Uint8Array ? data.byteLength : Buffer.isBuffer(data) ? data.byteLength : 0
      // Into an empty queue a message always goes: a large document has no other way to arrive.
      if (socket.bufferedAmount > 0 && socket.bufferedAmount + bytes > this.perSocket) { this.drop(socket); return }
      send(data, ...args)
    }) as BufferedSocket['send']
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
  }
  sweep(): void {
    let total = [...this.sockets].reduce((n, s) => n + s.bufferedAmount, 0)
    if (total <= this.total) return
    for (const socket of [...this.sockets].sort((a, b) => b.bufferedAmount - a.bufferedAmount)) {
      if (total <= this.total) break
      total -= socket.bufferedAmount
      this.drop(socket)
    }
  }
  private drop(socket: BufferedSocket): void {
    if (!this.sockets.delete(socket)) return
    // 1013 is retryable by y-websocket clients; 44xx is terminal to them.
    socket.close(1013, 'slow consumer; retry')
    socket.terminate()
  }
}

/** Sequential, cache-bypassing permission checks shared by every socket of a session/repo pair. */
export class PermissionRevalidator {
  private readonly pairs = new Map<string, Map<string, number>>()
  private readonly warned = new Set<string>()
  private running = false
  constructor(private readonly check: (session: string, repo: string) => Promise<boolean | undefined>,
    private readonly revoked: (session: string, repo: string) => void,
    private readonly unavailable: (session: string, repo: string) => void) {}
  track(session: string, repo: string): () => void {
    let repos = this.pairs.get(session)
    if (!repos) { repos = new Map(); this.pairs.set(session, repos) }
    repos.set(repo, (repos.get(repo) ?? 0) + 1)
    return () => {
      const current = this.pairs.get(session)
      const count = current?.get(repo) ?? 0
      if (count > 1) current!.set(repo, count - 1)
      else { current?.delete(repo); this.warned.delete(`${session}\0${repo}`) }
      if (current && !current.size) this.pairs.delete(session)
    }
  }
  forget(session: string): void {
    this.pairs.delete(session)
    for (const key of this.warned) if (key.startsWith(`${session}\0`)) this.warned.delete(key)
  }
  async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const [session, repos] of this.pairs) for (const repo of repos.keys()) {
        const key = `${session}\0${repo}`
        let result: boolean | undefined
        try { result = await this.check(session, repo) } catch { result = undefined }
        if (result === false) {
          this.revoked(session, repo)
          const current = this.pairs.get(session)
          current?.delete(repo)
          if (current && !current.size) this.pairs.delete(session)
          this.warned.delete(key)
          continue
        }
        if (result === undefined && !this.warned.has(key)) { this.warned.add(key); this.unavailable(session, repo) }
        if (result === true) this.warned.delete(key)
      }
    } finally { this.running = false }
  }
}
