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
  it('drops a slow consumer while a fast one still receives, and evicts the largest aggregate queue', () => {
    const budget = new OutboundBudget(100, 120)
    const fake = (queued: number) => ({ bufferedAmount: queued, send: vi.fn(), close: vi.fn(), terminate: vi.fn(), once: vi.fn() })
    const slow = fake(95), fast = fake(0), fastSend = fast.send
    budget.track(slow); budget.track(fast)
    slow.send(Buffer.alloc(10)); fast.send(Buffer.alloc(10))
    expect(slow.terminate).toHaveBeenCalledOnce()
    expect(fastSend).toHaveBeenCalledOnce()
    // Into an empty queue a message always goes, whatever its size: it is the only way a large document arrives.
    const idle = fake(0), idleSend = idle.send
    budget.track(idle); idle.send(Buffer.alloc(500))
    expect(idleSend).toHaveBeenCalledOnce()
    expect(idle.terminate).not.toHaveBeenCalled()
    const larger = fake(100), smaller = fake(50)
    budget.track(larger); budget.track(smaller); budget.sweep()
    expect(larger.terminate).toHaveBeenCalledOnce()
    expect(smaller.terminate).not.toHaveBeenCalled()
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
