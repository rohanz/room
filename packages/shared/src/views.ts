import { describeClaim } from './claims.js'
import { describeIdentity, isAgentic } from './identity.js'
import { holderFence, participantRecord, type ParticipantGit, type ParticipantHolder, type ParticipantRecord, type RoomDoc } from './doc.js'
import { workerLive, type Claim, type Kind, type NoteMsg, type Presence, type RetiredWorker, type Scope, type ShareLevel, type WorkerView } from './types.js'

export const ROOM_STALE_MS = 7 * 24 * 60 * 60 * 1000
export const AWARENESS_FRESH_MS = 30_000

export interface ParticipantView {
  name: string
  kind?: Kind
  fresh: boolean
  visible: boolean
  holder?: ParticipantHolder
  projectedBy?: string
  /** The holder session's own idle measure, from its presence (registry §18). */
  idleMin?: number
}

export interface AwarenessView {
  getStates(): Map<number, unknown>
  meta?: Map<number, { lastUpdated: number }>
}

/** Build the read-only presence and expiry view over flat participant records. */
export function participantsView(doc: RoomDoc, awareness: AwarenessView, now: number): ParticipantView[] {
  const names = new Set<string>()
  for (const key of doc.participants.keys()) {
    const split = key.lastIndexOf('\u0000')
    if (split > 0) names.add(key.slice(0, split))
  }
  const current = new Map<string, Partial<Presence>[]>()
  for (const [clientId, value] of awareness.getStates()) {
    const state = value as Partial<Presence> | null
    const name = state?.user?.name
    if (!name) continue
    names.add(name)
    const updated = awareness.meta?.get(clientId)?.lastUpdated
    if (updated !== undefined && (now - updated > AWARENESS_FRESH_MS || updated > now)) continue
    current.set(name, [...(current.get(name) ?? []), state])
  }
  return [...names].sort().map(name => {
    const record = participantRecord(doc, name)
    const presences = current.get(name) ?? []
    const own = record?.holder ? presences.find(state => state.sessionId === record.holder?.sessionId) : undefined
    const fresh = !!own
    const observedMs = doc.expiry.get(name)?.observedMs ?? 0
    return {
      name,
      ...(record?.id?.kind ? { kind: record.id.kind } : presences[0]?.user?.kind ? { kind: presences[0].user.kind } : {}),
      fresh,
      visible: fresh || (!!record && observedMs < ROOM_STALE_MS),
      ...(record?.holder ? { holder: record.holder } : {}),
      ...(record?.proj ? { projectedBy: record.proj.projectedBy } : {}),
      ...(typeof own?.idleMin === 'number' ? { idleMin: own.idleMin } : {}),
    }
  })
}

/** The fence of an un-ended holder while awareness names that exact host session. */
export function liveHolder(view: readonly ParticipantView[], name: string): string | undefined {
  const participant = view.find(p => p.name === name)
  return participant?.fresh && !participant.holder?.ended ? holderFence(participant.holder) : undefined
}

/** The only reader for a participant's git fact; stale writer incarnations read as updating. */
export function acceptedGit(record: ParticipantRecord | undefined, view: readonly ParticipantView[]): ParticipantGit | 'updating' {
  const expected = record?.proj ? liveHolder(view, record.proj.projectedBy) : holderFence(record?.holder)
  return expected && record?.git?.fence === expected ? record.git : 'updating'
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
const stoppedWithSession = (w: { stopReason?: WorkerView['stopReason'] }): boolean => w.stopReason === 'lead-session-ended'
const stoppedAfterMessage = (w: { stopReason?: WorkerView['stopReason'] }): string | undefined =>
  w.stopReason?.startsWith('message-delivered-')
    ? `stopped after receiving your message: ${w.stopReason === 'message-delivered-cancelled' ? 'cancelled' : 'launch failed'}`
    : undefined

/** Wording for action recency; connectivity and process liveness are separate facts. */
export function activityLabel(lastActive: number | undefined, now = Date.now(), options: { running?: boolean; processGone?: boolean; worker?: { status: WorkerView['status']; finishedAt?: number; stopReason?: WorkerView['stopReason'] } } = {}): string {
  if (options.worker && stoppedWithSession(options.worker)) return STOPPED_WITH_SESSION
  if (options.worker && workerLive(options.worker.status) && options.processGone) return STOPPED_UNWITNESSED
  const finished = options.worker !== undefined && !workerLive(options.worker.status)
  const running = options.worker ? workerLive(options.worker.status) : options.running
  if (finished) lastActive = options.worker!.finishedAt ?? lastActive
  if (lastActive === undefined || !Number.isFinite(lastActive)) return finished ? 'finished (time unknown)' : running ? 'running' : 'activity unknown'
  const seconds = Math.max(0, Math.floor((now - lastActive) / 1000))
  const duration = seconds < 60 ? seconds + 's' : seconds < 3600 ? Math.floor(seconds / 60) + 'm' : seconds < 86400 ? Math.floor(seconds / 3600) + 'h' : Math.floor(seconds / 86400) + 'd'
  if (finished) return 'finished ' + duration + ' ago'
  if (running) return now - lastActive > 300_000 ? 'running · quiet ' + duration : 'running'
  return seconds < 90 ? 'working' : 'last action ' + duration + ' ago'
}

/** Views show a quiet session as idle from this many minutes of its own idle measure (registry §18). */
export const IDLE_SHOWN_MIN = 10

/** "idle 25 min", "idle 3 h; holds 2 claims"; nothing under ten minutes. */
export function idleLabel(idleMin: number | undefined, claims = 0): string | undefined {
  if (idleMin === undefined || !Number.isFinite(idleMin) || idleMin < IDLE_SHOWN_MIN) return undefined
  const span = idleMin < 60 ? `${Math.floor(idleMin)} min` : `${Math.floor(idleMin / 60)} h`
  return `idle ${span}${claims ? `; holds ${claims} claim${claims === 1 ? '' : 's'}` : ''}`
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
  workers?: readonly WorkerView[]
  scopes: readonly (readonly [string, Scope])[]
  overlayPeople: readonly string[]
  changesByPerson: ReadonlyMap<string, readonly string[]>
  claims: readonly Claim[]
  now?: number
}

/** Shared identity text for browser cards and room_state, using only reported runtime facts. */
export function participantIdentityLine(current: readonly Presence[], name: string, worker?: WorkerView, fallbackKind?: Kind): string {
  const p = [...current].filter(p => p.user.name === name).sort((a, b) => Number(isAgentic(b.user.kind)) - Number(isAgentic(a.user.kind)) || (b.lastActive ?? 0) - (a.lastActive ?? 0))[0]
  const id = p?.user ?? (worker ? { name, kind: 'agent' as const, owner: worker.name.split('+')[0], label: worker.tag } : fallbackKind ? { name, kind: fallbackKind } : undefined)
  if (!id) return name
  const parts = [describeIdentity(id)]
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
    return {
      name,
      online,
      latestActive,
      kinds: Array.from(kinds).sort((a, b) => a.localeCompare(b)),
      identity: participantIdentityLine(current, name, input.workers?.find(w => w.name === name), kinds.has('agent') ? 'agent' : scope?.byKind ?? input.claims.find(c => c.by === name)?.byKind).split(' · ').slice(1).join(' · '),
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
  const active = participants.filter(p => p.online || (!!workers.get(p.name) && (workerLive(workers.get(p.name)!.status) || workers.get(p.name)!.status === 'failed' || workers.get(p.name)!.status === 'done')))
  const offlineTeammates = participants.filter(p => !p.online && !workers.has(p.name))
  const leads = new Set([...workers.values()].map(w => w.lead))
  for (const w of retiredWorkers) leads.add(w.lead)
  const allGroups = [...leads].sort().map(lead => ({
    lead,
    active: active.filter(p => workers.get(p.name)?.lead === lead),
    retiredWorkers: retiredWorkers.filter(w => w.lead === lead),
    running: [...workers.values()].filter(w => w.lead === lead && workerLive(w.status)).length,
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
  heldCount?: number
  excludedCount?: number
  messages: readonly NoteMsg[]
  share: ShareLevel
  /** Accepted team projection; runtime status comes from the worker view, not team awareness. */
  projectedWorker?: Pick<WorkerView, 'lead' | 'status'>
  /** A projection exists, but its lead fence no longer validates. */
  projectedStale?: string
}

/** The status/detail portion of a room_state participant line. */
export function personLine(input: PersonLineInput): string {
  const p = input.presences.find(x => x.user.name === input.name && isAgentic(x.user.kind))
    ?? input.presences.find(x => x.user.name === input.name)
  const lastDone = [...input.messages].reverse().find(m => m.from === input.name && m.text.startsWith('done')
    // A session that joined after the note is a new one under the same name: the note is not its status.
    && !(p?.joinedAt !== undefined && m.at < p.joinedAt))
  let what: string
  if (input.projectedStale) what = `projection stale/updating via ${input.projectedStale}`
  else if (input.projectedWorker) what = `${input.scope ? `working on ${scopeLine(input.scope)}; ` : ''}via ${input.projectedWorker.lead} (${input.projectedWorker.status})`
  else if (input.scope) what = `working on ${scopeLine(input.scope)}`
  else if (p?.status?.startsWith('done')) what = p.status
  else if (lastDone && (!p || p.status === 'idle' || p.status === 'synced')) what = `${lastDone.text} (${new Date(lastDone.at).toISOString().slice(11, 16)})`
  else what = p ? `${p.status && !['idle', 'synced'].includes(p.status) ? p.status + ', ' : ''}no task declared` : 'offline'
  const share = input.share === 'full' ? '' : `; shares ${input.share}${input.share === 'intent' ? ' (no file text)' : ' (file text only in their declared area)'}`
  const files = summarizeFiles(input.changedPaths)
  const changed = files.count > 5
    ? `${files.count} files${files.dominant ? `, mostly ${files.dominant.folder} (${files.dominant.count})` : ''}: ${files.named.map(file => file.label).join(', ')} ...`
    : input.changedPaths.join(', ')
  return `${what}${share}${files.count ? `; uncommitted, not yet pushed: ${changed}` : ''}${input.heldCount ? `; ${input.heldCount} changed path(s) without text` : ''}${input.excludedCount ? `; ${input.excludedCount} changed path(s) excluded (names not shared)` : ''}`
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
  worker: WorkerView
  /** The worktree, known only to the lead's own registry. */
  dir?: string
  processGone?: boolean
  lastActive?: number
  changedCount: number
  last?: string
  /** The latest tool or file event in the worker's host log (labels carry no message text or output). */
  activity?: { label: string; at: number }
  now?: number
}

const WORKER_ACTIVITY_MAX = 80
const ago = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`
}

/** The canonical room_state lines for one dispatched worker; a live worker with known activity gets a third. */
export function workerLine({ worker: w, dir, processGone = false, lastActive, changedCount, last, activity, now = Date.now() }: WorkerLineInput): string[] {
  const age = Math.max(0, Math.round((now - w.startedAt) / 60000))
  const showActivity = activity && workerLive(w.status) && !processGone && !w.stopReason
  if (showActivity) lastActive = Math.max(lastActive ?? 0, activity.at)
  const summary = w.summary?.startsWith(STOPPED_UNWITNESSED) ? w.summary : w.summary?.slice(0, 120)
  const state = stoppedAfterMessage(w) ?? (stoppedWithSession(w) ? STOPPED_WITH_SESSION
    : w.stopReason === 'discarded' ? `discard pending (${w.status})`
    : w.stopReason ? `stopped (${w.stopReason})`
    : w.noReport ? 'ended without a report'
    : workerLive(w.status) && processGone ? STOPPED_UNWITNESSED
    : workerLive(w.status) ? activityLabel(lastActive ?? w.startedAt, now, { running: true }) : w.status)
  return [
    `  - ${w.tag} (${w.host}${w.model ? ` ${w.model}` : ''}${w.effort ? ` · ${w.effort}` : ''}, ${state}, ${age}m): ${w.task.slice(0, 80)}${w.task.length > 80 ? '…' : ''}`,
    `      ${formatCount(changedCount, 'changed file')} · branch ${w.branch}${workerLive(w.status) && processGone && dir && !stoppedWithSession(w) ? ` · worktree ${dir}` : ''}${summary ? ` · ${summary}` : ''}${w.followUp ? ` · follow-up: ${w.followUp.slice(0, 120)}` : ''}${last ? ` · last: ${last.slice(0, 100)}` : ''}`,
    ...(showActivity ? [`      ${activity.label.slice(0, WORKER_ACTIVITY_MAX)} · ${ago(now - activity.at)} ago`] : []),
  ]
}

export function workerLines(inputs: readonly WorkerLineInput[], options: { all?: boolean; retiredWorkers?: readonly RetiredWorker[] } = {}): string[] {
  const retired = options.retiredWorkers ?? []
  if (!inputs.length && !retired.length) return []
  const visibleRetired = options.all ? retired : retired.filter(w => !!w.keptWorktree)
  const out = [`workers (${inputs.length + visibleRetired.length}):`, ...[...inputs]
    .sort((a, b) => a.worker.startedAt - b.worker.startedAt)
    .flatMap(workerLine)]
  for (const w of [...visibleRetired].sort((a, b) => b.retiredAt - a.retiredAt || a.name.localeCompare(b.name))) {
    const state = w.disposition === 'stopped' ? (stoppedAfterMessage(w) ?? (stoppedWithSession(w) ? STOPPED_WITH_SESSION : `stopped (${w.stopReason ?? 'reason unknown'})`)) : w.disposition ?? w.outcome
    const kept = w.keptWorktree ? `, kept: ${w.keptReason ?? (w.summary.startsWith('kept for ') ? w.summary.slice(9) : `worktree at ${w.keptWorktree}`)}` : ''
    out.push(`  - ${w.tag} (${state}${w.uncommitted ? ` with ${w.uncommitted} uncommitted files left in its worktree` : ''}${w.model ? `, ${w.model}` : ''}${kept}): ${w.summary} · ${formatCount(w.fileCount, 'file')}`)
  }
  const hiddenRetired = retired.length - visibleRetired.length
  if (hiddenRetired) out.push(`  retired: ${hiddenRetired} (all=true lists them)`)
  return out
}

export interface ConflictResolution {
  how: 'released' | 'narrowed' | 'merged clean'
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
  /** Every editor's latest notice has `merges` (ConflictMsg): an overlap that merges cleanly, not a conflict. */
  merges?: 'clean'
}

/** An unresolved span's status, in the notices' words: "overlap" when it merges cleanly, "conflict" otherwise. */
export const conflictSpanStatus = (span: Pick<ConflictSpan, 'merges'>): string =>
  span.merges === 'clean' ? 'Overlap: merges cleanly' : 'Unresolved conflict'

/** Reconstruct conflict history from existing bus facts; never manufacture a timestamp.
 * Missing claims alone are not proof of release (the rolling bus may be incomplete).
 */
export function deriveConflictSpans(messages: readonly import('./types.js').Msg[], claims: readonly Claim[]): ConflictSpan[] {
  const bus = [...messages].sort((a, b) => a.at - b.at)
  const known = new Map<string, Claim>()
  for (const m of bus) if (m.type === 'claim' && !known.has(m.claimId)) known.set(m.claimId, { id: m.claimId, path: m.path, from: m.from_line, to: m.to_line, by: m.from, byKind: m.fromKind, intent: m.intent, plans: m.plans, at: m.at })
  const current = new Map(claims.map(c => [c.id, c]))
  for (const c of claims) if (!known.has(c.id)) known.set(c.id, c)
  const spans: ConflictSpan[] = []
  /** Per span, each editor's latest `merges`: one editor's clean overlap does not hide another's conflict. */
  const merging = new Map<ConflictSpan, Map<string, 'clean' | undefined>>()
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
    const id = ids.length ? JSON.stringify([path, ids]) : pairKey(path, people)
    let span = spans.find(s => s.id === id || (people.length === 2 && pairKey(s.path, s.people) === pairKey(path, people) && ids.length === 0 && s.claimIds.length === 0))
    if (!span) { span = { id, path, people, claimIds: ids, from, to, at: m.at, events: [], claims: cs, hidden: false }; spans.push(span) }
    if (ids.length === 2 && span.claimIds.length < 2) { span.claimIds = ids; span.claims = cs }
    span.events.push(m)
    if (m.type === 'conflict') {
      // The editor's own notice is addressed to them; the holder's copy names them first.
      const holder = known.get(m.claimId)?.by
      const editor = m.to && m.to !== holder ? m.to : m.text.match(/^(.+?)(?:'s agent edited | edited |'s earlier change to )/)?.[1] ?? m.to ?? ''
      const editors = merging.get(span) ?? new Map<string, 'clean' | undefined>()
      merging.set(span, editors)
      // A cleared editor no longer overlaps; with none left, the clearing notice says what it was.
      if (m.clearedFrom) editors.delete(editor)
      else editors.set(editor, m.merges)
      span.merges = !editors.size ? m.merges : [...editors.values()].every(value => value === 'clean') ? 'clean' : undefined
    }
  }
  // Claims can overlap before a conflict notification is delivered.
  for (let i = 0; i < claims.length; i++) for (const b of claims.slice(i + 1)) {
    const a = claims[i]
    if (a.by === b.by || a.path !== b.path || a.from > b.to || b.from > a.to) continue
    const ids = [a.id, b.id].sort(), id = JSON.stringify([a.path, ids])
    const existing = spans.find(s => s.claimIds.join() === ids.join() || (s.claimIds.length === 0 && s.at >= Math.max(a.at, b.at) && pairKey(s.path, s.people) === pairKey(a.path, [a.by, b.by])))
    if (existing && existing.claimIds.length < 2) { existing.claimIds = ids; existing.claims = [a, b] }
    if (!existing) spans.push({ id, path: a.path, people: [a.by, b.by].sort(), claimIds: ids, from: Math.max(a.from, b.from), to: Math.min(a.to, b.to), at: Math.max(a.at, b.at), events: [], claims: [a, b], hidden: false })
  }
  for (const s of spans) {
    const lastConflict = s.events.at(-1)?.at ?? s.at
    for (const m of bus) {
      if (m.at < lastConflict) continue
      let resolution: ConflictResolution | undefined
      if (m.type === 'release' && s.claimIds.includes(m.claimId)) resolution = { how: 'released', who: m.from, at: m.at }
      if (m.type === 'note' && s.claimIds.length === 0 && s.people.some(person => m.to === person && m.text === `your ${s.path} and ${s.people.find(p => p !== person)}'s merge cleanly again`)) resolution = { how: 'merged clean', who: m.to, at: m.at }
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
  conflicts?: readonly { people: readonly string[]; detail?: string; resolved: boolean; overlap?: boolean; range?: string; status?: string; resolution?: string }[]
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
  const conflict = detail.conflicts.find(c => !c.resolved && !c.overlap) ?? detail.conflicts.find(c => !c.resolved) ?? detail.conflicts[0]
  if (conflict) return conflict.people.join(' ↔ ') + (conflict.resolved ? ' · resolved' : conflict.overlap ? ' · overlap' : ' · conflict')
  if (detail.claims.length) return detail.claims.map(c => c.by + ' · claimed: ' + c.intent).join(' · ')
  return detail.ownership
}

/** A bus message the room's hub never sequenced, in a room a hub serves: history a migration copied from
 *  Room 0.16, whose relay and server assigned no `seq`. It is the room's past, never its recent activity. */
export function importedHistory(room: RoomDoc, m: { seq?: number }): boolean {
  return typeof m.seq !== 'number' && room.metaMap.get('hubIncarnation') !== undefined
}

/** A migration `unresolved` entry, keyed `<old room>\0<old name>`. */
export interface UnresolvedEntry { placeholder: string; claims?: readonly unknown[]; scope?: unknown }

/** One plain line per ambiguous migrated name: what is owed to it and who it could be. `messagesTo`
 *  counts mail addressed to each placeholder. At most `maxNames` lines and three candidates per line.
 *  A name with nothing owed has no line (nobody needs to rejoin for it), and Room's own bot `room` never
 *  has one: it cannot be asked to rejoin. */
export function unresolvedLines(roomName: string, entries: Iterable<[string, UnresolvedEntry]>, messagesTo: ReadonlyMap<string, number>, maxNames = 5): string[] {
  const all = new Map<string, { candidates: string[]; messages: number; claims: number; scopes: number }>()
  for (const [key, entry] of entries) {
    const split = key.indexOf('\0')
    const source = key.slice(0, split), person = key.slice(split + 1)
    if (person === 'room') continue
    let where = source.startsWith('archive:') ? 'the old room' : source.startsWith(`${roomName}/`) ? source.slice(roomName.length + 1) : source
    try { where = decodeURIComponent(where) } catch { /* keep the stored spelling */ }
    let group = all.get(person)
    if (!group) { group = { candidates: [], messages: 0, claims: 0, scopes: 0 }; all.set(person, group) }
    group.candidates.push(`${person} on ${where}`)
    group.messages += messagesTo.get(entry.placeholder) ?? 0
    group.claims += Array.isArray(entry.claims) ? entry.claims.length : 0
    if (entry.scope) group.scopes++
  }
  const groups = new Map([...all].filter(([, group]) => group.messages || group.claims || group.scopes))
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const out = [...groups.values()].slice(0, maxNames).map(group => {
    const owed = [group.messages ? plural(group.messages, 'message') : '', group.claims ? plural(group.claims, 'claim') : ''].filter(Boolean).join(' and ')
      || 'a declared scope'
    const names = group.candidates.slice(0, 3).join(' or ') + (group.candidates.length > 3 ? `, +${group.candidates.length - 3} more` : '')
    return `${owed} for an unresolved name (${names}): ask them to rejoin`
  })
  if (groups.size > maxNames) out.push(`+${groups.size - maxNames} more unresolved names`)
  return out
}
