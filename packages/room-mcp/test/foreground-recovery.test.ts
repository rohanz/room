import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { lead, second, setup } from './collect-fixture.js'
import { FileWorkerStore } from '../src/worker-file-store.js'
import { registryForDir } from '../src/worker-registry.js'
import { retireIfNothingToCollect } from '../src/retire.js'
import type { WorkerRecord } from '../src/worker-status.js'
import { finishPendingCollect } from '../src/retire.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { ConflictSet } from '../src/conflict-set.js'
import { RoomDoc, type ParticipantSnapshot } from '@room/shared'
import type { Rooms } from '../src/registry.js'
import type { Session } from '../src/session.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

it.each(['no-op eligibility', 'room_collect'] as const)('does not delay %s for an unrelated suspended reconciliation', async route => {
  const t = setup()
  second(t)
  await t.sync()
  const registry = await registryForDir(lead)
  const other = (await registry.read('w_second'))!
  fs.writeFileSync(path.join(registry.root, 'workers/w_second.json'), JSON.stringify({ ...other, phase: 'collecting' }))
  fs.rmSync(path.join(registry.root, 'workers/w_second.op'), { force: true })
  const entered = deferred(), release = deferred()
  type Effects = { update(id: string, edit: (record: WorkerRecord) => WorkerRecord): Promise<WorkerRecord> }
  const prototype = FileWorkerStore.prototype as unknown as Effects
  const original = prototype.update
  const spy = vi.spyOn(prototype, 'update').mockImplementation(async function (this: Effects, id, edit) {
    if (id === 'w_second') { entered.resolve(); await release.promise }
    return original.call(this, id, edit)
  })
  const background = registry.reconcile()
  let foreground: Promise<unknown> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let outcome: string
  try {
    await entered.promise
    foreground = route === 'room_collect' ? t.call({ tag: 'test' })
      : retireIfNothingToCollect(lead, registry, (await registry.read('w_test'))!, {})
    outcome = await Promise.race([
      foreground.then(() => 'finished'),
      // The background pass stays suspended until `release`, so a foreground call that waits on it never
      // finishes: the limit only has to outlast a real collection on a loaded machine, not be tight.
      new Promise<string>(resolve => { timer = setTimeout(() => resolve('blocked by unrelated pass'), 15_000) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    release.resolve()
    await background
    await foreground
    spy.mockRestore()
  }
  expect(outcome!).toBe('finished')
})

it('finishes retirement when projected held text reopens the registry', async () => {
  const t = setup()
  second(t)
  await t.sync()
  const registry = await registryForDir(lead)
  await registry.deferCollectCleanup('w_test', 'cleanup incomplete')
  const opening = deferred(), emergency = deferred()
  const teamRoom = new RoomDoc()
  const team = { ...t.s, room: teamRoom } as Session
  const conflicts = new ConflictSet(team, 'lead+second', t.s)
  const source = { name: 'lead+second', head: { projectedFrom: 'w_second' },
    entries: new Map([['file.txt', { state: 'held', hash: 'unknown-hash' }]]) } as unknown as ParticipantSnapshot
  // Bridge.projectOnce -> reconcileProjectedConflicts -> ConflictSet.read is the production
  // attachment path. Exercise its held-text fallback, rather than a fake registry lookup.
  const read = conflicts as unknown as { read(snap: ParticipantSnapshot, file: string): Promise<unknown> }
  const rooms = { ...t.state.rooms, project: async () => {
    // Reproduce bounded-cache eviction immediately before the bridge's held-text read.
    // The pass and projectors retain their admitted store, but trustedWorker uses the cache.
    await closeRegistryForDir(lead)
    await read.read(source, 'file.txt')
  } } as unknown as Rooms
  const original = FileWorkerStore.prototype.reconcile
  const queued: Promise<void>[] = []
  const spy = vi.spyOn(FileWorkerStore.prototype, 'reconcile').mockImplementation(function () {
    const pending = original.call(this)
    queued.push(pending)
    opening.resolve()
    // Emergency release is used only AFTER recording the result, so a reproduced deadlock
    // does not leave the test process or its queue stuck during fixture teardown.
    return Promise.race([pending, emergency.promise])
  })
  const cleanup = finishPendingCollect(t.s, rooms, 'w_test', { list: () => [], alive: () => false })
  let timer: ReturnType<typeof setTimeout> | undefined, outcome: string
  try {
    await opening.promise
    outcome = await Promise.race([cleanup.then(() => 'finished'), new Promise<string>(resolve => {
      timer = setTimeout(() => resolve('deadlocked reopening registry'), 1000)
    })])
  } finally {
    if (timer) clearTimeout(timer)
    emergency.resolve()
    await cleanup
    await Promise.all(queued)
    spy.mockRestore()
    teamRoom.doc.destroy()
  }
  expect(outcome!).toBe('finished')
})
