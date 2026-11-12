import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { commit, git, put, repo, world } from './worker-refresh-fixture.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { registryForDir } from '../src/worker-registry.js'
import { collectBaseRef, collectHeadRef } from '../src/worker-git.js'
import { deleteWorkerRecordRef } from '../src/worker-refs.js'

async function downgradeFacts(id: string) {
  const registry = await registryForDir(repo)
  await mutateWorkerFixture(registry, id, record => {
    if (record.prep.witness) fs.rmSync(path.join(record.prep.witness.adminDir, 'room-preparation.json'))
    const { root, witness, branchOid, identityRequired, ...prep } = record.prep
    const { branchCleanup, ...legacy } = record
    return { ...legacy, prep, seq: record.seq + 1 }
  })
  fs.rmSync(path.join(registry.root, 'ref-writes'), { recursive: true, force: true })
  return registry
}

it('upgrades carried private refs through refresh and real collection without retention', async () => {
  put(repo, 'shared.txt', 'a\ncarried\nc\n'); put(repo, 'notes.md', 'carried untracked\n')
  const t = world(), worker = await t.spawn('old-carry')
  expect(worker.carriedBase).toBeTruthy()
  await t.finish(worker.tag)
  const registry = await downgradeFacts(worker.id)
  put(repo, 'new-lead.txt', 'new lead commit\n')
  // Keep the original carried bytes uncommitted so refresh has a carry ref to move.
  git(repo, 'add', 'new-lead.txt'); git(repo, 'commit', '-qm', 'lead advanced')
  const refresh = await t.call('room_send', { type: 'note', to: worker.tag, text: 'refresh', refresh: true })
  expect(refresh).toContain('rebased ' + worker.tag)
  expect(refresh).not.toContain('left in place because Room cannot confirm')
  await t.finish(worker.tag)
  const reply = await t.call('room_collect', { tag: worker.tag })
  expect(reply).not.toContain('left in place because Room cannot confirm')
  expect(fs.existsSync(worker.dir), reply).toBe(false)
  expect(git(repo, 'for-each-ref', '--format=%(refname)', `refs/room/carry/${worker.tag}`, `refs/room/carry-untracked/${worker.tag}`, collectHeadRef(worker.tag, worker.id), collectBaseRef(worker.tag, worker.id))).toBe('')
  expect((await registry.read(worker.id))?.phase).toBe('retired')
  expect(await t.call('room_spawn', { tag: worker.tag, task: 'reuse', carry: false })).toContain('spawned ' + worker.tag)
})

it('upgrades twice-kept carry and delta pins through refresh and real cleanup', async () => {
  put(repo, 'shared.txt', 'a\ncarried\nc\n'); put(repo, 'notes.md', 'carried untracked\n')
  const t = world(), worker = await t.spawn('old-kept')
  put(worker.dir, 'round-one.txt', 'one\n'); await t.finish(worker.tag)
  expect(await t.call('room_collect', { tag: worker.tag, keep: true })).not.toContain('error:')
  await t.call('room_send', { type: 'note', to: worker.tag, text: 'round two' })
  put(worker.dir, 'round-two.txt', 'two\n'); await t.finish(worker.tag)
  expect(await t.call('room_collect', { tag: worker.tag, keep: true })).not.toContain('error:')
  const registry = await downgradeFacts(worker.id)
  const oldPins = git(repo, 'for-each-ref', '--format=%(objectname)', `refs/room/carry/${worker.tag}`, `refs/room/carry-untracked/${worker.tag}`, collectBaseRef(worker.tag, worker.id)).split('\n')
  expect(oldPins).toHaveLength(3)
  commit(repo, 'integrated carried and kept output')
  const refresh = await t.call('room_send', { type: 'note', to: worker.tag, text: 'refresh', refresh: true })
  expect(refresh).toContain('rebased ' + worker.tag)
  expect(refresh).not.toContain('left in place because Room cannot confirm')
  await t.finish(worker.tag)
  const reply = await t.call('room_collect', { tag: worker.tag })
  expect(reply).not.toContain('left in place because Room cannot confirm')
  expect(fs.existsSync(worker.dir), reply).toBe(false)
  expect(git(repo, 'for-each-ref', '--format=%(refname)', `refs/room/carry/${worker.tag}`, `refs/room/carry-untracked/${worker.tag}`, collectHeadRef(worker.tag, worker.id), collectBaseRef(worker.tag, worker.id))).toBe('')
  for (const oid of oldPins) expect(git(repo, 'rev-parse', `refs/room/recovery/${worker.tag}/${oid}^{}`)).toBe(oid)
  expect((await registry.read(worker.id))?.phase).toBe('retired')
  expect(await t.call('room_spawn', { tag: worker.tag, task: 'reuse', carry: false })).toContain('spawned ' + worker.tag)
})

it('retains a legacy carry ref that disagrees with its recorded value', async () => {
  put(repo, 'shared.txt', 'a\ncarried\nc\n')
  const t = world(), worker = await t.spawn('old-mismatch')
  await t.finish(worker.tag)
  const registry = await downgradeFacts(worker.id), ref = `refs/room/carry/${worker.tag}`
  const foreign = commit(repo, 'foreign ref value')
  expect(foreign).not.toBe(worker.carriedBase)
  git(repo, 'update-ref', ref, foreign)
  const reply = await t.call('room_collect', { tag: worker.tag, discard: true })
  expect(reply).toContain(`kept ref ${ref}`)
  expect(git(repo, 'rev-parse', ref)).toBe(foreign)
  expect((await registry.read(worker.id))?.phase).toBe('retired')
})

it('atomically retains a moved legacy unknown pin and preserves its captured tree', async () => {
  put(repo, 'notes.md', 'carried untracked\n')
  const t = world(), worker = await t.spawn('old-race')
  await t.finish(worker.tag)
  const registry = await downgradeFacts(worker.id), record = (await registry.read(worker.id))!
  const ref = `refs/room/carry-untracked/${worker.tag}`, captured = git(repo, 'rev-parse', ref)
  const foreign = git(repo, 'rev-parse', 'HEAD^{tree}')
  expect(captured).not.toBe(foreign)
  await registry.beginOperation(worker.id, 'collect')
  const baseline = await import('@room/roomd/baseline'), run = baseline.boundedGitSync
  let moved = false
  const spy = vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
    if (!moved && args[1].includes('update-ref') && args[2]?.input?.toString().includes(`delete ${ref} `)) {
      moved = true; git(repo, 'update-ref', ref, foreign)
    }
    return run(...args)
  })
  try {
    expect(deleteWorkerRecordRef(registry.commonDir, ref, record)).toContain(`kept ref ${ref}`)
    expect(moved).toBe(true)
    expect(git(repo, 'rev-parse', ref)).toBe(foreign)
    expect(git(repo, 'rev-parse', `refs/room/recovery/${worker.tag}/${captured}^{}`)).toBe(captured)
  } finally { spy.mockRestore(); await registry.finishOperation(worker.id) }
})

it('never grants legacy ref authority to a new record whose receipt is missing', async () => {
  put(repo, 'notes.md', 'carried untracked\n')
  const t = world(), worker = await t.spawn('new-no-receipt')
  await t.finish(worker.tag)
  const registry = await registryForDir(repo), record = (await registry.read(worker.id))!
  expect(record.prep.identityRequired).toBe(true)
  fs.rmSync(path.join(registry.root, 'ref-writes'), { recursive: true, force: true })
  const ref = `refs/room/carry-untracked/${worker.tag}`, oid = git(repo, 'rev-parse', ref)
  await registry.beginOperation(worker.id, 'collect')
  try {
    expect(deleteWorkerRecordRef(registry.commonDir, ref, record)).toContain(`kept ref ${ref}`)
    expect(git(repo, 'rev-parse', ref)).toBe(oid)
    expect(git(repo, 'for-each-ref', '--format=%(refname)', `refs/room/recovery/${worker.tag}/${oid}`)).toBe('')
  } finally { await registry.finishOperation(worker.id) }
})
