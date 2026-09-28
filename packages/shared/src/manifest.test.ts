import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from './doc.js'
import { digestPath, gitBlobHash, localVersionOf, manifestKey, snapshot, versionOf, type ManifestHead } from './manifest.js'

const head = (fence = 's1'): ManifestHead => ({ base: 'abc', fence, coverage: { kind: 'all' }, level: 'declared', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true })

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
    room.participants.set('ben\0holder', { sessionId: 'winner' })
    room.participants.set('ben\0git', { base: 'abc', fence: 'winner' })
    room.manifestHead.set('ben', { ...head('winner'), excluded: [digestPath(salt, 'secret.txt')] })
    const winning = new Y.Map<any>(), losing = new Y.Map<any>()
    room.manifest.set(manifestKey('ben', 'winner'), winning)
    room.manifest.set(manifestKey('ben', 'loser'), losing)
    winning.set('x', { change: 'M', state: 'held', held: 'scope', at: 1, fence: 'winner' })
    winning.set('gone', { change: 'D', state: 'shared', at: 1, fence: 'winner' })
    winning.set('wrong', { change: 'M', state: 'held', held: 'scope', at: 1, fence: 'loser' })
    losing.set('y', { change: 'M', state: 'held', held: 'scope', at: 1, fence: 'loser' })
    const snap = snapshot(room, 'ben', [])!
    expect((await versionOf(snap, 'x', { gitAt: async () => 'base' })).kind).toBe('held')
    expect((await versionOf(snap, 'gone', { gitAt: async () => 'base' })).kind).toBe('deleted')
    expect((await versionOf(snap, 'secret.txt', { gitAt: async () => 'base' })).kind).toBe('excluded')
    expect((await versionOf(snap, 'y', { gitAt: async () => 'base' })).kind).toBe('base')
    expect((await versionOf(snap, 'wrong', { gitAt: async () => 'base' })).kind).toBe('base')
  })

  it('never resolves a hashless held entry from a known blob', async () => {
    const room = new RoomDoc()
    room.participants.set('ben\0holder', { sessionId: 's1' })
    room.participants.set('ben\0git', { base: 'abc', fence: 's1' })
    room.manifestHead.set('ben', head())
    const entries = new Y.Map<any>()
    room.manifest.set(manifestKey('ben', 's1'), entries)
    entries.set('x', { change: 'M', state: 'held', held: 'scope', at: 1, fence: 's1' })
    expect((await versionOf(snapshot(room, 'ben', [])!, 'x', { known: async () => 'same' })).kind).toBe('held')
  })

  it('verifies shared text and reads the caller checkout at intent', async () => {
    const room = new RoomDoc()
    room.participants.set('ben\0holder', { sessionId: 's1' })
    room.participants.set('ben\0git', { base: 'abc', fence: 's1' })
    room.manifestHead.set('ben', head())
    const entries = new Y.Map<any>(), texts = new Y.Map<Y.Text>()
    room.manifest.set(manifestKey('ben', 's1'), entries)
    room.overlays.set('ben', texts)
    entries.set('x', { change: 'M', state: 'shared', hash: gitBlobHash('current'), size: 7, at: 1, fence: 's1' })
    texts.set('x', new Y.Text('current'))
    expect(await versionOf(snapshot(room, 'ben', [])!, 'x')).toMatchObject({ kind: 'text', text: 'current' })
    expect(await localVersionOf('x', async () => 'disk only')).toEqual({ kind: 'text', text: 'disk only' })
  })
})
