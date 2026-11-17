import './shadow-controlled-fixture.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from '@room/shared'
import { ConflictShadow } from '../src/conflict-shadow.js'
import type { Session } from '../src/session.js'
import { repo } from './worker-refresh-fixture.js'

class ManualShadow extends ConflictShadow { override enqueue(): void {} }
const id = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)

it('retires only the owned identity when a newer worker reused its name', async () => {
  const room = new RoomDoc(new Y.Doc())
  const shadow = new ManualShadow({ dir: repo, room, me: { name: 'lead' } } as Session, () => {}), state = shadow as any
  const current = { name: 'lead+d', id: 'new' }, key = JSON.stringify(['lead', 'new', 'file'])
  try {
    await fs.mkdir(shadow.graph.root, { recursive: true })
    for (const name of ['old', 'new']) await fs.writeFile(path.join(shadow.graph.root, name + '.index'), 'private')
    state.actors.set(current.name, current); state.identities.set(current.name, 'new publication')
    state.pending.set(key, { input: 'new observation', since: 0 })
    await state.remove({ name: current.name, id: 'old' })
    expect(state.actors.get(current.name)).toBe(current)
    expect(state.identities.get(current.name)).toBe('new publication')
    expect(state.pending.has(key)).toBe(true)
    await expect(fs.stat(path.join(shadow.graph.root, 'new.index'))).resolves.toBeDefined()
    await expect(fs.stat(path.join(shadow.graph.root, 'old.index'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { shadow.stop(); await state.cleanup; room.doc.destroy() }
})

it.each(['lead unmodelled', 'repository ceiling', 'journal ceiling', 'reservation failure', 'late event'])('clears all participant state once after %s and later retirement', async reason => {
  const room = new RoomDoc(new Y.Doc()), log = vi.fn()
  const shadow = new ManualShadow({ dir: repo, room, me: { name: 'lead' } } as Session, log), state = shadow as any
  const records = [{ id: 'worker', phase: 'live' }]
  state.initialized = true
  state.registry = { list: async () => ({ records, blockers: [] }), close() {} }
  const actors = ['lead', 'lead+d'].map(name => ({ name, id: id(name === 'lead' ? 'lead' : 'worker'), node: 'node', tree: 'tree', entries: new Map(), gaps: new Set(), events: [] }))
  try {
    await fs.mkdir(shadow.graph.root, { recursive: true })
    for (const actor of actors) {
      state.actors.set(actor.name, actor); state.identities.set(actor.name, 'publication')
      ;(shadow.graph as any).pins.set(actor.id, 'node')
      await fs.writeFile(path.join(shadow.graph.root, actor.id + '.index'), 'private')
    }
    state.pending.set(JSON.stringify([actors[0].id, actors[1].id, 'file']), { input: 'old', since: 0 })
    if (reason === 'lead unmodelled') await state.unmodelled(actors[0], 'unsupported lead history')
    else if (reason === 'repository ceiling') {
      vi.spyOn(shadow.graph, 'storageBudget').mockResolvedValue(200 * 1024 * 1024)
      await shadow.idle()
    } else if (reason === 'reservation failure') {
      shadow.reserve('collection')!.expires = 0
      await shadow.idle()
    } else if (reason === 'late event') {
      const ticket = shadow.reserve('collection')!
      shadow.release(ticket); state.queue.delete(ticket.order); state.applied = ticket.order
      ConflictShadow.prototype.enqueue.call(shadow, () => { throw new Error('must not read a late payload') }, ticket)
      await state.removal
    } else {
      // The real journal-cap branch is exercised in shadow-event-loss.test.ts.
      state.halt('200 MB shared journal ceiling'); await state.removal
    }
    state.halt('a later reason must not reopen shutdown')
    records[0].phase = 'retired'; state.retire(records)
    await shadow.idle()
    expect(state.halted).toBe(true)
    expect(log.mock.calls.filter(([line]) => line.includes('family stopped for this session'))).toHaveLength(1)
    for (const map of [state.actors, state.identities, state.pending, state.queue, state.anchors, state.heads, state.spawns, (shadow.graph as any).pins]) expect(map.size).toBe(0)
    for (const actor of actors) await expect(fs.stat(path.join(shadow.graph.root, actor.id + '.index'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { shadow.stop(); await state.cleanup; room.doc.destroy() }
})
