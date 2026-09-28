import type { ShareLevel } from '@room/roomd'
import { policyFromLevel, type SharingPolicy } from '@room/roomd/policy'
import { containsPath } from '@room/shared'
import type { PolicyStore } from '../src/policy-store.js'

/** Synchronous test fixture for legacy fake Sessions; production uses the durable PolicyStore. */
export function testPolicyStore(level: ShareLevel = 'full', onChange?: (policy: SharingPolicy) => void): PolicyStore {
  let requested = level
  let ceiling: ShareLevel = 'full'
  let publisher = true
  let publisherName: string | undefined
  let active: string[] = [], ending: string[] = [], retained: string[] = []
  let disclosed: { level: ShareLevel; version: number } = { level: 'full', version: 1 }
  let policy: SharingPolicy
  const rebuild = () => {
    policy = Object.freeze({ ...policyFromLevel(requested, [...new Set([...active, ...ending, ...retained])], ceiling, publisher), ending: Object.freeze([...ending]), ...(publisherName ? { publisherName } : {}) })
    onChange?.(policy)
    return policy
  }
  rebuild()
  return {
    get policy() { return policy },
    get requested() { return requested },
    get disclosed() { return disclosed },
    get retained() { return retained },
    async setRequested(next: ShareLevel) {
      if (requested === next) return policy
      requested = next
      if (next !== 'declared') ending = retained = []
      return rebuild()
    },
    async declare(paths: readonly string[]) {
      ending = [...new Set([...ending, ...active.filter(p => !paths.includes(p))])].filter(p => !paths.includes(p))
      active = [...paths]
      return rebuild()
    },
    async settle(input: SharingPolicy, entries: ReadonlyMap<string, { state: string; change: string }>, unsettled: readonly string[]) {
      if (policy !== input) return policy
      const pending = ending.filter(prefix => unsettled.some(p => containsPath(prefix, p)))
      const nextRetained = new Set(retained.filter(p => entries.has(p) || unsettled.includes(p)))
      for (const prefix of ending) {
        if (pending.includes(prefix)) continue
        for (const [path, entry] of entries) if (containsPath(prefix, path) && (entry.state === 'shared' || entry.change === 'D')) nextRetained.add(path)
      }
      ending = pending
      retained = [...nextRetained].sort()
      return rebuild()
    },
    setCeiling(next: ShareLevel) { if (ceiling === next) return policy; ceiling = next; return rebuild() },
    setPublisher(next: boolean, name?: string) { if (publisher === next && publisherName === name) return policy; publisher = next; publisherName = name; return rebuild() },
    async markDisclosed(next: ShareLevel, version: number) { disclosed = { level: next, version }; return policy },
  } as unknown as PolicyStore
}
