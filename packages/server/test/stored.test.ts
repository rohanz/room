import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { levelDbOf, levelStoredSize, levelStoredUpdates, levelCopyRaw } from '../src/stored.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-stored-')), provider = new LeveldbPersistence(dir)
  cleanups.push(async () => { await provider.destroy(); fs.rmSync(dir, { recursive: true, force: true }) })
  const doc = new Y.Doc(), updates: Uint8Array[] = []
  doc.on('update', update => { updates.push(update) })
  for (let i = 0; i < 12; i++) doc.getText('text').insert(doc.getText('text').length, `${i}-`)
  for (const update of updates) await provider.storeUpdate('from', update)
  return { provider, db: await levelDbOf(provider), doc, updates }
}
it('measures exact stored bytes and stops before all records when over the limit', async () => {
  const f = await fixture()
  const bytes = f.updates.reduce((sum, update) => sum + update.byteLength, 0)
  expect(await levelStoredSize(f.db, 'from')).toEqual({ bytes, updates: f.updates.length, over: false })
  const bounded = await levelStoredSize(f.db, 'from', f.updates[0].byteLength)
  expect(bounded.over).toBe(true); expect(bounded.updates).toBeLessThan(f.updates.length)
  expect(bounded.bytes).toBeGreaterThan(f.updates[0].byteLength)
  f.doc.destroy()
})
it('streams all records in clock order and reproduces the document', async () => {
  const f = await fixture(), doc = new Y.Doc(), updates: Uint8Array[] = []
  for await (const update of levelStoredUpdates(f.db, 'from')) { updates.push(update); Y.applyUpdate(doc, update) }
  expect(updates.map(update => [...update])).toEqual(f.updates.map(update => [...update]))
  expect(doc.getText('text').toString()).toBe(f.doc.getText('text').toString())
  f.doc.destroy(); doc.destroy()
})
it('copies raw records and the discovery state vector without loading, and replays idempotently', async () => {
  const f = await fixture()
  await levelCopyRaw(f.db, 'from', 'to')
  await levelCopyRaw(f.db, 'from', 'to')
  expect(await f.provider.getAllDocNames()).toContain('to')
  expect(await levelStoredSize(f.db, 'to')).toEqual(await levelStoredSize(f.db, 'from'))
  const copy = await f.provider.getYDoc('to')
  expect(copy.getText('text').toString()).toBe(f.doc.getText('text').toString())
  copy.destroy(); f.doc.destroy()
})
