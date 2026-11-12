import { expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { digestPath } from '@room/shared'
import * as baselineModule from '@room/roomd/baseline'
import { base, carry, lead, put, setup, worker } from './collect-fixture.js'
import { publishFixture } from './fixtures/manifest.js'
import { buildCombinedTree } from '../src/tools/combined-tree.js'
import type { Session } from '../src/session.js'
import type { HandlerState } from '../src/tools/context.js'

it.each(['unchanged', 'edit', 'delete', 'rename', 'unreadable'])('requires an oversized carried file after keep when changed or unknown: %s', async change => {
  const t = setup(), bundle = 'bundle\n'.repeat(100_000)
  carry(t, worker, 'test', { 'file.txt': bundle })
  t.set('test', { ...t.get('test'), exitCode: 0 })
  put(lead, 'file.txt', bundle)
  const publish = async () => {
    publishFixture(t.s.room, 'lead', 'source.txt', 'source\n', { base })
    const head = t.s.room.manifestHead.get('lead')!
    t.s.room.manifestHead.set('lead', { ...head, excluded: [digestPath(t.s.room.ensureRoomSalt(), 'file.txt')] })
    t.s.room.participants.set('lead\0git', { ...t.s.room.participants.get('lead\0git')!, head: base })
  }
  put(lead, 'source.txt', 'source\n')
  t.s.daemon.fence = '1'; t.s.daemon.reconcileGitChanges = publish; t.s.daemon.settle = async () => {}
  expect(await t.call({ tag: 'test', keep: true })).toContain('kept test')
  put(worker, 'new.txt', 'next edit\n')
  if (change === 'edit') put(worker, 'file.txt', bundle + 'worker edit\n')
  if (change === 'delete') fs.unlinkSync(path.join(worker, 'file.txt'))
  if (change === 'rename') {
    fs.renameSync(path.join(worker, 'file.txt'), path.join(worker, 'renamed.txt'))
    put(worker, 'renamed.txt', 'renamed content\n')
  }
  const caller = { ...t.s, dir: worker, me: { name: 'lead+test', kind: 'agent' } } as Session
  const state = { ...t.state, S: () => caller, baseFor: () => base, shareOf: () => 'full' } as HandlerState
  const proof = change === 'unreadable' ? vi.spyOn(baselineModule, 'carriedCommitUnchangedPaths')
    .mockRejectedValueOnce(new Error('baseline comparison unavailable')) : undefined
  try {
    const result = await buildCombinedTree(state, caller, [{ person: 'lead', session: caller }])
    expect(result.complete, JSON.stringify(result.gaps)).toBe(change === 'unchanged')
    expect(result.merged.get('new.txt')).toBe('next edit\n')
    expect(result.merged.has('file.txt')).toBe(false)
    if (change !== 'unchanged') expect(result.gaps.some(gap => gap.path === 'file.txt')).toBe(true)
    if (change === 'rename') expect(result.merged.get('renamed.txt')).toBe('renamed content\n')
    if (proof) expect(proof).toHaveBeenCalled()
  } finally { proof?.mockRestore() }
})
