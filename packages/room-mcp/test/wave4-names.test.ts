import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { startAutoTaggedRoomd } from '../src/session.js'
import { hubRoom } from './fixtures/hub-provider.js'
import { WorkerRegistry } from '../src/worker-registry.js'
import { HooksBridge } from '../src/hooks-bridge.js'
import { createHandlerState } from '../src/tools/state.js'
import { IDLE_CLAIMS_MS, joinedPresenceHolds, joinedPresenceWorkers, releaseIdleHeld } from '../src/presence-end.js'
import { memorySession } from './fixtures/session.js'
import type { Session } from '../src/session.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const temporary = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-wave4-names-')); dirs.push(dir); return dir }

it('M2 detaches a lapsed name holder so another live session can publish the checkout', async () => {
  const dir = temporary(), room = hubRoom()
  execFileSync('git', ['init', '-q', dir])
  fs.writeFileSync(path.join(dir, 'x'), 'base\n')
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=t@t', 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=t@t', 'commit', '-qm', 'base'])
  const start = (sessionId: string) => startAutoTaggedRoomd({ dir, room: 'ws://test/room', localKey: 'key',
    name: 'ada', owner: 'ada', requested: 'full', sessionId, providerFactory: (_s, _r, doc: Y.Doc) => room.provider(doc) }, undefined)
  const a = await start('sa'), b = await start('sb')
  try {
    expect(a.policyStore.policy.publisher).toBe(true)
    expect(b.policyStore.policy.publisher).toBe(false)
    a.hub.close(); a.lease.check()
    await vi.waitFor(() => expect(a.policyStore.policy.publisher).toBe(false))
    await vi.waitFor(() => expect(b.policyStore.policy.publisher).toBe(true), { timeout: 8_000, interval: 100 })
  } finally { await a.daemon.stop(); await b.daemon.stop(); room.doc.doc.destroy() }
}, 20_000)

it('M6 keeps the H1 journal pending until the hub accepts and retries the same notice ID', async () => {
  const dir = temporary(), doc = new RoomDoc()
  const registry = await WorkerRegistry.open(dir, { migrate: false, watch: false })
  doc.addClaim({ path: 'x', from: 1, to: 1, by: 'ada', byKind: 'agent', intent: 'edit' })
  doc.setScope({ by: 'ada', byKind: 'agent', area: 'old', summary: 'old', paths: ['x'], at: 1 })
  const ids: string[] = []
  const action = { roomKey: 'local/repo', sessionId: 's', participant: 'ada', idleEpoch: 'one', host: 'shared-app-server' as const,
    lastActivityMs: 0, monotonicMs: () => 8 * 3600_000, doc, ownsParticipant: () => true,
    postNotice: (id: string) => { ids.push(id); return { ok: false as const, text: 'not sent: hub unreachable' } } }
  expect(await registry.reconcileIdleClaims(action)).toBe(false)
  expect(doc.openClaims()).toHaveLength(0)
  expect(doc.scope('ada')).toBeUndefined()
  doc.setScope({ by: 'ada', byKind: 'agent', area: 'new', summary: 'new', paths: ['y'], at: 2 })
  expect(await registry.reconcileIdleClaims({ ...action, idleEpoch: 'after-restart', lastActivityMs: 8 * 3600_000, postNotice: id => { ids.push(id); return { ok: true as const } } })).toBe(true)
  expect(ids).toEqual(['idle-claims:s:one', 'idle-claims:s:one'])
  expect(doc.scope('ada')?.area).toBe('new')
  expect(await registry.reconcileIdleClaims({ ...action, idleEpoch: 'after-restart', lastActivityMs: 8 * 3600_000, postNotice: id => { ids.push(id); return { ok: true as const } } })).toBe(false)
  doc.doc.destroy(); registry.close()
})

it('M6 cannot finish the idle leave while a pending notice has no name lease', async () => {
  const dir = temporary(), room = new RoomDoc()
  execFileSync('git', ['init', '-q', dir])
  const registry = await WorkerRegistry.open(path.join(dir, '.git'), { migrate: false, watch: false })
  room.addClaim({ path: 'x', from: 1, to: 1, by: 'ada', byKind: 'agent', intent: 'edit' })
  await registry.reconcileIdleClaims({ roomKey: 'local/repo', sessionId: 's', participant: 'ada', idleEpoch: 'idle-1', host: 'shared-app-server',
    lastActivityMs: 0, monotonicMs: () => IDLE_CLAIMS_MS, doc: room, ownsParticipant: () => true, postNotice: () => ({ ok: false }) })
  const s = memorySession({ name: 'ada', kind: 'agent' }, dir, room, 'local/repo')
  s.lease = { sessionId: 's', fence: () => undefined } as never
  await expect(releaseIdleHeld(s, 'idle-1', IDLE_CLAIMS_MS, () => IDLE_CLAIMS_MS)).rejects.toThrow(/pending/)
  s.awareness.destroy(); room.doc.destroy(); registry.close()
})

it('M12 writes a minimal paused hook state after the name fence disappears', () => {
  const dir = temporary(), room = new RoomDoc(), awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { name: 'ada', kind: 'agent' } })
  const s = { dir, roomName: 'local/repo', me: { name: 'ada', kind: 'agent' }, room, awareness } as unknown as Session
  let fenced = true
  const bridge = new HooksBridge(s, { owedCount: () => 0, fenced: () => fenced, paused: () => fenced ? undefined : '[room] coordination paused', sessionDir: () => dir })
  bridge.write()
  fenced = false
  bridge.write()
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))).toMatchObject({ paused: '[room] coordination paused' })
  const successor = new HooksBridge(s, { owedCount: () => 4, fenced: () => true, sessionDir: () => dir })
  successor.write()
  bridge.write()
  bridge.stop()
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))).toMatchObject({ owedCount: 4 })
  awareness.destroy(); room.doc.destroy()
})

it('M7 inspects held work and durable worker decisions in every joined room', () => {
  const dir = temporary()
  const a = memorySession({ name: 'ada', kind: 'agent' }, dir, undefined, 'team/repo/main')
  const b = memorySession({ name: 'ada', kind: 'agent' }, dir, undefined, 'local/repo/main')
  b.room.setScope({ by: 'ada', byKind: 'agent', area: 'x', summary: 'x', paths: ['x'] })
  expect(joinedPresenceHolds([a, b])).toBe(true)
  expect(joinedPresenceWorkers([a, b], (_dir, room) => room === b.roomName)).toBe(true)
  a.awareness.destroy(); b.awareness.destroy(); a.room.doc.destroy(); b.room.doc.destroy()
})

it('M8 ends host presence in both rooms without deleting offline scopes and claims', async () => {
  const dir = temporary()
  execFileSync('git', ['init', '-q', dir])
  const a = memorySession({ name: 'ada', kind: 'agent' }, dir, undefined, 'team/repo/main')
  const b = memorySession({ name: 'ada', kind: 'agent' }, dir, undefined, 'local/repo/main')
  for (const s of [a, b]) {
    s.room.setScope({ by: 'ada', byKind: 'agent', area: 'x', summary: 'x', paths: ['x'] })
    s.room.addClaim({ path: 'x', from: 1, to: 1, by: 'ada', byKind: 'agent', intent: 'edit' })
  }
  let current: Session | null = a
  const left: Session[] = []
  const state = createHandlerState({ cwd: dir, getSession: () => current, setSession: s => { current = s }, leave: async s => { left.push(s) } })
  state.rooms.add(a, 'primary'); state.rooms.add(b, 'workers', a)
  await state.shutdown()
  expect(left).toEqual([b, a])
  for (const s of [a, b]) {
    expect(s.room.scope('ada')).toBeDefined()
    expect(s.room.openClaims()).toHaveLength(1)
    s.awareness.destroy(); s.room.doc.destroy()
  }
})
