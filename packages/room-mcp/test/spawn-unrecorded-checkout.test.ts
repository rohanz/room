import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it, vi } from 'vitest'
import { realRepo, setupLead } from './workers-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { requireWorkerInventory } from '../src/worker-store.js'
import { suppliedWorkerCheckout as inspectSuppliedWorkerCheckout, assertNewWorkerWorktree } from '../src/worker-git.js'
import * as workerGit from '../src/worker-git.js'
import type { WorkerRecord } from '../src/worker-status.js'

// Assert the inspection's refusal result; spawn also retains its earlier directory gates.
function suppliedWorkerCheckout(dir: string, records: readonly WorkerRecord[]) {
  const result = inspectSuppliedWorkerCheckout(dir, records)
  if (result.refusal) throw new Error(result.refusal)
  return result
}

it('refuses another tag targeting a subdirectory of a moved orphan before launching', async () => {
  const { repo, head, git } = realRepo()
  // Keep cleanup within the fixture root even though the lead is a linked checkout.
  const leadDir = join(repo, 'lead')
  git('worktree', 'add', '-q', '-b', 'user-lead', leadDir)
  const orphan = join(repo, 'orphan')
  git('worktree', 'add', '-q', '-b', 'room/lost', orphan)
  const subdir = join(orphan, 'src')
  mkdirSync(subdir)
  writeFileSync(join(subdir, 'precious.txt'), 'orphan work')
  const t = setupLead(leadDir, head), registry = await registryForDir(leadDir)
  const reply = await t.leadTools.call('room_spawn', { tag: 'newtag', task: 'x', dir: subdir, allowOutside: true })
  expect(t.specs, reply).toHaveLength(0)
  expect(requireWorkerInventory(await registry.list())).toEqual([])
  expect(readFileSync(join(subdir, 'precious.txt'), 'utf8')).toBe('orphan work')
})

it('refuses a supplied orphan checkout in another clone for a hosted lead', async () => {
  const { repo, head } = realRepo(), other = realRepo()
  const orphan = join(other.repo, '.room/workers/lost')
  other.git('worktree', 'add', '-q', '-b', 'room/lost', orphan)
  const t = setupLead(repo, head), registry = await registryForDir(repo)
  delete t.session!.local
  const reply = await t.leadTools.call('room_spawn', { tag: 'newtag', task: 'x', dir: orphan, allowOutside: true })
  expect(t.specs, reply).toHaveLength(0)
  expect(requireWorkerInventory(await registry.list())).toEqual([])
})

it('refuses an unchecked-out orphan branch before writing intent', async () => {
  const { repo, head, git } = realRepo()
  git('branch', 'room/lost')
  const t = setupLead(repo, head), registry = await registryForDir(repo)
  const intent = vi.spyOn(registry, 'writeIntent')
  const refs = git('show-ref')
  const reply = await t.leadTools.call('room_spawn', { tag: 'lost', task: 'x' })
  expect(reply).toContain('error:')
  expect(t.specs).toHaveLength(0)
  expect(git('show-ref')).toBe(refs)
  expect(intent.mock.calls.length, reply).toBe(0)
  expect(requireWorkerInventory(await registry.list())).toEqual([])
})

it.each(['before intent', 'after intent'] as const)('does not delete an orphan created after the guard (%s)', async timing => {
  const { repo, head, git } = realRepo(), t = setupLead(repo, head)
  const registry = await registryForDir(repo), writeIntent = registry.writeIntent.bind(registry)
  const orphan = join(repo, '.room/workers/raced')
  vi.spyOn(registry, 'writeIntent').mockImplementation(async (...args) => {
    // Deterministic interleave: another process creates a checkout after the inventory read.
    if (timing === 'after intent') await writeIntent(...args)
    git('worktree', 'add', '-q', '-b', 'room/raced', orphan)
    writeFileSync(join(orphan, 'precious.txt'), 'unrecorded work')
    if (timing === 'before intent') await writeIntent(...args)
  })
  const reply = await t.leadTools.call('room_spawn', { tag: 'raced', task: 'x' })
  expect(reply).toContain('error:')
  expect(t.specs).toHaveLength(0)
  expect(existsSync(join(orphan, 'precious.txt')), reply).toBe(true)
  expect(readFileSync(join(orphan, 'precious.txt'), 'utf8')).toBe('unrecorded work')
})

it.each(['symlink', 'relative', 'trailing slash', 'case', 'subdirectory'] as const)('refuses a canonical orphan through a %s path', async form => {
  const { repo, head, git } = realRepo()
  const orphan = join(repo, '.room/workers/lost')
  git('worktree', 'add', '-q', '-b', 'room/lost', orphan)
  let leadDir = repo, supplied = orphan
  if (form === 'symlink') {
    leadDir = join(repo, 'alias')
    symlinkSync(repo, leadDir)
    supplied = join(leadDir, '.room/workers/lost')
  } else if (form === 'relative') supplied = relative(process.cwd(), orphan)
  else if (form === 'trailing slash') supplied += '/'
  else if (form === 'case') {
    supplied = join(repo, '.ROOM/WORKERS/LOST')
    if (!existsSync(supplied)) return // The case-insensitive variant applies only on such filesystems.
  } else { supplied = join(orphan, 'src'); mkdirSync(supplied) }
  const t = setupLead(leadDir, head), registry = await registryForDir(leadDir)
  const reply = await t.leadTools.call('room_spawn', { tag: 'another', task: 'x', dir: supplied, allowOutside: true })
  expect(reply).toContain('error:')
  expect(t.specs).toHaveLength(0)
  expect(requireWorkerInventory(await registry.list())).toEqual([])
})

it.each(['detached', 'locked', 'prunable', 'moved', 'newline'] as const)('recognizes the %s worktree inventory entry', form => {
  const { repo, git } = realRepo()
  let orphan = join(repo, '.room/workers/lost')
  if (form === 'newline') orphan = join(repo, 'with space\nand newline')
  git('worktree', 'add', '-q', '-b', 'room/lost', orphan)
  if (form === 'detached') git('-C', orphan, 'checkout', '--detach', '-q')
  if (form === 'locked') git('worktree', 'lock', orphan)
  if (form === 'prunable') rmSync(orphan, { recursive: true })
  if (form === 'moved') { const moved = join(repo, 'moved'); git('worktree', 'move', orphan, moved); orphan = moved }
  expect(() => suppliedWorkerCheckout(orphan, [])).toThrow(form === 'prunable' ? undefined : 'Room has no live record')
})

it.each(['retiring', 'retired', 'abandoned', 'sharedWith', 'outside', 'active'] as const)('uses only a live owning record (%s)', kind => {
  const { repo, git } = realRepo(), orphan = join(repo, '.room/workers/lost')
  git('worktree', 'add', '-q', '-b', 'room/lost', orphan)
  // The helper consumes exactly these ownership fields; full store validation is exercised above.
  const owner = { dir: orphan, branch: 'room/lost', phase: ['retiring', 'retired', 'abandoned'].includes(kind) ? kind : 'active',
    ...(kind === 'outside' ? { outside: true } : {}), ...(kind === 'sharedWith' ? { sharedWith: 'w_owner' } : {}) } as WorkerRecord
  const check = () => suppliedWorkerCheckout(orphan, [owner])
  if (kind === 'active') expect(check).not.toThrow()
  else expect(check).toThrow('Room has no live record')
})

it('accepts a bare repository with no worker collisions', () => {
  const { repo, git } = realRepo(), bare = join(repo, 'bare.git')
  git('clone', '--bare', '.', bare)
  expect(() => assertNewWorkerWorktree(bare, 'fresh')).not.toThrow()
})

it('inspects a supplied worktree with a newline in its root without parsing inventory blocks', () => {
  const { repo, git } = realRepo(), target = join(repo, 'with space\nand newline')
  git('worktree', 'add', '-q', '-b', 'room/lost', target)
  expect(() => suppliedWorkerCheckout(target, [])).toThrow('Room has no live record')
})

it('preserves a non-worktree directory containing user files on failed spawn', async () => {
  const { repo, head } = realRepo(), target = join(repo, '.room/workers/plain')
  mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'precious.txt'), 'user files')
  const t = setupLead(repo, head)
  expect(await t.leadTools.call('room_spawn', { tag: 'plain', task: 'x' })).toContain('error:')
  expect(t.specs).toHaveLength(0)
  expect(readFileSync(join(target, 'precious.txt'), 'utf8')).toBe('user files')
})

it('refuses simultaneous different tags targeting one orphan', async () => {
  const { repo, head, git } = realRepo(), orphan = join(repo, '.room/workers/lost')
  git('worktree', 'add', '-q', '-b', 'room/lost', orphan)
  const t = setupLead(repo, head), registry = await registryForDir(repo)
  const replies = await Promise.all(['a', 'b'].map(tag => t.leadTools.call('room_spawn', { tag, task: 'x', dir: orphan })))
  expect(replies.every(reply => reply.includes('Room has no live record'))).toBe(true)
  expect(t.specs).toHaveLength(0)
  expect(requireWorkerInventory(await registry.list())).toEqual([])
})

it('allows a fresh spawn and reuse after full collection removes the previous checkout', async () => {
  const actual = await vi.importActual<typeof workerGit>('../src/worker-git.js')
  vi.mocked(workerGit.cleanupWorker).mockImplementation(actual.cleanupWorker)
  vi.mocked(workerGit.ignoredWorkerArtifacts).mockImplementation(actual.ignoredWorkerArtifacts)
  vi.mocked(workerGit.saveDiscardPatch).mockImplementation(actual.saveDiscardPatch)
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  expect(await t.leadTools.call('room_spawn', { tag: 'fresh', task: 'x' })).toContain('spawned fresh')
  const first = (await registry.reserved('fresh'))!
  writeFileSync(join(first.dir, 'modified.txt'), 'worker edit\n')
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(first.id))?.status).toBe('done'))
  const reply = await t.leadTools.call('room_collect', { tag: 'fresh' })
  expect(existsSync(first.dir), reply).toBe(false)
  expect(git('branch', '--list', 'room/fresh')).toBe('')
  expect(await t.leadTools.call('room_spawn', { tag: 'fresh', task: 'again' })).toContain('spawned fresh')
  expect((await registry.reserved('fresh'))?.id).not.toBe(first.id)
})
