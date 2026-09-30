import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'

export class HttpFailure extends Error {
  constructor(public status: number, message: string) { super(message) }
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
