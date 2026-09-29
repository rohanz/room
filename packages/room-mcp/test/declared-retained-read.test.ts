import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { RoomDoc } from '@room/shared'
import { startRoomd, type Roomd } from '@room/roomd'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'

const active: Array<{ daemon: Roomd; ownerTools: ReturnType<typeof createTools>; readerTools: ReturnType<typeof createTools>; root: string; readerAwareness: Awareness }> = []

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'room-declared-retained-read-'))
  const ownerDir = join(root, 'owner')
  const readerDir = join(root, 'reader')
  mkdirSync(ownerDir)
  git(ownerDir, 'init', '-q', '-b', 'main')
  git(ownerDir, 'config', 'user.email', 'test@example.com')
  git(ownerDir, 'config', 'user.name', 'Test')
  writeFileSync(join(ownerDir, 'a.py'), 'base a\n')
  writeFileSync(join(ownerDir, 'b.py'), 'base b\n')
  writeFileSync(join(ownerDir, 'private.py'), 'private base\n')
  git(ownerDir, 'add', '-A')
  git(ownerDir, 'commit', '-q', '-m', 'base')
  git(root, 'clone', '-q', ownerDir, readerDir)

  const daemon = await startRoomd({ dir: ownerDir, name: 'Owner', room: 'ws://memory/declared-retained-read', share: 'declared',
    debounceMs: 20, hotThrottleMs: 100, trackedRefreshMs: 60_000, basePollMs: 60_000, log: () => {},
    providerFactory: (_server, _name, doc) => {
      const awareness = new Awareness(doc)
      const provider = { synced: true, awareness, on() { return provider }, off() { return provider }, destroy() { awareness.destroy() } }
      return provider as unknown as WebsocketProvider
    },
  })
  const owner: Session = {
    room: daemon.roomDoc, daemon, awareness: daemon.provider.awareness, provider: daemon.provider,
    me: { name: 'Owner', kind: 'agent' }, dir: ownerDir, roomUrl: 'ws://memory/declared-retained-read',
    roomName: 'declared-retained-read', browserUrl: 'http://memory', shareMax: 'full', shareRequested: 'declared',
  }
  const ownerTools = createTools({ cwd: ownerDir, getSession: () => owner, setSession: () => {} })

  const readerDoc = new Y.Doc()
  Y.applyUpdate(readerDoc, Y.encodeStateAsUpdate(daemon.roomDoc.doc))
  daemon.roomDoc.doc.on('update', update => Y.applyUpdate(readerDoc, update))
  const readerRoom = new RoomDoc(readerDoc)
  const readerAwareness = new Awareness(readerDoc)
  readerAwareness.setLocalState({ user: { name: 'Reader', kind: 'agent' }, status: 'idle', share: 'full' })
  applyAwarenessUpdate(readerAwareness, encodeAwarenessUpdate(daemon.provider.awareness, [daemon.roomDoc.doc.clientID]), 'test')
  const reader: Session = {
    room: readerRoom, daemon: { share: 'full', touch() {}, async stop() {} } as Roomd, awareness: readerAwareness,
    provider: { synced: true, awareness: readerAwareness } as WebsocketProvider,
    me: { name: 'Reader', kind: 'agent' }, dir: readerDir, roomUrl: 'ws://memory/declared-retained-read',
    roomName: 'declared-retained-read', browserUrl: 'http://memory', shareMax: 'full', shareRequested: 'full',
  }
  const readerTools = createTools({ cwd: readerDir, getSession: () => reader, setSession: () => {} })
  active.push({ daemon, ownerTools, readerTools, root, readerAwareness })
  const pending = (path: string) => (daemon as unknown as { batch: { add(path: string, fresh: boolean): void } }).batch.add(path, false)
  const ownerPresenceId = daemon.roomDoc.doc.clientID
  const syncOwnerPresence = () => applyAwarenessUpdate(readerAwareness, encodeAwarenessUpdate(daemon.provider.awareness, [ownerPresenceId]), 'test')
  const readerOwnerPresence = () => readerAwareness.getStates().get(ownerPresenceId) as { share?: string; retained?: string[] }
  return { daemon, ownerTools, readerTools, ownerDir, readerRoom, pending, syncOwnerPresence, readerOwnerPresence }
}

afterEach(async () => {
  for (const { daemon, ownerTools, readerTools, root, readerAwareness } of active.splice(0)) {
    await readerTools.shutdown()
    await ownerTools.shutdown()
    await daemon.stop()
    readerAwareness.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})

it('reads and previews edited and deleted declared files retained after room_done, then refuses a reverted path', async () => {
  const { daemon, ownerTools, readerTools, ownerDir, readerRoom, pending, syncOwnerPresence, readerOwnerPresence } = await setup()
  daemon.roomDoc.setScope({ by: 'Owner', byKind: 'agent', area: 'change', summary: 'edit two files', paths: ['a.py', 'b.py'] })
  writeFileSync(join(ownerDir, 'a.py'), 'edited a\n')
  rmSync(join(ownerDir, 'b.py'))
  pending('a.py')
  pending('b.py')
  await vi.waitFor(() => {
    expect(readerRoom.text('a.py', 'Owner')).toBe('edited a\n')
    expect(readerRoom.deleted.get('Owner')?.has('b.py')).toBe(true)
  })

  const done = await ownerTools.call('room_done', { summary: 'edited a and deleted b' })
  expect(done).toContain('2 changed file(s) you declared earlier stay shared while they differ from your base: a.py, b.py')
  expect(readerRoom.scope('Owner')).toBeUndefined()
  expect(daemon.retainedDeclared()).toEqual(['a.py', 'b.py'])
  expect(daemon.provider.awareness.getLocalState()?.publishUnder).toBeUndefined()
  expect(daemon.provider.awareness.getLocalState()).toMatchObject({ share: 'declared', retained: ['a.py', 'b.py'] })
  syncOwnerPresence()
  expect(readerOwnerPresence().retained).toEqual(['a.py', 'b.py'])

  expect(await readerTools.call('room_read', { person: 'Owner', path: 'a.py' })).toContain('edited a')
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'b.py' })).toContain('deleted by Owner')
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'a.py', diff: true })).toContain('+edited a')
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'b.py', diff: true })).toContain('-base b')
  const all = await readerTools.call('room_read', { person: 'Owner', diff: true })
  expect(all).toContain('+edited a')
  expect(all).toContain('-base b')
  expect(all).toContain('declared paths only')
  expect(all).toContain('published')
  const preview = await readerTools.call('room_preview_merge', { person: 'Owner' })
  expect(preview).toContain('a.py (Owner only)')
  expect(preview).toContain('b.py (Owner only)')
  expect(preview).toContain('retained changes still published from earlier scopes')
  expect(preview).not.toContain('not shared')

  const privateRefusal = 'private.py: not shared (Owner shares declared paths only; private.py is outside their scope)'
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'private.py' })).toContain(privateRefusal)
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'private.py', diff: true })).toContain(privateRefusal)

  writeFileSync(join(ownerDir, 'a.py'), 'base a\n')
  pending('a.py')
  await vi.waitFor(() => {
    expect(daemon.retainedDeclared()).toEqual(['b.py'])
    expect(readerRoom.text('a.py', 'Owner')).toBeUndefined()
  })
  syncOwnerPresence()
  expect(readerOwnerPresence().retained).toEqual(['b.py'])
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'a.py' })).toContain('not shared')
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'a.py', diff: true })).toContain('not shared')

  writeFileSync(join(ownerDir, 'b.py'), 'base b\n')
  pending('b.py')
  await vi.waitFor(() => {
    expect(daemon.retainedDeclared()).toEqual([])
    expect(readerRoom.deleted.get('Owner')?.has('b.py')).toBe(false)
  })
  syncOwnerPresence()
  expect(readerOwnerPresence().retained).toEqual([])
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'b.py' })).toContain('not shared')
})

it('refuses a stale full-sharing overlay on a declared restart without a retained record', async () => {
  const { readerRoom, readerTools, readerOwnerPresence } = await setup()
  // A resumed room can deliver its old overlay before the new daemon reconciles it.
  readerRoom.setOverlay('Owner', 'private.py', 'old full-sharing text\n')
  expect(readerOwnerPresence().share).toBe('declared')
  expect(readerOwnerPresence().retained).toEqual([])
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'private.py' })).toContain('not shared')
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'private.py', diff: true })).toContain('not shared')
  const all = await readerTools.call('room_read', { person: 'Owner', diff: true })
  expect(all).not.toContain('old full-sharing text')
  expect(all).toContain('1 other changed file(s) are not shared')
  delete readerOwnerPresence().retained // an older client has no retained field
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'private.py' })).toContain('not shared')
})

it('refuses an out-of-scope overlay as soon as full sharing narrows to declared', async () => {
  const { readerRoom, readerTools, readerOwnerPresence } = await setup()
  readerRoom.setOverlay('Owner', 'private.py', 'full-sharing text\n')
  const presence = readerOwnerPresence()
  presence.share = 'full'
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'private.py' })).toContain('full-sharing text')
  // Awareness can arrive ahead of the overlay withdrawal on another machine.
  presence.share = 'declared'
  presence.retained = []
  expect(readerRoom.text('private.py', 'Owner')).toBe('full-sharing text\n')
  expect(await readerTools.call('room_read', { person: 'Owner', path: 'private.py' })).toContain('not shared')
  const all = await readerTools.call('room_read', { person: 'Owner', diff: true })
  expect(all).not.toContain('full-sharing text')
  expect(all).toContain('1 other changed file(s) are not shared')
})

it('bounds retained paths in presence and keeps paths beyond the cap private', async () => {
  const { daemon, readerRoom, readerTools, syncOwnerPresence, readerOwnerPresence } = await setup()
  const paths = Array.from({ length: 257 }, (_, i) => `file-${i}.py`)
  ;(daemon as unknown as { publisher: { setRetained(paths: Set<string>): void } }).publisher.setRetained(new Set(paths))
  daemon.touch()
  syncOwnerPresence()
  const published = readerOwnerPresence().retained ?? []
  expect(published).toHaveLength(256)
  const omitted = paths.find(path => !published.includes(path))!
  readerRoom.setOverlay('Owner', omitted, 'stale text\n')
  expect(await readerTools.call('room_read', { person: 'Owner', path: omitted })).toContain('not shared')
})
