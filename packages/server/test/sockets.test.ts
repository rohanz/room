import { describe, expect, it, vi } from 'vitest'
import { CredentialSockets, PermissionRevalidator, ConnectionReservations, OutboundBudget } from '../src/sockets.js'

describe('credential sockets and tickets', () => {
  it('closes live sockets and invalidates tickets when a session is removed', () => {
    const registry = new CredentialSockets()
    const socket = { close: vi.fn(), once: vi.fn() }
    const credential = { kind: 'session' as const, value: 'session-id' }
    registry.track(credential, socket)
    const { ticket } = registry.mint('github.com/o/r', credential, false)
    registry.close(credential, 4401, 'logged out')
    expect(socket.close).toHaveBeenCalledWith(4401, 'logged out')
    expect(registry.take(ticket, 'github.com/o/r')).toBeUndefined()
  })

  it('enforces one use, exact room and 60-second expiry', () => {
    let now = 0
    const registry = new CredentialSockets(() => now)
    const credential = { kind: 'view' as const, value: 'view-key' }
    const first = registry.mint('local/demo', credential, true).ticket
    expect(registry.take(first, 'local/other')).toBeUndefined()
    expect(registry.take(first, 'local/demo')).toBeUndefined()
    const second = registry.mint('local/demo', credential, true).ticket
    expect(registry.take(second, 'local/demo')).toEqual({ credential, readOnly: true })
    expect(registry.take(second, 'local/demo')).toBeUndefined()
    const third = registry.mint('local/demo', credential, true).ticket
    now = 60_001
    expect(registry.take(third, 'local/demo')).toBeUndefined()
  })

  it('revokes one repository without disconnecting other rooms of the same session', () => {
    const registry = new CredentialSockets()
    const credential = { kind: 'session' as const, value: 'one-login' }
    const denied = { close: vi.fn(), once: vi.fn() }, other = { close: vi.fn(), once: vi.fn() }
    registry.track(credential, denied, 'github.com/o/denied')
    registry.track(credential, other, 'github.com/o/other')
    registry.closeRoom(credential, 'github.com/o/denied', 4403, 'access revoked')
    expect(denied.close).toHaveBeenCalledWith(4403, 'access revoked')
    expect(other.close).not.toHaveBeenCalled()
  })
  it('invalidates an in-flight upgrade generation on logout and repo revocation', () => {
    const registry = new CredentialSockets()
    const credential = { kind: 'session' as const, value: 's' }
    const before = registry.generation(credential)
    registry.close(credential, 4401, 'logged out')
    expect(registry.unchanged(credential, before)).toBe(false)
    const next = registry.generation(credential)
    registry.closeRoom(credential, 'github.com/o/r', 4403, 'revoked')
    expect(registry.unchanged(credential, next)).toBe(false)
  })
})

describe('connection and outbound budgets', () => {
  it('reserves concurrent cross-repository capacity before any load', () => {
    const quotas = new ConnectionReservations({ total: 2, room: 2, principal: 2, pending: 2, pendingAddress: 2 })
    const first = quotas.reserve('r1', 'p', 'a')!, second = quotas.reserve('r2', 'p', 'a')!
    expect(quotas.reserve('r3', 'p', 'a')).toBeUndefined()
    first.admitted(); second.admitted()
    expect(quotas.total).toBe(2)
    first(); second()
    expect(quotas.total).toBe(0)
  })
  it('reserves every send before enqueue, evicts the largest queue, and releases on completion', () => {
    const budget = new OutboundBudget(100, 120)
    const fake = () => {
      let complete: ((error?: Error) => void) | undefined
      const socket = { bufferedAmount: 0, send: vi.fn((_data: unknown, callback: (error?: Error) => void) => { complete = callback }),
        close: vi.fn(), terminate: vi.fn(), once: vi.fn() }
      return { socket, complete: () => complete?.() }
    }
    const a = fake(), b = fake(), c = fake()
    for (const item of [a, b, c]) budget.track(item.socket)
    a.socket.send(Buffer.alloc(70)); b.socket.send(Buffer.alloc(40))
    expect(budget.queuedBytes).toBe(110)
    c.socket.send(Buffer.alloc(50))
    expect(a.socket.terminate).toHaveBeenCalledOnce()
    expect(b.socket.terminate).not.toHaveBeenCalled()
    expect(budget.queuedBytes).toBe(90)
    b.complete(); expect(budget.queuedBytes).toBe(50)
    const huge = fake(); budget.track(huge.socket); huge.socket.send(Buffer.alloc(500))
    expect(huge.complete()).toBeUndefined()
    expect(huge.socket.close).toHaveBeenCalledWith(1013, 'server output budget exhausted; retry')
    expect(budget.queuedBytes).toBeLessThanOrEqual(120)
    c.complete(); expect(budget.queuedBytes).toBe(0)
  })
  it('keeps N concurrent initial responses within the process ceiling', () => {
    const budget = new OutboundBudget(100, 100)
    const readers = Array.from({ length: 10 }, () => {
      const callbacks: ((error?: Error) => void)[] = []
      const sent = vi.fn((_data: unknown, callback: (error?: Error) => void) => callbacks.push(callback))
      const socket = { bufferedAmount: 0, send: sent, close: vi.fn(), terminate: vi.fn(), once: vi.fn() }
      budget.track(socket)
      return { socket, callbacks, sent }
    })
    for (const reader of readers) {
      reader.socket.send(Buffer.alloc(80))
      expect(budget.queuedBytes).toBeLessThanOrEqual(100)
    }
    expect(readers.filter(r => r.sent.mock.calls.length)).toHaveLength(10)
    expect(readers.filter(r => r.socket.terminate.mock.calls.length)).toHaveLength(9)
    readers[9].callbacks[0]()
    expect(budget.queuedBytes).toBe(0)
  })
})

describe('permission revalidation', () => {
  it('checks each session/repo pair sequentially, retains outage, and revokes a definite denial', async () => {
    const calls: string[] = []
    const denied = vi.fn(), unavailable = vi.fn()
    const check = vi.fn(async (session: string, repo: string) => {
      calls.push(`${session}:${repo}`)
      return repo === 'github.com/o/b' ? false : undefined
    })
    const loop = new PermissionRevalidator(check, denied, unavailable)
    loop.track('s', 'github.com/o/a'); loop.track('s', 'github.com/o/a'); loop.track('s', 'github.com/o/b')
    await loop.run()
    expect(calls).toEqual(['s:github.com/o/a', 's:github.com/o/b'])
    expect(unavailable).toHaveBeenCalledOnce()
    expect(denied).toHaveBeenCalledWith('s', 'github.com/o/b')
    await loop.run()
    expect(check).toHaveBeenCalledTimes(3)
    expect(unavailable).toHaveBeenCalledOnce()
  })
})
