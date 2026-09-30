import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, type Msg } from '@room/shared'
import { migrateRepo, migrationSources, closeDocumentNames, safeRoomRegistry, type MigrationIO } from '../src/migrate.js'
import type { OpenRepo } from '../src/store.js'

const repo = 'github.com/o/r'
const one = `${repo}/main`, two = `${repo}/feature`
function fixture(failAfter?: string) {
  const docs = new Map<string, Uint8Array>()
  const put = (name: string, make: (room: RoomDoc) => void) => {
    const room = new RoomDoc(); make(room); docs.set(name, Y.encodeStateAsUpdate(room.doc))
  }
  const scope = (by: string) => ({ by, byKind: 'agent' as const, area: 'server', summary: by, paths: ['a.ts'], at: 1 })
  const note = (id: string, from: string, to: string): Msg => ({ id, type: 'question', from, to, fromKind: 'agent', priority: 'notify', at: 1, text: id } as Msg)
  put(one, r => {
    r.scopes.set('ben', scope('ben')); r.scopes.set('cy', scope('cy'))
    r.claims.set('c1', { id: 'c1', path: 'a.ts', from: 2, to: 3, by: 'ben', byKind: 'agent', intent: 'edit', at: 1, claimedHash: 'hash' })
    r.bus.push([note('q1', 'ben', 'cy')])
  })
  put(two, r => { r.scopes.set('ben', scope('ben')); r.bus.push([note('q2', 'ben', 'ben')]) })
  let saved: OpenRepo = { at: 1, branches: [one, two] }
  let crashed = false
  const io: MigrationIO = {
    list: async () => [...docs.keys()],
    load: async name => { const doc = new Y.Doc(); const update = docs.get(name); if (update) Y.applyUpdate(doc, update); return doc },
    write: async (name, update) => { const before = docs.get(name); docs.set(name, before ? Y.mergeUpdates([before, update]) : update) },
    clear: async name => { docs.delete(name) },
    freeze: async () => {}, revoke: async () => {},
    save: async () => { saved = structuredClone(entry); if (saved.step === failAfter && !crashed) { crashed = true; throw Error('crash') } },
    now: () => 100,
  }
  let entry: OpenRepo = structuredClone(saved)
  return { docs, io, get entry() { return entry }, restart() { entry = structuredClone(saved) } }
}

describe('migrateRepo', () => {
  it('loads sources sequentially and leaves capped sources in exportable archives', async () => {
    const f = fixture()
    let active = 0, peak = 0
    const load = f.io.load
    f.io.load = async name => { active++; peak = Math.max(peak, active); try { return await load(name) } finally { active-- } }
    f.io.maxSources = 1
    await migrateRepo(repo, f.entry, f.io)
    expect(peak).toBe(1)
    expect(f.entry.migrationSkippedSources).toBeGreaterThan(0)
    expect(f.docs.has(two)).toBe(true)
  })
  it('cannot absorb another GitHub repository through an open prefix', async () => {
    const f = fixture()
    const victim = 'github.com/o/r2/private'
    const hostile = new RoomDoc(); hostile.scopes.set('victim', { by: 'victim', byKind: 'agent', area: 'private', summary: 'secret', paths: ['secret.ts'], at: 1 })
    f.docs.set(victim, Y.encodeStateAsUpdate(hostile.doc))
    await migrateRepo(repo, f.entry, f.io)
    expect(f.entry.legacy).not.toContain(victim)
    expect(new RoomDoc(await f.io.load(repo)).scopes.has('victim')).toBe(false)
    expect(f.docs.has(victim)).toBe(true)
    expect(closeDocumentNames(repo, f.entry, [...f.docs.keys()], new Set([repo, 'github.com/o/r2']))).not.toContain(victim)
  })

  it('migrates only recorded non-GitHub branch documents, excluding other registry entries', () => {
    const key = 'git/host/a/repo'
    const entry: OpenRepo = { at: 1, branches: [`${key}/main`, 'git/host/a-b/repo/main', 'git/host/ab/repo', 'git/host/a/repo2'] }
    const docs = [...entry.branches, `${key}/unrecorded`]
    expect(migrationSources(key, entry, docs, new Set([key, 'git/host/ab/repo']))).toEqual([`${key}/main`])
    const short = 'git/host/a'
    const shortEntry: OpenRepo = { at: 1, branches: [`${short}/main`, `${short}/b/main`, 'git/host/a-b/main', 'git/host/ab'] }
    const registered = new Set([short, `${short}/b`, 'git/host/ab'])
    expect(migrationSources(short, shortEntry, [...shortEntry.branches, `${short}/unrecorded`], registered)).toEqual([`${short}/main`])
    expect(closeDocumentNames(short, shortEntry, [...shortEntry.branches, 'git/host/a-b/private'], registered)).toEqual([short, `${short}/main`])
    expect(migrationSources('local/a', { at: 1, branches: ['local/a/b/main'] }, ['local/a/b/main'], new Set(['local/a', 'local/a/b']))).toEqual([])
  })

  it('quarantines poisoned registry roots and filters cross-repository sources and plans', () => {
    const poisoned = 'github.com'
    const victim = 'github.com/victim/private'
    const log: string[] = []
    const safe = safeRoomRegistry({
      [poisoned]: { at: 1, branches: [victim], legacy: [victim] },
      'github.com/victim': { at: 1, branches: [victim], legacy: [victim] },
      [victim]: { at: 2, branches: [`${victim}/main`, 'github.com/other/repo/main'], legacy: ['github.com/other/repo/main'],
        plan: { id: 'x', sources: [`${victim}/main`, 'github.com/other/repo/main'], moved: 'archive:github.com/other/repo:123e4567-e89b-12d3-a456-426614174000' } },
    }, line => log.push(line))
    expect(safe[poisoned]).toBeUndefined()
    expect(safe['github.com/victim']).toBeUndefined()
    expect(log[0]).toContain('quarantined invalid room registry key')
    expect(safe[victim].legacy).toEqual([])
    expect(safe[victim].plan).toMatchObject({ sources: [`${victim}/main`], moved: undefined })
  })
  it('archives an old document at the canonical key and includes differently cased aliases', async () => {
    const f = fixture()
    const old = new RoomDoc(); old.scopes.set('early', { by: 'early', byKind: 'agent', area: 'old', summary: 'old', paths: ['old.ts'], at: 1 })
    f.docs.set(repo, Y.encodeStateAsUpdate(old.doc))
    f.docs.set('github.com/O/R', Y.encodeStateAsUpdate(old.doc))
    await migrateRepo(repo, f.entry, f.io)
    expect(f.entry.plan?.moved).toMatch(/^archive:github\.com\/o\/r:/)
    expect(f.entry.legacy).toContain(f.entry.plan?.moved)
    expect(f.entry.legacy).not.toContain(repo)
    expect(f.docs.has(f.entry.plan!.moved!)).toBe(true)
    expect(new RoomDoc(await f.io.load(repo)).meta.schemaVersion).toBe(2)
  })

  it.each(['planned', 'frozen', 'moved', 'written'])('resumes after a crash at %s without duplicating owed mail', async step => {
    const f = fixture(step)
    await expect(migrateRepo(repo, f.entry, f.io)).rejects.toThrow('crash')
    f.restart()
    await migrateRepo(repo, f.entry, f.io)
    await migrateRepo(repo, f.entry, f.io)
    expect(f.entry).toMatchObject({ mode: 'repo', migratedAt: 100, unresolved: 2 })
    const target = new RoomDoc(await f.io.load(repo))
    expect(target.meta.schemaVersion).toBe(2)
    expect(target.mail.size).toBe(2)
    expect(target.scopes.get('cy')?.by).toBe('cy')
    expect(target.claims.has('c1')).toBe(false)
    const unresolved = target.doc.getMap<{ placeholder: string; claims: { id: string; origin: string }[]; scope?: { by: string; summary: string } }>('unresolved')
    expect(unresolved.get(`${one}\0ben`)?.claims[0]).toMatchObject({ id: 'c1', origin: one })
    expect(unresolved.get(`${one}\0ben`)?.scope).toMatchObject({ by: unresolved.get(`${one}\0ben`)?.placeholder, summary: 'ben' })
    expect(unresolved.get(`${two}\0ben`)?.scope).toMatchObject({ by: unresolved.get(`${two}\0ben`)?.placeholder, summary: 'ben' })
    expect(target.mail.get('q1')).toMatchObject({ from: unresolved.get(`${one}\0ben`)?.placeholder, to: 'cy' })
    expect(target.mail.get('q2')?.to).toBe(unresolved.get(`${two}\0ben`)?.placeholder)
    expect(f.docs.has(one)).toBe(true)
    expect(f.docs.has(two)).toBe(true)
  })
})
