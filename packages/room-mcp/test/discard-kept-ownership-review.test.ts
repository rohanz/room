import fs from 'node:fs'
import { expect, it } from 'vitest'
import { lead, setup, worker } from './collect-fixture.js'
import { registryForDir } from '../src/worker-registry.js'

it('selects the owned second session after an unowned first kept candidate', async () => {
  const t = setup('done')
  await t.sync()
  const registry = await registryForDir(lead)
  const record = (await registry.read('w_test'))!
  const archive = { ...await registry.archiveOf(record, { summary: 'collected', disposition: 'collected' }), keptWorktree: worker }
  await registry.beginRetirement(record.id, archive, { keptWorktree: worker })
  await registry.finishCleanup(record.id, t.s.roomName)
  t.s.room.retireWorker(record.id, archive, () => {})
  const unowned = { ...t.s, me: { ...t.s.me, name: 'another-lead' } }
  t.state.rooms.all = () => [unowned, t.s]
  expect(await t.call({ tag: 'test', discard: true })).toContain('discarded test')
  expect(fs.existsSync(worker)).toBe(false)
  expect((await registry.read(record.id))!.archive!.disposition).toBe('discarded')
})
