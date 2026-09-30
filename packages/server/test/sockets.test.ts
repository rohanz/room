import { describe, expect, it, vi } from 'vitest'
import { CredentialSockets, PermissionRevalidator } from '../src/sockets.js'

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
