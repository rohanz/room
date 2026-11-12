/** Producer proposals only. The hub owns inventory revisions and every destructive outcome. */
import { randomBytes } from 'node:crypto'
import { NOTICE_BATCH_IDS, NOTICE_CAPABILITY, noticeEvidence, workerNoticeId, type NoticeIntent, type NoticeRecord } from '@room/hub-core'
import { outgoing, participantRecord, type Identity, type Msg, type PostBody } from '@room/shared'
import type { Session } from './session.js'
import type { Post, PostResult } from './post.js'
import { ended } from './worker-store.js'
import type { WorkerRegistry } from './worker-registry.js'
import { HubError } from './hub-client.js'

const nonce = () => randomBytes(16).toString('hex')
const instances = new WeakMap<Session, NoticeLifecycle>()
export function noticeLifecycle(s: Session): NoticeLifecycle | undefined {
  if (s.contract?.capabilities[NOTICE_CAPABILITY] !== 1) return undefined
  let lifecycle = instances.get(s)
  if (!lifecycle) { lifecycle = new NoticeLifecycle(s); instances.set(s, lifecycle) }
  return lifecycle
}

export class NoticeLifecycle {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly producers = new Map<string, string>()
  private readonly fallbacks = new Set<string>()
  /** Accepted hub responses may precede replica delivery. These are proposal inputs, never receipts or shared writes. */
  private readonly accepted = new Map<string, NoticeRecord>()
  private generation?: number
  constructor(private readonly s: Session) {}
  private supported(): boolean { return this.s.contract?.capabilities[NOTICE_CAPABILITY] === 1 }
  private fallback(reason: unknown): void {
    const warning = `notice lifecycle TTL fallback: ${String(reason)}`
    if (!this.fallbacks.has(warning)) { this.fallbacks.add(warning); process.stderr.write(`room-mcp: ${warning}\n`) }
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run)
    this.queue = next.catch(() => {})
    return next
  }
  private records(): [string, NoticeRecord][] {
    const generation = this.s.hub.noticeIncarnation?.()
    if (generation !== undefined && generation !== this.generation) {
      this.producers.clear(); this.accepted.clear(); this.generation = generation
    }
    const records = new Map([...this.s.room.doc.getMap<NoticeRecord>('noticeInventory').entries()]
      .filter(([, record]) => generation === undefined || record.generation === generation))
    for (const [key, record] of this.accepted) if ((records.get(key)?.revision ?? -1) < record.revision) records.set(key, record)
    return [...records]
  }
  private async send(intent: NoticeIntent): Promise<Record<string, unknown>> {
    const fence = this.s.lease?.fence()
    if (!fence) throw new Error('notice lease unavailable')
    const reply = await this.s.hub.noticeLifecycle({ ...intent, lease: { name: this.s.me.name, epoch: Number(fence) } })
    if (!reply.ok) throw new HubError(reply.reason, reply.text)
    if (reply.inventory && typeof reply.producer === 'string') this.accepted.set(reply.producer, reply.inventory as NoticeRecord)
    if (Array.isArray(reply.updates)) for (const update of reply.updates as { producer: string; revision: number; ids: string[]; at: number }[]) {
      const record = this.records().find(([key]) => key === update.producer)?.[1]
      if (record) this.accepted.set(update.producer, { ...record, revision: update.revision,
        entries: record.entries.map(e => update.ids.includes(e.id) && e.ended === undefined ? { ...e, ended: update.at } : e) })
    }
    return reply
  }

  /** A lease change starts a registration producer; retirement can still target old records by exact id. */
  private producer(names: string[]): string {
    this.records()
    const key = JSON.stringify([this.s.me.name, this.s.lease?.sessionId, this.s.lease?.fence(), [...names].sort()])
    let producer = this.producers.get(key)
    if (!producer) { producer = nonce(); this.producers.set(key, producer) }
    return producer
  }

  /** A proposed binding becomes an id only after this exact registration is accepted by the hub. */
  private async registeredNotice(from: Identity, body: PostBody<Msg>, baselineId: string, names: string[]): Promise<Msg | undefined> {
    // Holder identity precedes the projected worker view. Missing holders mean unknown, never non-worker.
    // The hub independently checks the complete binding against its private leases.
    const holders = names.map(name => participantRecord(this.s.room, name)?.holder)
    const proposed = this.supported() && holders.every(Boolean)
      ? workerNoticeId(baselineId, holders.flatMap(holder => holder?.workerId ? [holder.workerId] : [])) : undefined
    if (!proposed) return undefined
    // This binding is stored only by the hub's accepted registration. In particular,
    // a rejected replica worker ID must never leak into the ordinary fallback post.
    const msg = outgoing(from, { ...body, noticeSubjects: holders.flatMap((holder, i) => holder?.workerId
      ? [{ name: names[i]!, workerId: holder.workerId }] : []) }, proposed)
    const producer = this.producer(names), record = this.records().find(([key]) => key === producer)?.[1]
    const reply = await this.send({ action: 'register', producer, expected: record?.revision ?? 0, operation: nonce(),
      evidence: noticeEvidence(this.s.room, names), episode: nonce(), msg })
    if (reply.managed !== true) {
      this.fallback(reply.fallback ?? 'unconfirmed registration')
      return undefined
    }
    return { ...msg, at: Date.now() } as Msg
  }

  /** Keep baseline identity for every refused, failed or unconfirmed registration, including transport retries. */
  register(from: Identity, body: PostBody<Msg>, baselineId: string, names: string[], valid: () => boolean, baseline: Post = this.s.post): Promise<PostResult> {
    body = { ...body }
    delete body.noticeSubjects
    return this.serial(async () => {
      const refused = (text: string): PostResult => ({ ok: false,
        msg: { ...outgoing(from, body, baselineId), at: Date.now() } as Msg, reason: 'unreachable', text })
      if (!valid() || !this.s.lease?.fence()) return refused('notice lease unavailable')
      try {
        const msg = await this.registeredNotice(from, body, baselineId, names)
        if (msg !== undefined) return { ok: true, msg }
      } catch (error) {
        if (!valid() || !this.s.lease?.fence()) return refused(`notice registration: ${String(error)}`)
        this.fallback(error instanceof HubError ? error.reason : 'unavailable')
      }
      if (!valid() || !this.s.lease?.fence()) return refused('notice lease unavailable')
      // This is the only ordinary post path. Its immutable baseline id is never a rejected proposal.
      return baseline(from, body, { id: baselineId, auto: true })
    })
  }

  retirementTargets(workerId: string): { producer: string; expected: number; ids: string[]; episodes: Record<string, string> }[] {
    return this.records().flatMap(([producer, inventory]) => {
      const entries = inventory.entries.filter(e => e.ended === undefined && Date.now() <= e.until && e.dependencies.some(d => d.workerId === workerId))
      return entries.length ? [{ producer, expected: inventory.revision, ids: entries.slice(0, NOTICE_BATCH_IDS).map(e => e.id),
        episodes: Object.fromEntries(entries.slice(0, NOTICE_BATCH_IDS).map(e => [e.id, e.episode])) }] : []
    })
  }
  retire(workerId: string, target: { producer: string; expected: number; ids: string[]; episodes: Record<string, string> }): Promise<unknown> {
    return this.serial(() => this.send({ action: 'retire', producer: 'retirement', expected: 0, operation: nonce(), workerId, targets: [{ producer: target.producer, expected: target.expected, ids: target.ids, episodes: target.episodes }] }))
  }
}

/** Registry truth is local to the authenticated principal. The hub confines the effect to its exact private dependencies. */
export async function retireNoticeDependencies(s: Session, registry: Pick<WorkerRegistry, 'snapshot'>, active: () => boolean): Promise<void> {
  const lifecycle = noticeLifecycle(s)
  if (!lifecycle || !active() || !s.lease?.fence()) return
  const before = await registry.snapshot()
  if (!before.available || before.blockers.length || !active()) return
  for (const fact of before.workers) {
    const record = fact.record
    if (record.room !== s.roomName || !ended(record)) continue
    for (;;) {
      const targets = lifecycle.retirementTargets(record.id)
      if (!targets.length || !active() || !s.lease?.fence()) break
      const fresh = await registry.snapshot()
      const current = fresh.available ? fresh.workers.find(f => f.record.id === record.id)?.record : undefined
      if (!fresh.available || fresh.blockers.length || fresh.revision !== before.revision || !current || !ended(current)
        || current.seq !== record.seq || JSON.stringify(current.lead.instance) !== JSON.stringify(record.lead.instance)
        || !active() || !s.lease?.fence()) return
      // One producer per request keeps evidence small and makes expected-revision retries explicit.
      await lifecycle.retire(record.id, targets[0])
    }
  }
}
