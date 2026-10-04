import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CollectionReview } from '../src/collection-review.js'
import { WorkerRegistry } from '../src/worker-registry.js'
import { execFileSync } from 'node:child_process'

let root: string, checkout: string, registry: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-review-')))
  checkout = path.join(root, 'checkout'); registry = path.join(root, 'registry')
  fs.mkdirSync(checkout)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
const review = () => new CollectionReview(registry, checkout)

it('persists across instances, hides recovery tokens, and only releases the matching reviewer', () => {
  const first = review().hold('thread-a', 'reviewer-a', 'independent review')
  const token = /reviewToken: ([a-f0-9]{64})/.exec(first)![1]
  review().hold('thread-b', 'reviewer-b', 'check types')
  expect(review().status()).not.toContain(token)
  expect(fs.readFileSync(review().file, 'utf8')).not.toContain(token)
  expect(() => review().assertClear()).toThrow('held for review')
  expect(() => review().release('lead')).toThrow('no matching')
  expect(() => review().release('lead', '0'.repeat(64))).toThrow('no matching')
  review().release('restarted-unbound-controller', token)
  expect(review().status()).not.toContain('reviewer-a:')
  expect(() => review().assertClear()).toThrow('reviewer-b')
  review().release('thread-b')
  expect(() => review().assertClear()).not.toThrow()
})

it('makes repeat holds idempotent and permits the same host thread to release after restart', () => {
  review().hold('thread-a', 'old name', 'review')
  expect(review().hold('thread-a', 'new name', 'review')).toContain('already active')
  review().release('thread-a')
  expect(review().status()).toBe('no collection review holds')
})

it('canonicalizes checkout aliases and isolates other worktrees', () => {
  const alias = path.join(root, 'alias'), other = path.join(root, 'other')
  fs.symlinkSync(checkout, alias); fs.mkdirSync(other)
  new CollectionReview(registry, alias).hold('reviewer', 'reviewer', 'review')
  expect(() => review().assertClear()).toThrow('held for review')
  expect(() => new CollectionReview(registry, other).assertClear()).not.toThrow()
})

it.each(['{', '{}', '[{}]', '[null]'])('fails closed on corrupt saved state %s', value => {
  const r = review()
  fs.mkdirSync(path.dirname(r.file), { recursive: true }); fs.writeFileSync(r.file, value)
  expect(() => r.assertClear()).toThrow('collection blocked')
  expect(() => r.hold('a', 'a', 'review')).toThrow('collection blocked')
  expect(() => r.release('a')).toThrow('collection blocked')
})

it('serializes checkpoint creation with collection across registry instances', async () => {
  execFileSync('git', ['init', '-q', checkout])
  const common = path.join(checkout, '.git')
  const a = await WorkerRegistry.open(common, { watch: false })
  const b = await WorkerRegistry.open(common, { watch: false })
  let release!: () => void, entered!: () => void
  const active = new Promise<void>(resolve => { entered = resolve })
  const finish = new Promise<void>(resolve => { release = resolve })
  const events: string[] = []
  try {
    const collect = a.withCollectLease(checkout, async () => { events.push('collect'); entered(); await finish; events.push('collected') })
    await active
    const hold = b.withCollectLease(checkout, async () => { new CollectionReview(b.root, checkout).hold('reviewer', 'reviewer', 'review'); events.push('held') })
    release(); await Promise.all([collect, hold])
    expect(events).toEqual(['collect', 'collected', 'held'])
    await expect(a.withCollectLease(checkout, async () => new CollectionReview(a.root, checkout).assertClear())).rejects.toThrow('held for review')
  } finally { a.close(); b.close() }
})
