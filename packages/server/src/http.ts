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
