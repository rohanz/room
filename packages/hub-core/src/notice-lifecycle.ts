/** Stage 1: private hub authority, with a replicated diagnostic mirror. No restoration from that mirror. */
import { createHash } from 'node:crypto'
import { OWED_TTL_MS, type RoomDoc } from '@room/shared'
import type { PostIn, Reply } from './protocol.js'

export const NOTICE_CAPABILITY = 'room.notice-lifecycle'
export const NOTICE_ROOM_IDS = 2000
export const NOTICE_ROOM_BYTES = 512 * 1024
export const NOTICE_PRODUCER_IDS = 200
export const NOTICE_PRODUCER_BYTES = 64 * 1024
export const NOTICE_BATCH_IDS = 64
export const NOTICE_BATCH_BYTES = 64 * 1024
/** Each admitted id pays in advance for its terminal marker and a single-id ending acknowledgement. */
const END_RESERVE = 256
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= max
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

/** Preserve the baseline cf/pair prefix, but give every exact worker incarnation its own id. */
export function workerNoticeId(id: string, workerIds: readonly string[]): string | undefined {
  return workerIds.length ? `${id}:worker:${digest([...new Set(workerIds)].sort())}` : undefined
}
const bindsWorkers = (id: string, workerIds: readonly string[]) => {
  const suffix = workerNoticeId('', workerIds)
  return suffix !== undefined && id.endsWith(suffix)
}

export interface NoticeEvidence { names: string[]; revision: string }
/** Capture published inputs, not clocks or producer-computed merge results. The hub repeats this at acceptance. */
export function noticeEvidence(room: RoomDoc, names: readonly string[]): NoticeEvidence {
  const sorted = [...new Set(names)].sort(), named = new Set(sorted)
  return { names: sorted, revision: digest([
    room.roomSalt,
    sorted.map(name => [name, room.manifestHead.get(name), room.participants.get(`${name}\0holder`), room.participants.get(`${name}\0git`),
      room.participants.get(`${name}\0proj`),
      [...room.manifest.entries()].filter(([key]) => key.startsWith(`${name}\0`)).sort(([a], [b]) => a.localeCompare(b)).map(([key, map]) => [key, [...map.entries()].sort(([a], [b]) => a.localeCompare(b))])]),
    [...room.claims.entries()].filter(([, claim]) => named.has(claim.by)).sort(([a], [b]) => a.localeCompare(b)),
    [...room.workerViews.entries()].filter(([, worker]) => named.has(worker.name)).sort(([a], [b]) => a.localeCompare(b)),
    sorted.map(name => {
      const graph = room.graphs.get(name)
      return [name, graph && [graph.base, graph.status, graph.sourceFence, graph.sourceRev, graph.truncated,
        graph.observedTruncated, graph.observed, graph.uncoveredPaths, graph.uncoveredTruncated]]
    }),
  ]) }
}

export interface NoticeEntry {
  /** episode is an opaque registration nonce, never a conflict-completion or membership decision. */
  id: string; to: string; from: 'room'; episode: string; priority: string
  /** Copied only from private hub lease records, never a caller's worker view. */
  dependencies: { workerId: string; principal: string }[]
  names: string[]; until: number; ended?: number
}
interface Committed { hash: string; revision: number }
export interface NoticeRecord {
  v: 1; generation: number; name: string; session: string; principal: string; epoch: number; workerId?: string
  revision: number; until: number; entries: NoticeEntry[]; operations: Record<string, Committed>
}
/** Exactly two operations: atomic registration/publication, or exact-worker retirement. */
export interface NoticeIntent {
  action: 'register' | 'retire'
  producer: string; expected: number; operation: string
  evidence?: NoticeEvidence; episode?: string; msg?: PostIn
  workerId?: string
  targets?: { producer: string; expected: number; ids: string[]; episodes: Record<string, string> }[]
}
export interface NoticeAuthority { name: string; epoch: number; session: string; principal: string; workerId?: string }
type Refuse = (reason: 'invalid' | 'stale' | 'not-yours' | 'too-large', text: string) => Reply

/** All methods run inside the hub's non-yielding request path. Authority is supplied from its private lease. */
export class NoticeInventory {
  private readonly records = new Map<string, NoticeRecord>()
  constructor(private readonly room: RoomDoc, private readonly generation: () => number) {}

  /** Reassert only this authority's records. Synced or restart-loaded inventories are unknown, never adopted. */
  reassert(): void {
    const map = this.room.doc.getMap<NoticeRecord>('noticeInventory')
    for (const key of map.keys()) if (!this.records.has(key)) map.delete(key)
    for (const [key, record] of this.records) if (JSON.stringify(map.get(key)) !== JSON.stringify(record)) map.set(key, structuredClone(record))
  }

  terminal(id: string): boolean { return [...this.records.values()].some(r => r.entries.some(e => e.id === id && e.ended !== undefined)) }
  registered(id: string): boolean { return [...this.records.values()].some(r => r.entries.some(e => e.id === id)) }

  apply(input: unknown, authority: NoticeAuthority, now: number, publish: (msg: PostIn) => Reply,
    dependency: (name: string) => { workerId: string; principal: string } | undefined, fail: Refuse): Reply {
    if (!object(input) || bytes(input) > NOTICE_BATCH_BYTES) return fail('too-large', 'notice intent exceeds 64 KiB')
    const common = ['action', 'producer', 'expected', 'operation']
    const fields = input.action === 'register' ? [...common, 'evidence', 'episode', 'msg'] : [...common, 'workerId', 'targets']
    if (Object.keys(input).some(k => !fields.includes(k)) || input.action !== 'register' && input.action !== 'retire'
      || !text(input.producer) || !integer(input.expected) || !text(input.operation, 64)) return fail('invalid', 'invalid notice registration or retirement')
    const intent = input as unknown as NoticeIntent
    if ((intent.action === 'retire') !== (intent.producer === 'retirement') || intent.action === 'retire' && intent.expected !== 0)
      return fail('invalid', 'retirement uses its reserved operation namespace')
    const hash = digest(intent), opKey = digest([authority.principal, authority.name, intent.operation])
    if (intent.action === 'retire') return this.retire(intent, authority, now, hash, opKey, fail)
    if (!object(intent.evidence) || Object.keys(intent.evidence).some(k => !['names', 'revision'].includes(k))
      || !Array.isArray(intent.evidence.names) || intent.evidence.names.length < 1 || intent.evidence.names.length > 4
      || !intent.evidence.names.every(n => text(n, 200)) || !text(intent.evidence.revision, 64)
      || !intent.evidence.names.includes(authority.name)) return fail('invalid', 'registration requires its published participant evidence')
    const owned = this.records.get(intent.producer), previous = owned?.operations[opKey]
    if (owned && (owned.name !== authority.name || owned.principal !== authority.principal || owned.workerId !== authority.workerId))
      return fail('not-yours', 'notice producer belongs to another incarnation')
    if (owned && (owned.session !== authority.session || owned.epoch !== authority.epoch)) return fail('stale', 'notice producer authority changed')
    if (previous) {
      if (previous.hash !== hash) return fail('invalid', 'conflicting notice operation retry')
      return { v: 1, re: '', ok: true, managed: true, duplicate: true, producer: intent.producer,
        revision: previous.revision, inventory: structuredClone(owned) }
    }
    if (intent.expected !== (owned?.revision ?? 0)) return fail('stale', 'notice inventory revision moved')
    if (noticeEvidence(this.room, intent.evidence.names).revision !== intent.evidence.revision) return fail('stale', 'notice registration inputs moved')
    const msg = intent.msg
    if (!object(msg) || msg.from !== 'room' || !text(msg.id, 512) || !msg.id.startsWith('cf:') || !text(msg.to, 200)
      || !intent.evidence.names.includes(msg.to) || !['fyi', 'notify', 'interrupt'].includes(String(msg.priority))
      || !['conflict', 'merge-conflict', 'contract'].includes(String(msg.type)) || !text(intent.episode))
      return fail('invalid', 'registration requires an exact addressed conflict notice')
    const dependencies = intent.evidence.names.map(dependency).filter((d): d is NonNullable<typeof d> => !!d)
    // An ending is sound only when no successor can ever reuse this id. Verify against private leases,
    // before deduplication: a producer cannot rebind an old id to a new worker or register baseline history.
    if (!bindsWorkers(msg.id, dependencies.map(d => d.workerId)))
      return { v: 1, re: '', ok: true, managed: false, fallback: 'unbound' }
    // Duplicate ids never change their original private worker dependencies or reset their lifetime.
    if (this.registered(msg.id)) return { v: 1, re: '', ok: true, managed: true, duplicate: true, gone: this.terminal(msg.id) }
    if (this.room.message(msg.id) || this.room.archive.has(msg.id) || this.room.outcomes.has(msg.id))
      return { v: 1, re: '', ok: true, managed: false, fallback: 'untracked' }
    const added: NoticeEntry = { id: msg.id, from: 'room', to: msg.to, episode: intent.episode!, priority: String(msg.priority),
      names: [...intent.evidence.names], until: now + OWED_TTL_MS,
      dependencies }
    const revision = (owned?.revision ?? 0) + 1
    const next: NoticeRecord = { ...(owned ?? { v: 1 as const, generation: this.generation(), ...authority, until: added.until, entries: [], operations: {} }),
      revision, until: Math.max(owned?.until ?? 0, added.until), entries: [...owned?.entries ?? [], added],
      operations: { ...owned?.operations, [opKey]: { hash, revision } } }
    if (!this.fits(next, intent.producer)) return { v: 1, re: '', ok: true, managed: false, fallback: 'capacity' }
    const result = publish(msg)
    if (!result.ok || result.gone) return result
    this.records.set(intent.producer, next)
    this.reassert()
    return { v: 1, re: '', ok: true, managed: true, producer: intent.producer, revision, inventory: structuredClone(next) }
  }

  private retire(intent: NoticeIntent, authority: NoticeAuthority, now: number, hash: string, opKey: string, fail: Refuse): Reply {
    if (!text(intent.workerId, 512) || !Array.isArray(intent.targets) || !intent.targets.length || intent.targets.length > NOTICE_BATCH_IDS
      || intent.targets.some(t => !object(t) || Object.keys(t).some(k => !['producer', 'expected', 'ids', 'episodes'].includes(k)) || !text(t.producer)
        || !integer(t.expected) || !Array.isArray(t.ids) || !t.ids.length || !t.ids.every(id => text(id, 512)))
      || intent.targets.reduce((n, t) => n + t.ids.length, 0) > NOTICE_BATCH_IDS
      || new Set(intent.targets.map(t => t.producer)).size !== intent.targets.length) return fail('invalid', 'invalid exact-worker retirement batch')
    const work: { key: string; record: NoticeRecord; entries: NoticeEntry[]; duplicate: boolean }[] = []
    for (const target of intent.targets) {
      const record = this.records.get(target.producer)
      if (!record) return fail('stale', 'retirement inventory is unknown')
      const prior = record.operations[opKey]
      if (prior && prior.hash !== hash) return fail('invalid', 'conflicting retirement retry')
      const entries = target.ids.map(id => record.entries.find(e => e.id === id))
      if (new Set(target.ids).size !== target.ids.length || entries.some(e => !e || !e.dependencies.some(d => d.workerId === intent.workerId && d.principal === authority.principal)))
        return fail('not-yours', 'retirement may end only this principal exact-worker dependencies')
      if (!object(target.episodes) || Object.keys(target.episodes).length !== target.ids.length
        || entries.some(e => target.episodes[e!.id] !== e!.episode)) return fail('stale', 'retirement episode tokens moved')
      if (!prior && entries.some(e => e!.ended !== undefined)) return fail('stale', 'retirement already committed under another operation')
      if (!prior && (record.revision !== target.expected || entries.some(e => now > e!.until))) return fail('stale', 'retirement revision or horizon moved')
      work.push({ key: target.producer, record, entries: entries as NoticeEntry[], duplicate: !!prior })
    }
    for (const item of work) if (!item.duplicate) {
      const revision = item.record.revision + 1, ids = new Set(item.entries.map(e => e.id))
      this.records.set(item.key, { ...item.record, revision,
        entries: item.record.entries.map(e => ids.has(e.id) && e.ended === undefined ? { ...e, ended: now } : e),
        operations: { ...item.record.operations, [opKey]: { hash, revision } } })
      this.end(item.entries, now)
    }
    this.reassert()
    return { v: 1, re: '', ok: true, managed: true, duplicate: work.every(w => w.duplicate), updates: work.map(w => ({
      producer: w.key, revision: this.records.get(w.key)!.revision, ids: w.entries.map(e => e.id),
      at: this.records.get(w.key)!.entries.find(e => e.id === w.entries[0]!.id)!.ended!,
    })) }
  }

  private end(entries: NoticeEntry[], now: number): void {
    for (const entry of entries) if (!this.room.outcomes.has(entry.id))
      this.room.outcomes.set(entry.id, { to: entry.to, from: entry.from, outcome: 'expired', at: now })
  }

  private fits(next: NoticeRecord, key: string): boolean {
    const cost = (r: NoticeRecord, producer: string) => bytes(r) + Math.max(132, bytes(producer) + 2) +
      r.entries.filter(e => e.ended === undefined).length * END_RESERVE
    const records = [...this.records.entries()].filter(([k]) => k !== key)
    const producer = records.filter(([, r]) => r.name === next.name && r.workerId === next.workerId)
    return producer.reduce((n, [, r]) => n + r.entries.length, next.entries.length) <= NOTICE_PRODUCER_IDS
      && producer.reduce((n, [k, r]) => n + cost(r, k), cost(next, key)) <= NOTICE_PRODUCER_BYTES
      && records.reduce((n, [, r]) => n + r.entries.length, next.entries.length) <= NOTICE_ROOM_IDS
      && records.reduce((n, [k, r]) => n + cost(r, k), cost(next, key)) <= NOTICE_ROOM_BYTES
  }
}
