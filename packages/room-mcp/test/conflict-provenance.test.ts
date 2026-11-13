import { commitLines, git, lead, LINES, put, setup, worker } from './collect-fixture.js'
import { registerWorkers } from './registry-fixture.js'
import { ConflictSet, type ConflictSlot, slotKey } from '../src/conflict-set.js'
import { registryForDir } from '../src/worker-registry.js'
import { refreshWorkerBase } from '../src/worker-refresh.js'
import { epochPublication } from '@room/shared/testing'
import { gitBlobHash, manifestKey, type ManifestEntry } from '@room/shared'
import type { Session } from '../src/session.js'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vitest'

// Exercise collection/refresh and the real registry lookup, with publication snapshots
// derived from each actual checkout. No sockets or host processes are needed.
describe('conflict provenance across kept collection and Git history', () => {
  async function fixture() {
    const t = setup()
    const start = commitLines()
    t.set('test', { ...t.w, base: start })
    const bDir = path.join(lead, '.room', 'workers', 'b')
    git(lead, 'worktree', 'add', '-qb', 'room/b', bDir, start)
    await t.sync()
    await registerWorkers(t.s, [{ ...t.w, tag: 'b', name: 'lead+b', dir: bDir, branch: 'room/b', base: start }])
    const registry = await registryForDir(lead)
    const aText = LINES.replace('two', 'A output')
    const bEdit = (text: string) => text.replace('six', 'B output')
    const post = vi.fn().mockResolvedValue({ ok: true })
    const states = new Map<number, unknown>()
    const publish = async (name: string, dir: string, baseline: string) => {
      t.s.room.ensureRoomSalt()
      t.s.room.participants.delete(`${name}\0proj`)
      epochPublication(t.s.room, name, baseline)
      t.s.room.participants.set(`${name}\0id`, { name, kind: 'agent' })
      t.s.room.participants.set(`${name}\0git`, { ...t.s.room.participants.get(`${name}\0git`)!, head: git(dir, 'rev-parse', 'HEAD') })
      states.set(states.size + 1, { user: { name, kind: 'agent' }, sessionId: `session-${name}` })
      t.s.room.manifestHead.set(name, { ...t.s.room.manifestHead.get(name)!, level: 'full' })
      const text = fs.readFileSync(path.join(dir, 'app.py'), 'utf8')
      const entries = new Y.Map<ManifestEntry>()
      if (text !== git(dir, 'show', `${baseline}:app.py`) + '\n') {
        entries.set('app.py', { change: 'M', state: 'shared', hash: gitBlobHash(text), at: 1, fence: '1' })
        t.s.room.setOverlay(manifestKey(name, '1'), 'app.py', text)
      }
      t.s.room.manifest.set(manifestKey(name, '1'), entries)
    }
    const check = async (owner: string, other: string, conflict = false, includeLead = false) => {
      post.mockClear()
      for (const [name, dir, tag] of [['lead+test', worker, 'test'], ['lead+b', bDir, 'b']] as const) {
        await publish(name, dir, (await registry.reserved(tag))!.base!)
      }
      if (includeLead) await publish('lead', lead, git(lead, 'rev-parse', 'HEAD'))
      const session = { ...t.s, me: { name: owner, kind: 'agent' }, dir: owner === 'lead' ? lead : owner === 'lead+test' ? worker : bDir,
        post, awareness: { getStates: () => states }, provider: { synced: true }, lease: { fence: () => '1' } } as unknown as Session
      const set = new ConflictSet(session, owner, session, () => {}, 0)
      try {
        await set.reconcile('provenance regression')
        const slot = t.s.room.doc.getMap<ConflictSlot>('conflicts').get(slotKey(owner, 'merge', other, 'app.py'))
        expect(slot?.status, JSON.stringify([...t.s.room.doc.getMap('conflicts')])).toBe(conflict ? 'conflict' : 'clean')
        const notices = post.mock.calls.filter(call => call[1]?.type === 'merge-conflict' && call[1]?.to === owner && call[1]?.text?.includes(`with ${other}`))
        expect(notices.length).toBe(conflict ? 1 : 0)
      } finally { set.stop() }
    }
    const keepA = async () => {
      put(worker, 'app.py', aText)
      expect(await t.call({ tag: 'test', keep: true })).toContain('kept test: finished and resumable')
      expect(fs.readFileSync(path.join(lead, 'app.py'), 'utf8')).toBe(aText)
      const a = (await registry.reserved('test'))!
      expect(a.collectedKeep).toBe(true)
      return a
    }
    return { t, registry, start, bDir, aText, bEdit, check, keepA }
  }

  it.each(['lead+test', 'lead+b'])('kept A then carried B edits a different region (%s)', async owner => {
    const f = await fixture()
    await f.keepA()
    // Spawn's tracked carry commit has the lead HEAD as parent, independent of
    // the private collection snapshot, but records the same inherited tree.
    put(f.bDir, 'app.py', f.aText)
    git(f.bDir, 'add', 'app.py'); git(f.bDir, 'commit', '-qm', 'room: carried work')
    const carried = git(f.bDir, 'rev-parse', 'HEAD')
    await f.registry.command((await f.registry.reserved('b'))!.id, { type: 'rebase', expectedBase: f.start, base: carried, carriedBase: carried })
    put(f.bDir, 'app.py', f.bEdit(f.aText))
    await f.check(owner, owner === 'lead+test' ? 'lead+b' : 'lead+test')
  })

  it.each(['lead+test', 'lead+b'])('kept A then B resumes without refresh (%s)', async owner => {
    const f = await fixture()
    await f.keepA()
    // B retains the pre-collection tree and baseline; A's output is only in
    // the lead and A. Their independent hunks still merge against start.
    put(f.bDir, 'app.py', f.bEdit(LINES))
    await f.check(owner, owner === 'lead+test' ? 'lead+b' : 'lead+test')
  })

  it.each(['lead', 'lead+b'])('unrefreshed B compares cleanly with the lead holding kept A text (%s)', async owner => {
    const f = await fixture()
    await f.keepA()
    put(f.bDir, 'app.py', f.bEdit(LINES))
    await f.check(owner, owner === 'lead' ? 'lead+b' : 'lead', false, true)
  })

  it.each(['lead+test', 'lead+b'])('both workers merge the same commit before independent edits (%s)', async owner => {
    const f = await fixture()
    put(lead, 'app.py', f.aText)
    git(lead, 'add', 'app.py'); git(lead, 'commit', '-qm', 'shared implementation')
    const shared = git(lead, 'rev-parse', 'HEAD')
    for (const dir of [worker, f.bDir]) {
      // Distinct branch tips also exercise merge-base(HEADs), rather than an
      // identical-tip shortcut. Their published baselines remain pinned.
      put(dir, path.basename(dir) + '.txt', 'private checkpoint\n')
      git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'private checkpoint')
      git(dir, 'merge', '-q', shared)
    }
    put(worker, 'app.py', f.aText.replace('A output', 'A refined'))
    put(f.bDir, 'app.py', f.bEdit(f.aText))
    await f.check(owner, owner === 'lead+test' ? 'lead+b' : 'lead+test')
  })

  it.each(['lead+test', 'lead+b'])('preserves a real conflict after both merge the same commit (%s)', async owner => {
    const f = await fixture()
    put(lead, 'app.py', f.aText)
    git(lead, 'add', 'app.py'); git(lead, 'commit', '-qm', 'shared implementation')
    const shared = git(lead, 'rev-parse', 'HEAD')
    for (const dir of [worker, f.bDir]) git(dir, 'merge', '-q', shared)
    put(worker, 'app.py', f.aText.replace('A output', 'A refined'))
    put(f.bDir, 'app.py', f.aText.replace('A output', 'B alternative'))
    await f.check(owner, owner === 'lead+test' ? 'lead+b' : 'lead+test', true)
  })

  it.each(['lead+test', 'lead+b'])('equal lead bytes do not prove adoption by a worker (%s)', async owner => {
    const f = await fixture()
    put(lead, 'app.py', f.aText)
    put(worker, 'app.py', f.aText.replace('A output', 'A refined'))
    put(f.bDir, 'app.py', f.aText)
    await f.check(owner, owner === 'lead+test' ? 'lead+b' : 'lead+test', true, true)
  })

  it.each(['lead+test', 'lead+b'])('B refreshes onto a lead commit containing kept A output (%s)', async owner => {
    const f = await fixture()
    await f.keepA()
    git(lead, 'add', 'app.py'); git(lead, 'commit', '-qm', 'collected implementation')
    const b = (await f.registry.reserved('b'))!
    const refreshed = await refreshWorkerBase(lead, b)
    expect(refreshed.kind).toBe('rebased')
    if (refreshed.kind !== 'rebased') throw new Error('refresh did not rebase')
    await f.registry.command(b.id, { type: 'rebase', expectedBase: f.start, base: refreshed.base,
      carriedBase: refreshed.carriedBase, carriedUntracked: refreshed.carriedUntracked })
    put(f.bDir, 'app.py', f.bEdit(f.aText))
    await f.check(owner, owner === 'lead+test' ? 'lead+b' : 'lead+test')
  })
})
