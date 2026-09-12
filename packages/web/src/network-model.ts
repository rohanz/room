import type { GraphSnapshot } from '@room/shared'

export type NetworkRole = 'changed' | 'upstream' | 'downstream' | 'context'
export interface NetworkNode { path: string; role: NetworkRole; deleted: boolean }

/** Edges point from a provider to its consumer. Traversal handles cycles. */
export function deriveNetwork(snapshot: GraphSnapshot, changed: readonly string[], deleted: readonly string[] = [], focused = true) {
  const mine = new Set(changed)
  const walk = (reverse: boolean) => {
    const adjacent = new Map<string, string[]>()
    for (const edge of snapshot.edges) {
      const from = reverse ? edge.target : edge.source, to = reverse ? edge.source : edge.target
      adjacent.set(from, [...(adjacent.get(from) ?? []), to])
    }
    const visited = new Set(mine), queue = [...mine]
    for (let i = 0; i < queue.length; i++) for (const next of adjacent.get(queue[i]) ?? []) {
      if (!visited.has(next)) { visited.add(next); queue.push(next) }
    }
    for (const p of mine) visited.delete(p)
    return visited
  }
  const upstream = walk(true), downstream = walk(false), removed = new Set(deleted)
  const nodes: NetworkNode[] = [...new Set([...snapshot.paths, ...changed])].sort().map(path => ({
    path, deleted: removed.has(path),
    role: mine.has(path) ? 'changed' : upstream.has(path) ? 'upstream' : downstream.has(path) ? 'downstream' : 'context',
  }))
  const visible = nodes.filter(n => !focused || !mine.size || n.role !== 'context')
  return { nodes: visible, edges: snapshot.edges, upstream, downstream, total: nodes.length }
}

/** Contract declarations remain separate from actual overlay edits. A graph match is
 * potential impact, never proof of a breaking change or completed implementation. */
export function deriveContractImpact(snapshot: GraphSnapshot, claims: readonly import('@room/shared').Claim[]) {
  type Declaration = { claimId: string; path: string; owner: string; kind: string; symbol: string; detail: string }
  const declarations: Declaration[] = claims.flatMap(c => (c.plans ?? []).map(p => ({
    claimId: c.id, path: c.path, owner: c.by, kind: p.kind, symbol: p.symbol, detail: p.detail ?? c.intent,
  })))
  const contracts = new Map<string, Declaration[]>()
  const direct = new Map<string, Declaration[]>(), indirect = new Map<string, Declaration[]>()
  const affectedEdges = new Set<string>()
  const append = (map: Map<string, Declaration[]>, path: string, declaration: Declaration) => {
    const values = map.get(path) ?? []
    if (!values.includes(declaration)) map.set(path, [...values, declaration])
  }
  const outgoing = new Map<string, GraphSnapshot['edges']>()
  for (const edge of snapshot.edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge])
  for (const declaration of declarations) {
    append(contracts, declaration.path, declaration)
    const first = (outgoing.get(declaration.path) ?? []).filter(edge => edge.symbols.includes(declaration.symbol))
    const visited = new Set([declaration.path]), queue: string[] = []
    for (const edge of first) {
      append(direct, edge.target, declaration)
      affectedEdges.add(JSON.stringify([edge.source, edge.target]))
      if (!visited.has(edge.target)) { visited.add(edge.target); queue.push(edge.target) }
    }
    for (let i = 0; i < queue.length; i++) for (const edge of outgoing.get(queue[i]) ?? []) {
      affectedEdges.add(JSON.stringify([edge.source, edge.target]))
      if (!visited.has(edge.target)) {
        visited.add(edge.target); queue.push(edge.target)
        append(indirect, edge.target, declaration)
      }
    }
  }
  return { declarations, contracts, direct, indirect, affectedEdges }
}
