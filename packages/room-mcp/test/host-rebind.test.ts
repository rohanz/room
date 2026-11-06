import { expect, it, vi } from 'vitest'
import { HostRebind, type HostRebindDeps } from '../src/host-rebind.js'
import type { CheckoutReuse, Session } from '../src/session.js'

const session = (name: string, sessionId = 'old') => ({ roomName: name, lease: { sessionId } }) as unknown as Session
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve } }

function harness(join: HostRebindDeps['join']) {
  const primary = session('primary'), secondary = session('workers')
  const deps = {
    joined: () => [primary, secondary],
    detach: vi.fn(() => ({}) as CheckoutReuse),
    drop: vi.fn(async () => {}),
    join: vi.fn(join),
    adopt: vi.fn(async () => {}),
    attachSecondary: vi.fn(),
    dispose: vi.fn(async () => {}),
    log: () => {},
  } satisfies HostRebindDeps
  return { deps, primary, secondary, rebind: new HostRebind(deps) }
}

it('rebinds every joined session to the new host session', async () => {
  const { deps, rebind } = harness(async old => session(`${old.roomName}-new`, 'next'))
  await rebind.rebind('next')
  expect(deps.drop).toHaveBeenCalledTimes(2)
  expect(deps.adopt).toHaveBeenCalledWith(expect.objectContaining({ roomName: 'primary-new' }))
  expect(deps.attachSecondary).toHaveBeenCalledWith(expect.objectContaining({ roomName: 'workers-new' }), expect.objectContaining({ roomName: 'primary-new' }))
  expect(deps.dispose).not.toHaveBeenCalled()
})

it('a join that completes after shutdown began is left, never adopted, and no later rebind starts', async () => {
  const joining = deferred<Session>(), entered = deferred<void>()
  const { deps, rebind } = harness(async () => { entered.resolve(); return joining.promise })
  const running = rebind.rebind('next')
  await entered.promise // paused inside the join
  await rebind.close(false) // a signal shutdown does not wait for it
  const late = session('primary-new', 'next')
  joining.resolve(late)
  await running
  expect(deps.adopt).not.toHaveBeenCalled()
  expect(deps.attachSecondary).not.toHaveBeenCalled()
  expect(deps.dispose).toHaveBeenCalledWith(late)
  deps.drop.mockClear()
  await rebind.rebind('later')
  expect(deps.drop).not.toHaveBeenCalled()
})

it('a normal shutdown waits for a rebind in flight', async () => {
  const joining = deferred<Session>(), entered = deferred<void>()
  const { deps, rebind } = harness(async () => { entered.resolve(); return joining.promise })
  void rebind.rebind('next')
  await entered.promise
  let closed = false
  const closing = rebind.close(true).then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(closed).toBe(false)
  joining.resolve(session('primary-new', 'next'))
  await closing
  expect(rebind.pending).toBeUndefined()
  expect(deps.adopt).not.toHaveBeenCalled()
  expect(deps.dispose).toHaveBeenCalledTimes(1)
})
