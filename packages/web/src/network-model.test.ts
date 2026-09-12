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

import { deriveWorkImpact } from './network-model.ts'
describe('work-centered contract impact', () => {
  const own: Claim = { ...contract, id: 'mine', by: 'Kieran', path: 'checkout', plans: [{ kind: 'signature', symbol: 'checkout_summary' }] }
  it('anchors edits and plans, exposes upstream risks and only my outgoing contract impact', () => {
    const unrelated: Claim = { ...contract, id: 'unrelated', path: 'unrelated', plans: [{ kind: 'rename', symbol: 'other' }] }
    const view = deriveWorkImpact(graph, [contract, own, unrelated], 'Kieran', ['checkout'])
    expect([...view.work]).toEqual(['checkout'])
    expect([...view.upstream]).toEqual(['pricing'])
    expect([...view.downstream]).toEqual(['receipt'])
    expect(view.impact.contracts.has('unrelated')).toBe(false)
    expect(view.upstreamPlans).toBe(1)
  })
  it('includes unedited claimed files but never infers outgoing breakage from ordinary edits', () => {
    const view = deriveWorkImpact(graph, [contract, { ...own, plans: [] }], 'Kieran', [])
    expect(view.work.has('checkout')).toBe(true)
    expect(view.downstream.size).toBe(0)
    expect(view.upstreamPlans).toBe(1)
  })
  it('omits other consumers of an upstream plan and rejects an unrelated symbol in the same file', () => {
    const extended = { ...graph, edges: [...graph.edges, { source: 'pricing', target: 'unrelated', symbols: ['quote_total'] }] }
    const view = deriveWorkImpact(extended, [contract], 'Kieran', ['checkout'])
    expect(view.edges.has(JSON.stringify(['pricing', 'unrelated']))).toBe(false)
    expect(view.downstream.size).toBe(0)
    expect(deriveWorkImpact(graph, [{ ...contract, plans: [{ kind: 'rename', symbol: 'other' }] }], 'Kieran', ['checkout']).upstreamPlans).toBe(0)
  })
  it('retains multi-hop upstream routes and switches perspective without including unrelated work', () => {
    const view = deriveWorkImpact(graph, [contract], 'Kieran', ['receipt'])
    expect(view.upstream).toEqual(new Set(['checkout', 'pricing']))
    expect(view.upstreamPlans).toBe(1)
    const rohan = deriveWorkImpact(graph, [contract], 'Rohan', [])
    expect(rohan.work).toEqual(new Set(['pricing']))
    expect(rohan.downstream).toEqual(new Set(['checkout', 'receipt']))
    expect(deriveWorkImpact(graph, [contract], 'Nobody', []).work.size).toBe(0)
  })
})
