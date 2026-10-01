import { MIGRATION_MAX_RECORD_BYTES, MIGRATION_MAX_REBUILDS, MIGRATION_AUDIT_MAX_ENTRIES, MIGRATION_AUDIT_MAX_BYTES, LOAD_MAX_BYTES } from './limits.js'
import crypto from 'node:crypto'
import * as Y from 'yjs'
import { RoomDoc, type Claim, type Msg, type Scope } from '@room/shared'
import type { AuditEntry, OpenRepo } from './store.js'
import { ownsName } from './readonly.js'
import { archiveOwnerOf, parseRoomName, parseLegacyRoomName } from './names.js'
import { servedBy016, classifyDoc } from './inventory.js'
import type { StoredSize } from './stored.js'

/** A source is either recorded by the old registry or a GitHub document with the same exact repo identity. */
export function migrationSources(repo: string, entry: OpenRepo, docs: string[], registered: ReadonlySet<string> = new Set()): string[] {
  const parsed = parseRoomName(repo, true)
  if (!parsed || parsed.repo !== repo) return []
  const recorded = new Set([...entry.branches, ...(entry.legacy ?? []), ...(entry.plan?.sources ?? [])])
  return [...new Set([...recorded, ...docs])].filter(name => {
    if (name === repo || registered.has(name) && parseRoomName(name)?.repo !== repo) return false
    if (name.startsWith('archive:')) return recorded.has(name) && archiveOwnerOf(name) === repo
    const source = parseLegacyRoomName(name)
    if (!source || !servedBy016(name)) return false
    if (!parsed.github && [...registered].some(key => key.startsWith(`${repo}/`) && (name === key || name.startsWith(`${key}/`)))) return false
    return parsed.github ? source.repo === repo : recorded.has(name) && name.startsWith(`${repo}/`)
  })
}

export function closeDocumentNames(repo: string, entry: OpenRepo, docs: string[], registered: ReadonlySet<string> = new Set()): string[] {
  return [repo, ...migrationSources(repo, entry, docs, registered)]
}

/** Discard invalid registry keys and strip poisoned source lists before any migration can resume. */
export function safeRoomRegistry(all: Record<string, OpenRepo>, log: (line: string) => void = console.log): Record<string, OpenRepo> {
  const valid = new Set(Object.keys(all).filter(key => !!parseRoomName(key, true)))
  const out: Record<string, OpenRepo> = {}
  for (const [key, value] of Object.entries(all)) {
    if (!valid.has(key)) { log(`quarantined invalid room registry key: ${JSON.stringify(key)}`); continue }
    const owned = migrationSources(parseRoomName(key, true)!.repo, value, [], valid)
    const keep = new Set(owned)
    out[key] = { ...value, branches: (value.branches ?? []).filter(s => keep.has(s)),
      legacy: (value.legacy ?? []).filter(s => keep.has(s)),
      ...(value.plan ? { plan: { ...value.plan, sources: value.plan.sources.filter(s => keep.has(s)),
        ...(value.plan.moved && archiveOwnerOf(value.plan.moved) !== parseRoomName(key, true)!.repo ? { moved: undefined } : {}) } } : {}) }
  }
  return out
}

export interface MigrationIO {
  list(): Promise<string[]>
  load(name: string): Promise<Y.Doc>
  /** Measure raw storage before decoding, with early exit above limit. */
  stored(name: string, limit: number): Promise<StoredSize>
  copyRaw(from: string, to: string): Promise<void>
  /** A live Y.Doc belongs to the websocket server; only temporary loads are destroyed. */
  release?(name: string, doc: Y.Doc): void
  write(name: string, update: Uint8Array): Promise<unknown>
  clear(name: string): Promise<void>
  /** Close old sockets, then await pending persistence writes before reading a source. */
  freeze(names: string[]): Promise<void>
  revoke(names: string[]): Promise<void>
  save(): Promise<void>
  now?: () => number
  maxTargetBytes?: number
  maxSources?: number
  maxReadBytes?: number
  maxRecords?: number
  /** The newest `limit` audit entries (more than `limit - 1` means trimmed); rejects past `maxBytes` of stored audit. */
  audit?(limit: number, maxBytes: number): Promise<AuditEntry[]>
  maxAuditEntries?: number
  onBuild?: () => void
}

/**
 * The principals each repeated (source room, name) candidate joined as, keyed `<room>\0<name>`, or
 * undefined without a complete audit. 0.16 documents hold names only (its document identity guard
 * ran in observe mode), so the audit's `join` events are the only record tying a name in a room to
 * a login: a candidate's principals are the writers who joined that room under a login owning the name.
 */
async function auditedPrincipals(io: MigrationIO, repo: string, candidates: Map<string, Set<string>>): Promise<Map<string, Set<string>> | undefined> {
  if (!io.audit || !candidates.size) return undefined
  const max = io.maxAuditEntries ?? MIGRATION_AUDIT_MAX_ENTRIES
  let entries: AuditEntry[]
  try { entries = await io.audit(max + 1, MIGRATION_AUDIT_MAX_BYTES) } catch { return undefined }
  if (!Array.isArray(entries) || entries.length > max) return undefined
  const rooms = new Map<string, Set<string>>()
  for (const [person, sources] of candidates) for (const source of sources) {
    const room = source.startsWith('archive:') ? repo : source
    let people = rooms.get(room)
    if (!people) { people = new Set(); rooms.set(room, people) }
    people.add(person)
  }
  const found = new Map<string, Set<string>>()
  for (const e of entries) {
    if (e?.event !== 'join' || e.readOnly || typeof e.room !== 'string' || typeof e.login !== 'string' || !e.login) continue
    const principal = typeof e.id === 'string' && e.id ? e.id : typeof e.provider === 'string' && e.provider ? `${e.provider}:${e.login}` : undefined
    if (!principal) continue
    for (const person of rooms.get(e.room) ?? []) {
      if (!ownsName(person, e.login)) continue
      const key = `${e.room}\0${person}`
      let set = found.get(key)
      if (!set) { set = new Set(); found.set(key, set) }
      set.add(principal)
    }
  }
  return found
}

/** An existing canonical key cannot be treated as absent after a failed inspection. */
export class MigrationReadFailure extends Error {
  constructor() { super('room migration could not read the existing room within ROOM_MIGRATION_MAX_READ_MB; raise it and retry') }
}

const nextTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** The caller holds repoLock. A persisted plan makes every replay use the same sources and archive key. */
export async function migrateRepo(repo: string, entry: OpenRepo, io: MigrationIO, registered: ReadonlySet<string> = new Set()): Promise<void> {
  if (entry.migratedAt) return
  const maxReadBytes = io.maxReadBytes ?? Number(process.env.ROOM_MIGRATION_MAX_READ_MB ?? 128) * 1048576
  const maxRecords = io.maxRecords ?? Number(process.env.ROOM_MIGRATION_MAX_RECORDS ?? 100_000)
  let workBytes = 0, workRecords = 0
  const release = (name: string, doc: Y.Doc) => io.release ? io.release(name, doc) : doc.destroy()
  const checkedLoad = async (name: string): Promise<Y.Doc | undefined> => {
    const limit = Math.min(LOAD_MAX_BYTES, maxReadBytes - workBytes)
    if (limit <= 0) return undefined
    const known = await io.stored(name, limit)
    if (known.over || !Number.isFinite(known.bytes) || known.bytes < 0 || known.bytes > limit) return undefined
    workBytes += known.bytes
    return io.load(name)
  }
  const requiredCanonical = async (): Promise<Y.Doc> => {
    try {
      const doc = await checkedLoad(repo)
      if (!doc) throw new MigrationReadFailure()
      return doc
    } catch { throw new MigrationReadFailure() }
  }
  const allNames = [...new Set([...entry.branches, ...entry.legacy ?? [], ...entry.plan?.sources ?? [], ...await io.list()])]
  const quarantined = new Map((entry.quarantined ?? []).map(item => [item.name, item]))
  for (const name of allNames) {
    const found = classifyDoc(name, { [repo]: entry })
    if (found.repo !== repo) continue
    if (found.kind !== 'never-served' && found.kind !== 'served' && found.kind !== 'canonical' && found.kind !== 'archive') continue
    let size: StoredSize
    try { size = await io.stored(name, LOAD_MAX_BYTES) }
    catch { throw new MigrationReadFailure() }
    if (found.kind !== 'never-served' && !size.over) continue
    const reason = found.kind === 'never-served' ? found.reason! : size.reason ?? 'over the per-document load budget: kept as an archive without loading'
    const item = { name, bytes: size.bytes, over: size.over, reason }
    if (!quarantined.has(name)) console.log(`migration quarantine: ${repo} ${JSON.stringify(name)} ${size.over ? '>' : ''}${size.bytes}bytes ${reason}`)
    quarantined.set(name, item)
  }
  const publishQuarantine = () => { if (quarantined.size) entry.quarantined = [...quarantined.values()] }
  const canonicalOversized = async () => (await io.stored(repo, LOAD_MAX_BYTES)).over
  const save = () => io.save()
  if (!entry.plan) {
    const names = new Set([...entry.branches, ...(entry.legacy ?? []), ...await io.list()])
    workRecords += names.size
    const sources = migrationSources(repo, entry, [...names], registered)
    const oversized = names.has(repo) && await canonicalOversized()
    const canonicalDoc = names.has(repo) && !oversized ? await requiredCanonical() : undefined
    const moved = oversized || canonicalDoc && new RoomDoc(canonicalDoc).meta.schemaVersion !== 2
      ? `archive:${repo}:${crypto.randomUUID()}` : undefined
    if (canonicalDoc) release(repo, canonicalDoc)
    if (moved) sources.push(moved)
    publishQuarantine()
    entry.plan = { id: moved?.split(':').at(-1) ?? crypto.randomUUID(), sources: [...new Set(sources)], ...(moved ? { moved } : {}) }
    entry.legacy = [...entry.plan.sources]
    entry.mode = 'repo'; entry.step = 'planned'
    await save()
  }
  const plan = entry.plan
  publishQuarantine()
  plan.sources = migrationSources(repo, entry, plan.sources, registered)
  entry.legacy = migrationSources(repo, entry, entry.legacy ?? [], registered)
  if (plan.moved && archiveOwnerOf(plan.moved) !== repo) plan.moved = undefined
  // e274970 could persist a plan without a move after rejecting an oversized canonical read.
  // Inspect before advancing any step; reset to a replayable move when that old key is legacy.
  if (!plan.moved && (await io.list()).includes(repo)) {
    let legacy = await canonicalOversized()
    if (!legacy) {
      const canonicalDoc = await requiredCanonical()
      try { legacy = new RoomDoc(canonicalDoc).meta.schemaVersion !== 2 }
      finally { release(repo, canonicalDoc) }
    }
    if (legacy) {
      const moved = `archive:${repo}:${plan.id}`
      plan.moved = archiveOwnerOf(moved) === repo ? moved : `archive:${repo}:${crypto.randomUUID()}`
      plan.sources = [...new Set([...plan.sources, plan.moved])]
      entry.legacy = [...plan.sources]
      entry.mode = 'repo'; entry.step = 'planned'
      await save()
    }
  }
  if (entry.step === 'planned') {
    await io.freeze([...plan.sources, repo])
    await io.revoke([...plan.sources, repo])
    entry.step = 'frozen'; await save()
  }
  if (entry.step === 'frozen') {
    if (plan.moved) {
      const archived = await io.list()
      workRecords += archived.length
      if (!archived.includes(plan.moved)) {
        if (await canonicalOversized()) await io.copyRaw(repo, plan.moved)
        else {
          const source = await requiredCanonical()
          try { await io.write(plan.moved, Y.encodeStateAsUpdate(source)) }
          finally { release(repo, source) }
        }
      }
      await io.clear(repo)
    }
    entry.step = 'moved'; await save()
  }
  if (entry.step === 'moved') {
    const maxTargetBytes = io.maxTargetBytes ?? Number(process.env.ROOM_DOC_MAX_MB ?? 64) * 1048576
    const maxSources = io.maxSources ?? Number(process.env.ROOM_MIGRATION_MAX_SOURCES ?? 1000)
    const candidates = plan.sources.slice(0, maxSources)
    let skippedSources = plan.sources.length - candidates.length, skippedRecords = 0
    let unknownCounts = skippedSources
    // A cleared/absent canonical needs no iterator: seeking its old SSTs could read the huge archive.
    const base = (await io.list()).includes(repo) ? await checkedLoad(repo) : new Y.Doc()
    if (!base) throw new Error('migration canonical source exceeds read budget')
    const baseUpdate = Y.encodeStateAsUpdate(base)
    release(repo, base)
    type Records = { name: string; bytes: number; scopes: [string, Scope][]; claims: Claim[]; messages: Msg[]; identities: Set<string> }
    const sources: Records[] = []
    const valid = (value: unknown, fields: string[]): boolean => {
      if (!value || typeof value !== 'object' || fields.some(f => typeof (value as Record<string, unknown>)[f] !== 'string')) return false
      try { return Buffer.byteLength(JSON.stringify(value)) <= MIGRATION_MAX_RECORD_BYTES } catch { return false }
    }
    for (const [index, name] of candidates.entries()) {
      if (workBytes >= maxReadBytes || workRecords >= maxRecords) { skippedSources += candidates.length - index; unknownCounts += candidates.length - index; break }
      await nextTurn()
      const loaded = await checkedLoad(name)
      if (!loaded) { skippedSources++; unknownCounts++; continue }
      const source = new RoomDoc(loaded)
      const bytes = Y.encodeStateAsUpdate(source.doc).byteLength
      const allMessages = [...source.bus.toArray(), ...source.mail.values()]
      const identities = new Set<string>()
      const mark = (value: unknown) => { if (typeof value === 'string' && value) identities.add(value) }
      for (const key of source.scopes.keys()) mark(key)
      for (const claim of source.claims.values()) mark(claim.by)
      for (const key of source.overlays.keys()) mark(key)
      for (const key of source.legacyDeleted.keys()) mark(key)
      for (const msg of allMessages) { mark(msg.from); mark(msg.to) }
      const scopes = [...source.scopes].filter(([person, value]) => valid(value, ['by', 'byKind', 'area', 'summary']) &&
        typeof person === 'string' && Array.isArray(value.paths) && value.paths.every(path => typeof path === 'string') && Number.isFinite(value.at)) as [string, Scope][]
      const claims = [...source.claims.values()].filter(value => valid(value, ['id', 'by', 'byKind', 'path', 'intent']) &&
        Number.isSafeInteger(value.from) && Number.isSafeInteger(value.to) && value.to >= value.from && Number.isFinite(value.at)) as Claim[]
      const messages = allMessages.filter(value => valid(value, ['id', 'from', 'fromKind', 'type', 'priority']) &&
        Number.isFinite(value.at) && (value.to === undefined || typeof value.to === 'string') &&
        !(value.to && source.seen(value.to).has(value.id))) as Msg[]
      const count = source.scopes.size + source.claims.size + source.bus.length + source.mail.size
      workRecords += count + source.overlays.size + source.legacyDeleted.size
      skippedRecords += count - scopes.length - claims.length - messages.length
      release(name, source.doc)
      if (workRecords > maxRecords) { skippedSources += candidates.length - index; skippedRecords += scopes.length + claims.length + messages.length; unknownCounts += candidates.length - index - 1; break }
      sources.push({ name, bytes, scopes, claims, messages, identities })
    }
    const occurrences = new Map<string, Set<string>>()
    // Evidence from read sources survives output pruning. Unread sources have no safe identity list.
    for (const source of sources) for (const person of source.identities) {
      let found = occurrences.get(person)
      if (!found) { found = new Set(); occurrences.set(person, found) }
      found.add(source.name)
      workRecords++
    }
    // A name used on several branches by one audited principal is that person under the same 0.17 name
    // (the hub admits a login only to `login` and `login+label`); different or unknown principals keep placeholders.
    const repeated = new Map([...occurrences].filter(([, found]) => found.size > 1))
    const principals = await auditedPrincipals(io, repo, repeated)
    const resolved = new Set<string>()
    if (principals) for (const [person, found] of repeated) {
      const each = [...found].map(name => principals.get(`${name.startsWith('archive:') ? repo : name}\0${person}`))
      const first = each[0]?.size === 1 ? [...each[0]][0] : undefined
      if (first && each.every(set => set?.size === 1 && set.has(first))) resolved.add(person)
    }
    const isAmbiguous = (person: string) => (occurrences.get(person)?.size ?? 0) > 1 && !resolved.has(person)
    const recordCost = (included: Records[]) => included.reduce((n, source) => n + source.scopes.length + source.claims.length + source.messages.length + source.identities.size, 0)
    const makeTarget = (included: Records[]) => {
      io.onBuild?.()
      workRecords += recordCost(included)
      const baseDoc = new Y.Doc(); Y.applyUpdate(baseDoc, baseUpdate)
      const target = new RoomDoc(baseDoc)
      const translated = (person: string, name: string) => isAmbiguous(person)
        ? `?${crypto.createHash('sha256').update(`${name}\0${person}`).digest('hex').slice(0, 16)}` : person
      const groups = new Map<string, { placeholder: string; claims: Claim[]; scope?: Scope; ids: Set<string> }>()
      const includedNames = new Set(included.map(source => source.name))
      for (const [person, found] of occurrences) if (isAmbiguous(person)) for (const name of found) if (includedNames.has(name)) groups.set(`${name}\0${person}`, { placeholder: translated(person, name), claims: [], ids: new Set() })
      for (const source of included) {
        const name = source.name
        for (const [person, scope] of source.scopes) {
          const by = translated(person, name), copy = { ...scope, by, origin: name }
          const group = groups.get(`${name}\0${person}`)
          if (group) group.scope ??= copy
          else if (!target.scopes.has(by)) target.scopes.set(by, copy)
        }
        for (const claim of source.claims) {
          const by = translated(claim.by, name)
          const { anchor: _anchor, ...rest } = claim
          const copy = { ...rest, by, origin: name }
          const group = groups.get(`${name}\0${claim.by}`)
          if (group) { if (!group.ids.has(claim.id)) { group.ids.add(claim.id); group.claims.push(copy) } }
          else if (!target.claims.has(claim.id)) target.claims.set(claim.id, copy)
        }
        for (const msg of source.messages) {
          if (!msg.to || target.mail.has(msg.id)) continue
          target.mail.set(msg.id, { ...msg, from: translated(msg.from, name), to: translated(msg.to, name) } as Msg)
        }
      }
      const unresolved = target.doc.getMap<{ placeholder: string; claims: Claim[]; scope?: Scope }>('unresolved')
      for (const [key, group] of groups) unresolved.set(key, { placeholder: group.placeholder, claims: group.claims, ...(group.scope ? { scope: group.scope } : {}) })
      target.metaMap.set('schemaVersion', 2)
      return { target, unresolved: unresolved.size, update: Y.encodeStateAsUpdate(target.doc) }
    }
    let estimated = baseUpdate.byteLength
    let included = sources.filter(source => { estimated += source.bytes * 2; return estimated <= maxTargetBytes * 0.9 })
    while (included.length && workRecords + recordCost(included) > maxRecords) included = included.slice(0, Math.floor(included.length / 2))
    skippedSources += sources.length - included.length
    skippedRecords += sources.filter(source => !included.includes(source)).reduce((n, source) => n + source.scopes.length + source.claims.length + source.messages.length, 0)
    await nextTurn()
    let result = makeTarget(included)
    for (let pass = 0; result.update.byteLength > maxTargetBytes && included.length && pass < MIGRATION_MAX_REBUILDS; pass++) {
      result.target.doc.destroy()
      const kept = included.slice(0, Math.floor(included.length / 2))
      const dropped = included.slice(kept.length)
      skippedSources += dropped.length
      skippedRecords += dropped.reduce((n, source) => n + source.scopes.length + source.claims.length + source.messages.length, 0)
      included = kept
      if (workRecords + recordCost(included) > maxRecords) {
        skippedSources += included.length
        skippedRecords += included.reduce((n, source) => n + source.scopes.length + source.claims.length + source.messages.length, 0)
        included = []
      }
      await nextTurn()
      result = makeTarget(included)
    }
    if (result.update.byteLength > maxTargetBytes && included.length) {
      result.target.doc.destroy()
      skippedSources += included.length
      skippedRecords += included.reduce((n, source) => n + source.scopes.length + source.claims.length + source.messages.length, 0)
      await nextTurn()
      result = makeTarget([])
    }
    if (result.update.byteLength > maxTargetBytes) { result.target.doc.destroy(); throw new Error('canonical document exceeds migration target cap') }
    await io.write(repo, result.update)
    result.target.doc.destroy()
    entry.unresolved = result.unresolved
    entry.migrationSkippedSources = skippedSources
    entry.migrationSkippedRecords = skippedRecords
    entry.migrationSkippedRecordCountsUnknown = unknownCounts
    entry.step = 'written'; await save()
  }
  if (entry.step === 'written') {
    entry.migratedAt = (io.now ?? Date.now)()
    await save()
  }
}
