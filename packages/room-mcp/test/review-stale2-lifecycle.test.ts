import { expect, it } from 'vitest'
import * as Y from 'yjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoomDoc, deliveryIndex, memorySnapshot } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { ConflictSlots, openMergeConflicts, slotKey } from '../src/conflict-set.js'
import { Ledger } from '../src/ledger.js'
import type { Post } from '../src/post.js'
import type { Session } from '../src/session.js'
import { FileWorkerStore } from '../src/worker-file-store.js'

async function retention(room: RoomDoc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-stale2-retention-'))
  const store = await FileWorkerStore.open(dir, { watch: false })
  try { await store.retireWorkerMail(room, 'A', 'test') }
  finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }) }
}

function fixture() {
  const room = new RoomDoc()
  let oldBuild = true
  const post = ((from, body, options) => {
    const id = oldBuild ? options!.id!.split(':subject:')[0]! : options!.id!
    const value = { ...body }; if (oldBuild) delete value.noticeSubjects
    const msg = hubAppend(room, from, value, { id })
    return Object.assign(Promise.resolve({ ok: true, msg }), { id })
  }) as Post
  const session = { room, me: { name: 'A', kind: 'agent' }, roomName: 'test' } as Session
  const ledger = new Ledger({ sessionId: () => 's', route: () => ({}) })
  const slots = new ConflictSlots(room, post, '1')
  return { room, slots, pending: () => ledger.candidates(session), upgrade: () => { oldBuild = false } }
}

it.each(['claims', 'contract', 'edit-in-claim', 'possible'] as const)('offers an unchanged upgraded %s fact only once before hourly retention', async kind => {
  const f = fixture()
  try {
    const actual = kind === 'possible' ? 'merge' : kind
    const key = slotKey('A', actual, 'B', 'x')
    await f.slots.settle(key, { owner: 'A', other: 'B', path: 'x', kind: actual, subject: 'f',
      status: kind === 'possible' ? 'possible' : 'conflict', inputs: 'same', factId: 'same' })
    expect(f.pending()).toHaveLength(1)
    f.upgrade(); await f.slots.replay('A')
    expect(f.pending()).toHaveLength(1)
  } finally { f.room.doc.destroy() }
})

it('does not repeat an already receipted unchanged contract on upgrade', async () => {
  const f = fixture()
  try {
    await f.slots.settle(slotKey('A', 'contract', 'B', 'x'), { owner: 'A', other: 'B', path: 'x', kind: 'contract', subject: 'f', status: 'conflict', inputs: 'same', factId: 'same' })
    f.room.markSeen('A', f.pending().map(m => m.id), { s: 'old-session', via: 'reply' })
    expect(f.pending()).toEqual([])
    f.upgrade(); await f.slots.replay('A'); await retention(f.room)
    expect(f.pending()).toEqual([])
  } finally { f.room.doc.destroy() }
})

it('preserves a saved legacy merge notice through retention even when restore has no independent display', async () => {
  const f = fixture(), restored = new RoomDoc()
  try {
    await f.slots.settle(slotKey('A', 'merge', 'B', 'x'), { owner: 'A', other: 'B', path: 'x', kind: 'merge', status: 'conflict', inputs: 'same', factId: 'same' })
    expect(openMergeConflicts(f.room, 'A')).toHaveLength(1)
    const original = f.pending()[0]!
    // The real persisted format saves mail, but does not save conflict slots or
    // ordinary participants' publications. No comparison has disproved this fact.
    Y.applyUpdate(restored.doc, memorySnapshot(f.room.doc))
    expect(openMergeConflicts(restored, 'A')).toEqual([])
    await retention(restored)
    expect(deliveryIndex(restored).pending.has(original.id)).toBe(true)
  } finally { f.room.doc.destroy(); restored.doc.destroy() }
})

it('a peer clear suppresses both old and structured pending merge notices', async () => {
  const f = fixture()
  try {
    const key = slotKey('A', 'merge', 'B', 'x')
    const fact = { owner: 'A', other: 'B', path: 'x', kind: 'merge' as const, inputs: 'same', factId: 'same' }
    await f.slots.settle(key, { ...fact, status: 'conflict' })
    f.upgrade(); await f.slots.replay('A')
    await f.slots.settle(key, { ...fact, status: 'clean' })
    expect(f.pending()).toHaveLength(1)
    expect(f.pending()[0]).toMatchObject({ clearedFrom: 'conflict' })
  } finally { f.room.doc.destroy() }
})
