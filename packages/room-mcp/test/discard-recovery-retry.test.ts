import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { workerLines } from '@room/shared'
import { base, git, lead, put, setup, worker } from './collect-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { saveDiscardRecovery } from '../src/worker-git.js'

// Persisted interruption state; replay, cleanup, and Git GC afterwards are real.
async function interrupted(state: 'partial' | 'gone') {
  const t = setup('failed')
  put(worker, 'file.txt', 'complete work before removal\n')
  put(worker, 'survivor.txt', 'remaining work\n')
  await t.sync()
  const registry = await registryForDir(lead)
  await registry.beginDiscard('w_test', [])
  const original = await saveDiscardRecovery(lead, t.w)
  await registry.recordDiscardRecovery('w_test', original)
  await registry.markDiscardStep('w_test', 'removing')
  const oid = git(lead, 'rev-parse', `${original.recoveryRef}^{commit}`)
  if (state === 'partial') fs.unlinkSync(path.join(worker, 'file.txt'))
  else git(lead, 'worktree', 'remove', '--force', worker)
  git(lead, 'update-ref', '-d', original.recoveryRef)
  return { t, registry, ref: original.recoveryRef, oid }
}

it.each(['partial', 'gone'] as const)('preserves the complete commit after ref loss and a %s checkout', async state => {
  const { registry, ref, oid } = await interrupted(state)
  await registry.replayDiscard('w_test')
  expect((await registry.read('w_test'))!.discard!.recoveryRef).toBe(ref)
  git(lead, 'gc', '--prune=now')
  expect(git(lead, 'rev-parse', `${ref}^{commit}`)).toBe(oid)
  expect(git(lead, 'show', `${ref}:file.txt`)).toBe('complete work before removal')
})

it.each([false, true])('confirms recovery on an explicit discard retry with a gone checkout (commit gone: %s)', async commitGone => {
  const { t, registry, ref, oid } = await interrupted('gone')
  // A failed attempt after removal began stays a discard, with its removal marker intact.
  await registry.interruptDiscard('w_test', 'interrupted after worktree removal')
  expect((await registry.read('w_test'))!.phase).toBe('discarding')
  if (commitGone) {
    git(lead, 'reflog', 'expire', '--expire=now', '--all')
    git(lead, 'gc', '--prune=now')
    expect(() => git(lead, 'cat-file', '-e', oid)).toThrow()
  }
  const reply = await t.call({ tag: 'test', discard: true })
  expect(reply).toContain('discarded test')
  const finished = (await registry.read('w_test'))!
  if (commitGone) {
    expect.soft(reply).toContain('NOT recoverable')
    expect.soft(finished.archive!.summary).toContain('NOT recoverable')
    expect.soft(workerLines([], { all: true, retiredWorkers: t.s.room.retiredWorkers() }).join('\n')).toContain('NOT recoverable')
    expect(finished.discard!.lost).toBe(ref)
  } else {
    git(lead, 'gc', '--prune=now')
    let recovered: string | undefined
    try { recovered = git(lead, 'show', `${ref}:file.txt`) } catch { /* missing */ }
    expect(recovered, reply).toBe('complete work before removal')
  }
})

it('projects a replayed loss into the archive and room_state all=true worker output', async () => {
  const { t, registry, ref } = await interrupted('gone')
  git(lead, 'reflog', 'expire', '--expire=now', '--all')
  git(lead, 'gc', '--prune=now')
  await registry.replayDiscard('w_test')
  await t.state.rooms.project()
  expect((await registry.read('w_test'))!.discard!.lost).toBe(ref)
  expect(t.s.room.retiredWorkers()[0].summary).toContain('NOT recoverable')
  expect(workerLines([], { all: true, retiredWorkers: t.s.room.retiredWorkers() }).join('\n')).toContain('NOT recoverable')
})

it('does not confirm an occupied recovery name pointing at a different commit', async () => {
  const { registry, ref, oid } = await interrupted('gone')
  git(lead, 'update-ref', ref, base)
  expect(git(lead, 'show', `${oid}:file.txt`)).toBe('complete work before removal')
  // The foreign value must be retained without being mistaken for our snapshot.
  await expect(registry.replayDiscard('w_test')).rejects.toThrow()
  expect(git(lead, 'rev-parse', `${ref}^{commit}`)).toBe(base)
})

it('distinguishes a refused re-pin from a missing recovery commit', async () => {
  const { registry, ref, oid } = await interrupted('gone')
  git(lead, 'symbolic-ref', ref, 'refs/heads/unrelated-missing')
  expect(git(lead, 'show', `${oid}:file.txt`)).toBe('complete work before removal')
  // The refusal is reported as itself, and the discard stays unfinished rather than claiming a loss.
  await expect(registry.replayDiscard('w_test')).rejects.toThrow(/occupied by a symbolic ref/)
  expect((await registry.read('w_test'))!.discard!.lost).toBeUndefined()
  expect(git(lead, 'symbolic-ref', ref)).toBe('refs/heads/unrelated-missing')
  expect(git(lead, 'show', `${oid}:file.txt`)).toBe('complete work before removal')
})
