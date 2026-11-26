import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { RoomDoc, openConflicts, type ConflictKind, type ConflictSlot } from '@room/shared'
import { Bridge } from '../src/bridge.js'
import { Ledger } from '../src/ledger.js'
import type { Session } from '../src/session.js'
import type { WorkerRegistry } from '../src/worker-registry.js'
import { hubSeam } from './fixtures/hub.js'
import { epochPublication } from '@room/shared/testing'

const cleanup: (() => void)[] = []
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop() })
const provider = () => Object.assign(new EventEmitter(), { synced: true }) as unknown as Session['provider']
const reachable = (session: Session, synced: boolean) => { session.provider.synced = synced; (session.provider as unknown as EventEmitter).emit('sync', synced) }
const retained = (bridge: Bridge) => [...(bridge as unknown as { conflictRelayed: Map<string, { size: number }> }).conflictRelayed.values()].reduce((sum, entries) => sum + entries.size, 0)
async function fixture(sibling = false) {
  const teamRoom = new RoomDoc(), privateRoom = new RoomDoc()
  cleanup.push(() => { teamRoom.doc.destroy(); privateRoom.doc.destroy() })
  const seam = hubSeam(privateRoom)
  cleanup.push(() => seam.hub.close())
  const local = { ...seam, room: privateRoom, dir: '', me: { name: 'L', kind: 'agent' }, roomName: 'local/test',
    provider: provider(), daemon: { fence: '1' } } as unknown as Session
  const team = { ...local, provider: provider(), room: teamRoom, roomName: 'team/test' } as Session
  const record = { id: 'worker-1', name: 'W', tag: 'w', phase: 'active', room: local.roomName, lead: { participant: 'L' } }
  const workers = [{ record }, ...(sibling ? [{ record: { ...record, id: 'worker-2', name: 'P', tag: 'p' } }] : [])]
  const changed = new Set<() => void>()
  const registry = { snapshot: vi.fn(async () => ({ available: true, blockers: [], workers: workers.map(({ record }) => ({ record: { ...record } })) })),
    onChange: (listener: () => void) => { changed.add(listener); return () => changed.delete(listener) } } as unknown as WorkerRegistry
  const start = async (target = local) => {
    const bridge = new Bridge(team, target, { registry, debounceMs: 60_000 })
    bridge.start(); cleanup.push(() => bridge.stop())
    // Complete the registry attachment before exercising the public map observer.
    await Promise.resolve(); await Promise.resolve()
    return bridge
  }
  const bridge = await start()
  const map = teamRoom.doc.getMap<ConflictSlot>('conflicts')
  const slot = (patch: Partial<ConflictSlot> = {}): ConflictSlot => ({ kind: 'merge', owner: 'W', other: 'P', path: 'x',
    status: 'conflict', settled: 'conflict', inputs: 'i', factId: 'f', openId: 'opening',
    endpoints: [{ name: 'W', workerId: record.id }, { name: 'P', ...(sibling ? { workerId: 'worker-2' } : {}) }], fence: '1', checkedAt: 1, ...patch })
  const messages = () => privateRoom.messages().filter(message => message.type === 'note' && message.to === 'W')
  const worker = { ...local, me: { name: 'W', kind: 'agent' } } as Session
  const ledger = new Ledger({ sessionId: () => 'worker-session', route: () => ({}) }); ledger.bind(worker)
  return { teamRoom, privateRoom, local, map, slot, messages, bridge, start, ledger, worker, workers, registryListeners: changed, registryChanged: () => { for (const listener of changed) listener() } }
}

it.each(['merge', 'edit-in-claim', 'claims', 'contract'] as ConflictKind[])('sends one ordinary addressed %s note per opening, again after the lead loses its record', async kind => {
  const f = await fixture()
  f.map.set('first', f.slot({ kind }))
  await vi.waitFor(() => expect(f.messages()).toHaveLength(1))
  expect(f.messages()[0]).toMatchObject({ type: 'note', from: 'L', to: 'W', priority: kind === 'edit-in-claim' ? 'interrupt' : 'notify' })
  expect(f.messages()[0].id).toMatch(/^m_/)
  expect(f.ledger.candidates(f.worker).map(item => item.id)).toContain(f.messages()[0].id)
  expect(openConflicts(f.privateRoom, 'W')).toEqual([])
  f.map.set('first', f.slot({ kind, lines: [9], checkedAt: 2 }))
  await Promise.resolve()
  expect(f.messages()).toHaveLength(1)
  f.map.delete('first')
  await Promise.resolve()
  expect(f.messages()).toHaveLength(1) // no clearance mail
  f.map.set('first', f.slot({ kind, openId: 'next-opening' }))
  await vi.waitFor(() => expect(f.messages()).toHaveLength(2))
  f.bridge.stop()
  await f.start()
  f.map.set('first', f.slot({ kind, openId: 'next-opening', checkedAt: 3 }))
  await vi.waitFor(() => expect(f.messages()).toHaveLength(3))
  f.map.set('first', f.slot({ kind, openId: 'next-opening', checkedAt: 4 }))
  await Promise.resolve()
  expect(f.messages()).toHaveLength(3)
})

it('waits through quiet entries, relays a confirmed opening once and ignores quiet downgrades', async () => {
  const f = await fixture()
  f.teamRoom.doc.transact(() => {
    f.map.set('first', f.slot({ settled: 'possible', status: 'possible' }))
    f.map.set('second', f.slot({ settled: 'possible', status: 'possible', path: 'y' }))
  })
  await Promise.resolve()
  expect(f.messages()).toEqual([])
  f.map.set('first', f.slot())
  await vi.waitFor(() => expect(f.messages()).toHaveLength(1))
  f.map.set('first', f.slot({ settled: 'possible', status: 'possible' }))
  await Promise.resolve()
  f.map.set('first', f.slot())
  await Promise.resolve()
  expect(f.messages()).toHaveLength(1)
  f.map.clear()
  f.map.set('overlap', f.slot({ kind: 'edit-in-claim', merges: 'clean', openId: 'overlap' }))
  await Promise.resolve()
  expect(f.messages()).toHaveLength(1)
})

it('uses only the registry to exclude siblings and rejects a predecessor opening for a successor', async () => {
  const f = await fixture(true)
  f.map.set('private', f.slot())
  f.map.set('predecessor', f.slot({ other: 'Q', endpoints: [{ name: 'W', workerId: 'old-worker' }, { name: 'Q' }] }))
  await Promise.resolve()
  expect(f.messages()).toEqual([])
})

it('retries a refused normal post without marking the opening sent', async () => {
  const f = await fixture(), post = f.local.post
  f.local.post = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'unreachable' }).mockImplementation(post)
  f.map.set('first', f.slot())
  await vi.waitFor(() => expect(f.local.post).toHaveBeenCalledOnce())
  await Promise.resolve()
  f.map.set('first', f.slot({ checkedAt: 2 }))
  await vi.waitFor(() => expect(f.messages()).toHaveLength(1))
})

it('relays a team peer despite its old released record in the private room', async () => {
  const f = await fixture()
  f.privateRoom.participants.set('P\0id', { name: 'P', kind: 'agent' })
  f.privateRoom.participants.set('P\0holder', { sessionId: 'old-P', epoch: 1, ended: 'released' })
  f.map.set('first', f.slot())
  await vi.waitFor(() => expect(f.messages()).toHaveLength(1))
})

it('captures an observed opening before a back-to-back transaction deletes it', async () => {
  const f = await fixture()
  f.map.set('first', f.slot({ lines: [7] }))
  f.map.delete('first')
  await vi.waitFor(() => expect(f.messages()).toHaveLength(1))
  expect(f.messages()[0]).toMatchObject({ priority: 'notify', text: expect.stringContaining('at lines 7') })
})

it('relays an opening revealed by a policy change before synchronous clearance', async () => {
  const f = await fixture()
  epochPublication(f.teamRoom, 'P', 'a'.repeat(40))
  const head = f.teamRoom.manifestHead.get('P')!
  f.teamRoom.manifestHead.set('P', { ...head, level: 'intent' })
  f.map.set('first', f.slot())
  expect(openConflicts(f.teamRoom, 'W')).toEqual([])
  expect(f.messages()).toEqual([])
  f.teamRoom.manifestHead.set('P', { ...head, level: 'full' })
  f.map.clear()
  await vi.waitFor(() => expect(f.messages()).toHaveLength(1))
})

it('subscribes to query changes without relaying on unrelated document edits', async () => {
  const f = await fixture()
  const relay = vi.spyOn(f.bridge as unknown as { relayConflicts(): Promise<void> }, 'relayConflicts')
  f.teamRoom.metaMap.set('unrelated', 1)
  expect(relay).not.toHaveBeenCalled()
  f.map.set('first', f.slot())
  await vi.waitFor(() => expect(f.messages()).toHaveLength(1))
  expect(relay).toHaveBeenCalledOnce()
  f.teamRoom.metaMap.set('unrelated', 2)
  expect(relay).toHaveBeenCalledOnce()
  f.teamRoom.workerViews.set('p', { id: 'p', name: 'P', lead: 'R', startedAt: 1 } as never)
  expect(relay).toHaveBeenCalledTimes(2)
  expect(f.messages()).toHaveLength(1)
})

it('does not retry a refused note after its opening disappears', async () => {
  const f = await fixture(), post = f.local.post
  f.local.post = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'unreachable' }).mockImplementation(post)
  f.map.set('first', f.slot({ lines: [7] }))
  await vi.waitFor(() => expect(f.local.post).toHaveBeenCalledOnce())
  await Promise.resolve()
  f.map.delete('first')
  await Promise.resolve()
  expect(f.messages()).toEqual([])
  expect(f.local.post).toHaveBeenCalledOnce()
  expect(openConflicts(f.teamRoom, 'W')).toEqual([])
})

it('captures every opening before any asynchronous send can observe a later disappearance', async () => {
  const f = await fixture()
  f.teamRoom.doc.transact(() => {
    f.map.set('first', f.slot({ openId: 'first', lines: [7] }))
    f.map.set('second', f.slot({ openId: 'second', path: 'y', lines: [9] }))
  })
  f.map.clear()
  await vi.waitFor(() => expect(f.messages()).toHaveLength(2))
  expect(f.messages().map(message => message.text)).toEqual(expect.arrayContaining([
    expect.stringContaining('x conflicts'), expect.stringContaining('y conflicts'),
  ]))
})

it('does not give a same-name successor its predecessor’s unreachable opening', async () => {
  const f = await fixture()
  reachable(f.local, false)
  f.map.set('first', f.slot({ lines: [7] }))
  f.workers[0].record = { ...f.workers[0].record, id: 'successor' }
  f.registryChanged()
  f.local.post = vi.fn(f.local.post)
  reachable(f.local, true)
  f.map.set('first', f.slot({ lines: [7], checkedAt: 2 }))
  expect(f.local.post).not.toHaveBeenCalled()
  expect(f.messages()).toEqual([])
  f.bridge.stop()
  await f.start()
  expect(f.local.post).not.toHaveBeenCalled()
  f.map.set('first', f.slot({ endpoints: [{ name: 'W', workerId: 'successor' }, { name: 'P' }] }))
  await vi.waitFor(() => expect(f.messages()).toHaveLength(1))
})

it('relays what remains open exactly once after attachment replacement and private reconnect', async () => {
  const f = await fixture()
  reachable(f.local, false)
  f.map.set('first', f.slot())
  f.map.set('closed', f.slot({ path: 'closed', openId: 'closed-opening' }))
  f.map.delete('closed')
  f.bridge.stop()
  const replacement = { ...f.local, provider: provider() } as Session
  replacement.provider.synced = false
  const bridge = await f.start(replacement)
  reachable(replacement, true)
  await vi.waitFor(() => expect(f.messages()).toHaveLength(1))
  reachable(replacement, true)
  f.map.set('first', f.slot({ lines: [9] }))
  await Promise.resolve()
  expect(f.messages()).toHaveLength(1)
  expect(f.messages()[0].text).not.toContain('closed')
  expect(retained(bridge)).toBe(1)
})

it('retains nothing after 1,000 openings open and close while the private room is unreachable', async () => {
  const f = await fixture()
  reachable(f.local, false)
  for (let i = 0; i < 1_000; i++) {
    f.map.set('first', f.slot({ openId: 'opening-' + i }))
    f.map.delete('first')
  }
  expect(retained(f.bridge)).toBe(0)
  reachable(f.local, true)
  await Promise.resolve(); await Promise.resolve()
  expect(f.messages()).toEqual([])
})

it('removes its document, both transport-sync and registry listeners on stop', async () => {
  const f = await fixture()
  const relay = vi.spyOn(f.bridge as unknown as { relayConflicts(): Promise<void> }, 'relayConflicts')
  const teamProvider = f.bridge.team.provider as unknown as EventEmitter
  const localProvider = f.local.provider as unknown as EventEmitter
  expect(teamProvider.listenerCount('sync')).toBe(1)
  expect(localProvider.listenerCount('sync')).toBe(1)
  expect(f.registryListeners.size).toBe(1)
  f.bridge.stop()
  expect(teamProvider.listenerCount('sync')).toBe(0)
  expect(localProvider.listenerCount('sync')).toBe(0)
  expect(f.registryListeners.size).toBe(0)
  f.map.set('after-stop', f.slot())
  reachable(f.bridge.team, true)
  reachable(f.local, true)
  f.registryChanged()
  await Promise.resolve()
  expect(relay).not.toHaveBeenCalled()
  expect(f.messages()).toEqual([])
})
