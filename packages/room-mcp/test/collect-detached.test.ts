import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { base, git, lead, put, setup, worker } from './collect-fixture.js'
import { rootIdentity, witnessPreparation } from '../src/worker-preparation.js'

it.each(['detached', 'other-branch'])('discards a witnessed worker on %s while preserving both tips', async state => {
  const t = setup()
  t.set('test', { ...t.w, exitCode: 0 })
  witnessPreparation(worker, 'room/test', { id: 'fixture', nonce: 'fixture' }, rootIdentity(worker), base)
  await t.sync()
  put(worker, 'file.txt', 'branch tip\n')
  git(worker, 'commit', '-qam', 'branch work')
  const branchTip = git(worker, 'rev-parse', 'HEAD')
  git(worker, 'checkout', '--detach', base)
  if (state === 'other-branch') git(worker, 'checkout', '-qb', 'user-review')
  put(worker, 'file.txt', 'checkout tip\n')
  git(worker, 'commit', '-qam', 'checkout work')
  const head = git(worker, 'rev-parse', 'HEAD')
  put(worker, 'draft.txt', 'uncommitted\n')
  const refused = await t.call({ tag: 'test' })
  expect(refused).toContain(state === 'detached' ? 'detached HEAD' : 'user-review')
  expect(refused).toContain('room/test')
  expect(refused).toContain('discard=true')
  expect(fs.existsSync(worker)).toBe(true)
  const discarded = await t.call({ tag: 'test', discard: true })
  expect(discarded).toContain('discarded test')
  expect(fs.existsSync(worker)).toBe(false)
  for (const tip of [head, branchTip]) expect(git(lead, 'rev-parse', `refs/room/recovery/test/${tip}^{}`)).toBe(tip)
  if (state === 'other-branch') expect(git(lead, 'rev-parse', 'user-review')).toBe(head)
  expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
})
