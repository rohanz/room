import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { closeStorageAdmissions, storageGate } from '../src/storage-admission.js'
import { createTools } from '../src/tools.js'
import { Rooms } from '../src/registry.js'
import type { Session } from '../src/session.js'
import { testPolicyStore } from './policy-fixture.js'
import { hubSeam } from './fixtures/hub.js'

const dirs: string[] = []
afterEach(async () => { await closeStorageAdmissions(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('shutdown settles the tracked session registry open, so closing admissions leaves nothing registered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-shutdown-settle-'))
  dirs.push(dir)
  execFileSync('git', ['-C', dir, 'init', '-q'])
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  const room = new RoomDoc()
  const awareness = new Awareness(room.doc)
  const s = { room, awareness, me: { name: 'Rohan', kind: 'agent' }, dir, roomUrl: 'ws://127.0.0.1:9/r', roomName: 'r', browserUrl: '', shareMax: 'full', shareRequested: 'full', ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true } as never, daemon: { touch() {}, async stop() {} } as never } as Session
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir })
  tools.attachHooks(s)
  await tools.shutdown()
  awareness.destroy()
  await closeStorageAdmissions()
  // Nothing the session started may register or admit after this process acknowledged its close.
  for (let n = 0; n < 20; n++) await new Promise(resolve => setTimeout(resolve, 50))
  const status = await storageGate(join(dir, '.git')).status()
  expect(status.registrations).toBe(0)
  expect(status.tickets).toBe(0)
})

it('bounds the shutdown settle: hung background work is reported, not awaited forever', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-shutdown-settle-'))
  dirs.push(dir)
  execFileSync('git', ['-C', dir, 'init', '-q'])
  const room = new RoomDoc()
  const s = { room, dir } as Session
  let stopped = false, release!: () => void
  const hung = new Promise<void>(resolve => { release = resolve })
  const rooms = new Rooms({ primary: () => null, setPrimary: () => {}, log: () => {}, attach: () => ({ stop() { stopped = true }, settled: () => hung }) })
  rooms.add(s, 'primary')
  rooms.remove(s)
  expect(stopped).toBe(true)
  const started = performance.now()
  expect(await rooms.settle(100)).toBe(false)
  expect(performance.now() - started).toBeLessThan(2000)
  // Once the hung work ends, the same settle completes, the tracked registry open included.
  release()
  expect(await rooms.settle(30_000)).toBe(true)
})
