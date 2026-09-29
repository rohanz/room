import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from './doc.js'
import { localVersionOf, manifestKey, snapshot, snapshotStillCurrent, versionOf, type ManifestHead } from './manifest.js'
import { digestPath, gitBlobHash } from './manifest-node.js'

/** Fences are hub lease epochs (hub §4.1): session s1 holds epoch 11, s2 epoch 12, winner 1, loser 2. */
const head = (fence = '11'): ManifestHead => ({ base: 'abc', fence, coverage: { kind: 'all' }, level: 'declared', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true })

describe('manifest step 1', () => {
  it('uses a stable salt and hashes excluded paths without exposing names', () => {
    const room = new RoomDoc()
    const salt = room.ensureRoomSalt()
    expect(salt).toMatch(/^[a-f0-9]{64}$/)
    expect(room.ensureRoomSalt()).toBe(salt)
    expect(digestPath(salt, 'src/./secret.txt')).toBe(digestPath(salt, 'src/secret.txt'))
    expect(digestPath(salt, 'src/secret.txt')).not.toContain('secret')
  })

  it('converges a simultaneous salt initialization after CRDT exchange', () => {
    const a = new RoomDoc(), b = new RoomDoc()
    a.ensureRoomSalt(); b.ensureRoomSalt()
    const aUpdate = Y.encodeStateAsUpdate(a.doc), bUpdate = Y.encodeStateAsUpdate(b.doc)
    Y.applyUpdate(a.doc, bUpdate); Y.applyUpdate(b.doc, aUpdate)
    expect(a.roomSalt).toBe(b.roomSalt)
  })

  it('reads only the current incarnation and rejects an entry with the wrong fence', async () => {
    const room = new RoomDoc()
    const salt = room.ensureRoomSalt()
    room.participants.set('ben\0holder', { sessionId: 'winner', epoch: 1 })
    room.participants.set('ben\0git', { base: 'abc', fence: '1' })
    room.manifestHead.set('ben', { ...head('1'), excluded: [digestPath(salt, 'secret.txt')] })
    const winning = new Y.Map<any>(), losing = new Y.Map<any>()
    room.manifest.set(manifestKey('ben', '1'), winning)
    room.manifest.set(manifestKey('ben', '2'), losing)
    winning.set('x', { change: 'M', state: 'held', held: 'scope', at: 1, fence: '1' })
    winning.set('gone', { change: 'D', state: 'shared', at: 1, fence: '1' })
    winning.set('wrong', { change: 'M', state: 'held', held: 'scope', at: 1, fence: '2' })
    losing.set('y', { change: 'M', state: 'held', held: 'scope', at: 1, fence: '2' })
    const snap = snapshot(room, 'ben', [])!
    expect((await versionOf(snap, 'x', { gitAt: async () => 'base' })).kind).toBe('held')
    expect((await versionOf(snap, 'gone', { gitAt: async () => 'base' })).kind).toBe('deleted')
    expect((await versionOf(snap, 'secret.txt', { gitAt: async () => 'base' })).kind).toBe('excluded')
    expect((await versionOf(snap, 'y', { gitAt: async () => 'base' })).kind).toBe('base')
    expect((await versionOf(snap, 'wrong', { gitAt: async () => 'base' })).kind).toBe('base')
  })

  it('never resolves a hashless held entry from a known blob', async () => {
    const room = new RoomDoc()
    room.participants.set('ben\0holder', { sessionId: 's1', epoch: 11 })
    room.participants.set('ben\0git', { base: 'abc', fence: '11' })
    room.manifestHead.set('ben', head())
    const entries = new Y.Map<any>()
    room.manifest.set(manifestKey('ben', '11'), entries)
    entries.set('x', { change: 'M', state: 'held', held: 'scope', at: 1, fence: '11' })
    expect((await versionOf(snapshot(room, 'ben', [])!, 'x', { known: async () => 'same' })).kind).toBe('held')
  })

  it('verifies shared text and reads the caller checkout at intent', async () => {
    const room = new RoomDoc()
    room.participants.set('ben\0holder', { sessionId: 's1', epoch: 11 })
    room.participants.set('ben\0git', { base: 'abc', fence: '11' })
    room.manifestHead.set('ben', head())
    const entries = new Y.Map<any>(), texts = new Y.Map<Y.Text>()
    room.manifest.set(manifestKey('ben', '11'), entries)
    room.overlays.set(manifestKey('ben', '11'), texts)
    entries.set('x', { change: 'M', state: 'shared', hash: gitBlobHash('current'), size: 7, at: 1, fence: '11' })
    texts.set('x', new Y.Text('current'))
    expect(await versionOf(snapshot(room, 'ben', [])!, 'x')).toMatchObject({ kind: 'text', text: 'current' })
    expect(await localVersionOf('x', async () => 'disk only')).toEqual({ kind: 'text', text: 'disk only' })
  })

  it('reads text only from the current incarnation overlay', async () => {
    const room = new RoomDoc()
    room.participants.set('ben\0holder', { sessionId: 'winner', epoch: 1 })
    room.participants.set('ben\0git', { base: 'abc', fence: '1' })
    room.manifestHead.set('ben', head('1'))
    const entries = new Y.Map<any>()
    room.manifest.set(manifestKey('ben', '1'), entries)
    entries.set('x', { change: 'M', state: 'shared', hash: gitBlobHash('winner text'), size: 11, at: 1, fence: '1' })
    const winner = new Y.Map<Y.Text>(), loser = new Y.Map<Y.Text>()
    room.overlays.set(manifestKey('ben', '1'), winner)
    room.overlays.set(manifestKey('ben', '2'), loser)
    winner.set('x', new Y.Text('winner text'))
    loser.set('x', new Y.Text('loser text'))
    expect(await versionOf(snapshot(room, 'ben', [])!, 'x')).toMatchObject({ kind: 'text', text: 'winner text' })
    winner.delete('x')
    expect(await versionOf(snapshot(room, 'ben', [])!, 'x')).toMatchObject({ kind: 'unknown', why: 'updating' })
  })

  it('rejects a snapshot after a two-replica holder handover with equal semRev', () => {
    const seed = new RoomDoc(), a = new RoomDoc(), b = new RoomDoc()
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(seed.doc))
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(seed.doc))
    a.doc.clientID = 100; b.doc.clientID = 200
    a.participants.set('ben\0holder', { sessionId: 's1', epoch: 11 })
    a.participants.set('ben\0git', { base: 'abc', head: 'h1', fence: '11' })
    a.manifestHead.set('ben', { ...head('11'), semRev: 2 })
    const snap = snapshot(a, 'ben', [])!
    b.participants.set('ben\0holder', { sessionId: 's2', epoch: 12 })
    b.participants.set('ben\0git', { base: 'def', head: 'h2', fence: '12' })
    b.manifestHead.set('ben', { ...head('12'), base: 'def', semRev: 2 })
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc))
    expect(a.manifestHead.get('ben')?.fence).toBe('12')
    expect(snapshotStillCurrent(a, snap, [])).toBe(false)
  })

  it('rejects a changed git head under the same fence even if semRev is unchanged', () => {
    const room = new RoomDoc()
    room.participants.set('ben\0holder', { sessionId: 's1', epoch: 11 })
    room.participants.set('ben\0git', { base: 'abc', head: 'h1', fence: '11' })
    room.manifestHead.set('ben', head('11'))
    const snap = snapshot(room, 'ben', [])!
    room.participants.set('ben\0git', { base: 'abc', head: 'h2', fence: '11' })
    expect(snapshotStillCurrent(room, snap, [])).toBe(false)
  })
})
