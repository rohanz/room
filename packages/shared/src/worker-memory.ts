import type * as Y from 'yjs'
import type { RoomDoc, ParticipantHolder, ParticipantGit } from './doc.js'
import type { ManifestHead, ManifestEntry } from './manifest.js'
import type { ShareLevel, WorkerView } from './types.js'

/** Immutable read cache, deliberately separate from live CRDT publication roots.
 * Restoring copied live roots would give old text new CRDT identities that could
 * defeat a surviving replica's retirement or sharing-policy tombstones. */
export interface CompletedPublication {
  key: string
  worker: WorkerView
  head: ManifestHead
  holder: ParticipantHolder
  git: ParticipantGit
  entries: [string, ManifestEntry][]
  texts: [string, string][]
  baseTexts: [string, string][]
}

/** Immutable revision keys preserve narrowing even when no text can be saved.
 * A map keyed only by name would let a copied, older snapshot win by Yjs client ID.
 * semRev matters: incomplete/intent transitions need not increment content rev. */
interface PublicationRevision { name: string; epoch: number; semRev: number; rev: number; level?: ShareLevel }
const REVISIONS = 'completedPublicationRevisions'
const revisionKey = (r: PublicationRevision): string => `${r.name}\0${r.epoch}\0${r.semRev}\0${r.rev}`
const compareRevision = (a: PublicationRevision, b: PublicationRevision): number =>
  a.epoch - b.epoch || a.semRev - b.semRev || a.rev - b.rev
const publicationRevision = (p: CompletedPublication): PublicationRevision =>
  ({ name: p.worker.name, epoch: p.holder.epoch, semRev: p.head.semRev, rev: p.head.rev, level: p.head.level })
const hasPublicationRevision = (p: CompletedPublication): boolean => typeof p?.worker?.name === 'string'
  && Number.isSafeInteger(p.holder?.epoch) && Number.isSafeInteger(p.head?.semRev) && Number.isSafeInteger(p.head?.rev)

/** Maximum per name, including live policy changes that have no retained payload. */
function revisions(doc: Y.Doc): Map<string, PublicationRevision> {
  const latest = new Map<string, PublicationRevision>()
  const see = (r: PublicationRevision) => {
    const old = latest.get(r.name)
    if (!old || compareRevision(r, old) > 0 || compareRevision(r, old) === 0 && r.level !== undefined) latest.set(r.name, r)
  }
  for (const r of doc.getMap<PublicationRevision>(REVISIONS).values()) see(r)
  for (const p of doc.getMap<CompletedPublication>('completedPublications').values()) if (hasPublicationRevision(p)) see(publicationRevision(p))
  const participants = doc.getMap<ParticipantHolder>('participants')
  const heads = doc.getMap<ManifestHead>('manifestHead')
  const names = new Set([...latest.keys(), ...heads.keys(), ...[...doc.getMap<WorkerView>('workerViews').values()].map(worker => worker.name)])
  for (const name of names) {
    const holder = participants.get(`${name}\0holder`)
    // A newer holder can have no publication yet; it still supersedes old text.
    if (holder && Number.isSafeInteger(holder.epoch)) see({ name, epoch: holder.epoch, semRev: -1, rev: -1 })
    const head = heads.get(name)
    const epoch = head && Number(head.fence)
    if (head && epoch !== undefined && Number.isSafeInteger(epoch)) see({ name, epoch, semRev: head.semRev, rev: head.rev, level: head.level })
  }
  return latest
}

const matchesRevision = (p: CompletedPublication, latest: Map<string, PublicationRevision>): boolean => {
  const known = latest.get(p.worker.name)
  return !!known && compareRevision(publicationRevision(p), known) === 0
}

/** A live CRDT head can also be stale after a cold restart and late replica merge.
 * Readers must not let its mere presence defeat a newer persisted policy revision. */
export function publicationRevisionCurrent(doc: Y.Doc, name: string, head: ManifestHead): boolean {
  const known = revisions(doc).get(name)
  return !known || compareRevision({ name, epoch: Number(head.fence), semRev: head.semRev, rev: head.rev }, known) >= 0
}

/** No payload, paths or inferred withdrawal: older records without a published level are unknown. */
export function publicationPolicyLevel(doc: Y.Doc, name: string): { epoch: number; level: ShareLevel } | undefined {
  const known = revisions(doc).get(name)
  return known?.level && ['intent', 'declared', 'full'].includes(known.level) ? { epoch: known.epoch, level: known.level } : undefined
}

function contradicted(doc: Y.Doc, p: CompletedPublication): boolean {
  const view = doc.getMap<WorkerView>('workerViews').get(p.worker.id)
  const holder = doc.getMap<ParticipantHolder>('participants').get(`${p.worker.name}\0holder`)
  return !!view && (view.name !== p.worker.name || view.run !== p.worker.run || view.status !== 'done')
    || !!holder && (holder.workerId !== p.worker.id || holder.epoch !== p.holder.epoch)
    || doc.getArray<{ id: string }>('retiredWorkers').toArray().some(value => value.id === p.worker.id)
}

/** Reads need a current, accepted projection from the live lead. A cache is not
 * authority to resurrect a worker, even after the bounded retirement log expires. */
export function retainedPublication(room: RoomDoc, name: string): CompletedPublication | undefined {
  return room.manifestHead.has(name) ? undefined : completedPublicationOf(room, name)
}

/** The normal-exit publication, in the same form as its immutable restart cache. */
function livePublication(doc: Y.Doc, worker: WorkerView): CompletedPublication | undefined {
  const heads = doc.getMap<ManifestHead>('manifestHead')
  const participants = doc.getMap<unknown>('participants')
  const manifests = doc.getMap<Y.Map<ManifestEntry>>('manifest')
  const overlays = doc.getMap<Y.Map<Y.Text>>('overlays')
  const head = heads.get(worker.name)
  const holder = participants.get(`${worker.name}\0holder`) as ParticipantHolder | undefined
  const git = participants.get(`${worker.name}\0git`) as ParticipantGit | undefined
  if (!head?.complete || head.projectedFrom || head.level === 'intent' || head.coverage.kind !== 'all'
    || holder?.workerId !== worker.id || String(holder.epoch) !== head.fence
    || git?.fence !== head.fence || git.base !== head.base) return undefined
  const key = `${worker.name}\0${head.fence}`
  const manifest = manifests.get(key)
  if (!manifest) return undefined
  const entries = [...manifest].filter(([, entry]) => entry.fence === head.fence)
  const texts: [string, string][] = entries.flatMap(([path, entry]) => {
    const value = entry.state === 'shared' && entry.change !== 'D' && entry.hash ? overlays.get(key)?.get(path) : undefined
    return value ? [[path, value.toString()]] : []
  })
  const shared = new Set(entries.filter(([, entry]) => entry.state === 'shared').map(([path]) => path))
  for (const prefix of head.textPrefixes ?? []) if (!prefix.endsWith('/') && !manifest.has(prefix)) shared.add(prefix)
  const baseTexts: [string, string][] = [...doc.getMap<string>('basetextFlat')].flatMap(([key, value]) => {
    const prefix = `${worker.name}\0${head.base}:`
    const path = key.startsWith(prefix) ? key.slice(prefix.length) : undefined
    return path !== undefined && shared.has(path) ? [[path, value]] : []
  })
  const p: CompletedPublication = { key: `${worker.id}\0${worker.run}\0${head.fence}\0${head.semRev}\0${head.rev}`, worker, head, holder: { ...holder, ended: holder.ended ?? 'released' }, git, entries, texts, baseTexts }
  return p
}

/** One completed source: current live roots take precedence over the restart cache. */
export function completedPublicationOf(room: RoomDoc, name: string): CompletedPublication | undefined {
  const view = room.acceptedWorkerViewOf(name)
  if (!view || view.status !== 'done') return undefined
  const latest = revisions(room.doc)
  if (room.manifestHead.has(name)) {
    const p = livePublication(room.doc, view)
    return p && matchesRevision(p, latest) && !contradicted(room.doc, p) ? p : undefined
  }
  return [...room.doc.getMap<CompletedPublication>('completedPublications').values()]
    .find(p => hasPublicationRevision(p) && p.worker.id === view.id && p.worker.run === view.run && p.worker.name === name
      && matchesRevision(p, latest) && !contradicted(room.doc, p))
}

/** Only already-shared text is saved; live policy and generation changes win. */
export function workerMemory(doc: Y.Doc): {
  publications: { size: number; copyTo(copy: Y.Doc): void }[]
  copyRevisionsTo(copy: Y.Doc): void
} {
  const latest = revisions(doc)
  const heads = doc.getMap<ManifestHead>('manifestHead')
  const publications = new Map<string, CompletedPublication>()
  for (const p of doc.getMap<CompletedPublication>('completedPublications').values()) {
    if (!heads.has(p.worker.name) && matchesRevision(p, latest) && !contradicted(doc, p)) {
      const old = publications.get(p.worker.id)
      if (!old || p.holder.epoch > old.holder.epoch || p.holder.epoch === old.holder.epoch && p.head.rev > old.head.rev) publications.set(p.worker.id, p)
    }
  }
  for (const worker of doc.getMap<WorkerView>('workerViews').values()) {
    if (worker.status !== 'done') continue
    const p = livePublication(doc, worker)
    if (p && matchesRevision(p, latest) && !contradicted(doc, p)) publications.set(worker.id, p)
  }
  return {
    publications: [...publications.values()].sort((a, b) => (a.worker.finishedAt ?? 0) - (b.worker.finishedAt ?? 0)).map(p => ({
      size: JSON.stringify(p).length,
      copyTo(copy: Y.Doc) { copy.getMap('completedPublications').set(p.key, p) },
    })),
    // Never shed these with text: a late replica must not revive a superseded policy.
    copyRevisionsTo(copy) { for (const revision of latest.values()) copy.getMap(REVISIONS).set(revisionKey(revision), revision) },
  }
}
