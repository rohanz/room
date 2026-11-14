import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { MAX_MEMORY_BYTES, memorySnapshot, RoomDoc, type NoteMsg } from './index.js'
import { hubAppend } from './testing.js'

it('does not evict unrelated coordination history to retain retired roomagent transcripts', () => {
  const source = new RoomDoc(), restored = new RoomDoc()
  try {
    const note = hubAppend<NoteMsg>(source, { name: 'ada', kind: 'agent' }, { type: 'note', text: 'current coordination' })
    source.archive.set('prior-note', ['note', 'ada', Date.now(), ['review']])
    source.markSeen('bea', [note.id], { s: 'ordinary-session', via: 'reply' })
    // The retired runtime appended transcript entries indefinitely. Each entry here is small,
    // but their accumulated history alone exceeds the local snapshot target.
    source.doc.getArray('chat:former-agent').push(Array.from({ length: 700 }, (_, i) => ({
      id: `historical-${i}`, at: i, role: 'tool', text: 'x'.repeat(8192), meta: { kind: 'command' },
    })))
    expect(Y.encodeStateAsUpdate(source.doc).byteLength).toBeGreaterThan(MAX_MEMORY_BYTES)
    Y.applyUpdate(restored.doc, memorySnapshot(source.doc))
    expect.soft(restored.archive.get('prior-note')).toEqual(source.archive.get('prior-note'))
    expect.soft(restored.messages()).toEqual([note])
    expect.soft(restored.seen('bea').get(note.id)).toEqual(source.seen('bea').get(note.id))
  } finally { source.doc.destroy(); restored.doc.destroy() }
})
