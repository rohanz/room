import type { ShareLevel } from '@room/roomd'
import { policyFromLevel, type SharingPolicy } from '@room/roomd/policy'
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
      requested = next
      if (next !== 'declared') active = ending = retained = []
      return rebuild()
    },
    async declare(paths: readonly string[]) {
      ending = [...new Set([...ending, ...active.filter(p => !paths.includes(p))])].filter(p => !paths.includes(p))
      active = [...paths]
      return rebuild()
    },
    async settle(input: SharingPolicy, entries: ReadonlyMap<string, { state: string; change: string }>, unsettled: readonly string[]) {
      if (policy !== input || unsettled.length) return policy
      for (const p of ending) for (const [path, entry] of entries) if ((path === p || path.startsWith(p)) && (entry.state === 'shared' || entry.change === 'D')) retained.push(path)
      ending = []
      retained = [...new Set(retained)].filter(p => entries.has(p))
      return rebuild()
    },
    setCeiling(next: ShareLevel) { ceiling = next; return rebuild() },
    setPublisher(next: boolean, name?: string) { publisher = next; publisherName = name; return rebuild() },
    async markDisclosed(next: ShareLevel, version: number) { disclosed = { level: next, version }; return policy },
  } as unknown as PolicyStore
}
