import type { Claim, GraphSnapshot } from '@room/shared'

export type NetworkRole = 'changed' | 'upstream' | 'downstream' | 'context'
export interface NetworkNode { path: string; role: NetworkRole; deleted: boolean }
export type ImpactClaim = Claim & { released?: boolean }

/** Retain plan-bearing claims after release for the lifetime of this browser view. */
export function rememberPlanClaims(history: Map<string, ImpactClaim>, claims: readonly Claim[]): ImpactClaim[] {
  const open = new Set(claims.map(c => c.id))
  for (const claim of claims) if (claim.plans?.length) history.set(claim.id, { ...claim, released: false })
  for (const [id, claim] of history) if (!open.has(id)) history.set(id, { ...claim, released: true })
  return [...claims, ...[...history.values()].filter(c => c.released)]
}

const bareSymbol = (symbol: string) => symbol.trim().split(/[.:]+/).filter(Boolean).at(-1)?.toLowerCase() ?? ''

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
export function deriveContractImpact(snapshot: GraphSnapshot, claims: readonly ImpactClaim[]) {
  type Declaration = { claimId: string; path: string; owner: string; kind: string; symbol: string; detail: string; released: boolean }
  const declarations: Declaration[] = claims.flatMap(c => (c.plans ?? []).map(p => ({
    claimId: c.id, path: c.path, owner: c.by, kind: p.kind, symbol: p.symbol, detail: p.detail ?? c.intent, released: !!c.released,
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
    const symbol = bareSymbol(declaration.symbol)
    const first = (outgoing.get(declaration.path) ?? []).filter(edge => edge.symbols.some(candidate => bareSymbol(candidate) === symbol))
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

/** A participant's work is the anchor. Foreign plans only contribute paths that
 * reach that work; outgoing impact is inferred only from this participant's plans. */
export function deriveWorkImpact(snapshot: GraphSnapshot, claims: readonly ImpactClaim[], person: string, changed: readonly string[]) {
  const mine = claims.filter(c => c.by === person)
  const work = new Set([...changed, ...mine.map(c => c.path)])
  const ancestors = new Set(work), queue = [...work]
  const incoming = new Map<string, GraphSnapshot['edges']>()
  for (const edge of snapshot.edges) incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge])
  for (let i = 0; i < queue.length; i++) for (const edge of incoming.get(queue[i]) ?? []) {
    if (!ancestors.has(edge.source)) { ancestors.add(edge.source); queue.push(edge.source) }
  }
  const impact = deriveContractImpact(snapshot, mine)
  const downstream = new Set([...impact.direct.keys(), ...impact.indirect.keys()].filter(p => !work.has(p)))
  const upstream = new Set<string>()
  const edges = new Set(impact.affectedEdges)
  // Ordinary dependencies remain context, without implying that edits break them.
  for (const path of work) for (const edge of incoming.get(path) ?? []) {
    if (!work.has(edge.source)) upstream.add(edge.source)
    edges.add(JSON.stringify([edge.source, edge.target]))
  }
  let upstreamPlans = 0
  for (const claim of claims.filter(c => c.by !== person)) for (const plan of claim.plans ?? []) {
    const candidate = deriveContractImpact(snapshot, [{ ...claim, plans: [plan] }])
    if (!work.has(claim.path) && ![...work].some(p => candidate.direct.has(p) || candidate.indirect.has(p))) continue
    upstreamPlans++
    impact.declarations.push(...candidate.declarations)
    for (const [path, values] of candidate.contracts) impact.contracts.set(path, [...(impact.contracts.get(path) ?? []), ...values])
    for (const kind of ['direct', 'indirect'] as const) for (const [path, values] of candidate[kind]) {
      if (ancestors.has(path)) impact[kind].set(path, [...(impact[kind].get(path) ?? []), ...values])
    }
    for (const edge of snapshot.edges) {
      const key = JSON.stringify([edge.source, edge.target])
      if (candidate.affectedEdges.has(key) && ancestors.has(edge.source) && ancestors.has(edge.target)) {
        edges.add(key); impact.affectedEdges.add(key)
        if (!work.has(edge.source)) upstream.add(edge.source)
        if (!work.has(edge.target)) upstream.add(edge.target)
      }
    }
  }
  return { work, upstream, downstream, edges, impact, upstreamPlans, ownPlans: mine.reduce((n, c) => n + (c.plans?.length ?? 0), 0) }
}
