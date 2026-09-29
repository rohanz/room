// Repository rooms keep worker authority in the durable local registry, not in RoomDoc.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { JoinOptions, Session } from '../src/session.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { seedRegistryWorker } from './registry-fixture.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'
import { prepareWorktree } from '../src/worker-git.js'
import { registryForDir } from '../src/worker-registry.js'

let dir: string
const dispose: (() => Promise<void> | void)[] = []
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) vi.stubEnv(key, undefined)
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-move-workers-')))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Rohan', '-c', 'user.email=r@r', 'commit', '-q', '--allow-empty', '-m', 'init'])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/rohanz/x.git'])
})
afterEach(async () => {
  for (const fn of dispose.splice(0).reverse()) await fn()
  await closeRegistryForDir(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function fakeSession(local: boolean): Session {
  const doc = new Y.Doc(), room = new RoomDoc(doc), awareness = new Awareness(doc)
  dispose.push(() => { awareness.destroy(); doc.destroy() })
  const roomName = local ? `local/${path.basename(dir)}` : 'github.com/rohanz/x'
  return {
    dir, room, awareness, roomName,
    roomUrl: `${local ? 'ws://127.0.0.1:1' : 'ws://team.example'}/${encodeURIComponent(roomName)}`,
    browserUrl: 'http://localhost/', me: { name: 'rohanz', owner: 'rohanz', kind: 'agent' },
    ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true, awareness },
    daemon: { touch() {}, async stop() {}, skipped: () => ({ share: [], size: [], budget: [], ignore: [] }) },
    shareMax: 'full', shareRequested: 'full',
    ...(local ? { local: { url: 'ws://127.0.0.1:1' } } : {}),
  } as Session
}

function setup(join: (options: JoinOptions) => Promise<Session> = async () => fakeSession(true),
  options: { leave?: (s: Session) => Promise<void>; worktree?: typeof prepareWorktree } = {}) {
  let current: Session | null = fakeSession(false)
  const old = current
  const left: Session[] = []
  const exits: Array<(code: number | null) => void> = []
  let nextPid = 5000
  const alive = new Set<number>()
  const tools = createTools({ cwd: dir, getSession: () => current, setSession: s => { current = s },
    join, leave: async s => { await options.leave?.(s); left.push(s) },
    probe: pid => alive.has(pid) ? { startTime: `fixture:${pid}`, executable: 'node' } : undefined,
    spawner: () => { const pid = ++nextPid; alive.add(pid); const callbacks: Array<(code: number | null) => void> = []
      exits.push(code => { alive.delete(pid); for (const callback of callbacks) callback(code) })
      return { pid, started: Promise.resolve(), onExit: cb => { callbacks.push(cb) }, kill: () => true } },
    worktree: options.worktree ?? ((repo, tag) => prepareWorktree(repo, tag, 'rohanz')) })
  dispose.push(() => tools.shutdown())
  return { tools, old, left, exits, current: () => current }
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

it('refuses to move while a finished local worker is uncollected, then moves after retirement', async () => {
  const t = setup()
  const { registry, record } = await seedRegistryWorker(dir, 'money')
  await registry.update(record.id, old => ({ ...old, lead: { ...old.lead, participant: 'rohanz', room: t.old.roomName }, seq: old.seq + 1 }))
  await registry.writeExit(record.id, { run: 1, code: 0, at: Date.now(), witnessed: true })

  const blocked = await t.tools.call('room_join', { where: 'local' })
  expect(blocked).toContain('You have 1 worker(s) (money). Collect or discard them first')
  expect(t.current()).toBe(t.old)
  expect(t.left).toEqual([])

  await registry.update(record.id, old => ({ ...old, phase: 'retired', seq: old.seq + 1 }))
  expect(await t.tools.call('room_join', { where: 'local' })).toContain(`moved from ${t.old.roomName}`)
  expect(t.left).toEqual([t.old])
})

it('a send requested during a move posts in the room reached by that move', async () => {
  let release!: () => void
  let started!: () => void
  const reached = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const target = fakeSession(true)
  const t = setup(async () => { started(); await gate; return target })
  const moving = t.tools.call('room_join', { where: 'local' })
  await reached
  const sending = t.tools.call('room_send', { type: 'note', text: 'after the move' })
  let sent = false
  void sending.then(() => { sent = true })
  await nextTurn()
  expect(sent).toBe(false)
  expect(t.old.room.messages().some(m => m.type === 'note' && m.text === 'after the move')).toBe(false)
  release()
  await moving
  await sending
  expect(target.room.messages().some(m => m.type === 'note' && m.text === 'after the move')).toBe(true)
  expect(t.old.room.messages().some(m => m.type === 'note' && m.text === 'after the move')).toBe(false)
})

it('keeps the workers room when its shutdown fails and reuses it for the next spawn', async () => {
  let fail = true
  let joins = 0
  const t = setup(async () => { joins++; return fakeSession(true) }, { leave: async s => {
    if (fail && s.local) throw new Error('stop failed')
  } })
  expect(await t.tools.call('room_spawn', { tag: 'money', task: 'cents', where: 'local' })).toContain('spawned money')
  t.exits[0](0)
  const registry = await registryForDir(dir)
  await vi.waitFor(() => expect(registry.exits(registry.reserved('money')!.id)).toHaveLength(1))
  expect(await t.tools.call('room_collect', { tag: 'money', discard: true })).toContain('discarded money')
  expect(await t.tools.call('room_join', { where: 'local' })).toContain('closing the workers room failed (stop failed)')
  expect(t.current()).toBe(t.old)
  expect(await t.tools.call('room_spawn', { tag: 'more', task: 'again', where: 'local' })).toContain('spawned more')
  expect(joins).toBe(1)
  fail = false
  t.exits[1](0)
})

it('a spawn requested during a move starts in the destination room', async () => {
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const joined = new Promise<void>(resolve => { reached = resolve })
  const target = fakeSession(true)
  const t = setup(async () => { reached(); await gate; return target })
  const moving = t.tools.call('room_join', { where: 'local' })
  await joined
  const spawning = t.tools.call('room_spawn', { tag: 'late', task: 'after move', where: 'local' })
  let spawned = false
  void spawning.then(() => { spawned = true })
  await nextTurn()
  expect(spawned).toBe(false)
  expect((await registryForDir(dir)).reserved('late')).toBeUndefined()
  release()
  expect(await moving).toContain('moved from')
  expect(await spawning).toContain('spawned late')
  expect((await registryForDir(dir)).reserved('late')?.room).toBe(target.roomName)
  expect(t.current()).toBe(target)
  t.exits[0](0)
})

it('a move requested during spawn preparation waits, then refuses the new worker', async () => {
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const preparing = new Promise<void>(resolve => { reached = resolve })
  const t = setup(undefined, { worktree: async (repo, tag, ...rest) => {
    reached(); await gate; return prepareWorktree(repo, tag, ...rest)
  } })
  const spawning = t.tools.call('room_spawn', { tag: 'early', task: 'before move', where: 'local' })
  await preparing
  const moving = t.tools.call('room_join', { where: 'local' })
  let moved = false
  void moving.then(() => { moved = true })
  await nextTurn()
  expect(moved).toBe(false)
  release()
  expect(await spawning).toContain('spawned early')
  expect(await moving).toContain('You have 1 worker(s) (early). Collect or discard them first')
  expect(t.current()).toBe(t.old)
  t.exits[0](0)
})

it('a move requested during discard waits for retirement and then moves', async () => {
  const t = setup()
  expect(await t.tools.call('room_spawn', { tag: 'money', task: 'cents', where: 'local' })).toContain('spawned money')
  const registry = await registryForDir(dir)
  const discarding = t.tools.call('room_collect', { tag: 'money', discard: true })
  await vi.waitFor(() => expect(registry.reserved('money')?.phase).toBe('discarding'))
  const moving = t.tools.call('room_join', { where: 'local' })
  let moved = false
  void moving.then(() => { moved = true })
  await nextTurn()
  expect(moved).toBe(false)
  expect(t.left).toEqual([])
  t.exits[0](1)
  expect(await discarding).toContain('discarded money')
  expect(await moving).toContain('moved from')
  expect(t.left).toContain(t.old)
})
