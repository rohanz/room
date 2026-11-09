import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { setup, put, worker, lead } from './collect-fixture.js'
import { requireWorkerInventory } from '../src/worker-store.js'
import { registryForDir } from '../src/worker-registry.js'
import { handlers as reviewHandlers } from '../src/tools/review.js'

describe('room_review', () => {
it('enforces a durable review hold before apply, copy, discard or force and preserves resumable work', async () => {
  const t = setup()
  t.set('test', { ...t.w, exitCode: 0 })
  await t.sync()
  let reviewer = 'review-thread'
  t.state.ctx.binding = { id: () => reviewer } as NonNullable<typeof t.state.ctx.binding>
  put(worker, 'file.txt', 'reviewed change\n')
  const held = await reviewHandlers(t.state).room_review({ action: 'hold', reason: 'independent review before collection' })
  expect(held).toContain('hold active')
  reviewer = 'lead-thread'
  for (const args of [{}, { tag: 'test' }, { tag: 'test', keep: true }, { tag: 'test', mode: 'copy', paths: ['file.txt'], force: true }, { tag: 'test', discard: true, force: true }]) {
    expect(await t.call(args)).toContain('held for review')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
    expect(fs.existsSync(worker)).toBe(true)
    expect((await (await registryForDir(lead)).read((requireWorkerInventory(await (await registryForDir(lead)).list()))[0].id))?.phase).not.toBe('retired')
  }
  expect(await reviewHandlers(t.state).room_review({ action: 'release' })).toContain('no matching review hold')
  expect(await reviewHandlers(t.state).room_review({ action: 'status' })).toContain('independent review')
  reviewer = 'review-thread'
  expect(await reviewHandlers(t.state).room_review({ action: 'release' })).toContain('no work collected')
  expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
  expect(await t.call({})).toContain('Changes from test')
  expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('reviewed change\n')
  expect(fs.existsSync(worker)).toBe(false)
})

it.each([
  { action: 'hold', reason: 'review', discard: true },
  { action: 'release', tag: 'test' },
  { action: 'status', force: false },
  { action: 'status', keep: true },
  { action: 'hold', reason: '' },
  { action: 'hold', reason: 'review', reviewToken: '0'.repeat(64) },
  { action: 'release', reason: 'review' },
  { action: 'unknown' },
  { action: 'hold', reason: 'review', typo: true },
  { reason: 'review' },
  { reviewToken: '0'.repeat(64) },
])('rejects malformed or mixed review requests without collecting: %j', async args => {
  const t = setup()
  put(worker, 'file.txt', 'worker edit\n')
  expect(await reviewHandlers(t.state).room_review(args)).toContain('error:')
  expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
  expect(fs.existsSync(worker)).toBe(true)
})
it.each([{}, { action: ['hold'] }, { action: null }, { action: 'hold' }, { action: 'hold', reason: ' '.repeat(3) }, { action: 'hold', reason: 'x'.repeat(1001) }, { action: 'release', reviewToken: 'invalid' }, { action: 'status', reason: 'review' }])('validates %j', async args => {
  const t = setup()
  expect(await reviewHandlers(t.state).room_review(args)).toContain('error:')
})

it('releases with a private recovery token from a replacement session', async () => {
  const t = setup()
  let owner = 'reviewer'
  t.state.ctx.binding = { id: () => owner } as NonNullable<typeof t.state.ctx.binding>
  const held = await reviewHandlers(t.state).room_review({ action: 'hold', reason: 'review' })
  const token = /reviewToken: ([a-f0-9]{64})/.exec(held)![1]
  owner = 'replacement'
  expect(await reviewHandlers(t.state).room_review({ action: 'status' })).not.toContain(token)
  expect(await reviewHandlers(t.state).room_review({ action: 'release', reviewToken: token })).toContain('no work collected')
  expect(await reviewHandlers(t.state).room_review({ action: 'status' })).toBe('no collection review holds')
})
})
