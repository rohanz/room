import { commit, git, put, read, repo, world } from './worker-refresh-fixture.js'
import { workerByTag } from './registry-fixture.js'
import { ConflictSet, type ConflictSlot, slotKey } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'
import { gitBlobHash, manifestKey, type ManifestEntry } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import * as Y from 'yjs'
import fs from 'node:fs'
import path from 'node:path'
import { setGitObserver } from '@room/roomd/git'
import * as textMerge from '../src/merge.js'
import { describe, expect, it, vi } from 'vitest'

// Real spawn/carry against main's current worker baselines; no collection or
// separate given-baseline proof is needed. Only host processes and publication
// transport are synthetic. Unchanged carried files have no manifest entry,
// matching roomd's disk-scan/policy publication rule.
const initial = 'one\ncarried draft\nthree\nfour\nfive\n'
const round1 = initial.replace('carried draft', 'D round one')
const round2 = initial.replace('carried draft', 'D round two')

describe('merge budget workload', () => {
  async function fixture(kind: 'tracked' | 'untracked', structuredBase = false, extraWorkers = 0, expectCarry = true) {
    const file = kind === 'tracked' ? 'shared.txt' : 'draft.txt'
    if (structuredBase) {
      put(repo, file, initial.replace('carried draft', 'committed version'))
      commit(repo, 'structured tracked base')
    }
    put(repo, file, initial)
    const t = world()
    const spawn = async (tag: string, second: number) => {
      // Real workers can spawn minutes apart. Distinct deterministic carry
      // commits prevent a same-second identical-commit shortcut hiding the bug.
      const authorDate = process.env.GIT_AUTHOR_DATE, committerDate = process.env.GIT_COMMITTER_DATE
      process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = `2001-01-01T00:00:0${second}Z`
      try { return await t.spawn(tag, { carry: true }) }
      finally {
        if (authorDate === undefined) delete process.env.GIT_AUTHOR_DATE
        else process.env.GIT_AUTHOR_DATE = authorDate
        if (committerDate === undefined) delete process.env.GIT_COMMITTER_DATE
        else process.env.GIT_COMMITTER_DATE = committerDate
      }
    }
    const d = await spawn('d', 1)
    const u = await spawn('u', 2)
    const r = await spawn('r', 3)
    const extra = []
    for (let i = 0; i < extraWorkers; i++) extra.push(await spawn(`extra${i}`, i + 4))
    const publicationOverrides = new Map<string, typeof d>()
    for (const w of [d, u, r, ...extra]) {
      expect(read(w.dir, file)).toBe(initial)
      if (kind === 'tracked') expect(w.carriedBase).toBe(expectCarry ? w.base : undefined)
      else expect(w.carriedUntracked).toContainEqual(expect.objectContaining({ path: file, sha: gitBlobHash(initial) }))
    }
    const room = t.leadSession().room
    const dirs = new Map([['rohanz', repo], [d.name, d.dir], [u.name, u.dir], [r.name, r.dir], ...extra.map(w => [w.name, w.dir] as const)])
    const post = vi.fn().mockResolvedValue({ ok: true })
    const states = new Map([...dirs.keys()].map(name => [name, { user: { name, kind: 'agent' }, sessionId: `session-${name}` }]))
    let revision = 0
    const retained = new Map<string, () => void>()
    const retain = (name: string) => {
      const head = { ...room.manifestHead.get(name)! }
      const sourceGit = { ...room.participants.get(`${name}\0git`)! }
      const entries = [...room.manifest.get(manifestKey(name, '1'))!.entries()]
      const text = room.overlays.get(manifestKey(name, '1'))?.get(file)?.toString()
      retained.set(name, () => {
        room.participants.delete(`${name}\0proj`)
        room.manifestHead.set(name, head)
        room.participants.set(`${name}\0git`, sourceGit)
        room.manifest.set(manifestKey(name, '1'), new Y.Map(entries))
        if (text !== undefined) room.setOverlay(manifestKey(name, '1'), file, text)
      })
      return head
    }
    const publish = async () => {
      room.ensureRoomSalt()
      for (const [name, dir] of dirs) {
        if (retained.has(name)) { retained.get(name)!(); continue }
        const w = publicationOverrides.get(name) ?? (name === 'rohanz' ? undefined : await workerByTag(repo, name.slice(name.lastIndexOf('+') + 1)))
        const base = w?.base ?? git(dir, 'rev-parse', 'HEAD')
        // Projected public workers are intentionally replaced by their private
        // full publications, as in conflict-carried-untracked/provenance tests.
        room.participants.delete(`${name}\0proj`)
        epochPublication(room, name, base)
        room.participants.set(`${name}\0id`, { name, kind: 'agent' })
        room.participants.set(`${name}\0git`, { ...room.participants.get(`${name}\0git`)!, head: git(dir, 'rev-parse', 'HEAD') })
        room.manifestHead.set(name, { ...room.manifestHead.get(name)!, level: 'full', rev: ++revision, semRev: revision })
        const entries = new Y.Map<ManifestEntry>()
        const baselineHash = w?.carriedUntracked?.find(entry => entry.path === file)?.sha
          ?? / blob ([a-f0-9]+)\t/.exec(git(dir, 'ls-tree', base, '--', file))?.[1]
        const text = fs.existsSync(path.join(dir, file)) ? read(dir, file) : undefined
        // Match the publisher's blob comparison, including kept paths that are
        // present in the private base tree but remain untracked in the index.
        if ((text === undefined ? undefined : gitBlobHash(text)) !== baselineHash) {
          entries.set(file, { change: text === undefined ? 'D' : baselineHash ? 'M' : 'A', state: 'shared', ...(text === undefined ? {} : { hash: gitBlobHash(text) }), at: 1, fence: '1' })
          if (text !== undefined) room.setOverlay(manifestKey(name, '1'), file, text)
        }
        room.manifest.set(manifestKey(name, '1'), entries)
      }
    }
    const evaluate = async (owner: string, other: string, point: string) => {
      post.mockClear()
      const session = { ...t.leadSession(), graph: undefined, me: { name: owner, kind: 'agent' }, dir: dirs.get(owner)!, post,
        awareness: { getStates: () => states }, provider: { synced: true }, lease: { fence: () => '1' } } as unknown as Session
      const set = new ConflictSet(session, owner, session, () => {}, 0)
      try { await set.reconcile(point) } finally { set.stop() }
      const slot = room.doc.getMap<ConflictSlot>('conflicts').get(slotKey(owner, 'merge', other, file))
      const notices = post.mock.calls.map(call => call[1]).filter(n => n.type === 'merge-conflict' && n.to === owner && n.text.includes(`with ${other}'s version`)).map(n => n.text)
      return { owner, other, status: slot?.status, notices }
    }
    const checkpoint = async (point: string, expectedNoise: string[][] = []) => {
      await publish()
      for (const tag of ['u', 'r']) {
        const w = (await workerByTag(repo, tag))!
        const inherited = w.carriedUntracked?.find(entry => entry.path === file)?.sha
          ?? / blob ([a-f0-9]+)\t/.exec(git(w.dir, 'ls-tree', w.base!, '--', file))?.[1]
        expect(gitBlobHash(read(w.dir, file)), `${tag} still has exactly its received baseline`).toBe(inherited)
      }
      const rows = []
      for (const [owner, other] of [[d.name, u.name], [u.name, d.name], ['rohanz', u.name], [u.name, 'rohanz'], [d.name, r.name], [r.name, d.name]]) {
        rows.push(await evaluate(owner, other, point))
        expect(room.doc.getMap<ConflictSlot>('conflicts').get(slotKey(owner, 'merge', other, '*'))?.status,
          `${kind}: ${point}: comparison must be complete`).not.toBe('unknown')
      }
      console.info(JSON.stringify({ kind, point, rows }))
      const noisy = rows.filter(row => (row.status && row.status !== 'clean') || row.notices.length)
      expect.soft(noisy.map(row => [row.owner, row.other]), `${kind}: ${point}`).toEqual(expectedNoise)
      for (const row of noisy) {
        expect.soft(row.status).toBe('conflict')
        expect.soft(row.notices.length).toBeGreaterThan(0)
      }
      return rows
    }
    return { t, room, d, u, r, file, checkpoint, post, publish, dirs, states, publicationOverrides, evaluate, retain, retained }
  }

  it.skipIf(process.env.TEST_SCALE !== '1')('reports all Git reads for six workers and 200 changed tracked paths, cold and warm', async () => {
    const paths = Array.from({ length: 200 }, (_, i) => `batch/p${i}.txt`)
    for (const p of paths) put(repo, p, 'committed\n')
    commit(repo, 'many tracked inputs')
    for (const p of paths) put(repo, p, 'received carried draft\n')
    const f = await fixture('tracked', false, 3)
    await f.publish()
    // D edits all 200 paths; the five siblings keep exactly their received
    // copies. The lead still holds the carried drafts it originally handed out.
    for (const name of ['rohanz', f.d.name]) {
      const entries = f.room.manifest.get(manifestKey(name, '1'))!
      for (const p of paths) {
        const text = name === f.d.name ? `D edits ${p}\n` : 'received carried draft\n'
        put(f.dirs.get(name)!, p, text)
        entries.set(p, { change: 'M', state: 'shared', hash: gitBlobHash(text), at: 1, fence: '1' })
        f.room.setOverlay(manifestKey(name, '1'), p, text)
      }
    }
    const commands: string[][] = []
    const merges = vi.spyOn(textMerge, 'gitMergeFile')
    // Count admission without spending ten seconds on every four slots; the
    // actual merge and Git reads are unchanged. No wall-clock benchmark claim.
    const budget = vi.spyOn(ConflictSet.prototype as unknown as { budget(): Promise<void> }, 'budget').mockResolvedValue()
    let phaseStarted = performance.now()
    setGitObserver(args => commands.push([...args]))
    const report = () => ({ repositoryGitCommands: commands.length, mergeChecks: merges.mock.calls.length, budgetSlots: budget.mock.calls.length, elapsedMs: Math.round(performance.now() - phaseStarted), byFirstArgument: Object.fromEntries([...new Set(commands.map(args => args[0]))].sort()
      .map(command => [command, commands.filter(args => args[0] === command).length])) })
    try {
      // One owner reconciles against five sibling workers plus its lead, in a
      // room with six workers total. This is not an all-owner room-wide total.
      await f.evaluate(f.d.name, f.u.name, 'six-worker cold reconciliation')
      const cold = report()
      commands.length = 0
      merges.mockClear()
      budget.mockClear()
      phaseStarted = performance.now()
      await f.evaluate(f.d.name, f.u.name, 'six-worker warm reconciliation')
      const warm = report()
      process.stderr.write(JSON.stringify({ point: 'six-worker 200-path Git commands', workers: 6, changedPaths: 200, editedWorkers: 1, ownersReconciled: 1, peers: 6, cold, warm }) + '\n')
      // The Git observer covers repository commands; merge-file runs outside
      // the repository and is counted separately. Fixture setup is excluded.
      expect(cold.repositoryGitCommands).toBeGreaterThan(0)
      // Every unequal pair has one side equal to the ancestor: no merge runs.
      expect(cold.mergeChecks).toBe(0)
      expect(cold.budgetSlots).toBe(0)
      expect(warm.mergeChecks).toBe(0)
      expect(warm.budgetSlots).toBe(0)
      // Warm reconciliation still probes blob identity and ancestry; it does
      // not eliminate all Git reads.
      expect(warm.repositoryGitCommands).toBeGreaterThan(0)
      for (const p of paths) expect(f.room.doc.getMap<ConflictSlot>('conflicts').get(slotKey(f.d.name, 'merge', f.u.name, p))?.status).toBe('clean')
    } finally { setGitObserver(undefined); merges.mockRestore(); budget.mockRestore() }
  }, 600_000)

  it.each(['ours unchanged', 'theirs unchanged', 'identical', 'real conflict'] as const)('spends a slot only for a real merge: %s', async mode => {
    const f = await fixture('tracked')
    put(f.d.dir, f.file, mode === 'ours unchanged' ? initial : round1)
    put(f.u.dir, f.file, mode === 'theirs unchanged' ? initial : mode === 'identical' ? round1 : round2)
    await f.publish()
    const budget = vi.spyOn(ConflictSet.prototype as unknown as { budget(): Promise<void> }, 'budget')
    const merges = vi.spyOn(textMerge, 'gitMergeFile')
    try {
      const result = await f.evaluate(f.d.name, f.u.name, mode)
      expect(result.status).toBe(mode === 'real conflict' ? 'conflict' : 'clean')
      expect(budget).toHaveBeenCalledTimes(mode === 'real conflict' ? 1 : 0)
      expect(merges).toHaveBeenCalledTimes(mode === 'real conflict' ? 1 : 0)
    } finally { budget.mockRestore(); merges.mockRestore() }
  })
  it('does not spend a slot mapping an earlier edit against an unchanged claimant', async () => {
    put(repo, 'shared.txt', initial)
    commit(repo, 'common claimant ancestor')
    const f = await fixture('tracked', false, 0, false)
    put(f.d.dir, f.file, round1)
    f.room.addClaim({ by: f.u.name, byKind: 'agent', path: f.file, from: 1, to: 5, intent: 'review unchanged input' })
    await f.publish()
    const budget = vi.spyOn(ConflictSet.prototype as unknown as { budget(): Promise<void> }, 'budget')
    const merges = vi.spyOn(textMerge, 'gitMergeFile')
    try {
      await f.evaluate(f.d.name, f.u.name, 'unchanged claimant')
      expect(f.room.doc.getMap<ConflictSlot>('conflicts').get(slotKey(f.d.name, 'edit-in-claim', f.u.name, f.file)))
        .toMatchObject({ status: 'conflict', merges: 'clean' })
      expect(budget).not.toHaveBeenCalled()
      expect(merges).not.toHaveBeenCalled()
    } finally { budget.mockRestore(); merges.mockRestore() }
  })
})
