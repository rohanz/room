import { base, git, httpxWorkers, lead, put, setup, worker } from './collect-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { autoRetire } from '../src/retire.js'
import { cleanupWorker, type WorkerCleanupPreservation } from '../src/worker-git.js'
import { registryForDir } from '../src/worker-registry.js'
import { realStateInput } from '../src/worker-status.js'
import { finishWorker, workerByTag } from './registry-fixture.js'
describe('room_collect', () => {

  it('detaches port-bools, then discards port-fix and its worktree', async () => {
    const t = httpxWorkers()
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools; the worktree belongs to port-fix')
    expect(fs.existsSync(worker)).toBe(true)
    expect(workerByTag(lead, 'port-bools')).toBeUndefined()
    expect(await t.call({ tag: 'port-fix', discard: true })).toContain('discarded port-fix')
    expect(fs.existsSync(worker)).toBe(false)
  })

  it('detaches an older port-bools record without sharedWith using the canonical owner', async () => {
    const t = httpxWorkers('done', false)
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools; the worktree belongs to port-fix')
    expect(fs.existsSync(worker)).toBe(true)
  })

  it('never removes the owner checkout when discarding an already collected borrower', async () => {
    const t = httpxWorkers()
    await t.sync()
    const registry = await registryForDir(lead)
    const record = registry.read('w_port-bools')!
    const archive = { ...registry.archiveOf(record, { summary: 'kept', disposition: 'collected' }), keptWorktree: worker }
    await registry.beginRetirement(record.id, archive, { keptWorktree: worker })
    await registry.finishCleanup(record.id, t.s.roomName)
    t.s.room.retireWorker(record.id, { ...archive, id: record.id }, () => {})
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools; the worktree belongs to port-fix')
    expect(fs.existsSync(worker)).toBe(true)
    expect(workerByTag(lead, 'port-fix')).toBeDefined()
  })

  it('discards port-fix after retiring finished port-bools', async () => {
    const t = httpxWorkers()
    const result = await t.call({ tag: 'port-fix', discard: true })
    expect(result).toContain('detached port-bools')
    expect(result).toContain('discarded port-fix')
    expect(fs.existsSync(worker)).toBe(false)
    expect(workerByTag(lead, 'port-fix')).toBeUndefined()
    expect(workerByTag(lead, 'port-bools')).toBeUndefined()
  })

  it('keeps port-fix while port-bools still runs in its worktree', async () => {
    const t = httpxWorkers('running')
    const result = await t.call({ tag: 'port-fix', discard: true })
    expect(result).toContain('port-bools is still running')
    expect(fs.existsSync(worker)).toBe(true)
    expect(workerByTag(lead, 'port-fix')).toBeDefined()
  })

  it('collects the owner changes but keeps its running borrower and checkout', async () => {
    const t = httpxWorkers('running')
    put(worker, 'new.txt', 'shared output')
    const list = vi.fn(() => [])
    t.state.ctx = { listCwdProcesses: list, probe: () => undefined } as never
    const result = await t.call({ tag: 'port-fix' })
    expect(result).toContain('Changes from port-fix: new.txt')
    expect(result).toContain("kept port-fix's worktree: port-bools is still running in it")
    expect(fs.existsSync(worker)).toBe(true)
    expect(workerByTag(lead, 'port-bools')?.status).toBe('running')
    expect(fs.readFileSync(path.join(lead, 'new.txt'), 'utf8')).toBe('shared output')
    expect(list).not.toHaveBeenCalled()
  })

  it('collects an owner after retiring its finished borrower', async () => {
    const t = httpxWorkers()
    put(worker, 'new.txt', 'shared output')
    const result = await t.call({ tag: 'port-fix' })
    expect(result).toContain('retired port-bools with port-fix')
    expect(result).toContain('cleaned up port-fix')
    expect(fs.existsSync(worker)).toBe(false)
    expect(workerByTag(lead, 'port-bools')).toBeUndefined()
  })

  it('detaches the last discarded borrower without authorizing owner cleanup', async () => {
    const t = httpxWorkers('running')
    put(worker, 'new.txt', 'shared output')
    expect(await t.call({ tag: 'port-fix' })).toContain("kept port-fix's worktree")
    expect(git(lead, 'rev-parse', 'refs/room/collect-head/port-fix/w_port-fix')).toBe(git(worker, 'rev-parse', 'HEAD'))
    expect(git(lead, 'rev-parse', 'refs/room/collect-base/port-fix/w_port-fix')).toBe(base)
    put(worker, 'artifact.bin', 'late ignored output')
    await finishWorker(t.s, 'port-bools', { status: 'done' })
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools')
    expect(fs.existsSync(worker)).toBe(true)
    expect((await registryForDir(lead)).read('w_port-fix')?.keptWorktree).toBe(worker)
    expect(fs.readFileSync(path.join(worker, 'artifact.bin'), 'utf8')).toBe('late ignored output')
    expect(await t.call({ tag: 'port-fix', discard: true })).toContain('discard refused; ignored artifacts')
    expect(await t.call({ tag: 'port-fix', discard: true, force: true })).toContain('discarded port-fix')
    expect(fs.existsSync(worker)).toBe(false)
  })

  it('collects the last borrower without removing the owner checkout during its own collection', async () => {
    const t = httpxWorkers('running')
    put(worker, 'new.txt', 'shared output')
    expect(await t.call({ tag: 'port-fix' })).toContain("kept port-fix's worktree")
    await finishWorker(t.s, 'port-bools', { status: 'done' })
    const result = await t.call({ tag: 'port-bools' })
    expect(result).toContain('detached port-bools; the worktree belongs to port-fix')
    expect(fs.existsSync(worker)).toBe(false)
  })

  it('keeps late ignored owner output when collecting the last borrower', async () => {
    const t = httpxWorkers('running')
    put(worker, 'new.txt', 'shared output')
    expect(await t.call({ tag: 'port-fix' })).toContain("kept port-fix's worktree")
    put(worker, 'artifact.bin', 'late ignored output')
    await finishWorker(t.s, 'port-bools', { status: 'done' })
    const result = await t.call({ tag: 'port-bools' })
    expect(result).toContain(`kept port-fix's worktree at ${worker}: ignored files not copied: artifact.bin`)
    expect(result).toContain('Copy what you need from there, then room_collect(tag="port-fix", discard=true) (add force=true to delete ignored files too)')
    expect(fs.readFileSync(path.join(worker, 'artifact.bin'), 'utf8')).toBe('late ignored output')
    const owner = (await registryForDir(lead)).read('w_port-fix')
    expect(owner?.keptWorktree).toBe(worker)
    expect(owner?.archive?.keptReason).toContain('artifact.bin')
    expect(t.s.room.retiredWorkers().find(r => r.tag === 'port-fix')?.keptReason).toContain('artifact.bin')
    expect(await t.call({ tag: 'port-fix', discard: true })).toContain('discard refused; ignored artifacts')
    expect(fs.existsSync(worker)).toBe(true)
    expect(await t.call({ tag: 'port-fix', discard: true, force: true })).toContain('discarded port-fix')
    expect(fs.existsSync(worker)).toBe(false)
  })

  it.each([false, true])('keeps late output at the borrower retirement boundary (committed=%s)', async committed => {
    const t = httpxWorkers('running')
    put(worker, 'new.txt', 'shared output')
    expect(await t.call({ tag: 'port-fix' })).toContain("kept port-fix's worktree")
    await finishWorker(t.s, 'port-bools', { status: 'done' })
    const project = t.state.rooms.project
    let wrote = false
    t.state.rooms.project = async () => {
      await project()
      const registry = await registryForDir(lead)
      if (!wrote && registry.read('w_port-bools')?.phase === 'retired') {
        wrote = true
        put(worker, 'late.txt', 'uncopied late output')
        if (committed) { git(worker, 'add', 'late.txt'); git(worker, 'commit', '-qm', 'late work') }
      }
    }
    const result = await t.call({ tag: 'port-bools' })
    expect(wrote).toBe(true)
    expect(result).toContain("kept port-fix's worktree")
    expect(result).toContain('late.txt')
    if (committed) expect(result).toMatch(/commits after collection: [0-9a-f]{7,12} late\.txt/)
    expect(fs.readFileSync(path.join(worker, 'late.txt'), 'utf8')).toBe('uncopied late output')
    expect(fs.existsSync(path.join(lead, 'late.txt'))).toBe(false)
    expect(git(lead, 'show-ref', '--verify', 'refs/heads/room/port-fix')).toBeTruthy()
  })

  it('removes an unchanged checkout while naming a recovery ref for its unmerged branch tip', async () => {
    const t = setup()
    put(worker, 'committed.txt', 'worker output')
    git(worker, 'add', 'committed.txt'); git(worker, 'commit', '-qm', 'worker output')
    const tip = git(worker, 'rev-parse', 'HEAD')
    const result = await t.call({ tag: 'test' })
    const ref = `refs/room/recovery/test/${tip}`
    expect(result).toContain('cleaned up test')
    expect(result).toContain(`branch recovery ref: ${ref}`)
    expect(fs.existsSync(worker)).toBe(false)
    expect(git(lead, 'rev-parse', ref)).toBe(tip)
    expect(git(lead, 'branch', '--list', 'room/test')).toBe('')
  })

  it('keeps uncollected changes made after the owner was collected', async () => {
    const t = httpxWorkers('running')
    put(worker, 'new.txt', 'shared output')
    expect(await t.call({ tag: 'port-fix' })).toContain("kept port-fix's worktree")
    put(worker, 'late.txt', 'new borrower work')
    await finishWorker(t.s, 'port-bools', { status: 'done' })
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools')
    const registry = await registryForDir(lead)
    const owner = registry.read('w_port-fix')!, status = registry.status(owner.id)!
    const preservation: WorkerCleanupPreservation = { ignored: [], uncollected: [] }
    await registry.beginOperation(owner.id, 'collect')
    try {
      expect(await cleanupWorker(lead, { ...realStateInput(owner, status), status: 'done', exitCode: 0 }, true, false, [], {}, 'lead', [owner], preservation)).toBe(false)
    } finally { await registry.finishOperation(owner.id) }
    expect(preservation).toEqual({ ignored: [], uncollected: ['late.txt'] })
    expect(fs.readFileSync(path.join(worker, 'late.txt'), 'utf8')).toBe('new borrower work')
  })

  it.each(['staged', 'committed'] as const)('keeps an uncollected rename deletion after a retained owner is %s', async state => {
    const t = httpxWorkers('running')
    put(worker, 'new.txt', 'shared output')
    expect(await t.call({ tag: 'port-fix' })).toContain("kept port-fix's worktree")
    git(worker, 'config', 'diff.renames', 'true')
    git(worker, 'mv', 'file.txt', 'renamed.txt')
    expect(git(worker, 'diff', '--name-status', 'HEAD')).toMatch(/^R100\s/)
    if (state === 'committed') git(worker, 'commit', '-qm', 'late rename')
    // The lead has the destination bytes but has not collected the source deletion.
    put(lead, 'renamed.txt', fs.readFileSync(path.join(worker, 'renamed.txt'), 'utf8'))
    await finishWorker(t.s, 'port-bools', { status: 'done' })
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools')
    const registry = await registryForDir(lead)
    const owner = registry.read('w_port-fix')!, status = registry.status(owner.id)!
    const preservation: WorkerCleanupPreservation = { ignored: [], uncollected: [] }
    await registry.beginOperation(owner.id, 'collect')
    try {
      expect(await cleanupWorker(lead, { ...realStateInput(owner, status), status: 'done', exitCode: 0 }, true, false, [], {}, 'lead', [owner], preservation)).toBe(false)
    } finally { await registry.finishOperation(owner.id) }
    expect(preservation.uncollected).toEqual(['file.txt'])
    if (state === 'committed') expect(preservation.commitsAfterCollection?.paths).toEqual(['file.txt', 'renamed.txt'])
    expect(fs.existsSync(worker)).toBe(true)
    expect(fs.existsSync(path.join(worker, 'file.txt'))).toBe(false)
    expect(fs.existsSync(path.join(lead, 'file.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(worker, 'renamed.txt'))).toEqual(fs.readFileSync(path.join(lead, 'renamed.txt')))
  })

  it('deferred retirement keeps an owner checkout while its borrower runs', async () => {
    const t = httpxWorkers('running')
    await t.sync()
    const list = vi.fn(() => [])
    const rooms = { ...t.state.rooms, probe: () => undefined, hasHandle: () => false,
      tracking: () => true, listCwdProcesses: list } as never
    await autoRetire(t.s, rooms)
    const registry = await registryForDir(lead)
    expect(registry.read('w_port-fix')?.phase).toBe('retired')
    expect(registry.read('w_port-fix')?.keptWorktree).toBe(worker)
    expect(fs.existsSync(worker)).toBe(true)
    expect(workerByTag(lead, 'port-bools')?.status).toBe('running')
    expect(list).not.toHaveBeenCalled()
    await finishWorker(t.s, 'port-bools', { status: 'done' })
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools')
    expect(fs.existsSync(worker)).toBe(true)
  })

  it('serializes a borrower resume with the owner cleanup decision', async () => {
    const t = httpxWorkers()
    t.set('port-bools', { ...t.get('port-bools'), hostSessionId: 'borrower-session' })
    await t.sync()
    const registry = await registryForDir(lead)
    expect(registry.status('w_port-bools')?.status).toBe('done')
    await registry.beginOperation('w_port-fix', 'collect')
    try {
      await expect(registry.resume('w_port-bools', 10, { nonce: 'next', busFrontier: 0, logStart: 0 }))
        .rejects.toThrow('worker operation lease held')
    } finally { await registry.finishOperation('w_port-fix') }
    await registry.resume('w_port-bools', 10, { nonce: 'next', busFrontier: 0, logStart: 0 })
    await registry.finishOperation('w_port-bools')
    put(worker, 'new.txt', 'shared output')
    const result = await t.call({ tag: 'port-fix' })
    expect(result).toContain("kept port-fix's worktree: port-bools is still running in it")
    expect(fs.existsSync(worker)).toBe(true)
  })

  it('does not admit a new borrower while owner cleanup holds its operation', async () => {
    const t = httpxWorkers()
    await t.sync()
    const registry = await registryForDir(lead)
    const prior = registry.read('w_port-bools')!
    const late = { ...prior, id: 'w_late', tag: 'late', name: 'lead+late', phase: 'intent' as const,
      prep: { step: 'plan' as const }, runs: [{ ...prior.runs[0], launch: undefined }], seq: 1 }
    await registry.beginOperation('w_port-fix', 'collect')
    try {
      await expect(registry.writeIntent(late)).rejects.toThrow('worker operation lease held')
      expect(registry.read('w_late')).toBeUndefined()
    } finally { await registry.finishOperation('w_port-fix') }
    await registry.writeIntent(late)
    expect(registry.read('w_late')?.sharedWith).toBe('w_port-fix')
    await registry.finishOperation('w_late')
  })

  it('replays an owner discard by retiring its finished borrower first', async () => {
    const t = httpxWorkers()
    await t.sync()
    const registry = await registryForDir(lead)
    await registry.beginDiscard('w_port-fix', false, [])
    await registry.replayDiscard('w_port-fix')
    expect(registry.read('w_port-bools')?.phase).toBe('retiring')
    expect(registry.read('w_port-fix')?.phase).toBe('retiring')
    expect(fs.existsSync(worker)).toBe(false)
  })

  it('cleans both httpx registry entries after their shared worktree vanished', async () => {
    const t = httpxWorkers()
    await t.sync()
    fs.rmSync(worker, { recursive: true, force: true })
    expect(await t.call({ tag: 'port-bools', discard: true })).toContain('detached port-bools')
    expect(await t.call({ tag: 'port-fix', discard: true })).toContain('discarded port-fix')
    expect(workerByTag(lead, 'port-fix')).toBeUndefined()
    expect(workerByTag(lead, 'port-bools')).toBeUndefined()
  })

  it('retires the borrower when the vanished owner is discarded first', async () => {
    const t = httpxWorkers()
    await t.sync()
    fs.rmSync(worker, { recursive: true, force: true })
    const result = await t.call({ tag: 'port-fix', discard: true })
    expect(result).toContain('detached port-bools')
    expect(result).toContain('discarded port-fix; its worktree was already gone')
    expect(workerByTag(lead, 'port-fix')).toBeUndefined()
    expect(workerByTag(lead, 'port-bools')).toBeUndefined()
  })

  it('leaves all files and indexes untouched on a conflict', async () => {
    put(lead, 'file.txt', 'lead\n'); put(worker, 'file.txt', 'worker\n'); put(worker, 'new.txt', 'new')
    const before = git(lead, 'write-tree')
    expect(await setup().call({ tag: 'test' })).toContain('Nothing written; conflicting files: file.txt')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('lead\n')
    expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
    expect(git(lead, 'write-tree')).toBe(before); expect(git(worker, 'rev-parse', 'HEAD')).toBe(base)
  })
})
