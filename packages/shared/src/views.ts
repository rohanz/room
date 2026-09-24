import { describeClaim } from './claims.js'
import { describeIdentity, displayName, isAgentic } from './identity.js'
import type { Claim, Kind, NoteMsg, Presence, RetiredWorker, Scope, ShareLevel, Worker } from './types.js'

/** Split a room identity while preserving slashes within its branch. */
export function roomNameParts(roomName: string): { host?: string; owner?: string; repo: string; branch: string; local: boolean } {
  const parts = roomName.split('/')
  if (parts[0] === 'local' && parts.length >= 3) {
    return { repo: parts[1], branch: parts.slice(2).join('/'), local: true }
  }
  const offset = parts[0] === 'git' ? 1 : 0
  if ((parts[0] === 'github.com' || offset === 1) && parts.length >= offset + 4) {
    return { host: parts[offset], owner: parts[offset + 1], repo: parts[offset + 2], branch: parts.slice(offset + 3).join('/'), local: false }
  }
  return { repo: roomName, branch: '', local: false }
}

/** Format a count with its singular or plural label. */
export function formatCount(count: number, singular: string, plural = singular + 's'): string {
  return count + ' ' + (count === 1 ? singular : plural)
}

export interface FileSummaryOptions { namedLimit?: number }
export interface FileSummary {
  count: number
  dominant?: { folder: string; count: number }
  named: { path: string; label: string }[]
  groups: { folder: string; paths: string[] }[]
}

/** Stable path summary; overlays have a timestamp per person, never per file. */
export function summarizeFiles(paths: readonly string[], options: FileSummaryOptions = {}): FileSummary {
  const byPath = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
  const sorted = [...paths].sort(byPath)
  const folders = new Map<string, number>()
  const immediate = new Map<string, string[]>()
  for (const path of sorted) {
    const parts = path.split('/')
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : './'
    immediate.set(folder, [...(immediate.get(folder) ?? []), path])
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('/') + '/'
      folders.set(prefix, (folders.get(prefix) ?? 0) + 1)
    }
  }
  const majority = sorted.length > 5 ? [...folders].filter(([, count]) => count > sorted.length / 2) : []
  const winner = majority.sort(([a], [b]) => b.length - a.length || a.localeCompare(b))[0]
  const dominant = winner ? { folder: winner[0], count: winner[1] } : undefined
  const ordered = [...sorted].sort((a, b) => Number(!!dominant && a.startsWith(dominant.folder)) - Number(!!dominant && b.startsWith(dominant.folder)) || byPath(a, b))
  const selected = ordered.slice(0, options.namedLimit ?? 3)
  const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
  const counts = new Map<string, number>()
  for (const path of selected) counts.set(basename(path), (counts.get(basename(path)) ?? 0) + 1)
  return {
    count: sorted.length, dominant,
    named: selected.map(path => ({ path, label: counts.get(basename(path))! > 1 ? path : basename(path) })),
    groups: [...immediate].sort(([a], [b]) => a.localeCompare(b)).map(([folder, groupPaths]) => ({ folder, paths: groupPaths })),
  }
}

const STOPPED_WITH_SESSION = 'stopped when your last session ended; its partial work is in its worktree'
const STOPPED_UNWITNESSED = 'stopped while no session of yours was running; reason unknown'
const stoppedWithSession = (w: Pick<Worker, 'stopReason'>): boolean => w.stopReason === 'lead-session-ended'

/** Wording for action recency; connectivity and process liveness are separate facts. */
export function activityLabel(lastActive: number | undefined, now = Date.now(), options: { running?: boolean; processGone?: boolean; worker?: Pick<Worker, 'status' | 'finishedAt' | 'stopReason'> } = {}): string {
  if (options.worker && stoppedWithSession(options.worker)) return STOPPED_WITH_SESSION
  if (options.worker?.status === 'running' && options.processGone) return STOPPED_UNWITNESSED
  const finished = options.worker !== undefined && options.worker.status !== 'running'
  const running = options.worker ? options.worker.status === 'running' : options.running
  if (finished) lastActive = options.worker!.finishedAt ?? lastActive
  if (lastActive === undefined || !Number.isFinite(lastActive)) return finished ? 'finished (time unknown)' : running ? 'running' : 'activity unknown'
  const seconds = Math.max(0, Math.floor((now - lastActive) / 1000))
  const duration = seconds < 60 ? seconds + 's' : seconds < 3600 ? Math.floor(seconds / 60) + 'm' : seconds < 86400 ? Math.floor(seconds / 3600) + 'h' : Math.floor(seconds / 86400) + 'd'
  if (finished) return 'finished ' + duration + ' ago'
  if (running) return now - lastActive > 300_000 ? 'running · quiet ' + duration : 'running'
  return seconds < 90 ? 'working' : 'last action ' + duration + ' ago'
}

/** Keep candidate names that have a current awareness entry, preserving candidate order. */
export function presentPeople(people: readonly string[], current: readonly Pick<Presence, 'user'>[]): string[] {
  const present = new Set(current.map(p => p.user.name))
  return people.filter(person => present.has(person))
}

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
  workers?: readonly Worker[]
  scopes: readonly (readonly [string, Scope])[]
  overlayPeople: readonly string[]
  changesByPerson: ReadonlyMap<string, readonly string[]>
  claims: readonly Claim[]
  roomBase?: string
  basesByPerson?: ReadonlyMap<string, string>
  now?: number
}

/** Shared identity text for browser cards and room_state, using only reported runtime facts. */
export function participantIdentityLine(current: readonly Presence[], name: string, worker?: Worker): string {
  const p = [...current].filter(p => p.user.name === name).sort((a, b) => Number(isAgentic(b.user.kind)) - Number(isAgentic(a.user.kind)) || (b.lastActive ?? 0) - (a.lastActive ?? 0))[0]
  const id = p?.user ?? (worker ? { name, kind: 'agent' as const, owner: worker.name.split('+')[0], label: worker.tag } : undefined)
  if (!id) return name
  const parts = [describeIdentity(id).replace(id.name, displayName(id))]
  const host = p?.host ?? worker?.host
  if (host && host !== 'agent' && host !== id.label) parts.push(host)
  const model = p?.model ?? worker?.model
  const effort = p?.effort ?? worker?.effort
  if (model) parts.push(model)
  if (effort) parts.push(effort)
  return parts.join(' · ')
}

/** One card model per person, derived without mutating room state. */
export function deriveParticipants(input: ParticipantInput): Participant[] {
  const now = input.now ?? Date.now()
  const names = new Set<string>()
  for (const presence of input.presences) names.add(presence.user.name)
  for (const worker of input.workers ?? []) names.add(worker.name)
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
      identity: participantIdentityLine(current, name, input.workers?.find(w => w.name === name)).slice(name.length + 3),
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

export interface WorkerParticipantGroup {
  lead: string
  active: Participant[]
  retiredWorkers: RetiredWorker[]
  running: number
  nested: WorkerParticipantGroup[]
}

export interface ParticipantGroups {
  active: Participant[]
  offlineTeammates: Participant[]
  retiredWorkers: RetiredWorker[]
  workerGroups: WorkerParticipantGroup[]
}

/** Archived workers are history, not offline teammates. Failed workers remain actionable.
 * A new worker record with a reused name takes precedence over that name's archive. */
export function splitParticipants(input: ParticipantInput & { retiredWorkers: readonly RetiredWorker[] }): ParticipantGroups {
  const workers = new Map((input.workers ?? []).map(w => [w.name, w]))
  const retiredWorkers = [...input.retiredWorkers].sort((a, b) => b.retiredAt - a.retiredAt || a.name.localeCompare(b.name))
  const retiredNames = new Set(retiredWorkers.map(w => w.name))
  const participants = deriveParticipants(input).filter(p => !retiredNames.has(p.name) || workers.has(p.name))
  const active = participants.filter(p => p.online || ['running', 'failed'].includes(workers.get(p.name)?.status ?? ''))
  const offlineTeammates = participants.filter(p => !p.online && !workers.has(p.name))
  const leads = new Set([...workers.values()].map(w => w.lead))
  for (const w of retiredWorkers) leads.add(w.lead)
  const allGroups = [...leads].sort().map(lead => ({
    lead,
    active: active.filter(p => workers.get(p.name)?.lead === lead),
    retiredWorkers: retiredWorkers.filter(w => w.lead === lead),
    running: [...workers.values()].filter(w => w.lead === lead && w.status === 'running').length,
    nested: [] as WorkerParticipantGroup[],
  }))
  const byLead = new Map(allGroups.map(group => [group.lead, group]))
  const workerGroups: WorkerParticipantGroup[] = []
  for (const group of allGroups) {
    const parentLead = workers.get(group.lead)?.lead
    // A worker that leads others belongs inside its own lead's group, once.
    const parent = parentLead && parentLead !== group.lead ? byLead.get(parentLead) : undefined
    if (parent) parent.nested.push(group)
    else workerGroups.push(group)
  }
  return { active, offlineTeammates, retiredWorkers, workerGroups }
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
  else what = p ? `${p.status && !['idle', 'synced'].includes(p.status) ? p.status + ', ' : ''}no task declared` : 'offline'
  const share = input.share === 'full' ? '' : `; shares ${input.share}${input.share === 'intent' ? ' (no file text)' : ' (file text only under their scope paths)'}`
  const files = summarizeFiles(input.changedPaths)
  const changed = files.count > 5
    ? `${files.count} files${files.dominant ? `, mostly ${files.dominant.folder} (${files.dominant.count})` : ''}: ${files.named.map(file => file.label).join(', ')} ...`
    : input.changedPaths.join(', ')
  return `${what}${share}${files.count ? `; uncommitted, not yet pushed: ${changed}` : ''}`
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
  lastActive?: number
  changedCount: number
  last?: string
  now?: number
}

/** The two canonical room_state lines for one dispatched worker. */
export function workerLine({ worker: w, processGone = false, lastActive, changedCount, last, now = Date.now() }: WorkerLineInput): [string, string] {
  const age = Math.max(0, Math.round((now - w.startedAt) / 60000))
  const summary = w.summary?.startsWith(STOPPED_UNWITNESSED) ? w.summary : w.summary?.slice(0, 120)
  const state = stoppedWithSession(w) ? STOPPED_WITH_SESSION
    : w.status === 'running' && processGone ? STOPPED_UNWITNESSED
    : w.status === 'running' ? activityLabel(lastActive ?? w.startedAt, now, { running: true }) : w.status
  return [
    `  - ${w.tag} (${w.host}${w.model ? ` ${w.model}` : ''}${w.effort ? ` · ${w.effort}` : ''}, ${state}, ${age}m): ${w.task.slice(0, 80)}${w.task.length > 80 ? '…' : ''}`,
    `      ${formatCount(changedCount, 'changed file')} · branch ${w.branch}${w.status === 'running' && processGone && !stoppedWithSession(w) ? ` · worktree ${w.dir}` : ''}${summary ? ` · ${summary}` : ''}${last ? ` · last: ${last.slice(0, 100)}` : ''}`,
  ]
}

export function workerLines(inputs: readonly WorkerLineInput[], options: { all?: boolean; retiredWorkers?: readonly RetiredWorker[] } = {}): string[] {
  const retired = options.retiredWorkers ?? []
  if (!inputs.length && (!options.all || !retired.length)) return []
  const visible = inputs.filter(i => options.all || i.worker.stopReason || i.worker.status === 'running' || i.worker.status === 'failed')
  const finished = inputs.length - visible.length
  const out = [`workers (${inputs.length}):`, ...[...visible]
    .sort((a, b) => a.worker.startedAt - b.worker.startedAt)
    .flatMap(workerLine)]
  if (options.all) {
    for (const w of [...retired].sort((a, b) => b.retiredAt - a.retiredAt || a.name.localeCompare(b.name))) {
      out.push(`  - ${w.tag} (${w.outcome}${w.uncommitted ? ` with ${w.uncommitted} uncommitted files left in its worktree` : ''}${w.model ? `, ${w.model}` : ''}): ${w.summary} · ${formatCount(w.fileCount, 'file')}`)
    }
  } else if (finished) out.push(`  finished: ${finished} (all=true lists them)`)
  return out
}

export interface ConflictResolution {
  how: 'released' | 'narrowed' | 'merged clean' | 'base moved'
  who?: string
  at: number
}
export interface ConflictSpan {
  id: string
  path: string
  people: string[]
  claimIds: string[]
  from?: number
  to?: number
  at: number
  events: import('./types.js').Msg[]
  claims: Claim[]
  resolvedBy?: ConflictResolution
  hidden: boolean
}

/** Reconstruct conflict history from existing bus facts; never manufacture a timestamp.
 * Missing claims alone are not proof of release (the rolling bus may be incomplete).
 */
export function deriveConflictSpans(messages: readonly import('./types.js').Msg[], claims: readonly Claim[], base?: string): ConflictSpan[] {
  const bus = [...messages].sort((a, b) => a.at - b.at)
  const known = new Map<string, Claim>()
  for (const m of bus) if (m.type === 'claim' && !known.has(m.claimId)) known.set(m.claimId, { id: m.claimId, path: m.path, from: m.from_line, to: m.to_line, by: m.from, byKind: m.fromKind, intent: m.intent, plans: m.plans, at: m.at })
  const current = new Map(claims.map(c => [c.id, c]))
  for (const c of claims) if (!known.has(c.id)) known.set(c.id, c)
  const spans: ConflictSpan[] = []
  const pairKey = (path: string, people: string[]) => JSON.stringify([path, [...people].sort()])
  for (const m of bus) {
    let path: string, people: string[], ids: string[] = [], from: number | undefined, to: number | undefined
    if (m.type === 'conflict') {
      path = m.path
      ids = [m.claimId, m.otherClaimId].filter(Boolean).sort()
      people = ids.flatMap(id => known.get(id)?.by ?? [])
      if (people.length < 2) {
        const editor = m.text.match(/^(.+?)'s agent edited /)?.[1] ?? (m.text.startsWith('you edited ') ? m.to : undefined)
        if (editor) people.push(editor)
      }
      const range = m.text.slice(m.text.indexOf(`${path}:`) + path.length + 1).match(/^(\d+)-(\d+)/)
      if (range) { from = Number(range[1]); to = Number(range[2]) }
    } else if (m.type === 'note') {
      const match = m.text.match(/^your (.+) and (.+)'s now conflict around lines? ([\d, ]+);/)
      if (!match || !m.to) continue
      path = match[1]; people = [m.to, match[2]]
      const lines = match[3].split(',').map(Number)
      from = Math.min(...lines); to = Math.max(...lines)
    } else continue
    people = [...new Set(people)].sort()
    const cs = ids.flatMap(id => known.get(id) ?? [])
    if (cs.length === 2) { from = Math.max(...cs.map(c => c.from)); to = Math.min(...cs.map(c => c.to)) }
    const id = ids.length === 2 ? JSON.stringify([path, ids]) : pairKey(path, people)
    let span = spans.find(s => s.id === id || (people.length === 2 && pairKey(s.path, s.people) === pairKey(path, people) && (ids.length < 2 || s.claimIds.length < 2)))
    if (!span) { span = { id, path, people, claimIds: ids, from, to, at: m.at, events: [], claims: cs, hidden: false }; spans.push(span) }
    if (ids.length === 2 && span.claimIds.length < 2) { span.claimIds = ids; span.claims = cs }
    span.events.push(m)
  }
  // Claims can overlap before a conflict notification is delivered.
  for (let i = 0; i < claims.length; i++) for (const b of claims.slice(i + 1)) {
    const a = claims[i]
    if (a.by === b.by || a.path !== b.path || a.from > b.to || b.from > a.to) continue
    const ids = [a.id, b.id].sort(), id = JSON.stringify([a.path, ids])
    const existing = spans.find(s => s.claimIds.join() === ids.join() || (s.claimIds.length < 2 && pairKey(s.path, s.people) === pairKey(a.path, [a.by, b.by])))
    if (existing && existing.claimIds.length < 2) { existing.claimIds = ids; existing.claims = [a, b] }
    if (!existing) spans.push({ id, path: a.path, people: [a.by, b.by].sort(), claimIds: ids, from: Math.max(a.from, b.from), to: Math.min(a.to, b.to), at: Math.max(a.at, b.at), events: [], claims: [a, b], hidden: false })
  }
  for (const s of spans) {
    const lastConflict = s.events.at(-1)?.at ?? s.at
    for (const m of bus) {
      if (m.at <= lastConflict) continue
      let resolution: ConflictResolution | undefined
      if (m.type === 'release' && s.claimIds.includes(m.claimId)) resolution = { how: 'released', who: m.from, at: m.at }
      if (m.type === 'note' && s.people.some(person => m.to === person && m.text === `your ${s.path} and ${s.people.find(p => p !== person)}'s merge cleanly again`)) resolution = { how: 'merged clean', who: m.to, at: m.at }
      if (m.type === 'base' && base && (m.base === base || bus.some(next => next.type === 'base' && next.at > m.at && next.base === base))) {
        s.hidden = true
        resolution = { how: 'base moved', who: m.from, at: m.at }
      }
      if (resolution) { s.resolvedBy ??= resolution; s.events.push(m) }
    }
    const live = s.claimIds.flatMap(id => current.get(id) ?? [])
    if (!s.resolvedBy && live.length === 2 && (live[0].path !== live[1].path || live[0].from > live[1].to || live[1].from > live[0].to)) {
      const changed = [...live].sort((a, b) => b.at - a.at)[0]
      s.resolvedBy = { how: 'narrowed', who: changed.by, at: Math.max(lastConflict, changed.at) }
    }
    s.claims = s.claimIds.flatMap(id => current.get(id) ?? known.get(id) ?? [])
  }
  return spans
}

/** Shared facts for the compact annotation and expanded code-line details. */
export interface LineDetailInput {
  owners?: readonly string[]
  claims?: readonly Claim[]
  conflicts?: readonly { people: readonly string[]; detail?: string; resolved: boolean; range?: string; status?: string; resolution?: string }[]
}

export function lineDetail(input: LineDetailInput) {
  const owners = [...new Set(input.owners ?? [])]
  const claims = [...new Map((input.claims ?? []).map(c => [c.id, c])).values()]
  const conflicts = [...(input.conflicts ?? [])]
  const ownership = owners.length ? 'changed by ' + owners.join(' and ') : 'unchanged from base'
  const sections = [
    { label: 'Line', rows: [ownership] },
    { label: 'Conflict', rows: [...new Set(conflicts.flatMap(c => [c.people.join(' ↔ '), c.range, c.status ?? (c.resolved ? 'Resolved' : 'Unresolved conflict')]).filter((row): row is string => !!row))] },
    { label: 'Claims', rows: claims.map(c => [c.by, c.intent, c.plans?.map(p => p.kind + ' ' + p.symbol + (p.detail ? ' to ' + p.detail : '')).join(' · ')].filter(Boolean).join(' · ')) },
    { label: 'Resolution', rows: [...new Set(conflicts.flatMap(c => c.resolved && c.resolution ? [c.resolution] : []))] },
  ].filter(section => section.rows.length)
  return { owners, claims, conflicts, ownership, sections }

}

export function lineAnnotation(input: LineDetailInput): string {
  const detail = lineDetail(input)
  const conflict = detail.conflicts.find(c => !c.resolved) ?? detail.conflicts[0]
  if (conflict) return conflict.people.join(' ↔ ') + (conflict.resolved ? ' · resolved' : ' · conflict')
  if (detail.claims.length) return detail.claims.map(c => c.by + ' · claimed: ' + c.intent).join(' · ')
  return detail.ownership
}
