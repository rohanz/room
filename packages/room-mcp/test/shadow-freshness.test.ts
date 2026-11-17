import { baseVersions } from './shadow-publication-fixture.js'
import './shadow-controlled-fixture.js'
import { applyShadowEvent } from './shadow-event-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

const full = process.env.TEST_SCALE === '1' ? it : it.skip
import * as Y from 'yjs'
import { gitBlobHash, manifestKey, type ManifestEntry } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { ConflictShadow, type ShadowEvent } from '../src/conflict-shadow.js'
import { ConflictSet, type ConflictSlot } from '../src/conflict-set.js'
import { registryForDir } from '../src/worker-registry.js'
import type { Session } from '../src/session.js'
import { world, repo, put, git } from './worker-refresh-fixture.js'

class ManualShadow extends ConflictShadow { override enqueue(): void {} }
type Internal = {
  init(): Promise<void>; event(event: ShadowEvent): Promise<void>; pass(): Promise<void>
  actors: Map<string, { node: string; observed: number; disabled?: string }>
}

async function fixture() {
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
  return { t, d, u, s, actors, shadow, internal, publish, settle, rows, advance: (ms = 6000) => { clock += ms } }
}

full('does not record an old settled conflict against newly published equal deletions', async () => {
  const f = await fixture()
  try {
    put(f.d.dir, 'shared.txt', 'D\n'); put(f.u.dir, 'shared.txt', 'U\n')
    await f.publish(1); await f.settle(); await f.internal.pass()
    const slots = f.s.room.doc.getMap<ConflictSlot>('conflicts')
    expect([...slots.values()].some(s => s.owner === f.d.name && s.other === f.u.name && s.settled === 'conflict')).toBe(true)
    expect(f.rows()).toEqual([])
    fs.unlinkSync(path.join(f.d.dir, 'shared.txt')); fs.unlinkSync(path.join(f.u.dir, 'shared.txt'))
    f.advance(); await f.publish(2)
    // The next ordinary reconciliation has not happened yet. Both current trees are clean.
    await f.internal.pass()
    expect(f.rows()).toEqual([])
  } finally { f.shadow.stop() }
})

full('does not record a stale settled conflict after backdated equal file edits', async () => {
  const f = await fixture()
  try {
    put(f.d.dir, 'shared.txt', 'D\n'); put(f.u.dir, 'shared.txt', 'U\n')
    await f.publish(1); await f.settle(); await f.internal.pass()
    expect(f.rows()).toEqual([])
    for (const w of [f.d, f.u]) {
      put(w.dir, 'shared.txt', 'equal\n')
      fs.utimesSync(path.join(w.dir, 'shared.txt'), new Date(1000), new Date(1000))
    }
    f.advance(); await f.publish(2); await f.internal.pass()
    expect(f.rows()).toEqual([])
  } finally { f.shadow.stop() }
})

it('rejects a worker HEAD change between the history check and its snapshot', async () => {
  const f = await fixture()
  try {
    put(f.d.dir, 'shared.txt', 'D\n'); put(f.u.dir, 'shared.txt', 'U\n')
    await f.publish(1); await f.settle()
    const target = f.internal as unknown as { validateHistory(actor: { name: string }, records: unknown[], common: string): Promise<void> }
    const original = target.validateHistory.bind(target)
    const check = vi.spyOn(target, 'validateHistory').mockImplementation(async (actor, records, common) => {
      await original(actor, records, common)
      if (actor.name === f.d.name) git(f.d.dir, 'commit', '--allow-empty', '-qm', 'user commit during shadow snapshot')
    })
    const actor = f.internal.actors.get(f.d.name)!
    const compare = vi.spyOn(f.shadow.graph, 'compare')
    await f.internal.pass()
    expect(check).toHaveBeenCalled()
    expect(f.internal.actors.has(f.d.name)).toBe(false)
    // A changed real HEAD is unsupported even if its current file bytes did not change.
    expect(compare.mock.calls.filter(([a, b]) => a === actor.node || b === actor.node)).toHaveLength(0)
  } finally { f.shadow.stop() }
})

full('does not invent common carried history for a later carry=false worker', async () => {
  const originalText = fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8')
  put(repo, 'shared.txt', 'lead uncommitted draft\n')
  const f = await fixture()
  try {
    const v = await f.t.spawn('v', { carry: false })
    const record = (await (await registryForDir(repo)).read(v.id))!
    await applyShadowEvent(f.shadow, { kind: 'spawn', record, supplied: false })
    put(f.d.dir, 'shared.txt', originalText)
    put(v.dir, 'shared.txt', 'new worker edit\n')
    f.actors.push(v)
    await f.publish(1); await f.settle()
    const slots = [...f.s.room.doc.getMap<ConflictSlot>('conflicts').values()]
      .filter(s => s.owner === f.d.name && s.other === v.name)
    expect(slots.every(s => s.status === 'clean')).toBe(true)
    await f.internal.pass()
    f.advance(60_001); await f.internal.pass()
    // D reverted to committed O; V was spawned at O and then edited it. No overlapping edits from O.
    expect(f.rows().filter(row => row.participants.includes(f.d.name) && row.participants.includes(v.name))).toEqual([])
  } finally { f.shadow.stop() }
})

full('waits when a restored path publishes a new revision without an ordinary recheck', async () => {
  const f = await fixture()
  try {
    put(f.d.dir, 'shared.txt', 'D\n'); put(f.u.dir, 'shared.txt', 'U\n')
    await f.publish(1); await f.settle(); await f.internal.pass()
    const before = [...f.s.room.doc.getMap<ConflictSlot>('conflicts').values()]
    for (const w of [f.d, f.u]) {
      fs.unlinkSync(path.join(w.dir, 'shared.txt'))
      put(w.dir, 'shared.txt', 'restored equal bytes\n')
      fs.utimesSync(path.join(w.dir, 'shared.txt'), new Date(0), new Date(0))
    }
    // Deliberately leave semRev alone. The publication revision/fence identity still changes.
    f.advance(); await f.publish(1)
    for (const w of [f.d, f.u]) {
      const h = f.s.room.manifestHead.get(w.name)!
      f.s.room.manifestHead.set(w.name, { ...h, rev: h.rev + 1 })
    }
    await f.internal.pass()
    expect([...f.s.room.doc.getMap<ConflictSlot>('conflicts').values()]).toEqual(before)
    expect(f.rows()).toEqual([])
  } finally { f.shadow.stop() }
})

full('shares carried anchors across different housekeeping commits of the same prepared state', async () => {
  put(repo, 'shared.txt', 'carried draft\n')
  const f = await fixture()
  try {
    const nodes: string[] = [], bases: string[] = []
    for (const [tag, date] of [['x', '2001-01-01T00:00:00Z'], ['y', '2001-01-02T00:00:00Z']]) {
      vi.stubEnv('GIT_AUTHOR_DATE', date); vi.stubEnv('GIT_COMMITTER_DATE', date)
      const w = await f.t.spawn(tag), r = (await (await registryForDir(repo)).read(w.id))!
      await applyShadowEvent(f.shadow, { kind: 'spawn', record: r, supplied: false, carry: true })
      bases.push(r.base!); nodes.push(f.internal.actors.get(w.name)!.node)
    }
    expect(bases[0]).not.toBe(bases[1])
    expect(nodes[0]).toBe(nodes[1])
  } finally { f.shadow.stop() }
})

full('shares two carry=false anchors prepared at the same HEAD', async () => {
  const f = await fixture()
  try {
    const nodes: string[] = []
    for (const tag of ['x', 'y']) {
      const w = await f.t.spawn(tag, { carry: false }), r = (await (await registryForDir(repo)).read(w.id))!
      await applyShadowEvent(f.shadow, { kind: 'spawn', record: r, supplied: false, carry: false })
      nodes.push(f.internal.actors.get(w.name)!.node)
    }
    expect(nodes[0]).toBe(nodes[1])
  } finally { f.shadow.stop() }
})

full('separates carry=false anchors at different HEADs even with byte-identical trees', async () => {
  const f = await fixture()
  try {
    const nodes: string[] = [], trees: string[] = []
    for (const tag of ['x', 'y']) {
      const w = await f.t.spawn(tag, { carry: false }), r = (await (await registryForDir(repo)).read(w.id))!
      await applyShadowEvent(f.shadow, { kind: 'spawn', record: r, supplied: false, carry: false })
      nodes.push(f.internal.actors.get(w.name)!.node); trees.push(git(w.dir, 'rev-parse', 'HEAD^{tree}'))
      if (tag === 'x') git(repo, 'commit', '--allow-empty', '-qm', 'advance lead HEAD')
    }
    expect(trees[0]).toBe(trees[1]); expect(nodes[0]).not.toBe(nodes[1])
    expect((await f.shadow.graph.compare(nodes[0], nodes[1])).paths).toEqual([])
  } finally { f.shadow.stop() }
})

full('separates restored carried states after an observed lead generation changed', async () => {
  const originalText = fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8')
  put(repo, 'shared.txt', 'draft\n')
  const f = await fixture()
  try {
    await f.publish(1); await f.internal.pass()
    const old = f.internal.actors.get(f.d.name)!.node
    put(repo, 'shared.txt', 'intervening draft\n'); f.advance(); await f.publish(2); await f.internal.pass()
    put(repo, 'shared.txt', 'draft\n'); f.advance(); await f.publish(3); await f.internal.pass()
    const y = await f.t.spawn('y'), r = (await (await registryForDir(repo)).read(y.id))!
    await applyShadowEvent(f.shadow, { kind: 'spawn', record: r, supplied: false, carry: true })
    expect(f.internal.actors.get(y.name)!.node).not.toBe(old)
    put(f.d.dir, 'shared.txt', originalText); put(y.dir, 'shared.txt', 'new edit\n')
    f.actors.push(y); f.advance(); await f.publish(4); await f.internal.pass()
    // Both branch from received draft, despite its intervening change and restoration on the lead.
    expect((await f.shadow.graph.compare(f.internal.actors.get(f.d.name)!.node, f.internal.actors.get(y.name)!.node)).paths).toEqual(['shared.txt'])
  } finally { f.shadow.stop() }
})

full('rejects a worker commit made immediately after capture and before the final HEAD fence', async () => {
  const f = await fixture()
  try {
    put(f.d.dir, 'shared.txt', 'D\n'); put(f.u.dir, 'shared.txt', 'U\n')
    await f.publish(1)
    const target = f.internal as unknown as { readHead(dir: string): Promise<string> }
    const readHead = target.readHead.bind(target)
    let reads = 0
    vi.spyOn(target, 'readHead').mockImplementation(async dir => {
      if (dir === f.d.dir && ++reads === 2) git(dir, 'commit', '--allow-empty', '-qm', 'commit after snapshot')
      return readHead(dir)
    })
    const actor = f.internal.actors.get(f.d.name)!
    const compare = vi.spyOn(f.shadow.graph, 'compare')
    await f.internal.pass()
    expect(f.internal.actors.has(f.d.name)).toBe(false)
    expect(actor.disabled).toBe('worker HEAD moved')
    expect(compare.mock.calls.filter(([a, b]) => a === actor.node || b === actor.node)).toHaveLength(0)
    expect(f.rows()).toEqual([])
  } finally { f.shadow.stop() }
})

full('swallows a synchronous publication-arrival bookkeeping failure', async () => {
  const f = await fixture()
  try {
    const target = f.shadow as unknown as { observePublications(): void }
    vi.spyOn(target, 'observePublications').mockImplementationOnce(() => { throw new Error('arrival bookkeeping') })
    await expect(f.publish(1)).resolves.toBeUndefined()
    await f.internal.pass()
    expect(f.rows()).toEqual([])
  } finally { f.shadow.stop() }
})
