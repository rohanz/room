import { holderFence, participantRecord, type ParticipantHolder, type RoomDoc } from './doc.js'
import { containsPath } from './near.js'
import type { ManifestHead } from './manifest.js'
import { publicationPolicyLevel, publicationRevisionCurrent, retainedPublication } from './worker-memory.js'
import type { Priority, WorkerView } from './types.js'
import type { Transaction } from 'yjs'

export type ConflictKind = 'merge' | 'edit-in-claim' | 'claims' | 'contract'
export interface ConflictSlot {
  kind: ConflictKind
  owner: string
  other: string
  path: string
  subject?: string
  status: 'conflict' | 'possible' | 'unknown' | 'clean'
  inputs: string
  factId: string
  settled: 'conflict' | 'possible' | 'clean' | 'none'
  /** One continuous opening; content and line updates keep it, clearance and replacement do not. */
  openId?: string
  endpoints?: { name: string; workerId?: string }[]
  /** Claim ranges evaluated with this fact; never joined with later live claims at read time. */
  claimRanges?: { from: number; to: number }[]
  lines?: number[]
  why?: string
  earlierSha?: string | null
  merges?: 'clean'
  fence: string
  evaluatedRanges?: { from: number; to: number }[]
  confirmedAt?: number
  checkedAt: number
  retryAt?: number
  retrySource?: string
  consumers?: string[]
}
/** Raw identity observations; the shared end rule interprets them for writers and readers. */
export interface ConflictEndpointEvidence {
  name: string
  holderWorkerId?: string
  projection?: { projectedFrom: string; projectedBy: string }
  /** `stale`: written under a lead holder that is no longer current; proves no identity. */
  manifestProjection?: { projectedFrom?: string; projectedBy?: string; stale?: true }
  acceptedWorkerId?: string
  /** Lead holders observed in this same source room, qualified by the worker they own. */
  leads?: { name: string; workerId: string; holder?: Pick<ParticipantHolder, 'epoch' | 'ended'> }[]
}
export interface OpenConflict {
  id: string
  kind: ConflictKind
  /** The recipient; an edit-in-claim also has a separate entry for its holder. */
  owner: string
  other: string
  slots: ConflictSlot[]
  priority: Priority
  text: string
  /** Keep recipient wording when another reader combines or subsets this group's files. */
  presentation?: { holder: boolean; projectedOwner?: string; otherLead?: string }
}

/** Positive events supplied by their existing authority, never inferred from a missing map entry. */
export interface ConflictEndEvidence {
  evaluated?: 'clean'
  /** Exact retirement event; a different qualified endpoint can never be retired by its name. */
  retirement?: readonly { id: string; name: string }[]
  retiredWorkerIds?: ReadonlySet<string>
  withdrawnParticipants?: ReadonlySet<string>
  expiredParticipants?: ReadonlySet<string>
  endpointEvidence?: (name: string) => ConflictEndpointEvidence
  ownWorker?: { name: string; id: string; lead: string; status: WorkerView['status'] }
  /** Raw policy facts for one synchronous pass only; never retained across updates. */
  policyCache?: Map<string, ReturnType<typeof currentPolicy>>
}
export type ConflictEndReason = 'unsupported' | 'clean' | 'retired' | 'replaced' | 'expired' | 'withdrawn' | 'grant-withdrawn' | 'private-route' | 'claims-finished'

/** Only a current published policy can withdraw a grant; missing/stale policy is unknown. */
function currentPolicy(room: RoomDoc, name: string, workerId?: string): { level: ManifestHead['level']; head?: ManifestHead } | undefined {
  const head = room.manifestHead.get(name), record = participantRecord(room, name)
  const recorded = () => {
    const policy = publicationPolicyLevel(room.doc, name)
    if (!policy?.level) return
    const holder = record?.holder
    const matchingHolder = holder?.epoch === policy.epoch && (!workerId || holder.workerId === workerId)
    const matchingProjection = workerId && record?.proj?.projectedFrom === workerId
      && participantRecord(room, record.proj.projectedBy)?.holder?.epoch === policy.epoch
    const matchingCache = workerId && [...room.doc.getMap<import('./worker-memory.js').CompletedPublication>('completedPublications').values()]
      .some(value => value?.worker?.name === name && value.worker.id === workerId && value.holder?.epoch === policy.epoch)
    return matchingHolder || matchingProjection || matchingCache ? { level: policy.level } : undefined
  }
  if (!head) {
    const retained = retainedPublication(room, name)
    if (!retained) return recorded()
    if (workerId && retained.worker.id !== workerId) return
    return { level: retained.head.level, head: retained.head }
  }
  if (!Array.isArray(head.excluded) || !['intent', 'declared', 'full'].includes(head.level)
      || head.textPrefixes !== undefined && !Array.isArray(head.textPrefixes)) return
  const projection = record?.proj
  if ((projection?.projectedFrom || head.projectedFrom) && (projection?.projectedFrom !== head.projectedFrom || projection?.projectedBy !== head.projectedBy)) return
  if (!headFenceCurrent(room, name, head)) return recorded()
  if (!publicationRevisionCurrent(room.doc, name, head)) return recorded()
  return { level: head.level, head }
}

/** The one durable authority check for a publication head: its fence is its writer's
 * current holder epoch (the projecting lead's, for a projection). */
function headFenceCurrent(room: RoomDoc, name: string, head: { fence: string; projectedFrom?: string; projectedBy?: string }): boolean {
  const expected = holderFence(participantRecord(room, head.projectedFrom ? head.projectedBy ?? '' : name)?.holder)
  return !!expected && expected === head.fence
}

/**
 * The single rule for ending a recorded conflict. Absence, stale/unreadable publications,
 * missing projections and unknown worker status are never evidence of an ending.
 */
export function conflictEndReason(room: RoomDoc, slot: ConflictSlot, evidence: ConflictEndEvidence = {}): ConflictEndReason | undefined {
  if (evidence.evaluated === 'clean' || slot.status === 'clean' || slot.settled === 'clean') return 'clean'
  if (!hasConflictIdentity(slot)) return 'unsupported' // old data was never an admitted opening
  if (evidence.retirement) {
    const ids = new Set(evidence.retirement.map(worker => worker.id))
    const named = (name: string) => {
      const record = participantRecord(room, name), id = record?.holder?.workerId ?? record?.proj?.projectedFrom
      return !!id && evidence.retirement!.some(worker => worker.name === name && worker.id === id)
    }
    for (const endpoint of slot.endpoints) {
      const id = endpoint.workerId
      if (id ? ids.has(id) : named(endpoint.name)) return 'retired'
    }
    return
  }
  const names = [slot.owner, slot.other]
  if (names.some(name => evidence.expiredParticipants?.has(name))) return 'expired'
  if (names.some(name => evidence.withdrawnParticipants?.has(name))) return 'withdrawn'
  const retired = evidence.retiredWorkerIds ?? new Set(room.retiredWorkers().flatMap(worker => worker.id ? [worker.id] : []))
  const observed = new Map<string, ConflictEndpointEvidence[]>()
  const observations = (name: string) => {
    let values = observed.get(name)
    if (!values) {
      values = [(evidence.endpointEvidence ?? (name => conflictEndpointEvidence(room, name)))(name)]
      observed.set(name, values)
    }
    return values
  }
  for (const endpoint of slot.endpoints) {
    const status = endpointStatus(endpoint, observations(endpoint.name), retired)
    if (status === 'retired' || status === 'replaced') return status
  }
  // Incomplete diagnostics have never opened and keep the detector's existing lifecycle.
  if (slot.settled === 'none') return
  for (const endpoint of slot.endpoints) if (endpoint.workerId && observations(endpoint.name).some(value => value.leads?.some(lead =>
    lead.workerId === endpoint.workerId && lead.holder?.ended === 'released'))) return 'withdrawn'
  if (slot.kind === 'edit-in-claim' || slot.kind === 'claims') {
    const peer = slot.endpoints.find(endpoint => endpoint.name === slot.other)!
    // Only the detector's existing trusted registry lookup can finish stored claims.
    // A replicated display status may describe an older run and cannot end a slot.
    const own = evidence.ownWorker
    if (own?.name === slot.other && own.lead === slot.owner && own.status === 'done'
      && (!peer.workerId || own.id === peer.workerId)) return 'claims-finished'
  }
  const policies = evidence.policyCache ?? new Map<string, ReturnType<typeof currentPolicy>>()
  const policy = (name: string) => {
    const workerId = slot.endpoints.find(endpoint => endpoint.name === name)?.workerId, key = JSON.stringify([name, workerId])
    if (!policies.has(key)) policies.set(key, currentPolicy(room, name, workerId))
    return policies.get(key)
  }
  if (slot.kind !== 'claims' && (policy(slot.owner)?.level === 'intent' || policy(slot.other)?.level === 'intent')) return 'grant-withdrawn'
  if (slot.kind === 'contract') {
    const withdrawn = (name: string, path: string) => {
      const value = policy(name)
      if (!value) return false
      const { head } = value
      return head?.level === 'declared' && !(head.textPrefixes ?? []).some(prefix => containsPath(prefix, path))
    }
    if (withdrawn(slot.other, slot.path) || slot.consumers?.some(path => withdrawn(slot.owner, path))) return 'grant-withdrawn'
  }
  // A current, matching team projection explicitly moves private family comparisons out of this room.
  const leadOf = (name: string) => {
    const value = policy(name), projection = participantRecord(room, name)?.proj
    return value?.head && projection?.projectedFrom && value.head.projectedFrom === projection.projectedFrom
      && value.head.projectedBy === projection.projectedBy ? projection.projectedBy : undefined
  }
  const ownerLead = leadOf(slot.owner), otherLead = leadOf(slot.other)
  if (ownerLead && (slot.other === ownerLead || otherLead === ownerLead) || otherLead && slot.owner === otherLead) return 'private-route'
}

/** Only this writer generation's directed identity is evidence; older formats are never decoded. */
export function hasConflictIdentity(slot: ConflictSlot | undefined): slot is ConflictSlot & { openId: string; endpoints: { name: string; workerId?: string }[] } {
  return !!slot && typeof slot.openId === 'string' && slot.openId.length > 0 && Array.isArray(slot.endpoints) && slot.endpoints.length === 2
    && slot.owner !== slot.other && slot.endpoints.every(endpoint => endpoint && typeof endpoint.name === 'string'
      && (endpoint.workerId === undefined || typeof endpoint.workerId === 'string' && endpoint.workerId.length > 0))
    && slot.endpoints.some(endpoint => endpoint.name === slot.owner) && slot.endpoints.some(endpoint => endpoint.name === slot.other)
}
const isOpen = (slot: ConflictSlot) => hasConflictIdentity(slot) && ['merge', 'edit-in-claim', 'claims', 'contract'].includes(slot.kind)
  && (slot.settled === 'conflict' || slot.settled === 'possible')
type Row = ConflictSlot
type ConflictIndex = { all: Map<string, Row>; recipients: Map<string, Map<string, Row>>; cached: Map<string, OpenConflict[]>; listeners: Set<() => void> }
const indexes = new WeakMap<RoomDoc, ConflictIndex>()
function projectedLead(room: RoomDoc, slot: ConflictSlot): string | undefined {
  const projection = participantRecord(room, slot.owner)?.proj, head = room.manifestHead.get(slot.owner)
  return projection?.projectedFrom && projection.projectedFrom === head?.projectedFrom && projection.projectedBy === head.projectedBy
    && slot.endpoints?.some(endpoint => endpoint.name === slot.owner && endpoint.workerId === projection.projectedFrom)
    ? projection.projectedBy : undefined
}
const recipients = (room: RoomDoc, slot: Row): string[] => [...new Set([slot.owner,
  ...(slot.kind === 'edit-in-claim' && slot.settled === 'conflict' ? [slot.other] : []),
  ...[projectedLead(room, slot)].filter((name): name is string => !!name)])]
/** Changed-key indexes: a session reads its bucket, never the whole conflicts map on an edit. */
function index(room: RoomDoc): ConflictIndex {
  let result = indexes.get(room)
  if (result) return result
  const state: ConflictIndex = { all: new Map(), recipients: new Map(), cached: new Map(), listeners: new Set() }
  const changed = new WeakSet<Transaction>()
  const invalidate = (transaction: Transaction) => { state.cached.clear(); changed.add(transaction) }
  const owners = new Map<string, string[]>()
  {
    const name = 'conflicts'
    const map = room.doc.getMap<Row>(name)
    const update = (key: string) => {
      const id = name + '\0' + key, old = state.all.get(id)
      if (old) for (const owner of owners.get(id) ?? []) {
        const bucket = state.recipients.get(owner)
        bucket?.delete(id)
        if (!bucket?.size) state.recipients.delete(owner)
        state.cached.delete(owner)
      }
      state.all.delete(id); owners.delete(id)
      const raw = map.get(key), slot = raw
      if (!raw || !slot || !isOpen(slot)) return
      state.all.set(id, raw)
      const names = recipients(room, raw); owners.set(id, names)
      for (const owner of names) {
        let bucket = state.recipients.get(owner)
        if (!bucket) { bucket = new Map(); state.recipients.set(owner, bucket) }
        bucket.set(id, raw); state.cached.delete(owner)
      }
    }
    for (const key of map.keys()) update(key)
    map.observe(event => {
      for (const key of event.keysChanged) update(key)
      changed.add(event.transaction)
    })
    const refresh = (names: Iterable<string>) => {
      const ids = new Set<string>()
      for (const name of names) for (const id of state.recipients.get(name)?.keys() ?? []) ids.add(id)
      for (const id of ids) update(id.slice('conflicts\0'.length))
      state.cached.clear()
    }
    room.manifestHead.observe(event => { refresh(event.keysChanged); changed.add(event.transaction) })
    room.participants.observe(event => {
      refresh([...event.keysChanged].map(key => key.slice(0, key.lastIndexOf('\0'))))
      changed.add(event.transaction)
    })
  }
  // These roots affect endpoint authority, policy, urgency or wording. Claim ranges are
  // captured in slots; live manifests, text and room metadata are not query inputs.
  for (const map of [room.workerViews, room.doc.getArray('retiredWorkers'),
    room.doc.getMap('completedPublications'), room.doc.getMap('completedPublicationRevisions')])
    map.observe(event => invalidate(event.transaction))
  // Type observers update the changed-key recipient index first. Notify once per
  // completed transaction, synchronously before a following transaction can clear it.
  const notify = (transaction: Transaction) => {
    if (changed.delete(transaction)) for (const listener of [...state.listeners]) listener()
  }
  room.doc.on('afterTransaction', notify)
  room.doc.on('destroy', () => { room.doc.off('afterTransaction', notify); state.listeners.clear() })
  indexes.set(room, state)
  return state
}
const atLines = (lines?: number[]) => lines?.length ? ` at lines ${lines.join(', ')}` : ''
const bounded = (items: string[]) => items.slice(0, 8).join('; ') + (items.length > 8 ? `; and ${items.length - 8} more` : '')

/** Accepted worker identity and existing explicit lead-release observations in this room. */
export function conflictEndpointEvidence(room: RoomDoc, name: string): ConflictEndpointEvidence {
  const record = participantRecord(room, name), head = room.manifestHead.get(name), worker = room.workerViewOf(name)
  const accepted = room.acceptedWorkerViewOf(name)
  // A lead relationship is evidence only when written under that lead's own holder epoch:
  // a newer, unrelated release by a former lead says nothing about this worker.
  const projected = record?.proj && head && head.projectedFrom === record.proj.projectedFrom
    && head.projectedBy === record.proj.projectedBy && headFenceCurrent(room, name, head)
  const viewHolder = worker && participantRecord(room, worker.lead)?.holder
  const viewed = viewHolder && worker.fence === (holderFence(viewHolder) ?? viewHolder.sessionId)
  const leads = [...(projected ? [{ name: record.proj!.projectedBy, workerId: record.proj!.projectedFrom }] : []),
    ...(viewed ? [{ name: worker.lead, workerId: worker.id }] : [])].map(lead => {
      const holder = participantRecord(room, lead.name)?.holder
      return { ...lead, ...(holder ? { holder: { epoch: holder.epoch, ended: holder.ended } } : {}) }
    })
  return { name,
    ...(record?.holder?.workerId ? { holderWorkerId: record.holder.workerId } : {}),
    ...(record?.proj ? { projection: { ...record.proj } } : {}),
    ...(head ? { manifestProjection: { projectedFrom: head.projectedFrom, projectedBy: head.projectedBy,
      ...(head.projectedFrom && !headFenceCurrent(room, name, head) ? { stale: true as const } : {}) } } : {}),
    ...(accepted ? { acceptedWorkerId: accepted.id } : {}),
    ...(leads.length ? { leads } : {}) }
}
/** A malformed projection is ordinary comparison input, never proof of a worker incarnation. */
function workerIdFromEvidence(evidence: ConflictEndpointEvidence): string | undefined {
  const proj = evidence.projection, head = evidence.manifestProjection
  const projected = proj?.projectedFrom && !head?.stale && proj.projectedFrom === head?.projectedFrom && proj.projectedBy === head.projectedBy
    ? proj.projectedFrom : undefined
  return projected ?? evidence.holderWorkerId ?? (!proj?.projectedFrom && !head?.projectedFrom ? evidence.acceptedWorkerId : undefined)
}
export function conflictWorkerId(room: RoomDoc, name: string): string | undefined {
  return workerIdFromEvidence(conflictEndpointEvidence(room, name))
}
type EndpointStatus = 'current' | 'unknown' | 'replaced' | 'retired'
/** One rule for native observations and the explicit registry route. */
function endpointStatus(endpoint: { name: string; workerId?: string }, observations: ConflictEndpointEvidence[], retired: ReadonlySet<string>): EndpointStatus {
  if (!endpoint.workerId) return 'unknown'
  if (retired.has(endpoint.workerId)) return 'retired'
  const ids = observations.map(workerIdFromEvidence).filter((id): id is string => !!id)
  if (ids.some(id => id !== endpoint.workerId)) return 'replaced'
  return ids.length ? 'current' : 'unknown'
}

/** Subscribe to every input of openConflicts, after its indexes have updated.
 * Synchronous and coalesced per transaction; unrelated edits do not notify.
 * Does not emit an initial value. The caller reads once on attachment and disposes
 * the subscription when no longer interested; the room owns the underlying index. */
export function onOpenConflictsChanged(room: RoomDoc, listener: () => void): () => void {
  const { listeners } = index(room)
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Current directed conflicts. Unknown retains the last settled evidence. */
export function openConflicts(room: RoomDoc, participant?: string): OpenConflict[] {
  const state = index(room)
  if (participant !== undefined && state.cached.has(participant)) return state.cached.get(participant)!
  const groups = new Map<string, { entry: OpenConflict; holder: boolean; projectedOwner?: string; otherLead?: string }>()
  const retired = new Set(room.retiredWorkers().flatMap(worker => worker.id ? [worker.id] : []))
  const localEvidence = new Map<string, ConflictEndpointEvidence>()
  const policyCache: NonNullable<ConflictEndEvidence['policyCache']> = new Map()
  const evidenceOf = (name: string) => {
    let evidence = localEvidence.get(name)
    if (!evidence) { evidence = conflictEndpointEvidence(room, name); localEvidence.set(name, evidence) }
    return evidence
  }
  for (const raw of (participant === undefined ? state.all : state.recipients.get(participant) ?? new Map<string, Row>()).values()) {
    const slot = raw
    if (conflictEndReason(room, slot, { retiredWorkerIds: retired, endpointEvidence: evidenceOf, policyCache })) continue
    // Main's edit-in-claim delivery filter is deliberately separate from endings:
    // display-only status can suppress that alert, but cannot delete its stored fact
    // or suppress a claims/merge/contract alert about a resumed worker.
    const peerId = slot.endpoints?.find(endpoint => endpoint.name === slot.other)?.workerId
    const display = room.workerViewOf(slot.other)
    const worker = display && (!peerId || display.id === peerId) ? display : undefined
    if (slot.kind === 'edit-in-claim' && display?.lead === slot.owner && display.status !== 'running') continue
    const recipients = [{ owner: slot.owner, holder: false }]
    if (slot.kind === 'edit-in-claim' && slot.settled === 'conflict') recipients.push({ owner: slot.other, holder: true })
    const lead = projectedLead(room, slot)
    if (lead && !recipients.some(recipient => recipient.owner === lead)) recipients.push({ owner: lead, holder: false })
    for (const { owner, holder } of recipients) {
      if (participant !== undefined && owner !== participant) continue
      const other = holder ? slot.owner : slot.other
      // Merge conflicts and possibilities each have one opening per peer.
      const subject = slot.kind === 'merge' ? slot.settled : `${slot.path}\0${slot.kind === 'edit-in-claim' || slot.settled === 'possible' ? '' : slot.subject ?? ''}`
      const identity = slot.openId!
      const id = `state-conflict:${JSON.stringify([owner, slot.owner, slot.kind, other, subject, identity, holder])}`
      let group = groups.get(id)
      if (!group) {
        const priority: Priority = owner === lead && slot.kind === 'merge' && slot.settled === 'possible'
          && room.manifestHead.get(slot.other)?.projectedBy && room.manifestHead.get(slot.other)?.projectedBy !== lead ? 'notify'
          : slot.settled === 'possible' || slot.merges === 'clean' ? 'fyi'
          : slot.kind === 'edit-in-claim' && !holder && worker?.lead !== slot.owner ? 'interrupt' : 'notify'
        const otherLead = worker?.lead
        const entry: OpenConflict = { id, kind: slot.kind, owner, other, slots: [], priority, text: '' }
        group = { entry, holder, projectedOwner: owner === lead ? slot.owner : undefined, otherLead }; groups.set(id, group)
      }
      if (!group.entry.slots.some(s => s.owner === slot.owner && s.other === slot.other && s.path === slot.path && s.subject === slot.subject)) group.entry.slots.push(slot)
    }
  }
  const result = [...groups.values()].map(({ entry, holder, projectedOwner, otherLead }) => withConflictSlots({
    ...entry, presentation: { holder, projectedOwner, otherLead },
  }, entry.slots)).sort((a, b) => a.id.localeCompare(b.id))
  if (participant !== undefined) state.cached.set(participant, result)
  return result
}

/** Rebuild a group's line after a reader unions or subsets its evaluated slots. */
export function withConflictSlots(original: OpenConflict, slots: readonly ConflictSlot[]): OpenConflict {
  if (!slots.length) throw new Error('a conflict presentation needs at least one slot')
  const entry = { ...original, slots: [...slots].sort((a, b) => a.path.localeCompare(b.path) || (a.subject ?? '').localeCompare(b.subject ?? '')) }
  const { holder = entry.kind === 'edit-in-claim' && entry.owner === entry.slots[0]!.other, projectedOwner, otherLead } = entry.presentation ?? {}
  const slot = entry.slots[0]!
  const claimed = slot.claimRanges ?? []
  const claim = `${slot.other}'s claim${claimed.length > 1 ? 's' : ''}${claimed.length ? ` at lines ${claimed.map(c => c.from === c.to ? c.from : `${c.from}-${c.to}`).join(', ')}` : ''}`
  entry.text = slot.settled === 'possible'
    ? slot.kind === 'edit-in-claim' ? `you may have edited ${slot.path} inside ${claim}; line mapping is approximate`
      : slot.kind === 'claims' ? `claims in ${slot.path} may overlap with ${slot.other}; line mapping is approximate`
        : `possible conflict in ${slot.path} with ${otherLead ? `${otherLead}'s worker ` : ''}${slot.other}: ${slot.why ?? slot.other}'s file contents are not shared or available; Room cannot check whether these edits merge cleanly. Ask ${otherLead ?? slot.other}, or have one side collect and preview`
    : slot.kind === 'edit-in-claim' ? holder
      ? `${slot.owner}${slot.earlierSha !== undefined ? "'s earlier change to" : ' edited'} ${slot.path}${slot.earlierSha ? ` (${slot.earlierSha})` : ''} ${slot.earlierSha !== undefined ? 'overlaps your new claim' : 'inside your claim'}`
      : slot.earlierSha !== undefined ? `your earlier change to ${slot.path}${slot.earlierSha ? ` (${slot.earlierSha})` : ''} overlaps ${claim.replace(/'s claim/, "'s new claim")}`
        : `you edited ${slot.path} inside ${claim}${slot.why ? ` (${slot.why})` : ''}`
    : slot.kind === 'claims' ? `concurrent overlapping claims in ${slot.path} with ${slot.other}`
    : slot.kind === 'contract' ? `${slot.other} changed ${slot.subject ?? 'a symbol'} in ${slot.path}${slot.why ? ` (${slot.why})` : ''}`
    : entry.slots.length === 1 ? `${slot.path} conflicts with ${slot.other}'s version${atLines(slot.lines)}`
      : `${entry.slots.length} files conflict with ${slot.other}'s version: ${bounded(entry.slots.map(s => `${s.path}${atLines(s.lines)}`))}`
  if (slot.settled === 'possible' && slot.kind === 'merge' && entry.slots.length > 1) entry.text = `${entry.slots.length} files possibly conflict with ${slot.other}: ${bounded(entry.slots.map(s => s.path))}; file contents are not shared or available; Room cannot check whether these edits merge cleanly. Ask ${otherLead ?? slot.other}, or have one side collect and preview`
  if (slot.merges === 'clean') entry.text += '; merges cleanly'
  if (projectedOwner) entry.text = `${projectedOwner}: ${entry.text}`
  return entry
}

export function formatConflictLine(entry: OpenConflict): string {
  const slot = entry.slots[0]!
  const label = slot.settled === 'possible' ? 'POSSIBLE conflict' : slot.merges === 'clean' ? 'overlap' : entry.kind === 'contract' ? 'CONTRACT' : 'CONFLICT'
  return `[${entry.priority}] ${label}: ${entry.text}${entry.slots.some(slot => slot.status === 'unknown') ? '; recheck unavailable' : ''}`
}
