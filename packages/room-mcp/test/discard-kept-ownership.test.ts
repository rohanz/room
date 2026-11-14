import fs from 'node:fs'
import { expect, it } from 'vitest'
import { lead, setup, worker } from './collect-fixture.js'
import { registryForDir } from '../src/worker-registry.js'

it('skips a kept archive candidate whose lead chain is not owned by that session', async () => {
  const t = setup('done')
  await t.sync()
  const registry = await registryForDir(lead)
  const record = (await registry.read('w_test'))!
  const archive = { ...await registry.archiveOf(record, { summary: 'collected', disposition: 'collected' }), keptWorktree: worker }
  await registry.beginRetirement(record.id, archive, { keptWorktree: worker })
  await registry.finishCleanup(record.id, t.s.roomName)
  t.s.room.retireWorker(record.id, archive, () => {})
  // A different session holds the archived publication but has no ownership chain to its lead.
  t.s.me.name = 'another-lead'
  expect(await t.call({ tag: 'test', discard: true })).toBe('error: no worker test owned by you')
  expect((await registry.read(record.id))!.phase).toBe('retired')
  expect((await registry.read(record.id))!.discard).toBeUndefined()
  expect(fs.existsSync(worker)).toBe(true)
})
