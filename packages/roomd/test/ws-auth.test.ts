import { describe, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => [] as unknown[][])
vi.mock('@room/relay', () => ({
  localProofHeader: (key: string, method: string, path: string, port: number) => `proof:${key}:${method}:${path}:${port}`,
  SecureSession: class { clientHello() { return new Uint8Array(30) } },
}))
vi.mock('ws', () => ({ default: class {
  constructor(...args: unknown[]) { calls.push(args) }
} }))
import { authorizedWebSocket } from '../src/ws-auth.js'

describe('Node websocket credentials', () => {
  it('provides hosted headers without relay framing', () => {
    const Polyfill = authorizedWebSocket({ session: 'room-session', token: 'shared' })
    new Polyfill('ws://127.0.0.1:1/room?schema=2')
    expect(calls.at(-1)![2]).toEqual({ headers: { authorization: 'Bearer room-session', 'x-room-token': 'shared' } })
  })
  it('signs each relay upgrade; in-band proof gates document frames', () => {
    const Polyfill = authorizedWebSocket({ key: 'private' })
    new Polyfill('ws://127.0.0.1:4402/local%2Fr?schema=2')
    expect(calls.at(-1)![2]).toEqual({ headers: { authorization: 'proof:private:GET:/local%2Fr?schema=2:4402' } })
  })
})
