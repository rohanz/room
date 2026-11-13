/** Public tool parity contract using real Git, with no relay or host/model process. */
import { git, httpxWorkers, lead, put, setup, worker } from './collect-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CollectionReview } from '../src/collection-review.js'
import { registryForDir } from '../src/worker-registry.js'
import { registerWorkers } from './registry-fixture.js'

describe('lifecycle collection observable contract', () => {
  it('copies named files without retiring, then keeps incremental output without reapplying delivered edits', async () => {
    const t = setup()
    put(worker, 'file.txt', 'worker edit\n')
    put(worker, 'new.txt', 'first delivery\n')
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['new.txt'] })).toContain('copied new.txt')
    expect(fs.readFileSync(path.join(lead, 'new.txt'), 'utf8')).toBe('first delivery\n')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
    const registry = await registryForDir(lead)
    expect((await registry.read('w_test'))?.phase).toBe('active')
    expect(await t.call({ tag: 'test', keep: true })).toContain('kept test: finished and resumable')
    expect((await registry.read('w_test'))).toMatchObject({ phase: 'active', collectedKeep: true })
    expect(t.s.room.retiredWorkers()).toEqual([])
    put(lead, 'file.txt', 'lead revision after delivery\n')
    put(worker, 'later.txt', 'follow-up\n')
    expect(await t.call({ tag: 'test' })).toContain('cleaned up test')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('lead revision after delivery\n')
    expect(fs.readFileSync(path.join(lead, 'later.txt'), 'utf8')).toBe('follow-up\n')
    expect(git(lead, 'diff', '--cached', '--name-only')).toBe('')
    expect((await registry.read('w_test'))?.phase).toBe('retired')
  })

  it('retains pending cleanup after applying and retries cleanup without reapplying output', async () => {
    const t = setup()
    put(worker, 'file.txt', 'delivered edit\n')
    t.state.ctx!.listCwdProcesses = () => { throw new Error('inspection unavailable') }
    expect(await t.call({ tag: 'test' })).toContain('inspection unavailable')
    const registry = await registryForDir(lead)
    expect((await registry.read('w_test'))).toMatchObject({ phase: 'active', collectPending: { reason: expect.stringContaining('cleanup incomplete') } })
    expect(t.s.room.retiredWorkers()).toEqual([])
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('delivered edit\n')
    put(lead, 'file.txt', 'lead edit after application\n')
    t.state.ctx!.listCwdProcesses = () => []
    expect(await t.call({ tag: 'test' })).toContain('kept test: changed since collection: file.txt')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('lead edit after application\n')
    expect((await registry.read('w_test'))?.phase).toBe('active')
    put(worker, 'file.txt', 'lead edit after application\n')
    expect(await t.call({ tag: 'test' })).toContain('cleaned up test')
    expect((await registry.read('w_test'))?.phase).toBe('retired')
    expect(fs.existsSync(worker)).toBe(false)
  })

  it.each([{ tag: 'test' }, { tag: 'test', mode: 'copy', paths: ['new.txt'] },
    { tag: 'test', discard: true, force: true }])('review hold blocks collection before effects: %j', async args => {
    const t = setup()
    await t.sync()
    put(worker, 'new.txt', 'unreviewed output\n')
    const registry = await registryForDir(lead), review = new CollectionReview(registry.root, lead)
    review.hold('review-thread', 'reviewer', 'inspect output')
    expect(await t.call(args)).toContain('held for review')
    expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(worker, 'new.txt'), 'utf8')).toBe('unreviewed output\n')
    expect((await registry.read('w_test'))?.phase).toBe('active')
    review.release('review-thread')
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['new.txt'] })).toContain('copied new.txt')
  })

  it('detaches a borrower without deleting its owner checkout or output', async () => {
    const t = httpxWorkers()
    put(worker, 'new.txt', 'shared output\n')
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools; the worktree belongs to port-fix')
    const registry = await registryForDir(lead)
    expect((await registry.read('w_port-bools'))?.phase).toBe('retired')
    expect((await registry.read('w_port-fix'))?.phase).toBe('active')
    expect(fs.readFileSync(path.join(worker, 'new.txt'), 'utf8')).toBe('shared output\n')
    expect(await t.call({ tag: 'port-fix' })).toContain('Changes from port-fix: new.txt')
    expect(fs.readFileSync(path.join(lead, 'new.txt'), 'utf8')).toBe('shared output\n')
  })

  it('force discard stops nested workers in their own lanes and preserves their output as recovery commits', async () => {
    const t = setup('running')
    await t.sync()
    const child = path.join(worker, '.room', 'workers', 'child')
    git(worker, 'worktree', 'add', '-qb', 'room/child', child)
    await registerWorkers(t.s, [{ ...t.w, tag: 'child', name: 'lead+child', lead: 'lead+test',
      dir: child, branch: 'room/child', status: 'running', pid: 0 }])
    put(child, 'file.txt', 'nested output\n')
    const result = await t.call({ tag: 'test', discard: true, force: true })
    expect(result).toContain('discarded child')
    expect(result).toContain('discarded test')
    const registry = await registryForDir(lead)
    for (const id of ['w_test', 'w_child']) expect((await registry.read(id))).toMatchObject({ phase: 'retired', discard: { steps: { cleanup: true } } })
    expect((await registry.read('w_test'))?.discard?.children).toEqual(['w_child'])
    const ref = (await registry.read('w_child'))!.discard!.recoveryRef!
    expect(git(lead, 'show', `${ref}:file.txt`)).toBe('nested output')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
    expect(fs.existsSync(worker)).toBe(false)
  })
})
