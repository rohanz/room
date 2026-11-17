import { baseVersions } from './shadow-publication-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { vi } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, gitBlobHash, manifestKey, type ManifestEntry } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { ConflictShadow, type ShadowEvent } from '../src/conflict-shadow.js'
import { ConflictSet, type ConflictSlot } from '../src/conflict-set.js'
import { registryForDir } from '../src/worker-registry.js'
import type { Session } from '../src/session.js'
import { applyShadowEvent } from './shadow-event-fixture.js'
import { world, repo, put, git } from './worker-refresh-fixture.js'

class ManualShadow extends ConflictShadow { override enqueue(): void {} }
type Internal = {
  init(): Promise<void>; event(event: ShadowEvent): Promise<void>; pass(): Promise<void>
  actors: Map<string, { node: string; observed: number; disabled?: string }>
}

export async function stabilityFixture() {
  const t = world(), d = await t.spawn('d'), u = await t.spawn('u'), s = t.leadSession()
  let clock = Date.now()
  const shadow = new ManualShadow(s, () => {}, () => clock), internal = shadow as unknown as Internal
  await internal.init()
  const registry = await registryForDir(repo)
  for (const w of [d, u]) await applyShadowEvent(shadow, { kind: 'spawn', record: (await registry.read(w.id))!, supplied: false })
  const actors = [{ name: s.me.name, dir: repo, id: '' }, d, u]
  vi.spyOn(s.awareness, 'getStates').mockImplementation(() => new Map(actors.map((a, i) =>
    [i, { user: { name: a.name, kind: 'agent' }, sessionId: `session-${a.name}` }])) as never)
  const versions = baseVersions()
  async function publish(rev: number) {
    s.room.ensureRoomSalt()
    for (const a of actors) {
      const record = a.id ? await registry.read(a.id) : undefined
      const base = record?.base ?? git(repo, 'rev-parse', 'HEAD')
      epochPublication(s.room, a.name, base)
      s.room.participants.set(`${a.name}\0id`, { name: a.name, kind: 'agent' })
      s.room.manifestHead.set(a.name, { ...s.room.manifestHead.get(a.name)!, level: 'full', semRev: rev })
      const entries = new Y.Map<ManifestEntry>()
      for (const p of git(a.dir, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean)) {
        const before = versions(a.dir, base).get(p)
        const file = path.join(a.dir, p)
        if (!fs.existsSync(file)) {
          entries.set(p, { change: 'D', state: 'shared', fence: '1' })
        } else {
          const text = fs.readFileSync(file, 'utf8'), hash = gitBlobHash(text)
          if (hash !== before) {
            entries.set(p, { change: before ? 'M' : 'A', state: 'shared', hash, at: fs.statSync(file).mtimeMs, fence: '1' })
            s.room.setOverlay(manifestKey(a.name, '1'), p, text)
          }
        }
      }
      s.room.manifest.set(manifestKey(a.name, '1'), entries)
    }
  }
  async function settle() {
    for (const w of [d, u]) {
      const peer = { ...s, me: { name: w.name, kind: 'agent' }, dir: w.dir,
        post: vi.fn().mockResolvedValue({ ok: true }), lease: { fence: () => '1' } } as unknown as Session
      const set = new ConflictSet(peer, w.name, peer, () => {}, 0)
      try { await set.reconcile('rev34') } finally { set.stop() }
    }
  }
  const rows = () => {
    const file = path.join(path.dirname(shadow.graph.root), 'disagreements.jsonl')
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  }
  return { t, d, u, s, actors, shadow, internal, publish, settle, rows, setClock: (value: number) => { clock = value }, advance: (ms = 6000) => { clock += ms } }
}


/** A real evaluator reads the old replica; its same-fence result arrives after the new publication. */
export async function delayedConflict(f: Awaited<ReturnType<typeof stabilityFixture>>) {
  const doc = new Y.Doc()
  try {
    put(f.d.dir, 'shared.txt', 'D\n'); put(f.u.dir, 'shared.txt', 'U\n')
    await f.publish(1); Y.applyUpdate(doc, Y.encodeStateAsUpdate(f.s.room.doc))
    const room = new RoomDoc(doc)
    put(f.u.dir, 'shared.txt', 'D\n')
    const receivedAt = Date.now(); f.setClock(receivedAt); await f.publish(2)
    const peer = { ...f.s, room, me: { name: f.d.name, kind: 'agent' }, dir: f.d.dir,
      post: vi.fn().mockResolvedValue({ ok: true }), lease: { fence: () => '1' } } as unknown as Session
    const timestamp=vi.spyOn(Date,'now').mockReturnValue(receivedAt+1)
    const set = new ConflictSet(peer, f.d.name, peer, () => {}, 0)
    try { await set.reconcile('delayed replica') } finally { set.stop();timestamp.mockRestore() }
    const old = [...doc.getMap<ConflictSlot>('conflicts')].filter(([, s]) => s.owner === f.d.name && s.other === f.u.name)
    for (const [key, slot] of old) f.s.room.doc.getMap<ConflictSlot>('conflicts').set(key, slot)
    return { old, receivedAt }
  } finally { doc.destroy() }
}
