import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { httpxWorkers, lead, worker } from './collect-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { FileWorkerStore } from '../src/worker-file-store.js'
import * as workerGit from '../src/worker-git.js'

// Review's two old-pass/new-fail reproducers, with the newly authorized post-recovery boundary.
it.each(['late-sidecar', 'second-cleanup-error', 'during-recovery-write'] as const)('kept borrower cleans logs once after recovery (%s)', async fault => {
  const t = httpxWorkers()
  await t.sync()
  const registry = await registryForDir(lead)
  const record = (await registry.read('w_port-bools'))!
  const archive = { ...await registry.archiveOf(record, { summary: 'kept', disposition: 'collected' }), keptWorktree: worker }
  await registry.beginRetirement(record.id, archive, { keptWorktree: worker })
  await registry.finishCleanup(record.id, t.s.roomName)
  t.s.room.retireWorker(record.id, archive, () => {})
  const log = path.join(lead, '.room', 'workers', 'port-bools.log')
  fs.writeFileSync(log, 'original log')
  const facts = vi.spyOn(FileWorkerStore.prototype, 'recordDiscardRecovery')
  const ensure = FileWorkerStore.prototype.ensureDiscardRecovery, cleanup = workerGit.cleanupWorkerLogs
  let calls = 0, confirmed = false
  const cleanSpy = vi.spyOn(workerGit, 'cleanupWorkerLogs').mockImplementation((...args) => {
    if (args[1].id !== record.id) return cleanup(...args)
    expect(confirmed).toBe(true)
    if (++calls === 2 && fault === 'second-cleanup-error') throw new Error('log cleanup tag lock unavailable')
    const result = cleanup(...args)
    if (fault === 'late-sidecar') fs.writeFileSync(log, 'late log from another writer')
    return result
  })
  const ensureSpy = vi.spyOn(FileWorkerStore.prototype, 'ensureDiscardRecovery').mockImplementation(async function (this: FileWorkerStore, ...args) {
    await ensure.apply(this, args)
    if (args[0] === record.id) {
      expect(fs.readFileSync(log, 'utf8')).toBe('original log')
      if (fault === 'during-recovery-write') fs.writeFileSync(log, 'written before the final cleanup')
      confirmed = true
    }
  })
  try {
    expect(await t.call({ tag: 'port-bools', discard: true })).toBe('detached port-bools; the worktree belongs to port-fix')
    const retired = (await registry.read(record.id))!
    expect(retired.phase).toBe('retired')
    expect(retired.archive!.summary).toBe('discarded')
    expect(fs.existsSync(worker)).toBe(true)
    expect(calls).toBe(1)
    expect(facts.mock.calls.some(([, facts]) => facts.ignored?.length === 0)).toBe(false)
    if (fault === 'late-sidecar') expect(fs.readFileSync(log, 'utf8')).toBe('late log from another writer')
    else expect(fs.existsSync(log)).toBe(false)
  } finally { facts.mockRestore(); ensureSpy.mockRestore(); cleanSpy.mockRestore() }
})
