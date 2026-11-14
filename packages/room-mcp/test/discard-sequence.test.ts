import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { git, lead, put, setup, worker } from './collect-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { FileWorkerStore } from '../src/worker-file-store.js'
import * as workerGit from '../src/worker-git.js'
import * as workerProcess from '../src/worker-process.js'
import { recoveryRefDescription } from '../src/worker-refs.js'
import { discardRecoveryDetails } from '../src/worker-status.js'

type Route = 'live' | 'kept' | 'replay'
async function prepare(route: Route) {
  const t = setup('done')
  await t.sync()
  const registry = await registryForDir(lead)
  if (route === 'kept') {
    const record = (await registry.read('w_test'))!
    const archive = { ...await registry.archiveOf(record, { summary: 'collected', disposition: 'collected' }), keptWorktree: worker }
    await registry.beginRetirement(record.id, archive, { keptWorktree: worker })
    await registry.finishCleanup(record.id, t.s.roomName)
    t.s.room.retireWorker(record.id, archive, () => {})
  }
  const discard = async () => {
    if (route !== 'replay') return t.call({ tag: 'test', discard: true })
    await registry.beginDiscard('w_test', [])
    await registry.replayDiscard('w_test')
  }
  return { t, registry, discard }
}

it.each(['live', 'kept', 'replay'] as const)('%s journals stop after process quiescence and before recovery, without an empty ignored write', async route => {
  const { t, registry, discard } = await prepare(route)
  const events: string[] = []
  t.state.ctx!.listCwdProcesses = () => { events.push('inspect'); return [] }
  const quiesce = vi.spyOn(workerProcess, 'quiesceWorktreeProcesses').mockImplementation(async () => { events.push('inspect'); return true })
  const step = FileWorkerStore.prototype.markDiscardStep, recovery = FileWorkerStore.prototype.ensureDiscardRecovery
  const mark = vi.spyOn(FileWorkerStore.prototype, 'markDiscardStep').mockImplementation(async function (this: FileWorkerStore, id, checkpoint) {
    if (checkpoint === 'stop') { expect(events.at(-1)).toBe('inspect'); events.push('stop') }
    return step.call(this, id, checkpoint)
  })
  const ensure = vi.spyOn(FileWorkerStore.prototype, 'ensureDiscardRecovery').mockImplementation(async function (this: FileWorkerStore, ...args) {
    expect(events.at(-1)).toBe('stop')
    events.push('recovery')
    return recovery.apply(this, args)
  })
  const facts = vi.spyOn(FileWorkerStore.prototype, 'recordDiscardRecovery')
  try {
    const reply = await discard()
    const record = (await registry.read('w_test'))!
    if (route !== 'replay') expect(reply).toBe('discarded test' + discardRecoveryDetails(record.discard))
    expect(events.filter(event => event === 'stop')).toHaveLength(1)
    expect(facts.mock.calls.some(([, facts]) => facts.ignored?.length === 0)).toBe(false)
    expect(record.archive!.summary).toBe('discarded' + discardRecoveryDetails(record.discard))
  } finally { facts.mockRestore(); ensure.mockRestore(); mark.mockRestore(); quiesce.mockRestore() }
})

it.each(['live', 'kept', 'replay'] as const)('%s cleans a missing worktree and its logs only after recovery confirmation', async route => {
  const { registry, discard } = await prepare(route)
  git(lead, 'worktree', 'remove', '--force', worker)
  const log = path.join(lead, '.room', 'workers', 'test.log')
  put(path.dirname(log), path.basename(log), 'retained until confirmed')
  const events: string[] = []
  const recovery = FileWorkerStore.prototype.ensureDiscardRecovery, prune = workerGit.pruneMissingWorkerWorktree, clean = workerGit.cleanupWorkerLogs
  const ensure = vi.spyOn(FileWorkerStore.prototype, 'ensureDiscardRecovery').mockImplementation(async function (this: FileWorkerStore, ...args) {
    expect(fs.existsSync(log)).toBe(true)
    await recovery.apply(this, args)
    events.push('recovery')
  })
  let missingDetail: string | undefined
  const removal = vi.spyOn(workerGit, 'pruneMissingWorkerWorktree').mockImplementation(async (...args) => {
    expect(events).toEqual(['recovery'])
    missingDetail = await prune(...args)
    events.push('missing')
    return missingDetail
  })
  const cleanup = vi.spyOn(workerGit, 'cleanupWorkerLogs').mockImplementation((...args) => {
    expect(events).toEqual(['recovery', 'missing'])
    events.push('logs')
    return clean(...args)
  })
  try {
    const reply = await discard()
    expect(events).toEqual(['recovery', 'missing', 'logs'])
    expect(fs.existsSync(log)).toBe(false)
    const record = (await registry.read('w_test'))!
    if (route !== 'replay') expect(reply).toBe('discarded test; its worktree was already gone; ' + missingDetail + discardRecoveryDetails(record.discard))
    const branch = route === 'replay' && record.branchCleanup?.recoveryRef ? '; branch recovery ref: ' + recoveryRefDescription(registry.commonDir, record.branchCleanup.recoveryRef) : ''
    expect(record.archive!.summary).toBe('discarded' + discardRecoveryDetails(record.discard) + branch)
  } finally { cleanup.mockRestore(); removal.mockRestore(); ensure.mockRestore() }
})

it.each(['live', 'kept'] as const)('%s retry after cleanup retains its missing-worktree reply', async route => {
  const { t, registry } = await prepare(route)
  const retirement = vi.spyOn(FileWorkerStore.prototype, 'beginRetirement').mockRejectedValueOnce(new Error('interrupted before retirement'))
  try { expect(await t.call({ tag: 'test', discard: true })).toContain('interrupted before retirement') }
  finally { retirement.mockRestore() }
  expect((await registry.read('w_test'))!.discard!.steps.cleanup).toBe(true)
  const prune = workerGit.pruneMissingWorkerWorktree
  let missingDetail: string | undefined
  const removal = vi.spyOn(workerGit, 'pruneMissingWorkerWorktree').mockImplementation(async (...args) => { missingDetail = await prune(...args); return missingDetail })
  try {
    const reply = await t.call({ tag: 'test', discard: true })
    expect(removal).toHaveBeenCalledOnce()
    const record = (await registry.read('w_test'))!
    expect(reply).toBe('discarded test; its worktree was already gone; ' + missingDetail + discardRecoveryDetails(record.discard))
    expect(record.archive!.summary).toBe('discarded' + discardRecoveryDetails(record.discard))
  } finally { removal.mockRestore() }
})
