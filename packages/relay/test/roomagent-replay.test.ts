import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { RoomMemory, saveMemory } from '../src/memory.js'

it('does not duplicate retired chat when a surviving client reconnects after relay takeover', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-agent-replay-'))
  const client = new Y.Doc()
  const history = [{ id: 'old-tool', at: 1, role: 'tool', text: '$ old command', meta: { kind: 'command' } }]
  let relay: RoomMemory | undefined
  try {
    client.getArray('chat:ada').push(history)
    client.getArray('bus').push([{ id: 'event-1' }])
    // Like the existing relay takeover test: a normal periodic save, followed by owner loss
    // without a final generation-changing save. The surviving replica keeps its CRDT ids.
    expect(saveMemory(dir, 'local/repo', client)).toBe(true)
    relay = new RoomMemory(dir, 'local/repo')
    Y.applyUpdate(relay.doc, Y.encodeStateAsUpdate(client))
    Y.applyUpdate(client, Y.encodeStateAsUpdate(relay.doc))
    expect(client.getArray('bus').toArray()).toEqual([{ id: 'event-1' }])
    expect.soft(client.getArray('chat:ada').toArray()).toEqual(history)
    expect.soft(relay.doc.getArray('chat:ada').toArray()).toEqual(history)
  } finally {
    relay?.detach(); relay?.doc.destroy(); client.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
