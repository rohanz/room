import { describe, expect, it } from 'vitest'
import { deriveNetwork } from './network-model.ts'
import type { GraphSnapshot } from '@room/shared'
const graph: GraphSnapshot = {
  version: 1, base: 'abc', at: 0, status: 'ready', truncated: false,
  paths: ['catalog', 'pricing', 'checkout', 'receipt', 'unrelated'],
  edges: [
    { source: 'catalog', target: 'pricing', symbols: ['CATALOG'] },
    { source: 'pricing', target: 'checkout', symbols: ['quote_total'] },
    { source: 'checkout', target: 'receipt', symbols: ['checkout_summary'] },
  ],
}

describe('dependency network', () => {
  it('highlights transitive upstream providers, own changes, and downstream consumers', () => {
    const result = deriveNetwork(graph, ['checkout'])
    expect(result.upstream).toEqual(new Set(['pricing', 'catalog']))
    expect(result.downstream).toEqual(new Set(['receipt']))
    expect(result.nodes.map(n => [n.path, n.role])).toEqual([
      ['catalog', 'upstream'], ['checkout', 'changed'], ['pricing', 'upstream'], ['receipt', 'downstream'],
    ])
  })
  it('handles cycles and gives own changes priority', () => {
    const result = deriveNetwork({ ...graph, edges: [...graph.edges, { source: 'checkout', target: 'catalog', symbols: [] }] }, ['checkout', 'pricing'])
    expect(result.nodes.find(n => n.path === 'pricing')?.role).toBe('changed')
    expect(result.upstream.has('checkout')).toBe(false)
  })
  it('retains deleted and unindexed changes and supports the full network', () => {
    const result = deriveNetwork(graph, ['removed', 'new.md'], ['removed'], false)
    expect(result.nodes.find(n => n.path === 'removed')).toEqual({ path: 'removed', role: 'changed', deleted: true })
    expect(result.nodes.some(n => n.path === 'unrelated')).toBe(true)
    expect(deriveNetwork(graph, []).nodes).toHaveLength(5)
  })
})

import { deriveContractImpact } from './network-model.ts'
import type { Claim } from '@room/shared'
const contract: Claim = { id: 'plan', by: 'Rohan', byKind: 'agent', path: 'pricing', from: 1, to: 5, intent: 'Return Quote', at: 0, plans: [{ kind: 'signature', symbol: 'quote_total', detail: 'Return Quote' }] }
describe('contract impact', () => {
  it('matches the declared symbol and distinguishes direct from transitive exposure', () => {
    const result = deriveContractImpact(graph, [contract])
    expect([...result.contracts.keys()]).toEqual(['pricing'])
    expect([...result.direct.keys()]).toEqual(['checkout'])
    expect([...result.indirect.keys()]).toEqual(['receipt'])
    expect(result.direct.has('catalog')).toBe(false)
  })
  it('does not flag consumers of unrelated symbols or ordinary edits', () => {
    expect(deriveContractImpact(graph, [{ ...contract, plans: [] }]).declarations).toEqual([])
    const result = deriveContractImpact(graph, [{ ...contract, plans: [{ kind: 'rename', symbol: 'other_symbol' }] }])
    expect(result.contracts.size).toBe(1)
    expect(result.direct.size).toBe(0)
    expect(deriveContractImpact(graph, []).contracts.size).toBe(0)
  })
  it('handles cycles and plans on files absent from the current index', () => {
    const result = deriveContractImpact({ ...graph, edges: [...graph.edges, { source: 'receipt', target: 'pricing', symbols: ['callback'] }] }, [contract])
    expect(result.indirect.has('pricing')).toBe(false)
    expect(deriveContractImpact(graph, [{ ...contract, path: 'deleted.ts' }]).contracts.has('deleted.ts')).toBe(true)
  })
})
