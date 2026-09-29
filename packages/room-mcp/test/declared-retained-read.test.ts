import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { RoomDoc, manifestKey } from '@room/shared'
import { startRoomd, type Roomd } from '@room/roomd'
import { createTools } from '../src/tools.js'
import { PolicyStore } from '../src/policy-store.js'
import { applySessionPolicy } from '../src/session.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'
import type { Session } from '../src/session.js'

const active: Array<{ daemon: Roomd; tools: ReturnType<typeof createTools>[]; root: string; awareness: Awareness }> = []
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

afterEach(async () => {
  for (const { daemon, tools, root, awareness } of active.splice(0)) {
    for (const t of tools) await t.shutdown()
    await daemon.stop()
    awareness.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})

it('room_done retains declared text in the manifest while out-of-area edits remain named gaps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'room-declared-read-'))
  const ownerDir = join(root, 'owner'), readerDir = join(root, 'reader')
  mkdirSync(ownerDir)
  git(ownerDir, 'init', '-q', '-b', 'main')
  git(ownerDir, 'config', 'user.email', 'test@example.com')
  git(ownerDir, 'config', 'user.name', 'Test')
  for (const p of ['a.py', 'b.py', 'private.py']) writeFileSync(join(ownerDir, p), `base ${p}\n`)
  git(ownerDir, 'add', '-A'); git(ownerDir, 'commit', '-q', '-m', 'base')
  git(root, 'clone', '-q', ownerDir, readerDir)
  let daemon: Roomd | undefined
  const store = await PolicyStore.open({ dir: ownerDir, room: 'local/test/main', participant: 'Owner', requested: 'declared',
    onChange: policy => { if (daemon) applySessionPolicy(daemon, policy) } })
  await store.declare(['a.py'])
  writeFileSync(join(ownerDir, 'a.py'), 'edited a\n')
  rmSync(join(ownerDir, 'b.py'))
  writeFileSync(join(ownerDir, 'private.py'), 'private edit\n')
  daemon = await startRoomd({ dir: ownerDir, name: 'Owner', room: 'ws://memory/local/test/main', localKey: 'test', sessionId: '1',
    policy: store.policy, onFullScan: (policy, entries, unsettled) => store.settle(policy, entries, unsettled).then(() => {}),
    basePollMs: 0, trackedRefreshMs: 60_000, log: () => {},
    providerFactory: (_server, _name, doc) => {
      const awareness = new Awareness(doc)
      const provider = { synced: true, awareness, on() { return provider }, off() { return provider }, destroy() { awareness.destroy() } }
      return provider as unknown as WebsocketProvider
    },
  })
  daemon.roomDoc.participants.set('Owner\0holder', { sessionId: 'owner-1', epoch: 1 })
  const owner: Session = { room: daemon.roomDoc, daemon, awareness: daemon.provider.awareness, provider: daemon.provider,
    policyStore: store, me: { name: 'Owner', kind: 'agent' }, dir: ownerDir, roomUrl: 'ws://memory/local/test/main',
    roomName: 'local/test/main', browserUrl: 'http://memory', shareMax: 'full', shareRequested: 'declared', ...hubSeam(daemon.roomDoc) }
  const ownerTools = createTools({ cwd: ownerDir, getSession: () => owner, setSession: () => {} })
  const readerDoc = new Y.Doc()
  Y.applyUpdate(readerDoc, Y.encodeStateAsUpdate(daemon.roomDoc.doc))
  daemon.roomDoc.doc.on('update', update => Y.applyUpdate(readerDoc, update))
  const readerRoom = new RoomDoc(readerDoc), awareness = new Awareness(readerDoc)
  awareness.setLocalState({ user: { name: 'Reader', kind: 'agent' }, status: 'idle', share: 'full' })
  const syncOwner = () => applyAwarenessUpdate(awareness, encodeAwarenessUpdate(daemon!.provider.awareness, [daemon!.roomDoc.doc.clientID]), 'test')
  syncOwner()
  const reader: Session = { room: readerRoom, daemon: { share: 'full', touch() {}, async stop() {} } as Roomd,
    awareness, provider: { synced: true, awareness } as WebsocketProvider, me: { name: 'Reader', kind: 'agent' },
    policyStore: testPolicyStore('full'),
    dir: readerDir, roomUrl: 'ws://memory/local/test/main', roomName: 'local/test/main', browserUrl: 'http://memory',
    shareMax: 'full', shareRequested: 'full', ...hubSeam(readerRoom) }
  const readerTools = createTools({ cwd: readerDir, getSession: () => reader, setSession: () => {} })
  active.push({ daemon, tools: [ownerTools, readerTools], root, awareness })

  vi.stubEnv('ROOM_WORKER_ID', '')
  const done = await ownerTools.call('room_done', { summary: 'edited a and deleted b' })
  vi.unstubAllEnvs()
  expect(done).toContain('marked done')
  await (daemon as unknown as { publisher: { reconcile(paths: 'all'): Promise<void> } }).publisher.reconcile('all')
  await vi.waitFor(() => expect(store.retained).toEqual(['a.py']))
  syncOwner()
  expect(readerRoom.scope('Owner')).toBeUndefined()
  expect(readerRoom.manifestHead.get('Owner')?.textPrefixes).toEqual(['a.py'])
  expect(readerRoom.manifest.get(manifestKey('Owner', readerRoom.manifestHead.get('Owner')!.fence))?.get('private.py'))
    .toMatchObject({ state: 'held', held: 'scope' })
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'a.py' })).toContain('edited a')
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'a.py', diff: true })).toContain('+edited a')
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'b.py' })).toContain('deleted by Owner')
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'private.py' })).toContain('outside their declared area')
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'private.py', diff: true })).toContain('outside their declared area')
  const all = await readerTools.call('room_read', { person: 'Owner', diff: true })
  expect(all).toContain('+edited a')
  expect(all).toContain('-base b.py')
  expect(all).toContain('private.py changed by Owner')
  expect(all).not.toContain('private edit')

  // A stale overlay from an earlier full-sharing incarnation is never a read authority.
  readerRoom.setOverlay('Owner', 'private.py', 'stale full-sharing text\n')
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'private.py' })).not.toContain('stale full-sharing text')
  writeFileSync(join(ownerDir, 'a.py'), 'base a.py\n')
  await (daemon as unknown as { publisher: { reconcile(paths: 'all'): Promise<void> } }).publisher.reconcile('all')
  await vi.waitFor(() => expect(store.retained).toEqual([]))
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'a.py' })).toContain('base a.py')
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'a.py', diff: true })).toContain('no difference')
})
