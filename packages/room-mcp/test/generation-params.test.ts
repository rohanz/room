// `gen` reaches every (re)connect only because y-websocket re-encodes `provider.params` in its `url` getter each
// time it opens a socket (shared/src/compact.ts generationParams). This fails if an upgrade stops doing so.
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { compactDoc, roomConnection } from '@room/shared'

it("y-websocket's socket URL states the replica's current generation at each connect, with BroadcastChannel off", () => {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider('ws://127.0.0.1:9', 'github.com%2Fo%2Fr', doc, { connect: false, ...roomConnection(doc) })
  try {
    expect(provider.disableBc).toBe(true)
    expect(new URL(provider.url).searchParams.get('gen')).toBe('fresh')
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(compactDoc(new Y.Doc(), 'g7')), provider)
    expect(new URL(provider.url).searchParams.get('gen')).toBe('g7')
    expect(new URL(provider.url).searchParams.get('schema')).toBe('2')
  } finally { provider.destroy(); doc.destroy() }
})
