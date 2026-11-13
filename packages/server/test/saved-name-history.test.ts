import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { docGeneration } from '@room/shared'
import { serializedStore } from '@room/hub-core'
import { ServerHubs, type PersistenceProvider } from '../src/hub.js'

it('loads, compacts and saves inert name maps in the server document store without losing coordination', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-saved-names-'))
  const db = new LeveldbPersistence(dir), seed = new Y.Doc(), loaded = new Y.Doc()
  const name = 'github.com/o/r'
  const provider: PersistenceProvider = {
    getYDoc: name => db.getYDoc(name),
    storeUpdate: async (name, update) => { await db.storeUpdate(name, update) },
    replace: async (name, snapshot) => { await db.clearDocument(name); await db.storeUpdate(name, snapshot) },
  }
  const hubs = new ServerHubs({
    store: serializedStore({ read: async () => undefined, write: async () => {} }),
    log: () => {}, full: () => false, compaction: { minDeleted: 1, generation: () => 'saved-names' },
  })
  const expected = {
    aliases: { 'old-peer': 'peer' },
    unresolved: { 'old-room\0peer': { placeholder: '?peer', claims: [{ id: 'old-claim' }] } },
    scopes: { peer: { by: 'peer', paths: ['a.ts'], summary: 'working', at: 1 } },
    mail: { q: { id: 'q', type: 'question', from: 'peer', to: 'lead', text: '?', at: 1 } },
    outcomes: { earlier: { from: 'peer', to: 'lead', outcome: 'answered', at: 1 } },
    archive: { archived: ['note', 'peer', 1, []] },
  }
  let saved: Y.Doc | undefined
  try {
    for (const [root, entries] of Object.entries(expected)) for (const [key, value] of Object.entries(entries)) seed.getMap(root).set(key, value)
    seed.getMap('meta').set('churn', 1); seed.getMap('meta').set('churn', 2)
    await db.storeUpdate(name, Y.encodeStateAsUpdate(seed))
    await hubs.persistence(provider).bindState(name, loaded)
    expect(docGeneration(loaded)).toBe('saved-names')
    for (const [root, entries] of Object.entries(expected)) expect(loaded.getMap(root).toJSON()).toEqual(entries)
    loaded.getMap('colors').set('peer', 2)
    await hubs.flush(loaded); await hubs.flushName(name)
    saved = await db.getYDoc(name)
    expect(docGeneration(saved)).toBe('saved-names')
    for (const [root, entries] of Object.entries(expected)) expect(saved.getMap(root).toJSON()).toEqual(entries)
    expect(saved.getMap('colors').get('peer')).toBe(2)
  } finally {
    loaded.destroy(); seed.destroy(); saved?.destroy()
    await db.destroy(); fs.rmSync(dir, { recursive: true, force: true })
  }
})
