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

function setup(join: (options: JoinOptions) => Promise<Session> = async () => fakeSession(true)) {
  let current: Session | null = fakeSession(false)
  const old = current
  const left: Session[] = []
  const tools = createTools({ cwd: dir, getSession: () => current, setSession: s => { current = s },
    join, leave: async s => { left.push(s) } })
  dispose.push(() => tools.shutdown())
  return { tools, old, left, current: () => current }
}

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
  expect(t.old.room.messages().some(m => m.type === 'note' && m.text === 'after the move')).toBe(false)
  release()
  await moving
  await sending
  expect(target.room.messages().some(m => m.type === 'note' && m.text === 'after the move')).toBe(true)
  expect(t.old.room.messages().some(m => m.type === 'note' && m.text === 'after the move')).toBe(false)
})
