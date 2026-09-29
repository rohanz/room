import crypto from 'node:crypto'
import * as Y from 'yjs'
import { HUB_ORIGIN } from '@room/hub-core'
import { RoomDoc, type Claim, type Msg, type Scope } from '@room/shared'
import type { OpenRepo } from './store.js'
import { repoRoomOf } from './names.js'

export interface MigrationIO {
  list(): Promise<string[]>
  load(name: string): Promise<Y.Doc>
  write(name: string, update: Uint8Array): Promise<unknown>
  clear(name: string): Promise<void>
  /** Close old sockets, then await pending persistence writes before reading a source. */
  freeze(names: string[]): Promise<void>
  revoke(names: string[]): Promise<void>
  save(): Promise<void>
  now?: () => number
}

/** The caller holds repoLock. A persisted plan makes every replay use the same sources and archive key. */
export async function migrateRepo(repo: string, entry: OpenRepo, io: MigrationIO): Promise<void> {
  if (entry.migratedAt) return
  const save = () => io.save()
  if (!entry.plan) {
    const names = new Set([...entry.branches, ...(entry.legacy ?? []), ...await io.list()])
    const sources = [...names].filter(name => name !== repo && !name.startsWith('archive:') && repoRoomOf(name, p => p === repo) === repo)
    const canonicalDoc = names.has(repo) ? await io.load(repo) : undefined
    const moved = canonicalDoc && new RoomDoc(canonicalDoc).meta.schemaVersion !== 2
      ? `archive:${repo}:${crypto.randomUUID()}` : undefined
    if (moved) sources.push(moved)
    entry.plan = { id: moved?.split(':').at(-1) ?? crypto.randomUUID(), sources: [...new Set(sources)], ...(moved ? { moved } : {}) }
    entry.legacy = [...entry.plan.sources]
    entry.mode = 'repo'; entry.step = 'planned'
    await save()
  }
  const plan = entry.plan
  if (entry.step === 'planned') {
    await io.freeze([...plan.sources, repo])
    await io.revoke([...plan.sources, repo])
    entry.step = 'frozen'; await save()
  }
  if (entry.step === 'frozen') {
    if (plan.moved) {
      const archived = await io.list()
      if (!archived.includes(plan.moved)) await io.write(plan.moved, Y.encodeStateAsUpdate(await io.load(repo)))
      await io.clear(repo)
    }
    entry.step = 'moved'; await save()
  }
  if (entry.step === 'moved') {
    const sources = await Promise.all(plan.sources.map(async name => ({ name, room: new RoomDoc(await io.load(name)) })))
    const target = new RoomDoc(await io.load(repo))
    const occurrences = new Map<string, Set<string>>()
    const mark = (name: string | undefined, source: string) => {
      if (!name) return
      let found = occurrences.get(name); if (!found) { found = new Set(); occurrences.set(name, found) }
      found.add(source)
    }
    for (const { name, room } of sources) {
      for (const person of room.scopes.keys()) mark(person, name)
      for (const claim of room.claims.values()) mark(claim.by, name)
      for (const person of room.overlays.keys()) mark(person, name)
      for (const person of room.legacyDeleted.keys()) mark(person, name)
      for (const msg of [...room.bus.toArray(), ...room.mail.values()]) { mark(msg.from, name); mark(msg.to, name) }
    }
    const translated = (name: string, source: string) => (occurrences.get(name)?.size ?? 0) > 1
      ? `?${crypto.createHash('sha256').update(`${source}\0${name}`).digest('hex').slice(0, 16)}` : name
    const unresolved = target.doc.getMap<{ placeholder: string; claims: Claim[]; scope?: Scope }>('unresolved')
    target.doc.transact(() => {
      for (const [person, found] of occurrences) if (found.size > 1) for (const source of found) {
        const key = `${source}\0${person}`
        if (!unresolved.has(key)) unresolved.set(key, { placeholder: translated(person, source), claims: [] })
      }
      for (const { name, room } of sources) {
        for (const [person, scope] of room.scopes) {
          const by = translated(person, name)
          const copy = { ...scope, by, origin: name }
          if (by !== person) {
            const key = `${name}\0${person}`
            const old = unresolved.get(key) ?? { placeholder: by, claims: [] }
            if (!old.scope) unresolved.set(key, { ...old, scope: copy })
          } else if (!target.scopes.has(by)) target.scopes.set(by, copy)
        }
        for (const claim of room.claims.values()) {
          const by = translated(claim.by, name)
          const { anchor: _anchor, ...rest } = claim
          const copy = { ...rest, by, origin: name }
          if (by !== claim.by) {
            const key = `${name}\0${claim.by}`
            const old = unresolved.get(key) ?? { placeholder: by, claims: [] }
            if (!old.claims.some(c => c.id === claim.id)) unresolved.set(key, { ...old, claims: [...old.claims, copy] })
          } else if (!target.claims.has(claim.id)) target.claims.set(claim.id, copy)
        }
        for (const msg of [...room.bus.toArray(), ...room.mail.values()]) {
          if (!msg.to || room.seen(msg.to).has(msg.id) || target.mail.has(msg.id)) continue
          target.mail.set(msg.id, { ...msg, from: translated(msg.from, name), to: translated(msg.to, name) } as Msg)
        }
      }
      target.metaMap.set('schemaVersion', 2)
    }, HUB_ORIGIN)
    await io.write(repo, Y.encodeStateAsUpdate(target.doc))
    entry.unresolved = unresolved.size
    entry.step = 'written'; await save()
  }
  if (entry.step === 'written') {
    entry.migratedAt = (io.now ?? Date.now)()
    await save()
  }
}
