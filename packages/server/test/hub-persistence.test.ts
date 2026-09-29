import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { ServerHubs, type PersistenceProvider } from '../src/hub.js'

it('drains a disconnected legacy document by name before migration reads its archive', async () => {
  const stored = new Map<string, Uint8Array>()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  const provider: PersistenceProvider = {
    getYDoc: async name => {
      const doc = new Y.Doc()
      const update = stored.get(name)
      if (update) Y.applyUpdate(doc, update)
      return doc
    },
    storeUpdate: async (name, update) => {
      if (++writes > 1) await gate
      const before = stored.get(name)
      stored.set(name, before ? Y.mergeUpdates([before, update]) : update)
    },
  }
  const hubs = new ServerHubs({ store: { advance: async floor => floor }, log: () => {}, full: () => false })
  const persistence = hubs.persistence(provider)
  const live = new Y.Doc()
  await persistence.bindState('legacy', live)
  await hubs.flush(live)
  live.getMap('scopes').set('ben', { summary: 'last update' })
  let drained = false
  const flush = hubs.flushName('legacy').then(() => { drained = true })
  await Promise.resolve()
  expect(drained).toBe(false)
  expect((await provider.getYDoc('legacy')).getMap('scopes').get('ben')).toBeUndefined()
  release()
  await flush
  expect((await provider.getYDoc('legacy')).getMap('scopes').get('ben')).toMatchObject({ summary: 'last update' })
})
