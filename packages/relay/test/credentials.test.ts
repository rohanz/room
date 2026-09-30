import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startRelay } from '../src/index.js'

const room = 'local/credentials'
describe('local relay credentials', () => {
  it('accepts header key, rejects query key, and spends a browser ticket once', async () => {
    const relay = await startRelay(0, { key: 'test-key', ticketTtlMs: 500 })
    const base = `http://127.0.0.1:${relay.port}`
    const connect = (query: string, headers: Record<string, string> = {}) => new Promise<number>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/${encodeURIComponent(room)}?schema=2${query}`, { headers })
      ws.once('open', () => { ws.close(); resolve(101) })
      ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate() })
      ws.once('error', () => resolve(0))
    })
    try {
      const health = await fetch(base + '/health')
      expect(health.headers.get('referrer-policy')).toBe('no-referrer')
      expect(await connect('', { authorization: 'Bearer test-key' })).toBe(101)
      expect(await connect('&key=test-key')).toBe(400)
      const minted = await fetch(base + '/ws-ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, schema: 2, key: 'test-key' }) })
      const { ticket } = await minted.json() as { ticket: string }
      expect(await connect(`&ticket=${ticket}`)).toBe(101)
      expect(await connect(`&ticket=${ticket}`)).toBe(403)
      const expiring = (await (await fetch(base + '/ws-ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, schema: 2, key: 'test-key' }) })).json() as { ticket: string }).ticket
      await new Promise(r => setTimeout(r, 550))
      expect(await connect(`&ticket=${expiring}`)).toBe(403)
    } finally { await relay.close() }
  })
})
