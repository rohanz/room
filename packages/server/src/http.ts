import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'

export class HttpFailure extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/** Attach before admission or storage awaits so an early disconnect cannot be missed. */
export function requestCancellation(req: http.IncomingMessage, res: http.ServerResponse) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  req.once('aborted', cancel); res.once('close', cancel)
  if (req.aborted || res.destroyed || res.writableEnded) cancel()
  return { signal: controller.signal, cancelled: () => controller.signal.aborted || res.destroyed,
    dispose: () => { req.off('aborted', cancel); res.off('close', cancel) } }
}

/** A disconnected waiter releases its response slot while shared upstream work can finish. */
export async function waitForResult<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined
  let cancel!: () => void
  const stopped = new Promise<undefined>(resolve => { cancel = () => resolve(undefined); signal.addEventListener('abort', cancel, { once: true }) })
  try { return await Promise.race([work, stopped]) }
  finally { signal.removeEventListener('abort', cancel) }
}

export function waitForDrain(res: http.ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted || res.destroyed) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => { res.off('drain', done); res.off('close', done); signal.removeEventListener('abort', done); resolve() }
    res.once('drain', done); res.once('close', done); signal.addEventListener('abort', done, { once: true })
  })
}

export function waitForResponse(res: http.ServerResponse): Promise<void> {
  if (res.writableFinished || res.destroyed) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => { res.off('finish', done); res.off('close', done); resolve() }
    res.once('finish', done); res.once('close', done)
  })
}

export interface ByteBudget { reserve(bytes: number): (() => void) | undefined }

/** Counts complete operations, including work continuing after a client disconnects. */
export class WorkSlots {
  private readonly principals = new Map<string, number>()
  private active = 0
  constructor(readonly maxActive: number, readonly maxPerPrincipal: number, private readonly bytes: ByteBudget) {}
  reserve(principal: string, amount = 0, perPrincipal = this.maxPerPrincipal): { release(): void; resize(bytes: number): boolean } | undefined {
    if (this.active >= this.maxActive || (this.principals.get(principal) ?? 0) >= perPrincipal) return undefined
    let releaseBytes = this.bytes.reserve(amount)
    if (!releaseBytes) return undefined
    this.active++; this.principals.set(principal, (this.principals.get(principal) ?? 0) + 1)
    let released = false
    return {
      resize: size => {
        if (released || size < 0 || !Number.isFinite(size)) return false
        if (size === amount) return true
        if (size < amount) { releaseBytes?.(); releaseBytes = this.bytes.reserve(size); amount = size; return !!releaseBytes }
        const extra = this.bytes.reserve(size - amount)
        if (!extra) return false
        const previous = releaseBytes
        releaseBytes = () => { previous?.(); extra() }
        amount = size
        return true
      },
      release: () => { if (!released) { released = true; releaseBytes?.(); this.active--; const n = this.principals.get(principal)! - 1; if (n) this.principals.set(principal, n); else this.principals.delete(principal) } },
    }
  }
  get count(): number { return this.active }
}

/** Use verified account identity, never the replaceable session bearer value. */
export function workPrincipal(identity: { id?: string; provider?: string; login?: string } | undefined, sharedToken: boolean, address: string): string {
  if (identity?.id) return `id:${identity.id}`
  if (identity?.login) return `${identity.provider ?? 'github'}:${identity.login.toLowerCase()}`
  return sharedToken ? 'shared-token' : `address:${address}`
}

export function isAdminIdentity(st: { login: string; id?: string; provider?: 'github' | 'oidc' }, admins: ReadonlySet<string>): boolean {
  return st.provider === 'oidc' ? !!st.id && admins.has(st.id) : st.provider === 'github' && admins.has(st.login)
}

/** Node accepts some request targets that URL rejects. Parse once before routing or authentication. */
export function safeUrl(target: string | undefined): URL {
  if (!target || !target.startsWith('/') || target.startsWith('//') || /[\x00-\x1f\x7f]/.test(target)) throw new HttpFailure(400, 'Bad Request')
  try { return new URL(target, 'http://x') } catch { throw new HttpFailure(400, 'Bad Request') }
}

export function staticFile(root: string, pathname: string): string | undefined {
  let rel: string
  try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname) } catch { throw new HttpFailure(400, 'Bad Request') }
  const base = fs.realpathSync(root)
  const candidate = path.resolve(base, '.' + rel)
  const relative = path.relative(base, candidate)
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return undefined
  let real: string
  try { real = fs.realpathSync(candidate) } catch { return undefined }
  const inside = path.relative(base, real)
  if (inside.startsWith('..' + path.sep) || inside === '..' || path.isAbsolute(inside)) return undefined
  return fs.statSync(real).isFile() ? real : undefined
}

export function bodyReader(opts: { maxBytes?: number; maxConcurrent?: number; timeoutMs?: number } = {}) {
  const maxBytes = opts.maxBytes ?? 65536
  const maxConcurrent = opts.maxConcurrent ?? 32
  const timeoutMs = opts.timeoutMs ?? 10000
  let active = 0
  return (req: http.IncomingMessage, requestOpts: { maxBytes?: number } = {}): Promise<string> => {
    const requestMaxBytes = requestOpts.maxBytes ?? maxBytes
    if (active >= maxConcurrent) return Promise.reject(new HttpFailure(503, 'too many request bodies'))
    const length = req.headers['content-length']
    if (length && Number(length) > requestMaxBytes) return Promise.reject(new HttpFailure(413, 'request body too large'))
    active++
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let bytes = 0, settled = false
      const done = (error?: Error) => {
        if (settled) return
        settled = true; active--; clearTimeout(timer)
        req.off('data', data); req.off('end', end); req.off('aborted', aborted); req.off('close', close)
        const body = error ? undefined : Buffer.concat(chunks, bytes).toString('utf8')
        chunks.length = 0
        if (error) reject(error); else resolve(body!)
      }
      const data = (part: Buffer | string) => {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
        bytes += chunk.length
        if (bytes > requestMaxBytes) { done(new HttpFailure(413, 'request body too large')); req.pause(); return }
        chunks.push(chunk)
      }
      const end = () => done()
      const aborted = () => done(new HttpFailure(400, 'request aborted'))
      const errorEvent = () => done(new HttpFailure(400, 'request error'))
      const close = () => { if (!req.complete) done(new HttpFailure(400, 'request closed')) }
      const timer = setTimeout(() => { done(new HttpFailure(408, 'request body timed out')); req.pause() }, timeoutMs)
      req.on('data', data); req.once('end', end); req.once('aborted', aborted); req.on('error', errorEvent); req.once('close', close)
    })
  }
}

/** Fixed window budgets bound expensive anonymous work and return a retry delay. */
export class RateLimit {
  private readonly entries = new Map<string, { count: number; until: number }>()
  constructor(private readonly count: number, private readonly windowMs: number, private readonly maxKeys = 10000) {}
  check(key: string, now = Date.now()): number {
    const prior = this.entries.get(key)
    if (prior && prior.until > now) {
      if (prior.count >= this.count) return Math.max(1, Math.ceil((prior.until - now) / 1000))
      prior.count++; return 0
    }
    if (this.entries.size >= this.maxKeys) {
      for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k)
      if (this.entries.size >= this.maxKeys) this.entries.delete(this.entries.keys().next().value!)
    }
    this.entries.set(key, { count: 1, until: now + this.windowMs })
    return 0
  }
}

/** Each reader owns its output, even when the upstream load is shared. */
export class ResponseWork {
  private released = false
  private responseDone = false
  private working = 0
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly done = () => {
    if (this.responseDone) return
    this.responseDone = true
    clearTimeout(this.timer)
    this.res.off('finish', this.done); this.res.off('close', this.done)
    this.releaseIfDone()
  }
  private releaseIfDone(): void {
    if (this.responseDone && !this.working && !this.released) { this.released = true; this.slot.release() }
  }
  /** Keep already-started work bounded even after its reader disconnects. */
  hold(): () => void {
    this.working++
    let released = false
    return () => { if (!released) { released = true; this.working--; this.releaseIfDone() } }
  }
  private constructor(private readonly slot: NonNullable<ReturnType<WorkSlots['reserve']>>, private readonly res: http.ServerResponse, deadlineMs: number) {
    this.timer = setTimeout(() => { res.destroy(); this.done() }, deadlineMs)
    this.timer.unref?.()
    res.once('finish', this.done); res.once('close', this.done)
    if (res.destroyed || res.writableFinished) this.done()
  }
  static reserve(slots: WorkSlots, principal: string, res: http.ServerResponse, deadlineMs: number): ResponseWork | undefined {
    const slot = slots.reserve(principal)
    return slot ? new ResponseWork(slot, res, deadlineMs) : undefined
  }
  resize(bytes: number): boolean { return !this.responseDone && !this.released && this.slot.resize(bytes) }
  send(status: number, body: string, contentType = 'application/json'): boolean {
    if (this.res.destroyed || this.res.writableEnded || !this.resize(Buffer.byteLength(body))) return false
    this.res.writeHead(status, { 'content-type': contentType })
    this.res.end(body)
    return true
  }
}

export async function scanRooms<T>(rooms: ReadonlyMap<string, T>, admitted: (repo: string) => Promise<boolean>, signal: AbortSignal, maxRooms: number): Promise<({ repo: string } & T)[]> {
  const out: ({ repo: string } & T)[] = []
  let scanned = 0
  for (const [repo, entry] of rooms) {
    if (signal.aborted || scanned++ >= maxRooms) break
    const ok = await admitted(repo)
    if (signal.aborted) break
    if (ok) out.push({ repo, ...entry })
  }
  return out
}

/** Keep the list informational and bounded; serialize once per coalesced load. */
export function archiveListing(repo: string, legacy: string[], keys: { size: number; keys(): IterableIterator<string> }, limit: number): string {
  const unresolved: string[] = []
  for (const key of keys.keys()) { if (unresolved.length >= limit) break; unresolved.push(key) }
  return JSON.stringify({ repo, legacy, unresolved, unresolvedTotal: keys.size, ...(keys.size > unresolved.length ? { truncated: true } : {}) })
}
