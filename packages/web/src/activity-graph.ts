import { SymbolGraph, regexExtractor, scopeCovers, type Claim, type Scope } from '@room/shared'

export interface OverlayVersion { person: string; path: string; text: string }
export interface ActivityNode {
  id: string
  kind: 'plan' | 'file'
  label: string
  owner: string
}
export interface ActivityEdge { from: string; to: string }
export interface ActivityGraphModel { nodes: ActivityNode[]; edges: ActivityEdge[] }

export interface ActivityGraphInput {
  overlays: readonly OverlayVersion[]
  claims: readonly Claim[]
  scopes: readonly Scope[]
  changesByPerson: ReadonlyMap<string, readonly string[]>
  focusPerson?: string | null
}

function planLabel(claim: Claim, index: number): { id: string; text: string; symbol: string } {
  const plan = claim.plans![index]
  const detail = plan.detail ? ` → ${plan.detail}` : ''
  return { id: `plan:${claim.id}:${index}`, text: `${plan.kind} ${plan.symbol}${detail}`, symbol: plan.symbol }
}

/** Builds the dependency slice used by the inline SVG. */
export function buildActivityGraph(input: ActivityGraphInput): ActivityGraphModel {
  const chosen = new Map<string, OverlayVersion>()
  for (const overlay of input.overlays) {
    const existing = chosen.get(overlay.path)
    if (!existing || overlay.person === input.focusPerson) chosen.set(overlay.path, overlay)
  }
  const graph = new SymbolGraph(regexExtractor)
  for (const overlay of chosen.values()) graph.set(overlay.path, overlay.text)

  const nodes: ActivityNode[] = []
  const edges: ActivityEdge[] = []
  const fileIds = new Set<string>()
  for (const claim of input.claims) {
    for (let index = 0; index < (claim.plans?.length ?? 0); index++) {
      const plan = planLabel(claim, index)
      nodes.push({ id: plan.id, kind: 'plan', label: plan.text, owner: claim.by })
      for (const path of graph.usersOf(plan.symbol)) {
        const fileId = `file:${path}`
        if (!fileIds.has(fileId)) {
          const scopeOwner = [...input.scopes].sort((a, b) => b.at - a.at).find(scope => scopeCovers(scope, path))?.by
          const changedOwner = Array.from(input.changesByPerson).find(([, paths]) => paths.includes(path))?.[0]
          nodes.push({ id: fileId, kind: 'file', label: path, owner: scopeOwner ?? changedOwner ?? '' })
          fileIds.add(fileId)
        }
        edges.push({ from: plan.id, to: fileId })
      }
    }
  }
  return { nodes, edges }
}
