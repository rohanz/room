import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'

const held = new AsyncLocalStorage<ReadonlyMap<string, () => void>>()
/** Carry the existing destination lease's assertion; no new lease or write fence. */
export function withCollectLeaseAssertion<T>(root: string, assertOwned: () => void, work: () => Promise<T>): Promise<T> {
  const scopes = new Map(held.getStore())
  let active = true
  scopes.set(root, () => {
    if (!active) throw new Error('destination collect lease scope ended')
    assertOwned()
  })
  return held.run(scopes, async () => { try { return await work() } finally { active = false } })
}
/** Direct read-only diagnostics may run without a lease; production collection
 * diagnostics revalidate their active lease after the last await. */
export function assertCollectLease(root: string): void {
  const scopes = held.getStore()
  if (!scopes) return
  const assertOwned = scopes.get(fs.realpathSync(root))
  if (!assertOwned) throw new Error('destination collect lease does not cover gated root')
  assertOwned()
}
