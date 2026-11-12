import { expect, it } from 'vitest'
import { RoomDoc } from './doc.js'
import { deliveryIndex, owed } from './delivery.js'
import type { Msg } from './types.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

it('does not use an undelivered terminal replacement to end the only pending contract', async () => {
  // Keep the shared build independent of its downstream consumer's TypeScript project.
  const consumer = new URL('../../room-mcp/src/worker-file-store.ts', import.meta.url).href
  const { FileWorkerStore } = await import(consumer)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-stale2-terminal-'))
  const store = await FileWorkerStore.open(dir, { watch: false })
  const room = new RoomDoc()
  try {
    const old: Msg = { id: 'cf:fact:1', from: 'room', fromKind: 'agent', to: 'offline', type: 'contract', path: 'api.ts', symbol: 'f', text: 'peer changed f', priority: 'notify', at: 1 }
    const fresh: Msg = { ...old, id: `${old.id}:subject:digest`, noticeSubjects: [{ name: 'offline' }, { name: 'peer' }], at: 2 }
    room.bus.push([old, fresh])
    room.outcomes.set(fresh.id, { to: 'offline', from: 'room', at: 3, outcome: 'over-cap' })
    expect(owed(room, { name: 'offline' }, { frontier: 0, routed: new Set() }, {}).map(m => m.id)).toEqual([old.id])
    await store.retireWorkerMail(room, 'lead', 'test')
    const index = deliveryIndex(room)
    const before = { bytes: index.owedBytes, recipients: structuredClone(index.recipients), ids: [...index.pending.keys()] }
    index.rebuild()
    expect({ bytes: index.owedBytes, recipients: index.recipients, ids: [...index.pending.keys()] }).toEqual(before)
    expect(owed(room, { name: 'offline' }, { frontier: 0, routed: new Set() }, {}).map(m => m.id)).toEqual([old.id])
  } finally { store.close(); room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true }) }
})
