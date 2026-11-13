import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { digestPath } from '@room/shared'
import { base, git, lead, put, setup, worker } from './collect-fixture.js'
import { publishFixture } from './fixtures/manifest.js'
import { stampLocalPublisher } from './fixtures/local-publisher.js'
import { buildCombinedTree } from '../src/tools/combined-tree.js'
import type { Session } from '../src/session.js'
import type { HandlerState } from '../src/tools/context.js'

it.each(['delete', 'rename'])('does not certify a preview that omits a carried-untracked %s', async change => {
  const t = setup(), file = 'bundle.mjs', bundle = 'bundle\n'.repeat(100_000)
  put(lead, file, bundle); put(worker, file, bundle)
  const sha = git(worker, 'hash-object', '-w', file)
  t.set('test', { ...t.w, exitCode: 0, carriedUntracked: [{ path: file, sha, mode: 0o644 }] })
  await t.sync()
  t.s.daemon.fence = '1'
  t.s.daemon.reconcileGitChanges = async () => {
    publishFixture(t.s.room, 'lead', 'file.txt', 'base\n', { base })
    const head = t.s.room.manifestHead.get('lead')!
    t.s.room.manifestHead.set('lead', { ...head, excluded: [digestPath(t.s.room.ensureRoomSalt(), file)] })
    t.s.room.participants.set('lead\0git', { ...t.s.room.participants.get('lead\0git')!, head: base })
  }
  t.s.daemon.settle = async () => {}
  await t.s.daemon.reconcileGitChanges()
  stampLocalPublisher(t.s)
  if (change === 'rename') fs.renameSync(path.join(worker, file), path.join(worker, 'renamed.mjs'))
  else fs.unlinkSync(path.join(worker, file))
  // Keep a rename's destination within the publication limit; the omitted source
  // deletion, not an oversized destination, must make this preview incomplete.
  if (change === 'rename') put(worker, 'renamed.mjs', 'renamed content\n')
  put(worker, 'own.txt', 'worker edit\n')
  const caller = { ...t.s, dir: worker, me: { name: 'lead+test', kind: 'agent' } } as Session
  const state = { ...t.state, S: () => caller, baseFor: () => base, shareOf: () => 'full' } as HandlerState
  const result = await buildCombinedTree(state, caller, [{ person: 'lead', session: caller }])
  expect(result.merged.get('own.txt')).toBe('worker edit\n')
  expect(result.complete, JSON.stringify({ gaps: result.gaps, out: result.out })).toBe(false)
  expect(result.gaps.some(gap => gap.path === file)).toBe(true)
})
