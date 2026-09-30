import crypto from 'node:crypto'
import http from 'node:http'

export const PROOF_WINDOW_MS = 30_000
const REPLAY_CACHE_MAX = 10_000
const prefix = 'room-relay-v1\0'

function mac(key: string, message: string): string { return crypto.createHmac('sha256', key).update(prefix + message).digest('hex') }
export function sameProof(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || !/^[a-f0-9]{64}$/.test(a)) return false
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}
export function relayProof(key: string, nonce: string, port: number): string { return mac(key, `relay\0${nonce}\0${port}`) }
export function localViewKey(key: string, room: string): string { return mac(key, `view\0${room}`) }
export function viewTicketProof(viewKey: string, room: string, ts: number, nonce: string): string { return mac(viewKey, `ticket\0${room}\0${ts}\0${nonce}`) }
export function localProofHeader(key: string, method: string, path: string, port: number, ts = Date.now(), nonce = crypto.randomBytes(16).toString('hex')): string {
  return `Room-Proof ${ts}.${nonce}.${mac(key, `client\0${method.toUpperCase()}\0${path}\0${port}\0${ts}\0${nonce}`)}`
}
export class ProofVerifier {
  private seen = new Map<string, number>()
  constructor(private readonly key: string, private readonly port: number, private readonly now: () => number = Date.now) {}
  verify(header: unknown, method: string, path: string): boolean {
    if (typeof header !== 'string') return false
    const match = /^Room-Proof (\d{13})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(header)
    if (!match) return false
    const [, rawTs, nonce, proof] = match
    const ts = Number(rawTs), now = this.now()
    if (Math.abs(ts - now) > PROOF_WINDOW_MS) return false
    for (const [n, expiry] of this.seen) if (expiry <= now) this.seen.delete(n)
    if (this.seen.has(nonce) || this.seen.size >= REPLAY_CACHE_MAX) return false
    const expected = mac(this.key, `client\0${method.toUpperCase()}\0${path}\0${this.port}\0${ts}\0${nonce}`)
    if (!sameProof(proof, expected)) return false
    this.seen.set(nonce, now + PROOF_WINDOW_MS)
    return true
  }
}

/**
 * What answers on the port, in one request: its health line and whether it proved possession of `key` for
 * our nonce. Undefined when nothing answers with a health line in time.
 */
export async function relayIdentity(port: number, key: string, timeoutMs = 800): Promise<{ health: Record<string, unknown>; proven: boolean } | undefined> {
  const nonce = crypto.randomBytes(16).toString('hex')
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs, headers: { 'x-room-nonce': nonce } }, res => {
      let body = ''
      res.on('data', c => { body += c; if (body.length > 2048) req.destroy() })
      res.on('end', () => {
        try {
          const health = JSON.parse(body) as Record<string, unknown>
          if (res.statusCode !== 200 || !health || typeof health !== 'object') { resolve(undefined); return }
          resolve({ health, proven: sameProof(health.proof, relayProof(key, nonce, port)) })
        } catch { resolve(undefined) }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve(undefined) })
    req.on('error', () => resolve(undefined))
  })
}

/** Verify the listener before a caller transmits a request carrying any local authority. */
export async function relayHealth(port: number, key: string, timeoutMs = 800): Promise<Record<string, unknown> | undefined> {
  const identity = await relayIdentity(port, key, timeoutMs)
  return identity?.proven ? identity.health : undefined
}
