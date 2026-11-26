import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc, openConflicts, participantRecord, type ConflictSlot } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { publishFixture } from './fixtures/manifest.js'
import { ConflictSet, slotKey } from '../src/conflict-set.js'
import { Ledger } from '../src/ledger.js'
import { WakeReconciler } from '../src/wake-reconciler.js'
import * as roomd from '@room/roomd'
import * as merge from '../src/merge.js'
import type { Session } from '../src/session.js'
const cleanups: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) close() })
const oldSlot = (extra: Record<string, unknown> = {}) => ({ owner: 'A', other: 'B', kind: 'merge', path: 'x', status: 'conflict', settled: 'conflict', inputs: 'old', factId: 'old', fence: '1', checkedAt: 1, epoch: 1, peerEpisode: 1,
  projectedEpisode: { id: 'old-opening', endpoints: [{ name: 'A', workerId: 'old-worker' }, { name: 'B' }] }, ...extra }) as unknown as ConflictSlot
function fixture(peer: 'present' | 'absent' | 'retired' = 'present', identical = false) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'room-upgrade-')), room = new RoomDoc()
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@test')
  fs.writeFileSync(join(dir, 'x'), 'one\ntwo\n'); git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD'), states = new Map<number, unknown>()
  const add = (name: string, text: string) => {
    epochPublication(room, name, base)
    publishFixture(room, name, 'x', text, { base })
    states.set(states.size + 1, { user: { name, kind: 'agent' }, sessionId: participantRecord(room, name)!.holder!.sessionId })
  }
  add('A', 'one\nours\n')
  if (peer !== 'absent') add('B', identical ? 'one\nours\n' : 'one\ntheirs\n')
  if (peer === 'retired') {
    room.participants.set('B\0holder', { ...participantRecord(room, 'B')!.holder!, workerId: 'peer-retired' })
    room.doc.getArray('retiredWorkers').push([{ name: 'B', id: 'peer-retired' }])
  }
  const s = { room, roomName: 'upgrade', dir, me: { name: 'A', kind: 'agent' }, lease: { fence: () => '1' },
    awareness: { getStates: () => states, setLocalStateField() {} }, provider: { synced: true }, post: vi.fn(async () => ({ ok: true })) } as unknown as Session
  const set = new ConflictSet(s, 'A', s, () => {}, 0)
  const ledger = new Ledger({ sessionId: () => participantRecord(room, 'A')!.holder!.sessionId, sessionDir: () => dir, route: () => ({}) })
  const send = vi.fn(async () => 'socket' as const)
  let wake: WakeReconciler | undefined
  const startWake = () => { ledger.bind(s); wake = new WakeReconciler({ ledger, bound: () => ({ host: 'claude', id: 'host' }), sessionDir: () => dir, send, windowMs: 0 }); wake.attach(s) }
  cleanups.push(() => { wake?.stop(); set.stop(); room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { room, set, s, send, ledger, startWake, addPeer: () => add('B', 'one\ntheirs\n'), map: room.doc.getMap<ConflictSlot>('conflicts') }
}
it.each(['conflict', 'unknown'] as const)('reevaluates old %s inputs with both participants present and wakes once for the fresh opening', async status => {
  const f = fixture(), key = slotKey('A', 'merge', 'B', 'x')
  await f.set.reconcile('capture inputs')
  const { openId: _openId, endpoints: _endpoints, ...previous } = f.map.get(key)!
  f.map.set(key, oldSlot({ ...previous, status, retryAt: Date.now() + 60_000 }))
  f.startWake()
  expect(openConflicts(f.room, 'A')).toEqual([])
  expect(f.ledger.candidates(f.s)).toEqual([])
  const merging = vi.spyOn(merge, 'gitMergeFile')
  await f.set.reconcile('upgrade with unchanged inputs')
  expect(merging).toHaveBeenCalledOnce()
  expect(f.map.get(key)).toMatchObject({ status: 'conflict', endpoints: [{ name: 'A' }, { name: 'B' }], openId: expect.any(String) })
  expect(f.map.get(key)!.openId).not.toBe('old-opening')
  expect(f.map.get(key)!.openId).not.toBe(_openId)
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  await f.set.reconcile('unchanged again')
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(f.send).toHaveBeenCalledOnce()
})
it('an old unknown diagnostic cannot use its input retry cache to skip a fresh comparison', async () => {
  const f = fixture(), actual = roomd.comparePair
  const compare = vi.spyOn(roomd, 'comparePair').mockResolvedValueOnce({ cannotCompare: 'temporary fetch gap' })
  await f.set.reconcile('diagnose')
  const key = slotKey('A', 'merge', 'B', '*'), diagnostic = f.map.get(key)!
  compare.mockClear()
  await f.set.reconcile('current-format retry remains cached')
  expect(compare).not.toHaveBeenCalled()
  const { openId: _openId, endpoints: _endpoints, ...old } = diagnostic
  f.map.set(key, { ...old, retryAt: Date.now() + 60_000 })
  compare.mockClear(); compare.mockImplementation(actual)
  await f.set.reconcile('upgrade unchanged pair inputs')
  expect(compare).toHaveBeenCalledOnce()
  expect(openConflicts(f.room, 'A')).toMatchObject([{ slots: [{ path: 'x', status: 'conflict' }] }])
})
it.each(['absent', 'retired'] as const)('an old slot with an %s peer neither wakes nor remains after an owner check', async peer => {
  const f = fixture(peer), key = slotKey('A', 'merge', 'B', 'x')
  f.map.set(key, oldSlot()); f.startWake()
  expect(openConflicts(f.room, 'A')).toEqual([])
  await f.set.reconcile('upgrade without a current peer')
  expect(f.map.has(key)).toBe(false)
  expect(f.ledger.candidates(f.s)).toEqual([])
  await new Promise(resolve => setTimeout(resolve, 10)); expect(f.send).not.toHaveBeenCalled()
})
it('a fresh clean check removes an old open slot without a wake', async () => {
  const f = fixture('present', true), key = slotKey('A', 'merge', 'B', 'x')
  f.map.set(key, oldSlot()); f.startWake()
  expect(openConflicts(f.room, 'A')).toEqual([])
  await f.set.reconcile('upgrade clean pair')
  expect(f.map.has(key)).toBe(false)
  expect(f.ledger.candidates(f.s)).toEqual([])
  await new Promise(resolve => setTimeout(resolve, 10)); expect(f.send).not.toHaveBeenCalled()
})

it('an old message-only snapshot waits for both participants and a fresh evaluation', async () => {
  const f = fixture('absent')
  f.room.bus.push([{ id: 'cf:unread-before-upgrade', type: 'merge-conflict', from: 'room', fromKind: 'agent', to: 'A', path: 'x', text: 'old unread conflict', at: Date.now(), seq: 1, priority: 'notify' }])
  f.startWake()
  await f.set.reconcile('only one participant after upgrade')
  expect(openConflicts(f.room, 'A')).toEqual([])
  expect(f.ledger.candidates(f.s)).toEqual([])
  expect(f.room.seen('A').has('cf:unread-before-upgrade')).toBe(true)
  expect(f.send).not.toHaveBeenCalled()
  f.addPeer()
  await f.set.reconcile('both participants available')
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  expect(f.ledger.candidates(f.s)).toMatchObject([{ type: 'conflict-state', status: 'open' }])
})
