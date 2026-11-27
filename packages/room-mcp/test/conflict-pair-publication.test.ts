import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, openConflicts, gitBlobHash, manifestKey, type ParticipantSnapshot } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import type { Session } from '../src/session.js'
import { Ledger, isConflictItem, formatDeliveryItem } from '../src/ledger.js'
import { hubSeam } from './fixtures/hub.js'
import { recordEvaluations } from './fixtures/conflict-evaluations.js'
import { ConflictSet, ConflictSlots, slotKey, type ConflictSlot, type Evaluation } from '../src/conflict-set.js'

function fixture(realHub = false) {
  const dir = mkdtempSync(join(tmpdir(), 'room-pair-publication-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  for (const path of ['a', 'b', 'c']) writeFileSync(join(dir, path), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD'), room = new RoomDoc()
  room.ensureRoomSalt()
  const states = new Map()
  for (const [i, name] of ['A', 'B'].entries()) {
    epochPublication(room, name, base, 1)
    room.participants.set(`${name}\0id`, { name, kind: 'agent' })
    states.set(i, { user: { name, kind: 'agent' }, sessionId: `session-${name}` })
    room.manifestHead.set(name, { base, fence: '1', coverage: { kind: 'all' }, level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true })
    room.manifest.set(manifestKey(name, '1'), new Y.Map())
  }
  const edit = (name: string, path: string, text: string) => {
    room.manifest.get(manifestKey(name, '1'))!.set(path, { change: 'M', state: 'shared', hash: gitBlobHash(text), at: 1, fence: '1' })
    room.setOverlay(manifestKey(name, '1'), path, text)
    const head = room.manifestHead.get(name)!
    room.manifestHead.set(name, { ...head, rev: head.rev + 1, semRev: head.semRev + 1 })
  }
  const seam = realHub ? hubSeam(room) : undefined
  const post = seam ? vi.fn(seam.post) : vi.fn().mockResolvedValue({ ok: true })
  const session = { room, dir, post, me: { name: 'A', kind: 'agent' }, awareness: { getStates: () => states },
    provider: { synced: true, on() {}, off() {} }, lease: { fence: () => '1' } } as unknown as Session
  const set = new ConflictSet(session, 'A', session, () => {}, 0, () => undefined)
  const evaluated = recordEvaluations(set)
  vi.spyOn(set as unknown as { budget(): Promise<void> }, 'budget').mockResolvedValue()
  const slots = room.doc.getMap<ConflictSlot>('conflicts')
  const files = () => [...slots.values()].filter(s => s.owner === 'A' && s.other === 'B' && s.kind === 'merge' && s.path !== '*')
  return { room, set, slots, files, edit, post, states, session, evaluated: evaluated.results,
    cleanup() { evaluated.stop(); set.stop(); seam?.hub.close(); room.doc.destroy(); rmSync(dir, { recursive: true, force: true }) } }
}

describe('whole pair file publication', () => {
  it('exposes only completed pair states to map observers and replicated readers', async () => {
    const f = fixture(), replica = new Y.Doc()
    try {
      f.edit('A', 'a', 'mine\n'); f.edit('B', 'a', 'peer\n')
      await f.set.reconcile('first result')
      Y.applyUpdate(replica, Y.encodeStateAsUpdate(f.room.doc))
      const local: string[][] = [], remote: string[][] = []
      const open = (map: Y.Map<ConflictSlot>) => [...map.values()].filter(s => s.owner === 'A' && s.other === 'B' && s.kind === 'merge' && s.settled === 'conflict').map(s => s.path).sort()
      f.slots.observe(() => local.push(open(f.slots)))
      replica.getMap<ConflictSlot>('conflicts').observe(() => remote.push(open(replica.getMap('conflicts'))))
      f.room.doc.on('update', update => Y.applyUpdate(replica, update))
      f.edit('B', 'a', 'mine\n')
      f.edit('A', 'b', 'mine\n'); f.edit('B', 'b', 'peer\n')
      await f.set.reconcile('move conflict from a to b')
      expect(local).toEqual([['b']])
      expect(remote).toEqual([['b']])
      expect(f.files().map(s => [s.path, s.status])).toEqual([['b', 'conflict']])
      expect(f.evaluated.filter(result => result.path === 'a').at(-1)).toMatchObject({ status: 'clean' })
    } finally { replica.destroy(); f.cleanup() }
  })

  it('removes an absent peer as one map update without posting notices', async () => {
    const f = fixture()
    try {
      for (const path of ['a', 'b']) { f.edit('A', path, 'mine\n'); f.edit('B', path, 'peer\n') }
      await f.set.reconcile('published peer conflicts')
      expect(f.files()).toHaveLength(2)
      const observed: string[][] = []
      f.slots.observe(() => observed.push(f.files().map(s => s.path).sort()))
      f.post.mockClear()
      f.states.delete(1)
      for (const key of [...f.room.participants.keys()]) if (key.startsWith('B\0')) f.room.participants.delete(key)
      f.room.manifestHead.delete('B')
      f.room.manifest.delete(manifestKey('B', '1'))
      await f.set.reconcile('peer removed')
      expect(observed).toEqual([[]])
      expect(f.files()).toEqual([])
      expect(f.post).not.toHaveBeenCalled()
    } finally { f.cleanup() }
  })

  it('publishes readable siblings together with hash-only and binary results', async () => {
    const f = fixture()
    try {
      for (const path of ['a', 'b', 'c']) f.edit('A', path, 'mine\n')
      f.edit('B', 'c', 'peer\n')
      const entries = f.room.manifest.get(manifestKey('B', '1'))!
      entries.set('a', { change: 'M', state: 'held', held: 'scope', hash: gitBlobHash('peer\n'), at: 1, fence: '1' })
      entries.set('b', { change: 'M', state: 'held', held: 'binary', hash: gitBlobHash('binary\0'), at: 1, fence: '1' })
      const observed: string[][] = []
      f.slots.observe(() => observed.push(f.files().map(s => `${s.path}:${s.status}`).sort()))
      await f.set.reconcile('complete but uncheckable files')
      expect(observed).toEqual([['a:possible', 'b:unknown', 'c:conflict']])
      expect(openConflicts(f.room, 'A').some(entry => entry.slots.some(slot => slot.path === 'c'))).toBe(true)
    } finally { f.cleanup() }
  })

  it('delivers a possible sibling through the hub and Ledger while another file persistently fails', async () => {
    const f = fixture(true)
    const ledger = new Ledger({ sessionId: () => 'session-A', route: () => ({}) })
    ledger.bind(f.session)
    f.edit('A', 'a', 'mine\n')
    f.room.manifest.get(manifestKey('B', '1'))!.set('a', { change: 'M', state: 'held', held: 'scope', at: 1, fence: '1' })
    f.edit('A', 'b', 'mine\n')
    const mkdir = vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) })
    const observed: string[][] = []
    f.slots.observe(() => observed.push(f.files().map(s => `${s.path}:${s.status}`).sort()))
    try {
      for (let pass = 0; pass < 2; pass++) {
        f.edit('B', 'b', `peer-${pass}\n`)
        await f.set.reconcile('persistent file-specific merge failure')
      }
      expect(mkdir).toHaveBeenCalledTimes(2)
      expect(observed.every(result => JSON.stringify(result) === JSON.stringify(['a:possible', 'b:unknown']))).toBe(true)
      expect(observed).toHaveLength(2)
      const messages = openConflicts(f.room, 'A')
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ slots: [{ path: 'a' }], priority: 'fyi' })
      expect(ledger.candidates(f.session).filter(m => isConflictItem(m)).map(m => m.id)).toEqual([messages[0]!.id])
      expect(f.slots.get(slotKey('A', 'merge', 'B', 'b'))).toMatchObject({ status: 'unknown', settled: 'none' })
    } finally { mkdir.mockRestore(); f.cleanup() }
  })

  it('wakes for episode two after a completed clearance whose sibling could not be checked', async () => {
    const f = fixture(true)
    const ledger = new Ledger({ sessionId: () => 'session-A', route: () => ({}) })
    ledger.bind(f.session)
    let mkdir: ReturnType<typeof vi.spyOn> | undefined
    try {
      f.edit('A', 'a', 'mine\n'); f.edit('B', 'a', 'peer\n')
      f.edit('A', 'b', 'same\n'); f.edit('B', 'b', 'same\n')
      await f.set.reconcile('initial completed conflict')
      const firstId = openConflicts(f.room, 'A')[0]!.id
      const batch = ledger.open('reply')
      expect(ledger.select(f.session, batch).map(m => m.priority)).toEqual(['notify'])
      ledger.commit(batch)
      expect(ledger.candidates(f.session)).toHaveLength(0)
      f.edit('B', 'a', 'mine\n'); f.edit('B', 'b', 'changed\n')
      mkdir = vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => { throw new Error('ENOSPC') })
      await f.set.reconcile('clear a; b cannot be checked')
      expect(f.slots.has(slotKey('A', 'merge', 'B', 'a'))).toBe(false)
      expect(f.evaluated.filter(result => result.path === 'a').at(-1)).toMatchObject({ status: 'clean' })
      expect(f.slots.get(slotKey('A', 'merge', 'B', 'b'))).toMatchObject({ status: 'unknown' })
      mkdir.mockRestore()
      f.edit('B', 'b', 'same\n'); f.edit('B', 'a', 'peer\n')
      await f.set.reconcile('storage recovered; a conflicts again')
      const notifications = openConflicts(f.room, 'A')
      expect(notifications).toHaveLength(1)
      expect(notifications[0]!.id).not.toBe(firstId)
      expect(f.slots.get(slotKey('A', 'merge', 'B', 'a'))).toMatchObject({ status: 'conflict' })
      expect(ledger.candidates(f.session).filter(m => isConflictItem(m) && m.priority === 'notify').map(m => m.id)).toEqual([notifications[0]!.id])
    } finally { mkdir?.mockRestore(); f.cleanup() }
  })

  it('publishes readable siblings when a later file read fails', async () => {
    const f = fixture(true)
    const ledger = new Ledger({ sessionId: () => 'session-A', route: () => ({}) })
    ledger.bind(f.session)
    try {
      for (const path of ['a', 'b']) { f.edit('A', path, 'mine\n'); f.edit('B', path, 'peer\n') }
      const target = f.set as unknown as { read(snap: ParticipantSnapshot, path: string): Promise<unknown> }
      const read = target.read.bind(target)
      vi.spyOn(target, 'read').mockImplementation(async (snap, path) => {
        if (path === 'b') throw new Error('read failed')
        return read(snap, path)
      })
      const observed: string[][] = []
      f.slots.observe(() => observed.push(f.files().map(s => `${s.path}:${s.status}`).sort()))
      await f.set.reconcile('one failed read')
      expect(observed).toEqual([['a:conflict', 'b:unknown']])
      expect(ledger.candidates(f.session).filter(m => isConflictItem(m))).toMatchObject([{ type: 'conflict-state', conflict: { text: expect.stringContaining('a conflicts') }, priority: 'notify' }])
    } finally { f.cleanup() }
  })

  it.each(['updating', 'no-record', 'not-publisher'])('keeps the pair incomplete when a read fails while its counterpart is %s', async why => {
    const f = fixture()
    try {
      for (const path of ['a', 'b']) { f.edit('A', path, 'mine\n'); f.edit('B', path, 'peer\n') }
      await f.set.reconcile('prior completed files')
      const prior = f.files()
      f.edit('B', 'a', 'mine\n')
      const target = f.set as unknown as { read(snap: ParticipantSnapshot, path: string): Promise<unknown> }
      const read = target.read.bind(target)
      vi.spyOn(target, 'read').mockImplementation(async (snap, path) => {
        if (path !== 'b') return read(snap, path)
        if (snap.name === 'A') throw new Error('file read failed')
        return { kind: 'unknown', why }
      })
      await f.set.reconcile('one failed read and another input still arriving')
      expect(f.files()).toEqual(prior)
    } finally { f.cleanup() }
  })

  it('publishes and announces completed file results before a later claims failure', async () => {
    const f = fixture(true)
    const ledger = new Ledger({ sessionId: () => 'session-A', route: () => ({}) })
    ledger.bind(f.session)
    try {
      f.edit('A', 'a', 'mine\n'); f.edit('B', 'a', 'peer\n')
      const claims = vi.spyOn(f.set as unknown as { claims(...args: unknown[]): Promise<void> }, 'claims')
        .mockRejectedValue(new Error('claims phase failed'))
      await expect(f.set.reconcile('files complete; claims fail')).rejects.toThrow('claims phase failed')
      expect(claims).toHaveBeenCalledOnce()
      expect(f.files()).toMatchObject([{ path: 'a', status: 'conflict' }])
      expect(ledger.candidates(f.session).filter(m => isConflictItem(m))).toMatchObject([{ type: 'conflict-state', conflict: { text: expect.stringContaining('a conflicts') }, priority: 'notify' }])
    } finally { f.cleanup() }
  })

  it('keeps a receipted episode continuous across a clear and reopen in an unfinished check', async () => {
    const f = fixture(true)
    const ledger = new Ledger({ sessionId: () => 'session-A', route: () => ({}) })
    ledger.bind(f.session)
    try {
      f.edit('A', 'a', 'mine\n'); f.edit('B', 'a', 'peer\n')
      f.edit('A', 'b', 'same\n'); f.edit('B', 'b', 'same\n')
      await f.set.reconcile('initial completed conflict')
      const prior = f.slots.get(slotKey('A', 'merge', 'B', 'a'))!
      const batch = ledger.open('reply')
      ledger.select(f.session, batch); ledger.commit(batch)
      f.edit('B', 'a', 'mine\n')
      const target = f.set as unknown as { read(snap: ParticipantSnapshot, path: string): Promise<unknown> }
      const read = target.read.bind(target)
      let changes = 0
      const moved = vi.spyOn(target, 'read').mockImplementation(async (snap, path) => {
        const result = await read(snap, path)
        if (snap.name === 'B' && path === 'b') f.edit('B', 'b', `moving-${++changes}\n`)
        return result
      })
      await f.set.reconcile('clear a, but inputs move before pair completion')
      expect(changes).toBe(2)
      expect(f.slots.get(slotKey('A', 'merge', 'B', 'a'))).toBe(prior)
      moved.mockRestore()
      f.edit('B', 'a', 'peer\n'); f.edit('B', 'b', 'same\n')
      await f.set.reconcile('original conflict, now on stable inputs')
      expect(f.slots.get(slotKey('A', 'merge', 'B', 'a'))?.openId).toBe(prior.openId)
      expect(f.room.messages()).toHaveLength(0)
      expect(ledger.candidates(f.session).filter(m => isConflictItem(m))).toHaveLength(0)
    } finally { f.cleanup() }
  })

  it('keeps previous files while the manifest is incomplete and publishes once it completes', async () => {
    const f = fixture()
    try {
      f.edit('A', 'a', 'mine\n'); f.edit('B', 'a', 'peer\n')
      await f.set.reconcile('prior completed result')
      const prior = f.files()
      const head = f.room.manifestHead.get('B')!
      f.room.manifestHead.set('B', { ...head, complete: false })
      f.edit('B', 'a', 'mine\n')
      await f.set.reconcile('manifest arriving')
      expect(f.files()).toEqual(prior)
      expect(f.slots.get(slotKey('A', 'merge', 'B', '*'))?.status).toBe('unknown')
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, complete: true })
      await f.set.reconcile('manifest complete')
      expect(f.files()).toEqual([])
      expect(f.slots.has(slotKey('A', 'merge', 'B', '*'))).toBe(false)
      expect(f.evaluated.filter(result => result.path === 'a').at(-1)).toMatchObject({ status: 'clean' })
    } finally { f.cleanup() }
  })

  it('replays the last completed possible-conflict reason while a manifest is arriving', async () => {
    const f = fixture()
    try {
      f.edit('A', 'a', 'mine\n')
      f.room.manifest.get(manifestKey('B', '1'))!.set('a', { change: 'M', state: 'held', held: 'scope', at: 1, fence: '1' })
      await f.set.reconcile('completed unreadable result')
      const prior = f.files()
      const text = openConflicts(f.room, 'A')[0]!.text
      f.post.mockClear()
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, complete: false })
      await f.set.reconcile('manifest arriving')
      expect(f.files()).toEqual(prior)
      expect(openConflicts(f.room, 'A').map(entry => entry.text)).toEqual([text])
    } finally { f.cleanup() }
  })

  it('discards private slot preparation when its guard fails after a yield', async () => {
    const room = new RoomDoc()
    let valid = true
    const post = vi.fn().mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, '1', Date.now, () => valid)
    const results = new Map<string, Evaluation>()
    for (let i = 0; i < 64; i++) {
      const path = `file-${i}`
      results.set(slotKey('A', 'merge', 'B', path), { owner: 'A', other: 'B', kind: 'merge', path, status: 'conflict', inputs: 'i', factId: 'f' })
    }
    try {
      setImmediate(() => { valid = false })
      await expect(slots.settlePair('A', 'B', results)).rejects.toBeInstanceOf(Error)
      expect(room.doc.getMap('conflicts').size).toBe(0)
      expect(post).not.toHaveBeenCalled()
    } finally { room.doc.destroy() }
  })

  it.each([false, true])('withholds buffered results when inputs move, including a failed read (%s)', async failedRead => {
    const f = fixture()
    try {
      for (const path of ['a', 'b']) { f.edit('A', path, 'mine\n'); f.edit('B', path, 'peer\n') }
      await f.set.reconcile('prior completed result')
      const prior = f.files()
      f.edit('B', 'a', 'mine\n')
      const target = f.set as unknown as { read(snap: ParticipantSnapshot, path: string): Promise<unknown> }
      const read = target.read.bind(target)
      let changes = 0
      vi.spyOn(target, 'read').mockImplementation(async (snap, path) => {
        const value = await read(snap, path)
        if (path === 'b' && snap.name === 'B') {
          f.edit('B', 'b', `moving-${++changes}\n`)
          if (failedRead) throw new Error('read failed while inputs moved')
        }
        return value
      })
      await f.set.reconcile('moving inputs')
      expect(changes).toBe(2)
      expect(f.files()).toEqual(prior)
    } finally { f.cleanup() }
  })
})
