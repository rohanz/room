import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, gitBlobHash, manifestKey, type ManifestEntry } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { ConflictSet } from '../src/conflict-set.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import { seedRegistryWorker } from './registry-fixture.js'
import { hubSeam } from './fixtures/hub.js'
import type { Session } from '../src/session.js'

const stops: (() => Promise<void>)[] = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'room-reservation-privacy-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'review'); git('config', 'user.email', 'review@example.com')
  writeFileSync(join(dir, 'x'), 'base\n'); git('add', 'x'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD'), registry = await registryForDir(dir)
  const { record } = await seedRegistryWorker(dir, 'work', { name: 'L+work', base, carriedBase: base,
    room: 'local/L', projectedInto: 'team/review', lead: { participant: 'L', room: 'local/L', instance: registry.instance } })
  git('worktree', 'add', '-q', '-b', record.branch, record.dir, base)
  writeFileSync(join(record.dir, 'x'), 'worker\n')
  const room = new RoomDoc(), awareness = new Awareness(new Y.Doc()), seam = hubSeam(room)
  const me = { name: 'L', kind: 'agent' as const }
  awareness.setLocalState({ user: me, sessionId: 'session-L' })
  room.ensureRoomSalt()
  for (const [name, text] of [['L', 'lead\n'], [record.name, 'worker\n']]) {
    epochPublication(room, name, base, 1)
    room.participants.set(`${name}\0id`, { name, kind: 'agent' })
    const projected = name === record.name, entries = new Y.Map<ManifestEntry>()
    entries.set('x', { state: projected ? 'held' : 'shared', change: 'M', hash: gitBlobHash(text),
      ...(projected ? { held: 'worker' as const } : {}), fence: '1', at: 1 })
    room.manifest.set(manifestKey(name, '1'), entries)
    if (!projected) room.setOverlay(manifestKey(name, '1'), 'x', text)
    room.manifestHead.set(name, { base, fence: '1', coverage: { kind: 'all' }, complete: true,
      level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: Date.now(),
      ...(projected ? { projectedFrom: record.id, projectedBy: 'L' } : {}) })
    if (projected) {
      room.participants.delete(`${name}\0holder`)
      room.participants.set(`${name}\0proj`, { projectedFrom: record.id, projectedBy: 'L' })
    }
  }
  const session = { ...seam, dir, room, awareness, me, roomName: 'team/review',
    lease: { fence: () => '1' }, daemon: { fence: '1' }, provider: { synced: true } } as unknown as Session
  const set = new ConflictSet(session, 'L', session, () => {}, 0)
  stops.push(async () => {
    set.stop(); seam.hub.close(); awareness.destroy(); awareness.doc.destroy(); room.doc.destroy()
    await closeRegistryForDir(dir); rmSync(dir, { recursive: true, force: true })
  })
  return { room, set, registry, record, base }
}

it.each(['missing', 'earlier incarnation'])('does not publish a family notice when its reservation is %s', async damage => {
  const { room, set, registry, record } = await fixture()
  await set.reconcile('intact reservation')
  expect(room.messages().filter(m => m.type === 'merge-conflict')).toEqual([])
  const tagFile = join(registry.root, 'tags', `${record.tag}.json`)
  if (damage === 'missing') rmSync(tagFile)
  else {
    const oldId = 'w_old_incarnation'
    writeFileSync(join(registry.root, 'workers', `${oldId}.json`), JSON.stringify({ ...record, id: oldId, phase: 'retired' }))
    writeFileSync(tagFile, JSON.stringify({ id: oldId }))
  }
  await set.reconcile('lost current reservation')
  expect(room.messages().filter(m => m.type === 'merge-conflict')).toEqual([])
})

it('keeps cross-team warnings and clears independent of unrelated historical quarantine', async () => {
  const { room, set, registry, base } = await fixture()
  const quarantine = join(registry.root, 'quarantine')
  mkdirSync(quarantine, { recursive: true })
  writeFileSync(join(quarantine, 'w_unreserved_history.json.bad-test'), '{broken old record')
  epochPublication(room, 'R', base, 1)
  room.participants.set('R\0id', { name: 'R', kind: 'agent' })
  const entries = new Y.Map<ManifestEntry>()
  entries.set('x', { change: 'M', state: 'shared', hash: gitBlobHash('teammate\n'), fence: '1', at: 1 })
  room.manifest.set(manifestKey('R', '1'), entries)
  room.setOverlay(manifestKey('R', '1'), 'x', 'teammate\n')
  room.manifestHead.set('R', { base, fence: '1', coverage: { kind: 'all' }, complete: true,
    level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: Date.now() })
  await set.reconcile('unrelated history does not withhold warning')
  const notices = () => room.messages().filter(m => m.type === 'merge-conflict' && m.to === 'L')
  expect(notices()).toHaveLength(1)
  expect(notices()[0]).toMatchObject({ priority: 'notify' })
  entries.clear()
  room.manifestHead.set('R', { ...room.manifestHead.get('R')!, rev: 2, semRev: 2 })
  await set.reconcile('unrelated history does not withhold clear')
  expect(notices()).toHaveLength(2)
  expect(notices()[1]).toMatchObject({ clearedFrom: 'conflict', priority: 'fyi' })
})
