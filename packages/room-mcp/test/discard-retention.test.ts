import fs from 'node:fs'
import { expect, it, vi } from 'vitest'
import { git, lead, put, setup, worker } from './collect-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { FileWorkerStore } from '../src/worker-file-store.js'

async function interruptedKeptDiscard() {
  const t = setup()
  put(worker, 'file.txt', 'delivered private baseline\n')
  await t.call({ tag: 'test', keep: true })
  put(worker, 'file.txt', 'later worker bytes\n')
  const registry = await registryForDir(lead)
  await registry.beginDiscard('w_test', [])
  const original = FileWorkerStore.prototype.markDiscardStep
  const fault = vi.spyOn(FileWorkerStore.prototype, 'markDiscardStep').mockImplementation(async function (this: FileWorkerStore, id, step) {
    const result = await original.call(this, id, step)
    if (step === 'patch') throw new Error('crashed after patch')
    return result
  })
  try { await expect(registry.replayDiscard('w_test')).rejects.toThrow('crashed after patch') }
  finally { fault.mockRestore() }
  return { registry, record: (await registry.read('w_test'))! }
}

it('resets the patch retention age when delayed replay destructively removes the checkout', async () => {
  const { registry, record } = await interruptedKeptDiscard()
  const patch = record.discard!.patch!.path
  const initialAge = fs.statSync(patch).mtimeMs
  const day = 86400_000, realNow = Date.now.bind(Date)
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6 * day)
  try {
    const removalTime = Date.now()
    await registry.replayDiscard('w_test')
    expect(fs.existsSync(worker)).toBe(false)
    expect(fs.statSync(patch).mtimeMs).toBeGreaterThanOrEqual(removalTime - 1)
    expect(fs.statSync(patch).mtimeMs - initialAge).toBeGreaterThan(5 * day)
  } finally { clock.mockRestore() }
})

it('retains the checkout and names the missing exact patch base instead of deleting unrecoverable work', async () => {
  const { registry, record } = await interruptedKeptDiscard()
  const ref = record.discard!.baseRef!, oid = ref.split('/').at(-1)!
  // Remove only fixture refs holding this private kept base, then make the loss real.
  for (const name of git(lead, 'for-each-ref', '--format=%(refname)', '--contains', oid).split('\n').filter(Boolean)) {
    git(lead, 'update-ref', '-d', name)
  }
  git(lead, 'reflog', 'expire', '--expire=now', '--all')
  git(lead, 'gc', '--prune=now', '--quiet')
  expect(() => git(lead, 'cat-file', '-t', oid)).toThrow()
  await expect(registry.replayDiscard('w_test')).rejects.toThrow(`discard recovery base commit ${oid} is missing`)
  expect(fs.existsSync(worker)).toBe(true)
  expect((await registry.read('w_test'))!.phase).toBe('discarding')
})
