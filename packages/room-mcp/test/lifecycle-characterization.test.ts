/** Storage parity contract: observable results, not file-store implementation details. Socket-free. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomDoc } from '@room/shared'
import { IdleClaimsJournal } from '../src/idle-claims.js'
import { FileWorkerStore } from '../src/worker-file-store.js'
import { WorkerRegistry } from '../src/worker-registry.js'
import type { WorkerRecord } from '../src/worker-status.js'

const roots: string[] = []
const opened: { close(): void }[] = []
const token = { pid: process.pid, startTime: 'characterization', executable: process.execPath, sessionId: 'lead', nonce: 'owner' }
const room = 'local/characterization'
function intent(common: string, tag = 'worker', id = `w_${tag}`): WorkerRecord {
  return { v: 1, id, tag, name: `lead+${tag}`, mode: 'local', room,
    lead: { participant: 'lead', room, instance: token }, host: 'codex',
    budget: { threads: 1, memGb: 1, nice: 10 }, share: 'declared', task: 'characterization',
    dir: path.join(common, 'checkout'), outside: false, branch: `room/${tag}`, prep: { step: 'prepared' },
    capabilities: { resume: true, signal: true, collect: 'delta' }, phase: 'prepared',
    runs: [{ n: 1, mode: 'fresh', intentAt: 1, nonce: `launch-${id}`, busFrontier: 0, promptMsgIds: [], launcher: token, logStart: 0 }],
    createdAt: 1, seq: 1 }
}
afterEach(() => {
  for (const registry of opened.splice(0)) registry.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

// Exactly the same assertions exercise the async facade and its current file adapter.
describe.each([['facade', WorkerRegistry], ['file adapter', FileWorkerStore]] as const)('%s lifecycle storage observable contract', (_name, implementation) => {
  async function open(common?: string) {
    if (!common) { common = fs.mkdtempSync(path.join(os.tmpdir(), 'room-lifecycle-parity-')); roots.push(common) }
    const registry = await implementation.open(common, { migrate: false, watch: false, identity: token, liveness: () => 'alive' })
    opened.push(registry)
    return registry
  }

  it('reserves a tag until every retirement cleanup finishes, then reuses it without replacing history', async () => {
    const registry = await open(), first = intent(registry.commonDir)
    await registry.writeIntent(first)
    expect((await registry.reserved(first.tag))?.id).toBe(first.id)
    await expect(registry.writeIntent({ ...first, id: 'w_competitor' })).rejects.toThrow('tag in use')
    await registry.beginRetirement(first.id, (await registry.archiveOf(first, { summary: 'collected', disposition: 'collected' })))
    if (registry instanceof WorkerRegistry) expect(await registry.projectable('lead', room)).toMatchObject({ write: [], retire: [{ id: first.id }] })
    const snapshot = await registry.snapshot()
    expect(snapshot.available && snapshot.workers.map(fact => fact.record)).toMatchObject([{ id: first.id, phase: 'retiring', cleanup: { [room]: 'pending' } }])
    await expect(registry.writeIntent({ ...first, id: 'w_competitor' })).rejects.toThrow('tag in use')
    await registry.finishCleanup(first.id, room)
    await registry.finishOperation(first.id)
    await registry.writeIntent({ ...first, id: 'w_successor' })
    expect((await registry.reserved(first.tag))?.id).toBe('w_successor')
    expect((await registry.read(first.id))).toMatchObject({ phase: 'retired', archive: { summary: 'collected' } })
  })

  it('keeps a retired checkout reserved and permits an abandoned tag to be reused', async () => {
    const registry = await open(), first = intent(registry.commonDir)
    await registry.writeIntent(first)
    await registry.beginRetirement(first.id, (await registry.archiveOf(first, { summary: 'kept' })), { keptWorktree: first.dir })
    await registry.finishCleanup(first.id, room)
    await expect(registry.writeIntent({ ...first, id: 'w_replacement' })).rejects.toThrow('tag in use')
    const abandoned = intent(registry.commonDir, 'abandoned')
    await registry.writeIntent(abandoned)
    await registry.abandonPreparation(abandoned.id)
    await registry.finishOperation(abandoned.id)
    await registry.writeIntent({ ...abandoned, id: 'w_reused' })
    expect((await registry.reserved('abandoned'))?.id).toBe('w_reused')
  })

  it('refuses stale sequence and run mutations without changing durable state', async () => {
    const registry = await open(), first = intent(registry.commonDir)
    await registry.writeIntent(first)
    await registry.beginCollect(first.id)
    const before = (await registry.read(first.id))!
    await expect(registry.command(first.id, { type: 'activate' }, first.seq)).rejects.toThrow(/seq|sequence/)
    await expect(registry.command(first.id, { type: 'launch', run: 99, launch: { outcome: 'launched', pid: 42 } }, before.seq)).rejects.toThrow('run changed')
    expect((await registry.read(first.id))).toEqual(before)
  })

  it('refuses the last occupied capacity slot without reserving the refused tag', async () => {
    const registry = await open(), first = intent(registry.commonDir)
    await registry.writeIntent(first, 1)
    await expect(registry.writeIntent(intent(registry.commonDir, 'overflow'), 1)).rejects.toThrow('capacity')
    expect((await registry.occupancy())).toBe(1)
    expect((await registry.reserved('overflow'))).toBeUndefined()
    expect((await registry.list()).map(record => record.id)).toEqual([first.id])
  })

  it('permits nested discard to stop in its own lane but refuses another call and a stale owner release', async () => {
    const registry = await open(), first = intent(registry.commonDir)
    await registry.writeIntent(first)
    await registry.finishOperation(first.id)
    expect(await registry.beginOperation(first.id, 'discard')).toBe(true)
    expect(await registry.beginOperation(first.id, 'stop')).toBe(false)
    await registry.beginStop(first.id, 'discarded')
    await expect(registry.beginOperation(first.id, 'collect')).rejects.toThrow('another call')
    const stranger = await implementation.open(registry.commonDir, { watch: false, migrate: false,
      identity: { ...token, nonce: 'stranger' }, liveness: () => 'alive' })
    opened.push(stranger)
    expect(await stranger.finishOperation(first.id)).toBe(false)
    expect((await registry.operationInProgress(first.id))).toBe(true)
    expect(await registry.finishOperation(first.id)).toBe(true)
    expect((await registry.read(first.id))?.stop?.reason).toBe('discarded')
  })

  it.each(['claude', 'codex'] as const)('preserves %s admission identity, report completion IDs and witnessed exit evidence after reopen', async host => {
    const registry = await open(), first = { ...intent(registry.commonDir), host }
    fs.mkdirSync(first.dir)
    await registry.writeIntent(first)
    const input = { id: first.id, run: 1, nonce: first.runs[0].nonce, dir: first.dir,
      chain: [{ pid: 42, startTime: 'born', executable: host }], hostSessionId: `${host}-thread` }
    await expect(registry.admit({ ...input, nonce: 'wrong' })).rejects.toThrow('not admitted')
    await registry.admit(input)
    await registry.reportDone(first.id, 1, 'finished', ['output.ts'])
    const ids: string[] = []
    expect(await registry.postCompletion(first.id, 1, async id => { ids.push(id) })).toBe(true)
    expect(await registry.postCompletion(first.id, 1, async id => { ids.push(id) })).toBe(false)
    expect(ids).toEqual([`wk:${first.id}:1`])
    await registry.writeExit(first.id, { run: 1, code: null, at: 3, witnessed: false })
    await registry.writeExit(first.id, { run: 1, code: 7, at: 4, witnessed: true })
    await registry.writeExit(first.id, { run: 1, code: null, at: 5, witnessed: false })
    const restarted = await open(registry.commonDir)
    expect((await restarted.reports(first.id))).toMatchObject([{ chain: input.chain, hostSessionId: input.hostSessionId,
      done: { summary: 'finished', changed: ['output.ts'] }, posted: `wk:${first.id}:1` }])
    expect((await restarted.exits(first.id))).toEqual([{ run: 1, code: 7, at: 4, witnessed: true }])
  })

  it('quarantines malformed records while retaining their tag and healthy neighbours', async () => {
    const registry = await open(), bad = intent(registry.commonDir), good = intent(registry.commonDir, 'healthy')
    await registry.writeIntent(bad)
    await registry.writeIntent(good)
    // Corruption injection is intentionally the only direct lifecycle-file access in this suite.
    fs.writeFileSync(path.join(registry.root, 'workers', `${bad.id}.json`), '{malformed')
    const restarted = await open(registry.commonDir)
    expect((await restarted.read(bad.id))).toBeUndefined()
    expect((await restarted.list()).map(record => record.id)).toEqual([good.id])
    await expect(restarted.writeIntent({ ...bad, id: 'w_replacement' })).rejects.toThrow('tag in use')
    const quarantined = fs.readdirSync(path.join(registry.root, 'quarantine'))
    expect(quarantined).toHaveLength(1)
    expect(fs.readFileSync(path.join(registry.root, 'quarantine', quarantined[0]), 'utf8')).toBe('{malformed')
  })

  it('journals idle release before posting and replays the same notice without deleting new work', async () => {
    const registry = await open(), doc = new RoomDoc()
    try {
      doc.claims.set('old', { id: 'old', path: 'old.ts', from: 2, to: 4, by: 'lead', byKind: 'agent', intent: 'old work', at: 1 })
      doc.claims.set('human', { id: 'human', path: 'human.ts', from: 1, to: 1, by: 'lead', byKind: 'human', intent: 'human work', at: 1 })
      const action = { roomKey: room, sessionId: 'lead', participant: 'lead', idleEpoch: 'epoch',
        host: 'shared-app-server' as const, lastActivityMs: 0, monotonicMs: () => 8 * 3600_000, doc, ownsParticipant: () => true }
      const ids: string[] = []
      await expect(IdleClaimsJournal.open(registry.commonDir).reconcileIdleClaims({ ...action, postNotice: id => { ids.push(id); throw new Error('post failed') } })).rejects.toThrow('post failed')
      expect(doc.claims.has('old')).toBe(false)
      expect(doc.claims.has('human')).toBe(true)
      doc.claims.set('new', { id: 'new', path: 'new.ts', from: 1, to: 1, by: 'lead', byKind: 'agent', intent: 'new work', at: 2 })
      const restarted = await open(registry.commonDir)
      expect(await IdleClaimsJournal.open(restarted.commonDir).reconcileIdleClaims({ ...action, idleEpoch: 'after-restart', postNotice: (id, text) => {
        ids.push(id); expect(text).toContain('old.ts:2-4')
      } })).toBe(true)
      expect(ids).toEqual(['idle-claims:lead:epoch', 'idle-claims:lead:epoch'])
      expect(doc.claims.has('new')).toBe(true)
      expect(await IdleClaimsJournal.open(restarted.commonDir).reconcileIdleClaims({ ...action, postNotice: () => { throw new Error('duplicate notice') } })).toBe(false)
    } finally { doc.doc.destroy() }
  })
})
