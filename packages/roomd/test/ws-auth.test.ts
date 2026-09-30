import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
const calls = vi.hoisted(() => [] as unknown[][])
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
})
