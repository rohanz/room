import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { realRepo, setupLead, createTools } from './workers-fixture.js'
import { registryForDir, WorkerRegistry } from '../src/worker-registry.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { cleanupPreparedWorktree, prepareWorktree } from '../src/worker-git.js'
import * as workerGit from '../src/worker-git.js'
import * as gitCommands from '@room/roomd/git'
import * as baseline from '@room/roomd/baseline'
import { PREPARATION_WITNESS_FILE } from '../src/worker-preparation.js'

it.each(['missing', 'id', 'nonce', 'token', 'unreadable', 'symlink', 'oversized'] as const)('retains checkout and branch with a %s preparation witness', async kind => {
  const { repo, git } = realRepo(), prepared = await prepareWorktree(repo, 'proof', 'lead', { carry: false })
  const marker = path.join(prepared.witness!.adminDir, PREPARATION_WITNESS_FILE)
  fs.writeFileSync(path.join(prepared.dir, 'precious.txt'), 'preserve this')
  if (kind === 'missing') fs.rmSync(marker)
  else if (kind === 'symlink') {
    const target = path.join(repo, 'marker-copy.json')
    fs.copyFileSync(marker, target); fs.rmSync(marker); fs.symlinkSync(target, marker)
  } else if (kind === 'oversized') fs.writeFileSync(marker, 'x'.repeat(4097))
  else if (kind === 'unreadable') {
    const read = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file) === marker) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return (read as (...args: unknown[]) => unknown)(file, ...args)
    }) as typeof fs.readFileSync)
  } else {
    const contents = JSON.parse(fs.readFileSync(marker, 'utf8'))
    contents[kind] = 'foreign'
    fs.writeFileSync(marker, JSON.stringify(contents))
  }
  await expect(cleanupPreparedWorktree(repo, prepared)).rejects.toThrow('cannot verify')
  expect(fs.readFileSync(path.join(prepared.dir, 'precious.txt'), 'utf8')).toBe('preserve this')
  expect(git('branch', '--list', 'room/proof')).not.toBe('')
})

it('does not remove a replacement worktree using a stale in-memory witness', async () => {
  const { repo, git } = realRepo(), prepared = await prepareWorktree(repo, 'proof', 'lead', { carry: false })
  git('worktree', 'remove', '--force', prepared.dir)
  git('worktree', 'add', '-q', '-b', 'user-replacement', prepared.dir)
  fs.writeFileSync(path.join(prepared.dir, 'precious.txt'), 'replacement')
  await expect(cleanupPreparedWorktree(repo, prepared)).rejects.toThrow('cannot verify')
  expect(fs.readFileSync(path.join(prepared.dir, 'precious.txt'), 'utf8')).toBe('replacement')
  expect(git('branch', '--list', 'room/proof')).not.toBe('')
})

it('does not delete a branch different from the branch in its witness', async () => {
  const { repo, git } = realRepo(), prepared = await prepareWorktree(repo, 'proof', 'lead', { carry: false })
  git('-C', prepared.dir, 'branch', '-m', 'user-renamed')
  await expect(cleanupPreparedWorktree(repo, prepared)).rejects.toThrow('branch changed')
  expect(fs.existsSync(prepared.dir)).toBe(true)
  expect(git('branch', '--list', 'user-renamed')).not.toBe('')
})

it('keeps the Git-admin witness valid when the witnessed worktree moves', async () => {
  const { repo, git } = realRepo(), prepared = await prepareWorktree(repo, 'proof', 'lead', { carry: false })
  const moved = path.join(repo, 'moved')
  git('worktree', 'move', prepared.dir, moved)
  await cleanupPreparedWorktree(repo, { ...prepared, dir: moved })
  expect(fs.existsSync(moved)).toBe(false)
  expect(git('branch', '--list', 'room/proof')).toBe('')
})

it('writes and verifies the witness when the lead is itself a linked checkout', async () => {
  const { repo, git } = realRepo(), lead = path.join(repo, 'linked-lead')
  git('worktree', 'add', '-q', '-b', 'lead', lead)
  const prepared = await prepareWorktree(lead, 'nested', 'lead', { carry: false })
  expect(prepared.witness!.adminDir).toContain(`${path.sep}.git${path.sep}worktrees${path.sep}`)
  await cleanupPreparedWorktree(lead, prepared)
  expect(fs.existsSync(prepared.dir)).toBe(false)
  expect(fs.existsSync(lead)).toBe(true)
  expect(git('branch', '--list', 'room/nested')).toBe('')
})

it('retains a preparing record with a mismatched durable record identity after restart', async () => {
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  expect(await t.leadTools.call('room_spawn', { tag: 'restart-proof', task: 'x' })).toContain('spawned restart-proof')
  const record = (await registry.reserved('restart-proof'))!
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
  const admin = git('-C', record.dir, 'rev-parse', '--absolute-git-dir'), marker = path.join(admin, PREPARATION_WITNESS_FILE)
  const contents = JSON.parse(fs.readFileSync(marker, 'utf8'))
  expect(contents).toMatchObject({ id: record.id, nonce: record.runs[0].nonce })
  contents.nonce = 'foreign'
  fs.writeFileSync(marker, JSON.stringify(contents))
  await mutateWorkerFixture(registry, record.id, old => ({ ...old, phase: 'preparing', runs: [{ ...old.runs[0], launch: undefined }], seq: old.seq + 1 }))
  const reopened = await WorkerRegistry.open(path.join(repo, '.git'), { watch: false, liveness: () => 'dead' })
  try {
    expect(fs.existsSync(record.dir)).toBe(true)
    expect(git('branch', '--list', record.branch)).not.toBe('')
    expect((await reopened.read(record.id))?.phase).toBe('abandoned')
  } finally { reopened.close() }
})

it.each(['collect', 'discard'] as const)('keeps pre-change established %s authority when its preparation witness is absent', async action => {
  const actual = await vi.importActual<typeof workerGit>('../src/worker-git.js')
  vi.mocked(workerGit.cleanupWorker).mockImplementation(actual.cleanupWorker)
  vi.mocked(workerGit.ignoredWorkerArtifacts).mockImplementation(actual.ignoredWorkerArtifacts)
  vi.mocked(workerGit.saveDiscardRecovery).mockImplementation(actual.saveDiscardRecovery)
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  expect(await t.leadTools.call('room_spawn', { tag: 'established', task: 'x' })).toContain('spawned established')
  const record = (await registry.reserved('established'))!
  await mutateWorkerFixture(registry, record.id, old => ({ ...old, prep: { step: 'prepared', created: true, branchCreated: true }, seq: old.seq + 1 }))
  fs.rmSync(path.join(git('-C', record.dir, 'rev-parse', '--absolute-git-dir'), PREPARATION_WITNESS_FILE))
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
  const reply = await t.leadTools.call('room_collect', { tag: 'established', ...(action === 'discard' ? { discard: true } : {}) })
  expect(fs.existsSync(record.dir), reply).toBe(false)
  expect(git('branch', '--list', record.branch)).toBe('')
  expect(reply).not.toContain('left in place because Room cannot confirm')
})

it('refuses damaged Git metadata found in an ancestor of a supplied directory', async () => {
  const { repo, head } = realRepo(), other = realRepo(), t = setupLead(repo, head)
  const orphan = path.join(other.repo, 'moved'), subdir = path.join(orphan, 'src')
  other.git('worktree', 'add', '-q', '-b', 'room/lost', orphan)
  fs.mkdirSync(subdir)
  fs.writeFileSync(path.join(orphan, '.git'), 'gitdir: missing-admin\n')
  delete t.session!.local
  expect(await t.leadTools.call('room_spawn', { tag: 'broken', task: 'x', dir: subdir, allowOutside: true })).toContain('error:')
  expect(t.specs).toHaveLength(0)
})

it('does not alias uppercase Room-like names on a case-sensitive filesystem', async context => {
  const { repo, head } = realRepo(), other = realRepo(), t = setupLead(repo, head)
  const outside = path.join(other.repo, '.ROOM/WORKERS/user')
  other.git('worktree', 'add', '-q', '-b', 'user-uppercase', outside)
  if (fs.existsSync(path.join(other.repo, '.room/workers/user'))) context.skip('requires a case-sensitive filesystem')
  delete t.session!.local
  expect(await t.leadTools.call('room_spawn', { tag: 'uppercase', task: 'x', dir: outside, allowOutside: true })).toContain('spawned uppercase')
})

it('does not prune unrelated unrecorded worktree metadata while preparing a fresh worker', async () => {
  const { repo, head, git } = realRepo(), t = setupLead(repo, head)
  const orphan = path.join(repo, '.room/workers/unrecorded')
  git('worktree', 'add', '-q', '--detach', orphan)
  fs.rmSync(orphan, { recursive: true })
  const registered = git('worktree', 'list', '--porcelain').split('\n').find(line => line.startsWith('worktree ') && line.endsWith('/unrecorded'))!
  expect(registered).toBeTruthy()
  expect(await t.leadTools.call('room_spawn', { tag: 'fresh-unrelated', task: 'x' })).toContain('spawned fresh-unrelated')
  expect(git('worktree', 'list', '--porcelain')).toContain(registered)
})

it('refuses an unmarked canonical stale registration and preserves every unrelated entry', async () => {
  const { repo, head, git } = realRepo(), target = path.join(repo, '.room/workers/stale')
  const unrelated = [path.join(repo, '.room/workers/other'), path.join(repo, 'other\ncheckouts/stale')]
  for (const dir of [target, ...unrelated]) git('worktree', 'add', '-q', '--detach', dir)
  const preserved = unrelated.map(dir => ({
    root: fs.realpathSync(dir), admin: fs.readFileSync(path.join(dir, '.git'), 'utf8').trim().slice(8),
  })).map(entry => ({ ...entry, backlink: fs.readFileSync(path.join(entry.admin, 'gitdir'), 'utf8') }))
  for (const dir of [target, ...unrelated]) fs.rmSync(dir, { recursive: true })
  const t = setupLead(repo, head)
  expect(await t.leadTools.call('room_spawn', { tag: 'stale', task: 'x' })).toContain('error:')
  const listing = git('worktree', 'list', '--porcelain', '-z')
  for (const entry of preserved) {
    expect(listing).toContain(`worktree ${entry.root}\0`)
    expect(fs.readFileSync(path.join(entry.admin, 'gitdir'), 'utf8')).toBe(entry.backlink)
  }
})

it('keeps a stale registration refused when its canonical directory exists again', async () => {
  const { repo, head, git } = realRepo(), target = path.join(repo, '.room/workers/stale')
  git('worktree', 'add', '-q', '--detach', target)
  fs.rmSync(target, { recursive: true }); fs.mkdirSync(target)
  const listing = git('worktree', 'list', '--porcelain'), t = setupLead(repo, head)
  expect(await t.leadTools.call('room_spawn', { tag: 'stale', task: 'x' })).toContain('error:')
  expect(t.specs).toHaveLength(0)
  expect(fs.readdirSync(target)).toEqual([])
  expect(git('worktree', 'list', '--porcelain')).toBe(listing)
})

it('rechecks the witness before fallback clean after a foreign replacement follows reset', async () => {
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), target = path.join(repo, '.room/workers/fallback')
  fs.writeFileSync(path.join(repo, 'modified.txt'), 'lead WIP')
  const bounded = baseline.boundedGitSync
  vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
    if (args[1].includes('apply')) throw new Error('forced carry failure')
    return bounded(...args)
  })
  const run = gitCommands.git
  let replaced = false
  vi.spyOn(gitCommands, 'git').mockImplementation(async (...args) => {
    const result = await run(...args)
    if (!replaced && args[0] === target && args[1].includes('read-tree')) {
      replaced = true
      git('worktree', 'remove', '--force', target)
      git('worktree', 'add', '-q', '-b', 'user-fallback', target)
      fs.writeFileSync(path.join(target, 'precious.txt'), 'foreign files')
    }
    return result
  })
  const spawn = vi.fn(() => { throw new Error('must not launch') })
  const tools = createTools({ getSession: () => t.session, setSession: () => {}, cwd: repo, spawner: spawn })
  const reply = await tools.call('room_spawn', { tag: 'fallback', task: 'x' })
  expect(replaced).toBe(true)
  expect(fs.existsSync(path.join(target, 'precious.txt')), reply).toBe(true)
  expect(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8')).toBe('foreign files')
  expect(spawn).not.toHaveBeenCalled()
})

it('keeps a recorded retry usable through filesystem-equivalent worker parent spelling', async context => {
  const { repo, head } = realRepo()
  fs.mkdirSync(path.join(repo, '.ROOM/WORKERS'), { recursive: true })
  if (!fs.existsSync(path.join(repo, '.room/workers'))) context.skip('requires a case-insensitive filesystem')
  const t = setupLead(repo, head), registry = await registryForDir(repo)
  expect(await t.leadTools.call('room_spawn', { tag: 'case-owner', task: 'x' })).toContain('spawned case-owner')
  const owner = (await registry.reserved('case-owner'))!
  t.exits[0](1)
  await vi.waitFor(async () => expect((await registry.status(owner.id))?.status).toBe('failed'))
  const reply = await t.leadTools.call('room_spawn', { tag: 'case-retry', task: 'x', dir: owner.dir })
  expect(reply).toContain('spawned case-retry')
  expect((await registry.reserved('case-retry'))?.sharedWith).toBe(owner.id)
})
