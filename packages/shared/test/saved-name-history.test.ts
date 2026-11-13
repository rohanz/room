import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { compactDoc, docGeneration, historyOf, memorySnapshot, RoomDoc } from '../src/index.js'

it('keeps inert saved name maps and other coordination through local snapshots and compaction', () => {
  const source = new RoomDoc(), wire = new Y.Doc(), restored = new Y.Doc(), reloaded = new Y.Doc()
  const aliases = { 'old-peer': 'peer' }
  const unresolved = { 'local/repo/main\0peer': { placeholder: '?peer', claims: [{ id: 'old-claim' }] } }
  source.doc.getMap('aliases').set('old-peer', 'peer')
  for (const [key, value] of Object.entries(unresolved)) source.doc.getMap('unresolved').set(key, value)
  source.scopes.set('peer', { by: 'peer', byKind: 'agent', paths: ['a.ts'], summary: 'working', at: 1 })
  source.mail.set('q', { id: 'q', type: 'question', from: 'peer', fromKind: 'agent', to: 'lead', text: '?', at: 1 })
  source.outcomes.set('earlier', { from: 'peer', to: 'lead', outcome: 'answered', at: 1 })
  source.archive.set('archived', ['note', 'peer', 1, []])
  let compacted: Y.Doc | undefined
  try {
    // Both roots arrive as unread AbstractTypes, as they do when loading a saved file.
    Y.applyUpdate(wire, Y.encodeStateAsUpdate(source.doc))
    const before = Y.encodeStateAsUpdate(wire)
    Y.applyUpdate(restored, memorySnapshot(wire))
    expect(Y.encodeStateAsUpdate(wire)).toEqual(before)
    compacted = compactDoc(restored, 'next')
    Y.applyUpdate(reloaded, memorySnapshot(compacted))
    expect(docGeneration(reloaded)).toBe('next')
    expect(historyOf(compacted).deleted).toBe(0)
    for (const doc of [restored, compacted, reloaded]) {
      expect(doc.getMap('aliases').toJSON()).toEqual(aliases)
      expect(doc.getMap('unresolved').toJSON()).toEqual(unresolved)
      for (const name of ['scopes', 'mail', 'outcomes', 'archive']) expect(doc.getMap(name).toJSON()).toEqual(source.doc.getMap(name).toJSON())
    }
  } finally { source.doc.destroy(); wire.destroy(); restored.destroy(); compacted?.destroy(); reloaded.destroy() }
})
