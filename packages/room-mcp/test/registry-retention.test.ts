import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { ROOM_STALE_MS } from '@room/shared'
import { registryForDir, WorkerRegistry } from '../src/worker-registry.js'
import type { WorkerRecord } from '../src/worker-status.js'
import { seedRegistryWorker } from './registry-fixture.js'

const DAY = 86_400_000

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'room-retention-'))
  const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  run('init', '-q'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't'); run('commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}

describe('retired worker record retention', () => {
  it('removes ended records past the room expiry, keeping kept worktrees, borrowed checkouts and live work', async () => {
    const dir = repo()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const registry = await registryForDir(dir)
      const root = registry.root
      const file = (id: string) => path.join(root, 'workers', `${id}.json`)
      const now = Date.now(), old = now - ROOM_STALE_MS - DAY
      const end = async (tag: string, phase: 'retired' | 'abandoned' | 'retiring', retiredAt: number, patch: Partial<WorkerRecord> = {},
        seeded?: WorkerRecord) => {
        const record = seeded ?? (await seedRegistryWorker(dir, tag)).record
        await registry.update(record.id, prior => ({ ...prior, ...patch, phase, seq: prior.seq + 1,
          ...(phase === 'abandoned' ? {} : { archive: registry.archiveOf(prior, { summary: '', retiredAt }), cleanup: { [prior.room]: phase === 'retiring' ? 'pending' : 'done' } }) }))
        fs.mkdirSync(path.join(root, 'runs', record.id), { recursive: true })
        return record
      }
      const expired = await end('expired', 'retired', old)
      const recent = await end('recent', 'retired', now - DAY)
      const keptDir = mkdtempSync(join(tmpdir(), 'room-kept-'))
      const kept = await end('kept', 'retired', old, { keptWorktree: keptDir })
      const keptGone = await end('kept-gone', 'retired', old, { keptWorktree: join(tmpdir(), 'room-kept-missing-' + now) })
      const retiring = await end('retiring', 'retiring', old)
      const abandoned = await end('abandoned', 'abandoned', 0)
      fs.utimesSync(file(abandoned.id), new Date(old), new Date(old))
      // The owner retires while a borrower still uses its checkout.
      const { record: active } = await seedRegistryWorker(dir, 'owner')
      const { record: borrower } = await seedRegistryWorker(dir, 'borrower', { dir: active.dir, sharedWith: active.id })
      await end('owner', 'retired', old, {}, active)
      const { record: live } = await seedRegistryWorker(dir, 'live')

      const removed = await registry.pruneRetired(ROOM_STALE_MS)
      expect(removed.map(r => r.tag).sort()).toEqual(['abandoned', 'expired', 'kept-gone'])
      const remaining = registry.list().map(r => r.tag).sort()
      expect(remaining).toEqual(['borrower', 'kept', 'live', 'owner', 'recent', 'retiring'].sort())
      for (const gone of [expired, keptGone, abandoned]) {
        expect(fs.existsSync(file(gone.id))).toBe(false)
        expect(fs.existsSync(path.join(root, 'runs', gone.id))).toBe(false)
        expect(fs.existsSync(path.join(root, 'tags', `${gone.tag}.json`))).toBe(false)
      }
      expect(registry.reserved('kept')?.id).toBe(kept.id)
      expect(registry.reserved('recent')?.id).toBe(recent.id)
      expect(registry.reserved('retiring')?.id).toBe(retiring.id)
      expect([borrower.id, live.id].every(id => fs.existsSync(file(id)))).toBe(true)
      expect(stderr.mock.calls.filter(([line]) => String(line).includes('removed') && String(line).includes('worker record'))).toHaveLength(3)
      // A freed tag can be spawned again.
      const { record: again } = await seedRegistryWorker(dir, 'expired')
      expect(registry.reserved('expired')?.id).toBe(again.id)
      // Idempotent.
      expect(await registry.pruneRetired(ROOM_STALE_MS)).toEqual([])
      rmSync(keptDir, { recursive: true, force: true })
    } finally { stderr.mockRestore(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('removes nothing before migration has finished', async () => {
    const dir = repo()
    try {
      const { registry, record } = await seedRegistryWorker(dir, 'old')
      await registry.update(record.id, prior => ({ ...prior, phase: 'abandoned', seq: prior.seq + 1 }))
      fs.utimesSync(path.join(registry.root, 'workers', `${record.id}.json`), new Date(0), new Date(0))
      fs.writeFileSync(path.join(registry.root, 'migration.json'), JSON.stringify({ v: 1, sources: {}, done: false }))
      expect(await registry.pruneRetired(ROOM_STALE_MS)).toEqual([])
      expect(registry.read(record.id)?.phase).toBe('abandoned')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  /**
   * Forced interleavings: `beginOperation(id, 'prune')` is where retention takes the record's operation lease,
   * so a hook there runs between the candidate snapshot and the decision made under the lease.
   */
  async function expiredOwner(dir: string, tag: string) {
    const { registry, record } = await seedRegistryWorker(dir, tag)
    const old = Date.now() - ROOM_STALE_MS - DAY
    await registry.update(record.id, prior => ({ ...prior, phase: 'retired', seq: prior.seq + 1,
      archive: registry.archiveOf(prior, { summary: '', retiredAt: old }), cleanup: { [prior.room]: 'done' } }))
    return { registry, record: registry.read(record.id)! }
  }
  function beforePruneLease(registry: WorkerRegistry, id: string, hook: () => Promise<void>, after?: () => Promise<void>) {
    const begin = registry.beginOperation.bind(registry)
    return vi.spyOn(registry, 'beginOperation').mockImplementation(async (target, op) => {
      if (op !== 'prune' || target !== id) return begin(target, op)
      await hook()
      const held = await begin(target, op)
      await after?.()
      return held
    })
  }
  const otherInstance = (registry: WorkerRegistry) => WorkerRegistry.open(registry.commonDir,
    { identity: { ...registry.instance, nonce: `other-${registry.instance.nonce}` }, watch: false, migrate: false })

  it('keeps a record whose operation lease another instance takes mid-prune (a borrower resume)', async () => {
    const dir = repo()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const { registry, record } = await expiredOwner(dir, 'owner')
      const other = await otherInstance(registry)
      // resume() of a borrower takes its owner's lease before its own; the owner's sequence does not change.
      const spy = beforePruneLease(registry, record.id, async () => { expect(await other.beginOperation(record.id, 'resume')).toBe(true) })
      try {
        expect(await registry.pruneRetired(ROOM_STALE_MS)).toEqual([])
      } finally { spy.mockRestore() }
      expect(registry.read(record.id)?.seq).toBe(record.seq)
      expect(registry.reserved('owner')?.id).toBe(record.id)
      // The other instance's operation still holds its lease; prune released nothing of it.
      expect(registry.operationInProgress(record.id)).toBe(true)
      expect(await other.finishOperation(record.id)).toBe(true)
      other.close()
    } finally { stderr.mockRestore(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('keeps record and reservation when an update lands between snapshot and delete', async () => {
    const dir = repo()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const keptDir = mkdtempSync(join(tmpdir(), 'room-kept-'))
    try {
      const { registry, record } = await expiredOwner(dir, 'kept')
      // Collection keeps the worktree after prune selected the record as expired with none kept.
      const spy = beforePruneLease(registry, record.id, async () => {
        await registry.update(record.id, prior => ({ ...prior, keptWorktree: keptDir, seq: prior.seq + 1 }))
      })
      try {
        expect(await registry.pruneRetired(ROOM_STALE_MS)).toEqual([])
      } finally { spy.mockRestore() }
      expect(registry.read(record.id)?.keptWorktree).toBe(keptDir)
      // The earlier order released the tag before noticing the change: a surviving record without its reservation.
      expect(registry.reserved('kept')?.id).toBe(record.id)
      expect(registry.operationInProgress(record.id)).toBe(false)
    } finally { stderr.mockRestore(); rmSync(keptDir, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) }
  })

  it('keeps an owner whose checkout a live record starts borrowing after the snapshot', async () => {
    const dir = repo()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const { registry, record } = await expiredOwner(dir, 'owner')
      // A legacy dir= borrower: its owner is inferred from the canonical checkout, not from sharedWith.
      const spy = beforePruneLease(registry, record.id, async () => { await seedRegistryWorker(dir, 'borrower', { dir: record.dir }) })
      try {
        expect(await registry.pruneRetired(ROOM_STALE_MS)).toEqual([])
      } finally { spy.mockRestore() }
      expect(registry.read(record.id)?.phase).toBe('retired')
      expect(registry.reserved('owner')?.id).toBe(record.id)
    } finally { stderr.mockRestore(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('refuses another instance\'s update and borrower spawn while it holds the lease, then removes the unchanged record', async () => {
    const dir = repo()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const { registry, record } = await expiredOwner(dir, 'owner')
      const other = await otherInstance(registry)
      const spy = beforePruneLease(registry, record.id, async () => {}, async () => {
        await expect(other.update(record.id, prior => ({ ...prior, seq: prior.seq + 1 }))).rejects.toThrow(/lease held by another instance/)
        await expect(seedRegistryWorker(dir, 'borrower', { dir: record.dir, sharedWith: record.id })).rejects.toThrow(/lease held/)
      })
      try {
        expect((await registry.pruneRetired(ROOM_STALE_MS)).map(r => r.id)).toEqual([record.id])
      } finally { spy.mockRestore() }
      expect(registry.read(record.id)).toBeUndefined()
      expect(registry.reserved('owner')).toBeUndefined()
      expect(fs.existsSync(path.join(registry.root, 'tags', 'owner.json'))).toBe(false)
      expect(registry.operationInProgress(record.id)).toBe(false)
      other.close()
    } finally { stderr.mockRestore(); rmSync(dir, { recursive: true, force: true }) }
  })
})
