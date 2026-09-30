import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
const calls = vi.hoisted(() => [] as unknown[][])
const health = vi.hoisted(() => vi.fn().mockResolvedValue({ local: true }))
vi.mock('@room/relay', () => ({ relayHealth: health, localProofHeader: (key: string, method: string, path: string, port: number) => `proof:${key}:${method}:${path}:${port}` }))
vi.mock('ws', () => ({ default: class {
  constructor(...args: unknown[]) { calls.push(args) }
} }))
import { authorizedWebSocket } from '../src/ws-auth.js'

describe('Node websocket credentials', () => {
  it('provides a polyfill with headers while provider params contain only schema', () => {
    const Polyfill = authorizedWebSocket({ session: 'room-session', token: 'shared' })
    new Polyfill('ws://127.0.0.1:1/room?schema=2')
    expect(calls[0]![0]).toBe('ws://127.0.0.1:1/room?schema=2')
    expect(calls[0]![2]).toEqual({ headers: { authorization: 'Bearer room-session', 'x-room-token': 'shared' } })
  })
  it('waits for a fresh relay challenge before signing each upgrade', async () => {
    const Polyfill = authorizedWebSocket({ key: 'private' })
    new Polyfill('ws://127.0.0.1:4402/local%2Fr?schema=2')
    const options = calls.at(-1)![2] as { headers: Record<string, string>; finishRequest: (request: { setHeader: (name: string, value: string) => void; end: () => void; destroy: (error: Error) => void }) => void }
    expect(options.headers).not.toHaveProperty('authorization')
    const request = { setHeader: vi.fn(), end: vi.fn(), destroy: vi.fn() }
    options.finishRequest(request)
    await vi.waitFor(() => expect(request.end).toHaveBeenCalledOnce())
    expect(health).toHaveBeenCalledWith(4402, 'private')
    expect(request.setHeader).toHaveBeenCalledWith('authorization', 'proof:private:GET:/local%2Fr?schema=2:4402')
  })
})
