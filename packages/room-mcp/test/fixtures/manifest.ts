import * as Y from 'yjs'
import fs from 'node:fs'
import pathModule from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitBlobHash, manifestKey, participantRecord, type ManifestEntry, type RoomDoc } from '@room/shared'
import { syntheticSessionId } from '../../src/session.js'
import { visiblePeer } from './visible.js'

const localRoots = new WeakMap<RoomDoc, { name: string; dir: string }>()
/** The caller's own version comes from its checkout, including in tests. */
export function setFixtureLocalRoot(room: RoomDoc, name: string, dir: string): void { localRoots.set(room, { name, dir }) }

/** A fixture holder is the session id an unbound test session's Ledger fences on, so the caller's own receipts still land. */
const FIXTURE_HOLDER = syntheticSessionId({ pid: process.pid, startTime: '', executable: '' })

/** A registered worker's lease carries its registry id, as the hub records it; others hold a plain session. */
function fixtureHolder(room: RoomDoc, name: string, sessionId: string): { sessionId: string; workerId?: string } {
  const view = [...room.workerViews.values()].find(v => v.name === name)
  return view ? { sessionId, workerId: view.id } : { sessionId }
}

/** A worker registered after its text was published takes over the fixture holder, as its lease would. */
export function stampFixtureWorker(room: RoomDoc, name: string, workerId: string): void {
  const holder = participantRecord(room, name)?.holder
  if (holder && !holder.workerId) room.participants.set(`${name}\u0000holder`, { ...holder, workerId })
}

/** Publish a test participant's current text in the schema-2 incarnation. */
export function publishFixture(room: RoomDoc, name: string, path: string, text: string, options: { fence?: string; base?: string; level?: 'intent' | 'declared' | 'full' } = {}): void {
  const local = localRoots.get(room)
  if (local?.name === name) {
    const file = pathModule.join(local.dir, path)
    fs.mkdirSync(pathModule.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  const record = participantRecord(room, name)
  const fence = options.fence ?? record?.holder?.sessionId ?? FIXTURE_HOLDER
  visiblePeer(room, name, 'agent', fence)
  const base = options.base ?? record?.git?.base ?? room.baseOf(name) ?? 'HEAD'
  const prior = room.manifestHead.get(name)
  const key = manifestKey(name, fence)
  room.doc.transact(() => {
    if (!record?.holder) room.participants.set(`${name}\u0000holder`, fixtureHolder(room, name, fence))
    if (!record?.git || record.git.fence !== fence || record.git.base !== base) room.participants.set(`${name}\u0000git`, { ...(record?.git ?? {}), base, fence, rev: record?.git?.rev ?? 1 })
    let entries = room.manifest.get(key)
    if (!entries) { entries = new Y.Map<ManifestEntry>(); room.manifest.set(key, entries) }
    entries.set(path, { change: 'M', state: 'shared', hash: gitBlobHash(text), size: Buffer.byteLength(text), at: Date.now(), fence })
    room.setOverlay(key, path, text)
    room.manifestHead.set(name, { base, fence, coverage: { kind: 'all' }, level: options.level ?? 'full', excluded: [], rev: (prior?.rev ?? 0) + 1,
      semRev: (prior?.semRev ?? 0) + 1, scannedAt: Date.now(), complete: true })
    room.setOverlay(name, path, text) // legacy assertions in older fixtures still inspect this map
  })
}

export function deleteFixture(room: RoomDoc, name: string, path: string, options: { fence?: string; base?: string } = {}): void {
  const local = localRoots.get(room)
  if (local?.name === name) fs.rmSync(pathModule.join(local.dir, path), { force: true })
  const record = participantRecord(room, name)
  const fence = options.fence ?? record?.holder?.sessionId ?? FIXTURE_HOLDER
  visiblePeer(room, name, 'agent', fence)
  const base = options.base ?? record?.git?.base ?? room.baseOf(name) ?? 'HEAD'
  const prior = room.manifestHead.get(name)
  const key = manifestKey(name, fence)
  room.doc.transact(() => {
    if (!record?.holder) room.participants.set(`${name}\u0000holder`, fixtureHolder(room, name, fence))
    if (!record?.git || record.git.fence !== fence || record.git.base !== base) room.participants.set(`${name}\u0000git`, { ...(record?.git ?? {}), base, fence, rev: record?.git?.rev ?? 1 })
    let entries = room.manifest.get(key)
    if (!entries) { entries = new Y.Map<ManifestEntry>(); room.manifest.set(key, entries) }
    entries.set(path, { change: 'D', state: 'shared', at: Date.now(), fence })
    room.clearOverlay(key, path)
    room.manifestHead.set(name, { base, fence, coverage: { kind: 'all' }, level: 'full', excluded: [], rev: (prior?.rev ?? 0) + 1,
      semRev: (prior?.semRev ?? 0) + 1, scannedAt: Date.now(), complete: true })
    room.markDeleted(name, path)
  })
}

export function clearFixture(room: RoomDoc, name: string, path: string): void {
  const local = localRoots.get(room)
  if (local?.name === name) {
    const file = pathModule.join(local.dir, path)
    try {
      const base = execFileSync('git', ['-C', local.dir, 'show', `HEAD:${path}`], { stdio: ['ignore', 'pipe', 'ignore'] })
      fs.mkdirSync(pathModule.dirname(file), { recursive: true })
      fs.writeFileSync(file, base)
    } catch { fs.rmSync(file, { force: true }) }
  }
  const prior = room.manifestHead.get(name)
  if (prior) room.doc.transact(() => {
    const key = manifestKey(name, prior.fence)
    room.manifest.get(key)?.delete(path)
    room.clearOverlay(key, path)
    room.manifestHead.set(name, { ...prior, rev: prior.rev + 1, semRev: prior.semRev + 1, scannedAt: Date.now() })
  })
  room.clearOverlay(name, path)
  room.unmarkDeleted(name, path)
}
