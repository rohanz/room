import { describeClaim } from './claims.js'
import { describeIdentity, isAgentic } from './identity.js'
import type { Claim, Kind, NoteMsg, Presence, Scope, ShareLevel, Worker } from './types.js'

export interface ParticipantClaim extends Claim { stale: boolean }
export interface Participant {
  name: string
  online: boolean
  behindBase: boolean
  latestActive?: number
  kinds: Kind[]
  /** e.g. "agent of rohanz · codex"; empty for a plain human. */
  identity: string
  statuses: { kind: Kind; status: string }[]
  scope?: Scope
  files: string[]
  claims: ParticipantClaim[]
}

export interface ParticipantInput {
  presences: readonly Presence[]
  scopes: readonly (readonly [string, Scope])[]
  overlayPeople: readonly string[]
  changesByPerson: ReadonlyMap<string, readonly string[]>
  claims: readonly Claim[]
  roomBase?: string
  basesByPerson?: ReadonlyMap<string, string>
  now?: number
}

function identityLine(current: readonly Presence[], name: string): string {
  const p = [...current].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0)).find(x => x.user.owner || x.user.label) ?? current[0]
  if (!p) return ''
  const line = describeIdentity(p.user)
  return line === name ? '' : line.slice(name.length + 3)
}

/** One card model per person, derived without mutating room state. */
export function deriveParticipants(input: ParticipantInput): Participant[] {
  const now = input.now ?? Date.now()
  const names = new Set<string>()
  for (const presence of input.presences) names.add(presence.user.name)
  for (const [name] of input.scopes) names.add(name)
  for (const name of input.overlayPeople) names.add(name)

  return Array.from(names).sort().map(name => {
    const current = input.presences.filter(presence => presence.user.name === name)
    const latest = new Map<Kind, Presence>()
    for (const presence of current) {
      const previous = latest.get(presence.user.kind)
      if (!previous || (presence.lastActive ?? 0) >= (previous.lastActive ?? 0)) latest.set(presence.user.kind, presence)
    }
    const scope = input.scopes.find(([scopeName]) => scopeName === name)?.[1]
    const kinds = new Set<Kind>(latest.keys())
    if (scope) kinds.add(scope.byKind)
    for (const claim of input.claims) if (claim.by === name) kinds.add(claim.byKind)
    const latestActive = current.reduce<number | undefined>((value, presence) => {
      if (presence.lastActive === undefined) return value
      return value === undefined ? presence.lastActive : Math.max(value, presence.lastActive)
    }, undefined)
    const online = current.length > 0
    const ownBase = input.basesByPerson?.get(name)
    return {
      name,
      online,
      behindBase: Boolean(input.roomBase && ownBase && ownBase !== input.roomBase),
      latestActive,
      kinds: Array.from(kinds).sort((a, b) => a.localeCompare(b)),
      identity: identityLine(current, name),
      statuses: Array.from(latest.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, presence]) => ({ kind, status: presence.status ?? 'online' })),
      scope,
      files: [...(input.changesByPerson.get(name) ?? [])].sort(),
      claims: input.claims
        .filter(claim => claim.by === name)
        .map(claim => ({ ...claim, stale: !online && now - claim.at > 10 * 60_000 })),
    }
  })
}

export const scopeLine = (scope: Scope): string => `${scope.area}: ${scope.summary} (${scope.paths.join(', ')})`

export interface PersonLineInput {
  name: string
  scope?: Scope
  presences: readonly Presence[]
  changedPaths: readonly string[]
  messages: readonly NoteMsg[]
  share: ShareLevel
}

/** The status/detail portion of a room_state participant line. */
export function personLine(input: PersonLineInput): string {
  const p = input.presences.find(x => x.user.name === input.name && isAgentic(x.user.kind))
    ?? input.presences.find(x => x.user.name === input.name)
  const lastDone = [...input.messages].reverse().find(m => m.from === input.name && m.text.startsWith('done'))
  let what: string
  if (input.scope) what = `working on ${scopeLine(input.scope)}`
  else if (p?.status?.startsWith('done')) what = p.status
  else if (lastDone && (!p || p.status === 'idle' || p.status === 'synced')) what = `${lastDone.text} (${new Date(lastDone.at).toISOString().slice(11, 16)})`
  else what = p ? `${p.status ?? 'idle'}, no task declared` : 'offline'
  const share = input.share === 'full' ? '' : `; shares ${input.share}${input.share === 'intent' ? ' (no file text)' : ' (file text only under their scope paths)'}`
  return `${what}${share}${input.changedPaths.length ? `; uncommitted, not yet pushed: ${input.changedPaths.join(', ')}` : ''}`
}

export function claimLine(claim: Claim, options: { yours?: boolean; stale?: boolean } = {}): string {
  return `  - ${claim.id}: ${describeClaim(claim)}${options.yours ? ' (yours)' : ''}${options.stale ? ' [stale: owner offline]' : ''}`
}

/** Compact claim text used inside a browser participant card. */
export function participantClaimLine(claim: Claim): string {
  const plans = claim.plans?.map(plan => `→ ${plan.kind} ${plan.symbol}${plan.detail ? ` to ${plan.detail}` : ''}`).join(' · ')
  return `${claim.path}:${claim.from}-${claim.to} · ${claim.intent}${plans ? ` ${plans}` : ''}`
}

/** Canonical sorted area membership suffix used by participant views. */
export function areaMembershipSummary(areas: readonly string[]): string {
  return areas.length ? `areas ${Array.from(new Set(areas)).sort().join(', ')}` : ''
}

/** Canonical summary for participants hidden by an area-scoped view. */
export function otherAreasLine(hiddenCount: number, areas: readonly string[]): string {
  const unique = Array.from(new Set(areas)).sort()
  return `${hiddenCount} other${hiddenCount === 1 ? '' : 's'} in ${unique.length} other area${unique.length === 1 ? '' : 's'}${unique.length ? ` (${unique.join(', ')})` : ''}`
}

export interface WorkerLineInput {
  worker: Worker
  processGone?: boolean
  changedCount: number
  last?: string
  now?: number
}

/** The two canonical room_state lines for one dispatched worker. */
export function workerLine({ worker: w, processGone = false, changedCount, last, now = Date.now() }: WorkerLineInput): [string, string] {
  const age = Math.max(0, Math.round((now - w.startedAt) / 60000))
  const alive = w.status === 'running' && processGone ? ' (process gone)' : ''
  return [
    `  - ${w.tag} (${w.host}${w.model ? ` ${w.model}` : ''}, ${w.status}${alive}, ${age}m): ${w.task.slice(0, 80)}${w.task.length > 80 ? '…' : ''}`,
    `      ${changedCount} changed file(s) · branch ${w.branch}${w.summary ? ` · ${w.summary.slice(0, 120)}` : ''}${last ? ` · last: ${last.slice(0, 100)}` : ''}`,
  ]
}

export function workerLines(inputs: readonly WorkerLineInput[]): string[] {
  if (!inputs.length) return []
  return [`workers (${inputs.length}):`, ...[...inputs]
    .sort((a, b) => a.worker.startedAt - b.worker.startedAt)
    .flatMap(workerLine)]
}
