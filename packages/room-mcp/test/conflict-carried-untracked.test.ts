import { realRepo, setupLead } from './workers-fixture.js'
import { workerByTag } from './registry-fixture.js'
import { ConflictSet, type ConflictSlot, slotKey } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'
import { epochPublication } from '@room/shared/testing'
import { gitBlobHash, manifestKey, type ManifestEntry } from '@room/shared'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vitest'

const file = 'docs/carried.md'
const prefix = Array.from({ length: 252 }, (_, i) => `original line ${i + 1}`).join('\n')
const additions = Array.from({ length: 30 }, (_, i) => `worker addition ${i + 1}`).join('\n') + '\n'
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()

describe('conflicts on real spawn-carried untracked text', () => {
  async function fixture(trailingNewline: boolean, withSibling = false) {
    const { repo, head } = realRepo()
    fs.mkdirSync(path.join(repo, 'docs'))
    const original = prefix + (trailingNewline ? '\n' : '')
    fs.writeFileSync(path.join(repo, file), original)
    const t = setupLead(repo, head)
    expect(await t.leadTools.call('room_spawn', { tag: 'carried', task: 'extend carried documentation', carry: true })).toContain('spawned carried')
    const worker = (await workerByTag(repo, 'carried'))!
    expect(worker.carriedUntracked).toEqual([expect.objectContaining({ path: file, sha: gitBlobHash(original) })])
    expect(fs.readFileSync(path.join(worker.dir, file), 'utf8')).toBe(original)
    expect(git(worker.dir, 'ls-files', '--', file)).toBe('')
    if (withSibling) expect(await t.leadTools.call('room_spawn', { tag: 'sibling', task: 'leave carried documentation unchanged', carry: true })).toContain('spawned sibling')
    const sibling = withSibling ? (await workerByTag(repo, 'sibling'))! : undefined
    const room = t.a
    room.ensureRoomSalt()
    const states = new Map()
    const post = vi.fn().mockResolvedValue({ ok: true })
    const publish = (name: string, dir: string) => {
      room.participants.delete(`${name}\0proj`)
      epochPublication(room, name, head)
      room.participants.set(`${name}\0id`, { name, kind: 'agent' })
      states.set(name, { user: { name, kind: 'agent' }, sessionId: `session-${name}` })
      const oldHead = room.manifestHead.get(name)!
      room.manifestHead.set(name, { ...oldHead, level: 'full', rev: oldHead.rev + 1, semRev: oldHead.semRev + 1 })
      const text = fs.readFileSync(path.join(dir, file), 'utf8')
      const entries = new Y.Map<ManifestEntry>()
      entries.set(file, { change: name === 'rohanz' ? 'A' : 'M', state: 'shared', hash: gitBlobHash(text), at: 1, fence: '1' })
      room.manifest.set(manifestKey(name, '1'), entries)
      room.setOverlay(manifestKey(name, '1'), file, text)
    }
    const check = async (owner: string, nonPublisher?: 'owner' | 'peer') => {
      publish('rohanz', repo)
      publish(worker.name, worker.dir)
      if (sibling) publish(sibling.name, sibling.dir)
      if (nonPublisher) {
        const name = 'checkout-editor'
        epochPublication(room, name, head)
        room.participants.set(`${name}\0id`, { name, kind: 'agent' })
        room.participants.delete(`${name}\0git`)
        states.set(name, { user: { name, kind: 'agent' }, sessionId: `session-${name}` })
        room.manifestHead.set(name, { ...room.manifestHead.get(name)!,
          coverage: { kind: 'none', reason: 'not-publisher' }, publisher: nonPublisher === 'owner' ? 'rohanz' : worker.name })
      }
      post.mockClear()
      const session = { ...t.session, me: { name: owner, kind: 'agent' }, dir: owner === worker.name ? worker.dir : repo,
        post, awareness: { getStates: () => states }, provider: { synced: true }, lease: { fence: () => '1' } } as unknown as Session
      const set = new ConflictSet(session, owner, session, () => {}, 0)
      try { await set.reconcile('real carried untracked regression') } finally { set.stop() }
      const other = nonPublisher === 'peer' ? 'checkout-editor' : owner === worker.name ? 'rohanz' : worker.name
      return {
        merge: room.doc.getMap<ConflictSlot>('conflicts').get(slotKey(owner, 'merge', other, file)),
        overlap: room.doc.getMap<ConflictSlot>('conflicts').get(slotKey(owner, 'edit-in-claim', other, file)),
        notices: post.mock.calls.map(call => call[1]),
      }
    }
    return { ...t, repo, worker, original, check }
  }

  it.each([true, false])('keeps text and claim comparisons clean with an unchanged carried sibling (newline %s)', async trailingNewline => {
    const f = await fixture(trailingNewline, true)
    try {
      const text = f.original + (trailingNewline ? '' : '\n') + additions
      fs.writeFileSync(path.join(f.worker.dir, file), text)
      f.a.addClaim({ by: f.worker.name, byKind: 'agent', path: file, from: 252, to: 282, intent: 'extend end of file', claimedHash: gitBlobHash(text) })
      for (const owner of ['rohanz', f.worker.name]) {
        const result = await f.check(owner)
        expect(result.merge?.status).toBe('clean')
        if (owner === 'rohanz') expect(result.overlap?.status).toBe('clean')
        expect(result.notices.filter(n => n.type === 'conflict' || n.type === 'merge-conflict')).toEqual([])
      }
    } finally { await f.leadTools.shutdown() }
  })

  for (const side of ['owner', 'peer'] as const) {
    it.each([false, true])(`maps ${side} non-publisher claims against carried text (lead edits %s)`, async leadEdits => {
      const f = await fixture(true)
      try {
        const text = f.original + additions
        fs.writeFileSync(path.join(f.worker.dir, file), text)
        if (leadEdits) fs.appendFileSync(path.join(f.repo, file), 'lead addition\n')
        f.a.addClaim({ by: side === 'peer' ? 'checkout-editor' : f.worker.name, byKind: 'agent',
          path: file, from: 252, to: 282, intent: 'extend end of file', claimedHash: gitBlobHash(text) })
        const result = await f.check(side === 'owner' ? 'checkout-editor' : 'rohanz', side)
        expect(result.overlap?.status).toBe(leadEdits ? 'conflict' : 'clean')
        expect(result.notices.some(n => n.type === 'conflict')).toBe(leadEdits)
      } finally { await f.leadTools.shutdown() }
    })
  }

  for (const trailingNewline of [true, false]) {
    for (const edit of ['append', 'interior'] as const) {
      it(`${edit}, trailing newline ${trailingNewline}: unchanged lead has no competing edit or notice`, async () => {
        const f = await fixture(trailingNewline)
        try {
          const text = edit === 'append' ? f.original + (trailingNewline ? '' : '\n') + additions
            : f.original.replace('original line 126', 'worker revised line 126')
          fs.writeFileSync(path.join(f.worker.dir, file), text)
          f.a.addClaim({ by: f.worker.name, byKind: 'agent', path: file, from: edit === 'append' ? 253 : 126,
            to: edit === 'append' ? 282 : 126, intent: 'worker additions', claimedHash: gitBlobHash(text) })
          for (const owner of ['rohanz', f.worker.name]) {
            const result = await f.check(owner)
            expect.soft(result.merge?.status).toBe('clean')
            if (owner === 'rohanz') expect.soft(result.overlap?.status).toBe('clean')
            expect.soft(result.notices.filter(n => n.type === 'conflict' || n.type === 'merge-conflict')).toEqual([])
          }
        } finally { await f.leadTools.shutdown() }
      })

      it(`${edit}, trailing newline ${trailingNewline}: lead's post-spawn competing edit still conflicts`, async () => {
        const f = await fixture(trailingNewline)
        try {
          const text = edit === 'append' ? f.original + (trailingNewline ? '' : '\n') + additions
            : f.original.replace('original line 126', 'worker revised line 126')
          const leadText = edit === 'append' ? f.original + (trailingNewline ? '' : '\n') + 'lead addition\n'
            : f.original.replace('original line 126', 'lead revised line 126')
          fs.writeFileSync(path.join(f.worker.dir, file), text)
          fs.writeFileSync(path.join(f.repo, file), leadText)
          f.a.addClaim({ by: f.worker.name, byKind: 'agent', path: file, from: edit === 'append' ? 253 : 126,
            to: edit === 'append' ? 282 : 126, intent: 'worker additions', claimedHash: gitBlobHash(text) })
          for (const owner of ['rohanz', f.worker.name]) {
            const result = await f.check(owner)
            expect(result.merge?.status).toBe('conflict')
            expect(result.notices.some(n => n.type === 'merge-conflict' && n.to === owner)).toBe(true)
            if (owner === 'rohanz') expect(result.overlap?.status).toBe('conflict')
          }
        } finally { await f.leadTools.shutdown() }
      })
    }
  }
})
