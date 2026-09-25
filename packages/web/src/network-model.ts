import { bareSymbol, type Claim, type GraphSnapshot, type Plan } from '@room/shared'

type NetworkRole = 'changed' | 'upstream' | 'downstream' | 'context'
export interface NetworkNode { path: string; role: NetworkRole; deleted: boolean }
export type ContractSource = 'declared' | 'observed'
type ImpactPlan = Plan & { source: ContractSource }
export type ImpactClaim = Omit<Claim, 'plans'> & { plans?: ImpactPlan[]; released?: boolean }
type ImpactClaimInput = Claim | ImpactClaim

const withDeclaredSource = (claim: ImpactClaimInput): ImpactClaim => ({
  ...claim,
  plans: claim.plans?.map(plan => ({ ...plan, source: 'source' in plan ? plan.source : 'declared' })),
})

/** Turn one participant's diff-derived snapshot changes into claim-shaped impact inputs. */
export function observedImpactClaims(snapshot: GraphSnapshot, owner: string): ImpactClaim[] {
  return (snapshot.observed ?? []).map((change, index) => ({
    id: `observed:${owner}:${snapshot.base}:${index}:${change.path}:${change.symbol}`,
    by: owner, byKind: 'agent', path: change.path, from: 1, to: 1,
    intent: change.detail, at: snapshot.at,
    plans: [{ kind: change.kind, symbol: change.symbol, detail: change.detail, source: 'observed' }],
  }))
}

/** One signal per path+symbol. Announcements are earlier and win over observed edits. */
function dedupeImpactClaims(claims: readonly ImpactClaimInput[]): ImpactClaim[] {
  const singlePlans = claims.flatMap(input => {
    const claim = withDeclaredSource(input)
    return (claim.plans ?? []).map(plan => ({ ...claim, plans: [plan] }))
  }).sort((a, b) => (a.plans![0].source === 'declared' ? 0 : 1) - (b.plans![0].source === 'declared' ? 0 : 1))
  const seen = new Set<string>()
  return singlePlans.filter(claim => {
    const key = `${claim.path}\0${bareSymbol(claim.plans![0].symbol)}`
    if (seen.has(key)) return false
    seen.add(key); return true
  })
}

/** Retain plan-bearing claims after release for the lifetime of this browser view. */
export function rememberPlanClaims(history: Map<string, ImpactClaim>, claims: readonly Claim[]): ImpactClaim[] {
  const open = new Set(claims.map(c => c.id))
  for (const claim of claims) if (claim.plans?.length) history.set(claim.id, { ...withDeclaredSource(claim), released: false })
  for (const [id, claim] of history) if (!open.has(id)) history.set(id, { ...claim, released: true })
  return [...claims.map(withDeclaredSource), ...[...history.values()].filter(c => c.released)]
}

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

/** Announced and observed contract signals remain distinct. A graph match is potential
 * impact, never proof of a breaking change or completed implementation. */
export function deriveContractImpact(snapshot: GraphSnapshot, claims: readonly ImpactClaimInput[]) {
  type Declaration = { claimId: string; path: string; owner: string; kind: string; symbol: string; detail: string; released: boolean; source: ContractSource }
  const declarations: Declaration[] = dedupeImpactClaims(claims).flatMap(c => (c.plans ?? []).map(p => ({
    claimId: c.id, path: c.path, owner: c.by, kind: p.kind, symbol: p.symbol, detail: p.detail ?? c.intent, released: !!c.released, source: p.source,
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

/** A participant's work is the anchor. Foreign signals only contribute paths that
 * reach that work; outgoing impact comes from this participant's contract signals. */
export function deriveWorkImpact(snapshot: GraphSnapshot, claims: readonly ImpactClaimInput[], person: string, changed: readonly string[], foreignObserved: readonly ImpactClaim[] = []) {
  const allImpactClaims = dedupeImpactClaims([...claims, ...observedImpactClaims(snapshot, person), ...foreignObserved])
  const mine = allImpactClaims.filter(c => c.by === person)
  const work = new Set([...changed, ...claims.filter(c => c.by === person).map(c => c.path)])
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
  for (const claim of allImpactClaims.filter(c => c.by !== person)) for (const plan of claim.plans ?? []) {
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
  return { work, upstream, downstream, edges, impact, upstreamPlans, ownPlans: impact.declarations.filter(d => d.owner === person).length }
}
