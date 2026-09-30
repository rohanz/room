import crypto from 'node:crypto'
import * as Y from 'yjs'
import { RoomDoc, type Claim, type Msg, type Scope } from '@room/shared'
import type { OpenRepo } from './store.js'
import { archiveOwnerOf, parseRoomName } from './names.js'

/** A source is either recorded by the old registry or a GitHub document with the same exact repo identity. */
export function migrationSources(repo: string, entry: OpenRepo, docs: string[], registered: ReadonlySet<string> = new Set()): string[] {
  const parsed = parseRoomName(repo, true)
  if (!parsed || parsed.repo !== repo) return []
  const recorded = new Set([...entry.branches, ...(entry.legacy ?? []), ...(entry.plan?.sources ?? [])])
  return [...new Set([...recorded, ...docs])].filter(name => {
    if (name === repo || registered.has(name) && parseRoomName(name)?.repo !== repo) return false
    if (name.startsWith('archive:')) return recorded.has(name) && archiveOwnerOf(name) === repo
    const source = parseRoomName(name)
    if (!source) return false
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
  /** Stored update size, when the provider can report it without loading/encoding a document. */
  size?(name: string): Promise<number | undefined>
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
  onBuild?: () => void
}

const MAX_REBUILDS = Math.min(8, Math.max(1, Number(process.env.ROOM_MIGRATION_MAX_REBUILDS ?? 4) || 4))
const nextTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** The caller holds repoLock. A persisted plan makes every replay use the same sources and archive key. */
export async function migrateRepo(repo: string, entry: OpenRepo, io: MigrationIO, registered: ReadonlySet<string> = new Set()): Promise<void> {
  if (entry.migratedAt) return
  const maxReadBytes = io.maxReadBytes ?? Number(process.env.ROOM_MIGRATION_MAX_READ_MB ?? 128) * 1048576
  const maxRecords = io.maxRecords ?? Number(process.env.ROOM_MIGRATION_MAX_RECORDS ?? 100_000)
  let workBytes = 0, workRecords = 0
  const release = (name: string, doc: Y.Doc) => io.release ? io.release(name, doc) : doc.destroy()
  const checkedLoad = async (name: string): Promise<Y.Doc | undefined> => {
    const known = await io.size?.(name)
    if (known !== undefined && (!Number.isFinite(known) || known < 0 || workBytes + known > maxReadBytes)) return undefined
    if (workBytes >= maxReadBytes) return undefined
    const doc = await io.load(name)
    const measured = Y.encodeStateAsUpdate(doc).byteLength
    workBytes += measured
    if (workBytes > maxReadBytes) { release(name, doc); return undefined }
    return doc
  }
  const save = () => io.save()
  if (!entry.plan) {
    const names = new Set([...entry.branches, ...(entry.legacy ?? []), ...await io.list()])
    workRecords += names.size
    const sources = migrationSources(repo, entry, [...names], registered)
    const canonicalDoc = names.has(repo) ? await checkedLoad(repo) : undefined
    const moved = canonicalDoc && new RoomDoc(canonicalDoc).meta.schemaVersion !== 2
      ? `archive:${repo}:${crypto.randomUUID()}` : undefined
    if (canonicalDoc) release(repo, canonicalDoc)
    if (moved) sources.push(moved)
    entry.plan = { id: moved?.split(':').at(-1) ?? crypto.randomUUID(), sources: [...new Set(sources)], ...(moved ? { moved } : {}) }
    entry.legacy = [...entry.plan.sources]
    entry.mode = 'repo'; entry.step = 'planned'
    await save()
  }
  const plan = entry.plan
  plan.sources = migrationSources(repo, entry, plan.sources, registered)
  if (plan.moved && archiveOwnerOf(plan.moved) !== repo) plan.moved = undefined
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
        const source = await checkedLoad(repo)
        if (!source) throw new Error('migration archive source exceeds read budget')
        try { await io.write(plan.moved, Y.encodeStateAsUpdate(source)) }
        finally { release(repo, source) }
      }
      await io.clear(repo)
    }
    entry.step = 'moved'; await save()
  }
  if (entry.step === 'moved') {
    const maxTargetBytes = io.maxTargetBytes ?? Number(process.env.ROOM_DOC_MAX_MB ?? 64) * 1048576
    const maxSources = io.maxSources ?? Number(process.env.ROOM_MIGRATION_MAX_SOURCES ?? 1000)
    const maxRecordBytes = Number(process.env.ROOM_MIGRATION_MAX_RECORD_KB ?? 64) * 1024
    const candidates = plan.sources.slice(0, maxSources)
    let skippedSources = plan.sources.length - candidates.length, skippedRecords = 0
    let unknownCounts = skippedSources
    const base = await checkedLoad(repo)
    if (!base) throw new Error('migration canonical source exceeds read budget')
    const baseUpdate = Y.encodeStateAsUpdate(base)
    release(repo, base)
    type Records = { name: string; bytes: number; scopes: [string, Scope][]; claims: Claim[]; messages: Msg[]; identities: Set<string> }
    const sources: Records[] = []
    const valid = (value: unknown, fields: string[]): boolean => {
      if (!value || typeof value !== 'object' || fields.some(f => typeof (value as Record<string, unknown>)[f] !== 'string')) return false
      try { return Buffer.byteLength(JSON.stringify(value)) <= maxRecordBytes } catch { return false }
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
    const recordCost = (included: Records[]) => included.reduce((n, source) => n + source.scopes.length + source.claims.length + source.messages.length + source.identities.size, 0)
    const makeTarget = (included: Records[]) => {
      io.onBuild?.()
      workRecords += recordCost(included)
      const baseDoc = new Y.Doc(); Y.applyUpdate(baseDoc, baseUpdate)
      const target = new RoomDoc(baseDoc)
      const translated = (person: string, name: string) => (occurrences.get(person)?.size ?? 0) > 1
        ? `?${crypto.createHash('sha256').update(`${name}\0${person}`).digest('hex').slice(0, 16)}` : person
      const groups = new Map<string, { placeholder: string; claims: Claim[]; scope?: Scope; ids: Set<string> }>()
      const includedNames = new Set(included.map(source => source.name))
      for (const [person, found] of occurrences) if (found.size > 1) for (const name of found) if (includedNames.has(name)) groups.set(`${name}\0${person}`, { placeholder: translated(person, name), claims: [], ids: new Set() })
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
    for (let pass = 0; result.update.byteLength > maxTargetBytes && included.length && pass < MAX_REBUILDS; pass++) {
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
