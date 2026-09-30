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
  it('stops reading after the byte budget and counts untouched archives', async () => {
    const f = fixture()
    for (let i = 0; i < 100; i++) {
      const name = `${repo}/extra-${i}`
      const room = new RoomDoc(); room.scopes.set(`p${i}`, { by: `p${i}`, byKind: 'agent', area: 'a', summary: 'x'.repeat(1000), paths: ['a'], at: 1 })
      f.docs.set(name, Y.encodeStateAsUpdate(room.doc))
    }
    const loaded: string[] = [], load = f.io.load
    f.io.load = async name => { loaded.push(name); return load(name) }
    f.io.maxReadBytes = 100
    await migrateRepo(repo, f.entry, f.io)
    expect(loaded.length).toBeLessThan(5)
    expect(f.entry.migrationSkippedSources).toBeGreaterThan(90)
    expect(f.entry.migrationSkippedRecordCountsUnknown).toBeGreaterThan(90)
  })
  it('bounds actual encoded target growth and records dropped sources', async () => {
    const f = fixture()
    f.io.maxTargetBytes = 1000
    await migrateRepo(repo, f.entry, f.io)
    expect(f.docs.get(repo)!.byteLength).toBeLessThanOrEqual(1000)
    expect(f.entry.migrationSkippedSources).toBeGreaterThanOrEqual(0)
  })
  it('builds thousands of ambiguous claims without copying each previous group', async () => {
    const f = fixture()
    const room = new RoomDoc()
    room.scopes.set('ben', { by: 'ben', byKind: 'agent', area: 'a', summary: 'a', paths: ['a'], at: 1 })
    for (let i = 0; i < 3000; i++) room.claims.set(`claim-${i}`, { id: `claim-${i}`, by: 'ben', byKind: 'agent', path: 'a', from: i, to: i + 1, intent: 'edit', at: 1 })
    f.docs.set(two, Y.encodeStateAsUpdate(room.doc))
    const start = performance.now()
    await migrateRepo(repo, f.entry, f.io)
    expect(performance.now() - start).toBeLessThan(10000)
    expect(f.entry.unresolved).toBeGreaterThan(0)
  })
  it('uses overlay, deletion and receipted-message evidence even when their source is pruned', async () => {
    for (const evidence of ['overlay', 'deletion', 'receipt'] as const) {
      const f = fixture()
      const other = new RoomDoc()
      if (evidence === 'overlay') other.overlays.set('cy', new Y.Map())
      if (evidence === 'deletion') other.legacyDeleted.set('cy', new Y.Map())
      if (evidence === 'receipt') { other.mail.set('old', { id: 'old', type: 'question', from: 'cy', to: 'cy', fromKind: 'agent', priority: 'notify', at: 1, text: 'old' } as Msg); other.seen('cy').set('old', 1) }
      f.docs.set(two, Y.encodeStateAsUpdate(other.doc))
      f.io.maxTargetBytes = Math.ceil((f.docs.get(one)!.byteLength * 2 + 10) / 0.9) // first fits estimate; second does not
      await migrateRepo(repo, f.entry, f.io)
      const target = new RoomDoc(await f.io.load(repo))
      expect(target.mail.get('q1')?.to).toMatch(/^\?/) // different cy in source two
      expect(f.entry.unresolved).toBeGreaterThan(0)
      expect(f.entry.migrationSkippedSources).toBeGreaterThan(0)
    }
  })
  it('skips known oversized sources without loading and yields between many sources', async () => {
    const f = fixture()
    const loaded: string[] = []
    const load = f.io.load
    f.io.size = async name => name === two ? 10_000 : f.docs.get(name)?.byteLength
    f.io.load = async name => { loaded.push(name); return load(name) }
    f.io.maxReadBytes = 1000
    let timerFired = false
    setTimeout(() => { timerFired = true }, 0)
    await migrateRepo(repo, f.entry, f.io)
    expect(loaded).not.toContain(two)
    expect(timerFired).toBe(true)
  })
  it('bounds rebuilds when many translations overflow the target', async () => {
    const f = fixture()
    for (let i = 0; i < 80; i++) {
      const room = new RoomDoc()
      room.scopes.set('ben', { by: 'ben', byKind: 'agent', area: 'a', summary: 'x'.repeat(200), paths: ['a'], at: 1 })
      f.docs.set(`${repo}/bulk-${i}`, Y.encodeStateAsUpdate(room.doc))
    }
    let builds = 0, reads = 0, yielded = false
    f.io.onBuild = () => { builds++ }
    f.io.size = async name => f.docs.get(name)?.byteLength
    const load = f.io.load
    f.io.load = async name => { reads += f.docs.get(name)?.byteLength ?? 0; return load(name) }
    f.io.maxReadBytes = 20_000
    f.io.maxTargetBytes = 2_000
    setTimeout(() => { yielded = true }, 0)
    await migrateRepo(repo, f.entry, f.io)
    expect(builds).toBeLessThanOrEqual(6) // initial, four rebuilds, empty fallback
    expect(reads).toBeLessThanOrEqual(20_000)
    expect(yielded).toBe(true)
    expect(f.docs.get(repo)!.byteLength).toBeLessThanOrEqual(2_000)
  })
  it('skips malformed and oversized records before translation', async () => {
    const f = fixture()
    const doc = new RoomDoc()
    doc.scopes.set('bad', { by: 1, summary: 'bad' } as never)
    doc.scopes.set('large', { by: 'large', byKind: 'agent', area: 'a', summary: 'x'.repeat(70_000), paths: ['a'], at: 1 })
    f.docs.set(two, Y.encodeStateAsUpdate(doc.doc))
    await migrateRepo(repo, f.entry, f.io)
    const target = new RoomDoc(await f.io.load(repo))
    expect(target.scopes.has('bad')).toBe(false)
    expect(target.scopes.has('large')).toBe(false)
    expect(f.entry.migrationSkippedRecords).toBeGreaterThanOrEqual(2)
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

function canonicalFixture() {
  const f = fixture()
  // Two unrelated old participants named cy, one under the canonical key.
  f.docs.set(repo, f.docs.get(one)!)
  f.docs.delete(one)
  f.docs.delete(two)
  const other = new RoomDoc()
  other.scopes.set('cy', { by: 'cy', byKind: 'agent', area: 'other', summary: 'other cy', paths: ['other.ts'], at: 1 })
  f.docs.set(two, Y.encodeStateAsUpdate(other.doc)); other.doc.destroy()
  f.entry.branches = [two]
  return f
}

it.each(['known-size', 'measured-size', 'load-error', 'size-error'])('canonical inspection %s failure persists nothing; larger-budget retry archives and translates identities', async failure => {
  const f = canonicalFixture(), before = structuredClone(f.entry), saved: OpenRepo[] = []
  const save = f.io.save, load = f.io.load
  f.io.save = async () => { saved.push(structuredClone(f.entry)); await save() }
  f.io.maxReadBytes = failure.includes('size') ? 10 : 100_000
  if (failure === 'known-size') f.io.size = async name => f.docs.get(name)?.byteLength
  if (failure === 'size-error') f.io.size = async () => { throw Error('size unavailable') }
  if (failure === 'load-error') f.io.load = async name => { if (name === repo) throw Error('unreadable'); return load(name) }
  await expect(migrateRepo(repo, f.entry, f.io)).rejects.toThrow('room migration could not read the existing room within ROOM_MIGRATION_MAX_READ_MB; raise it and retry')
  expect(saved).toEqual([])
  expect(f.entry).toEqual(before)
  expect([...f.docs.keys()]).toEqual([repo, two])
  f.io.maxReadBytes = 100_000; f.io.load = load; f.io.size = undefined
  await migrateRepo(repo, f.entry, f.io)
  const moved = f.entry.plan!.moved!
  expect(f.docs.has(moved)).toBe(true)
  expect(f.entry.unresolved).toBe(2)
  const target = new RoomDoc(await f.io.load(repo))
  expect(target.mail.get('q1')?.to).toMatch(/^\?/)
  expect(target.meta.schemaVersion).toBe(2)
  target.doc.destroy()
})

it.each(['planned', 'frozen', 'moved', 'written'])('repairs an incomplete saved plan at %s before reusing a legacy canonical document', async step => {
  const f = canonicalFixture()
  f.entry.plan = { id: '123e4567-e89b-12d3-a456-426614174000', sources: [two] }
  f.entry.mode = 'repo'; f.entry.step = step as OpenRepo['step']; f.entry.legacy = [two]
  await migrateRepo(repo, f.entry, f.io)
  expect(f.entry.plan.moved).toBe(`archive:${repo}:123e4567-e89b-12d3-a456-426614174000`)
  expect(f.docs.has(f.entry.plan.moved!)).toBe(true)
  expect(f.entry.unresolved).toBe(2)
  const target = new RoomDoc(await f.io.load(repo))
  expect(target.mail.get('q1')?.to).toMatch(/^\?/)
  target.doc.destroy()
})

it('cannot advance the mandatory canonical archive move when its budget is insufficient', async () => {
  const f = canonicalFixture()
  f.entry.plan = { id: '123e4567-e89b-12d3-a456-426614174000', sources: [two], moved: `archive:${repo}:123e4567-e89b-12d3-a456-426614174000` }
  f.entry.legacy = [two, f.entry.plan.moved!]; f.entry.step = 'frozen'; f.entry.mode = 'repo'
  f.io.maxReadBytes = 10
  await expect(migrateRepo(repo, f.entry, f.io)).rejects.toThrow(/could not read the existing room/)
  expect(f.entry.step).toBe('frozen')
  expect(f.docs.has(repo)).toBe(true)
  expect(f.docs.has(f.entry.plan.moved!)).toBe(false)
  f.io.maxReadBytes = 100_000
  await migrateRepo(repo, f.entry, f.io)
  expect(f.docs.has(f.entry.plan.moved!)).toBe(true)
  expect(f.entry.unresolved).toBe(2)
})
