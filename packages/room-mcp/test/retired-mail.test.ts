import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { admit, deliveryIndex, MAIL_BYTES, memorySnapshot, RoomDoc, type Msg } from '@room/shared'
import { Rooms } from '../src/registry.js'
import type { Session } from '../src/session.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { seedRegistryWorker } from './registry-fixture.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-retired-mail-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('init', '-qb', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@test'); git('commit', '-qm', 'initial', '--allow-empty')
  const room = new RoomDoc()
  const s = { ...hubSeam(room), policyStore: testPolicyStore(), room, dir, me: { name: 'lead' }, roomName: 'local/test/main',
    roomUrl: 'ws://team/local%2Ftest%2Fmain', daemon: { fence: 'lead-session' }, provider: { on() {}, off() {} } } as unknown as Session
  const rooms = new Rooms({ primary: () => s, setPrimary: () => {}, attach: () => ({ stop() {} }), listCwdProcesses: () => [] })
  rooms.track(s)
  cleanups.push(async () => { rooms.remove(s); room.doc.destroy(); await closeRegistryForDir(dir); fs.rmSync(dir, { recursive: true, force: true }) })
  return { dir, room, s, rooms }
}
const message = (id: string, to: string, text = 'hello'): Msg => ({ id, type: 'note', from: 'sender', to, text, at: Date.now(), priority: 'notify' })
const checkTotals = (room: RoomDoc) => {
  const index = deliveryIndex(room)
  const before = { bytes: index.owedBytes, recipients: structuredClone(index.recipients), ids: [...index.pending.keys()].sort() }
  index.rebuild()
  expect({ bytes: index.owedBytes, recipients: index.recipients, ids: [...index.pending.keys()].sort() }).toEqual(before)
}
async function retired(dir: string, tag: string) {
  const { registry, record } = await seedRegistryWorker(dir, tag)
  await registry.beginRetirement(record.id, await registry.archiveOf(record, { summary: 'done' }))
  await registry.finishCleanup(record.id, record.room)
  return { registry, record: (await registry.read(record.id))! }
}

it('the hourly pass ends old and late mail using the lead registry, preserving reused tags and other recipients', async () => {
  const { dir, room, s, rooms } = fixture()
  const { registry, record } = await retired(dir, 'gone')
  const { record: previous } = await retired(dir, 'reused')
  const { record: successor } = await seedRegistryWorker(dir, 'reused')
  // Keep the live successor out of unrelated nothing-to-collect and process-exit cleanup.
  fs.mkdirSync(successor.dir, { recursive: true })
  rooms.setHandle(s, successor.id, { pid: process.pid, onExit() {}, kill: () => true })
  room.doc.getArray('retiredWorkers').push([record.archive!, previous.archive!])
  const another = await retired(dir, 'other')
  // A record owned by another lead, even in this registry, is not authority for this session.
  const file = path.join(registry.root, 'workers', `${another.record.id}.json`)
  const otherRecord = { ...another.record, name: 'another+other', lead: { ...another.record.lead, participant: 'another' },
    archive: { ...another.record.archive!, name: 'another+other', lead: 'another' } }
  fs.writeFileSync(file, JSON.stringify(otherRecord))
  room.doc.getArray('retiredWorkers').push([otherRecord.archive])
  await registry.pruneRetired(0)
  expect(await registry.read(record.id)).toBeUndefined()
  room.mail.set('old', message('old', record.name))
  room.bus.push([message('late', record.name), message('successor', successor.name), message('other', otherRecord.name), message('ordinary', 'lead+ordinary')])
  let atomicDeletion = false
  room.mail.observe(event => {
    if (event.changes.keys.get('old')?.action === 'delete') {
      atomicDeletion = event.transaction.changed.get(room.outcomes)?.has('old') === true
      expect(room.outcomes.get('old')?.outcome).toBe('recipient-retired')
    }
  })
  deliveryIndex(room)
  checkTotals(room)
  await rooms.autoRetire()
  expect(atomicDeletion).toBe(true)
  expect(room.outcomes.get('old')?.outcome).toBe('recipient-retired')
  expect(room.outcomes.get('late')?.outcome).toBe('recipient-retired')
  expect(room.mail.has('old')).toBe(false)
  expect(room.messages().some(m => m.id === 'late')).toBe(true)
  for (const id of ['successor', 'other', 'ordinary']) {
    expect(room.outcomes.has(id)).toBe(false)
    expect(deliveryIndex(room).pending.has(id)).toBe(true)
  }
  checkTotals(room)
  // The existing hourly cadence, rather than a new timer, catches later arrivals.
  room.bus.push([message('later', record.name)])
  checkTotals(room)
  await rooms.autoRetire()
  expect(room.outcomes.has('later')).toBe(false)
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 3_600_001)
  await rooms.autoRetire()
  expect(room.outcomes.get('later')?.outcome).toBe('recipient-retired')
  checkTotals(room)
})

it('loads saved over-cap mail and admits an addressed send after one lead retention pass', async () => {
  const { dir, room, rooms } = fixture()
  const { record } = await retired(dir, 'gone')
  const saved = new RoomDoc()
  saved.doc.getArray('retiredWorkers').push([record.archive!])
  saved.doc.transact(() => {
    for (let i = 0; i < 200; i++) {
      const m = message(`old-${i}`, record.name, 'x'.repeat(9000))
      if (i % 2) saved.bus.push([m]); else saved.mail.set(m.id, m)
    }
  })
  const snapshotFile = path.join(dir, 'saved.ydoc')
  fs.writeFileSync(snapshotFile, memorySnapshot(saved.doc)); saved.doc.destroy()
  Y.applyUpdate(room.doc, fs.readFileSync(snapshotFile))
  expect(deliveryIndex(room).owedBytes).toBeGreaterThan(MAIL_BYTES)
  checkTotals(room)
  await rooms.autoRetire()
  expect(deliveryIndex(room).owedBytes).toBe(0)
  expect(room.mail.size).toBe(0)
  expect(admit(room, { to: 'another', text: 'hello' }, Date.now())).toEqual({ ok: true })
  checkTotals(room)
})

it('keeps mail when the on-disk worker inventory is incomplete', async () => {
  const { dir, room, rooms } = fixture()
  const { registry, record } = await retired(dir, 'gone')
  room.mail.set('old', message('old', record.name))
  fs.writeFileSync(path.join(registry.root, 'workers', 'w_broken.json'), '{')
  await expect(rooms.autoRetire()).rejects.toThrow(/blocked/)
  expect(room.outcomes.has('old')).toBe(false)
  expect(room.mail.has('old')).toBe(true)
  checkTotals(room)
})

it('heals retired publications and recorded-subject notices while preserving unbound notices after the retiring session exited', async () => {
  const { dir, room, rooms } = fixture()
  const { record } = await retired(dir, 'gone')
  room.doc.getArray('retiredWorkers').push([record.archive!])
  room.participants.set(`${record.name}\0holder`, { workerId: record.id, epoch: 1, sessionId: 'old', ended: 'released' })
  room.manifestHead.set(record.name, { fence: '1' } as any)
  room.manifest.set(`${record.name}\0${1}`, new Y.Map())
  room.setOverlay(`${record.name}\0${1}`, 'x', 'retired text')
  room.doc.getMap('completedPublications').set('old', { worker: { id: record.id } })
  const notice = { ...message('cf:legacy', 'lead'), type: 'merge-conflict', from: 'room', path: 'x', text: `x conflicts with ${record.name}'s version at lines 1` } as Msg
  room.mail.set(notice.id, notice)
  room.bus.push([{ ...notice, id: 'cf:bus' }, message('ordinary', 'lead', `Discuss ${record.name}`)])
  room.bus.push([{ ...notice, id: 'cf:recorded', noticeSubjects: [{ name: record.name, workerId: record.id }] }])
  await rooms.autoRetire()
  expect(room.manifestHead.has(record.name)).toBe(false)
  expect(room.manifest.size).toBe(0)
  expect(room.overlays.size).toBe(0)
  expect(room.doc.getMap('completedPublications').size).toBe(0)
  expect(deliveryIndex(room).pending.has('cf:legacy')).toBe(true)
  expect(deliveryIndex(room).pending.has('cf:bus')).toBe(true)
  expect(deliveryIndex(room).pending.has('cf:recorded')).toBe(false)
  expect(deliveryIndex(room).pending.has('ordinary')).toBe(true)
})

it('heals a registry-proven retired worker dispatched by a departed lead', async () => {
  const { dir, room, rooms } = fixture()
  const { registry, record } = await retired(dir, 'gone')
  const file = path.join(registry.root, 'workers', `${record.id}.json`)
  const gone = { ...record, name: 'departed+gone', lead: { ...record.lead, participant: 'departed' },
    archive: { ...record.archive!, name: 'departed+gone', lead: 'departed' } }
  fs.writeFileSync(file, JSON.stringify(gone))
  room.doc.getArray('retiredWorkers').push([gone.archive])
  room.manifestHead.set(gone.name, { fence: '1' } as any)
  room.mail.set('cf:departed', { ...message('cf:departed', 'lead'), from: 'room', type: 'merge-conflict', path: 'x', text: `x conflicts with ${gone.name}'s version` } as Msg)
  room.mail.set('cf:departed-recorded', { ...room.mail.get('cf:departed')!, id: 'cf:departed-recorded', noticeSubjects: [{ name: gone.name, workerId: gone.id }] })
  await rooms.autoRetire()
  expect(room.manifestHead.has(gone.name)).toBe(false)
  expect(deliveryIndex(room).pending.has('cf:departed')).toBe(true)
  expect(deliveryIndex(room).pending.has('cf:departed-recorded')).toBe(false)
})
