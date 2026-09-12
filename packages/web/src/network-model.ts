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
