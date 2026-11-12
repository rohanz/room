import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoomDoc, deliveryIndex, owed, type RetiredWorker } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { ConflictSlots, slotKey } from '../src/conflict-set.js'
import { FileWorkerStore } from '../src/worker-file-store.js'
import type { Post } from '../src/post.js'

it('preserves an unmanaged fallback through registry retention and an identical same-tag successor conflict', async () => {
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'review-stale2-successor-'))
  fs.mkdirSync(path.join(common, 'room/registry'), { recursive: true })
  const room = new RoomDoc(), store = await FileWorkerStore.openReader(common)
  const post = ((from, body, options) => {
    const id = options!.id!, msg = hubAppend(room, from, body, { id })
    return Object.assign(Promise.resolve({ ok: true, msg }), { id })
  }) as Post
  const pending = () => owed(room, { name: 'A' }, { frontier: 0, routed: new Set() }, {})
  const totals = () => {
    const index = deliveryIndex(room)
    const before = { ids: [...index.pending.keys()].sort(), bytes: index.owedBytes, recipients: structuredClone(index.recipients) }
    index.rebuild()
    expect({ ids: [...index.pending.keys()].sort(), bytes: index.owedBytes, recipients: index.recipients }).toEqual(before)
  }
  try {
    room.participants.set('B\0holder', { sessionId: 'w1', epoch: 1, workerId: 'w1' })
    const slots = new ConflictSlots(room, post, '1')
    const key = slotKey('A', 'merge', 'B', 'x')
    const fact = { owner: 'A', other: 'B', path: 'x', kind: 'merge' as const, status: 'conflict' as const, inputs: 'same bytes', factId: 'same conflict' }
    await slots.settle(key, fact)
    const first = pending()[0]!; expect(first).toBeDefined(); totals()
    const retired: RetiredWorker & { id: string } = { id: 'w1', name: 'B', lead: 'A', tag: 'B', host: 'codex', task: '', summary: '', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: Date.now(), outcome: 'clean' }
    room.retireWorker('w1', retired, () => {})
    await store.retireWorkerMail(room, 'A', 'test')
    expect(pending().map(m => m.id)).toEqual([first.id]); totals()
    expect(room.outcomes.has(first.id)).toBe(false)
    room.participants.set('B\0holder', { sessionId: 'w2', epoch: 2, workerId: 'w2' })
    await slots.settle(key, fact)
    totals()
    expect(pending()).toHaveLength(1)
    expect(pending()[0]!.id).toBe(first.id)
    expect(room.outcomes.has(pending()[0]!.id)).toBe(false)
  } finally { store.close(); room.doc.destroy(); fs.rmSync(common, { recursive: true, force: true }) }
})
