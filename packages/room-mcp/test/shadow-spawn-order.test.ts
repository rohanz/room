import './shadow-controlled-fixture.js'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { manifestKey, type ManifestEntry } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { ConflictShadow, shadowIdle, type ShadowEvent } from '../src/conflict-shadow.js'
import { put, world } from './worker-refresh-fixture.js'

it.each([
  { keep: false, unsupported: false }, { keep: true, unsupported: false },
  { keep: false, unsupported: true }, { keep: true, unsupported: true },
])('handles a second spawn during the first private event and collection ($keep, unsupported=$unsupported)', async ({ keep, unsupported }) => {
  vi.stubEnv('ROOM_CONFLICT_SHADOW', '1')
  const t = world(), s = t.leadSession()
  let release!: () => void, entered!: () => void, shadow!: ConflictShadow
  const barrier = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  const prototype = ConflictShadow.prototype as unknown as { event(e: ShadowEvent): Promise<void | false> }
  const event = prototype.event
  let first = true
  vi.spyOn(prototype, 'event').mockImplementation(async function (this: ConflictShadow, e) {
    shadow = this
    if (e.kind === 'spawn' && first) { first = false; entered(); await barrier }
    return event.call(this, e)
  })
  try {
    const d = await t.spawn('d')
    const diagnostic = shadowIdle(s)
    await reached
    // The pass has read its inventory; u's reservation and registry record arrive later.
    const u = await t.spawn('u', unsupported ? { share: 'intent' } : {})
    release(); await diagnostic
    const state = shadow as unknown as { actors: Map<string, { node: string; events: string[] }>; halted: boolean }
    expect.soft([...state.actors.keys()].sort()).toEqual([s.me.name, d.name, ...(unsupported ? [] : [u.name])].sort())
    // Publish unchanged full snapshots so the real comparison pass must visit every pair.
    const names = [s.me.name, d.name, ...(unsupported ? [] : [u.name])]
    vi.spyOn(s.awareness, 'getStates').mockReturnValue(new Map(names.map((name, i) => [i, { user: { name, kind: 'agent' }, sessionId: `session-${name}` }])))
    s.room.ensureRoomSalt()
    for (const name of names) {
      epochPublication(s.room, name, d.base!)
      s.room.participants.set(`${name}\0id`, { name, kind: 'agent' })
      s.room.manifestHead.set(name, { ...s.room.manifestHead.get(name)!, level: 'full', semRev: 1 })
      s.room.manifest.set(manifestKey(name, '1'), new Y.Map<ManifestEntry>())
    }
    const compare = vi.spyOn(shadow.graph, 'compare')
    await shadowIdle(s)
    expect(compare).toHaveBeenCalledTimes(unsupported ? 1 : 3)
    put(d.dir, 'shared.txt', 'D\n'); put(u.dir, 'keep.txt', 'U\n')
    await t.finish('d'); await t.finish('u')
    const reply = await t.call('room_collect', { keep })
    expect(reply).toContain(keep ? 'kept d' : 'Changes from d, u:')
    if (keep) expect(reply).toContain('kept u')
    await shadowIdle(s)
    expect(state.halted).toBe(false)
    expect(state.actors.has(s.me.name)).toBe(true)
    expect(state.actors.has(d.name)).toBe(keep)
    expect(state.actors.has(u.name)).toBe(keep && !unsupported)
    if (keep) expect(state.actors.get(d.name)!.events.some(e => e.startsWith('delivery:'))).toBe(true)
    const entries = await shadow.graph.entries(state.actors.get(s.me.name)!.node)
    expect(await shadow.graph.run(['cat-file', 'blob', entries.get('shared.txt')!.oid])).toBe('D')
    expect(await shadow.graph.run(['cat-file', 'blob', entries.get('keep.txt')!.oid])).toBe('U')
    const later = await t.spawn('later')
    await shadowIdle(s)
    expect(state.actors.has(later.name)).toBe(true)
  } finally { release(); await t.close() }
})
