import * as workerGit from '../src/worker-git.js'
import { registryForDir, closeRegistryForDir } from '../src/worker-registry.js'
import * as doctor from '../src/doctor.js'
import { deleteWorkerRef, writeWorkerRef } from '../src/worker-refs.js'
import { retainedWorkerLines } from '../src/worker-retained.js'
import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { realRepo, setupLead } from './workers-fixture.js'
import { cleanupPreparedWorktree, inheritWorkerRefs, prepareWorktree, saveWorkerScratch, prepareWorkerLinks } from '../src/worker-git.js'

it('refuses a pre-existing empty root rather than witnessing a directory Room did not create', async () => {
  const { repo } = realRepo(), dir = path.join(repo, '.room/workers/empty')
  fs.mkdirSync(dir, { recursive: true })
  const before = fs.statSync(dir, { bigint: true })
  await expect(prepareWorktree(repo, 'empty', 'lead', { carry: false })).rejects.toThrow()
  expect(fs.statSync(dir, { bigint: true }).ino).toBe(before.ino)
  expect(fs.readdirSync(dir)).toEqual([])
})

it('never adopts a different-tip branch as its deletion expectation during cleanup', async () => {
  const { repo, git } = realRepo(), prepared = await prepareWorktree(repo, 'early-tip', 'lead', { carry: false })
  git('commit', '--allow-empty', '-qm', 'foreign tip')
  const foreign = git('rev-parse', 'HEAD')
  git('update-ref', `refs/heads/${prepared.branch}`, foreign)
  await cleanupPreparedWorktree(repo, prepared)
  expect(git('rev-parse', `refs/heads/${prepared.branch}`)).toBe(foreign)
})

it('keeps a symbolic branch target when deleting only the recorded worker ref name', async () => {
  const { repo, git } = realRepo(), prepared = await prepareWorktree(repo, 'symbolic', 'lead', { carry: false })
  const head = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/heads/user-target', head)
  git('symbolic-ref', `refs/heads/${prepared.branch}`, 'refs/heads/user-target')
  await cleanupPreparedWorktree(repo, prepared)
  expect(git('rev-parse', 'refs/heads/user-target')).toBe(head)
})

it('does not delete a borrower target pin when its source is absent', () => {
  const { repo, git, head } = realRepo()
  git('update-ref', 'refs/room/carry/retry', head)
  inheritWorkerRefs(path.join(repo, '.git'), { tag: 'absent', id: 'w_owner' }, { tag: 'retry', id: 'w_retry' })
  expect(git('rev-parse', 'refs/room/carry/retry')).toBe(head)
})

it('refuses a replacement between exclusive root creation and Git attachment', async () => {
  const { repo } = realRepo(), dir = path.join(repo, '.room/workers/root-swap')
  let replaced = false
  await expect(prepareWorktree(repo, 'root-swap', 'lead', { carry: false, onStep: async step => {
    if (step !== 'root') return
    fs.renameSync(dir, dir + '-original')
    fs.mkdirSync(dir)
    replaced = true
  } })).rejects.toThrow(/root directory identity changed/)
  expect(replaced).toBe(true)
  expect(fs.existsSync(dir)).toBe(true)
})

it('retains the actual checkout when a copied gitfile impersonates its admin directory', async () => {
  const { repo } = realRepo(), prepared = await prepareWorktree(repo, 'copied-git', 'lead', { carry: false })
  fs.renameSync(prepared.dir, prepared.dir + '-original')
  fs.mkdirSync(prepared.dir)
  fs.copyFileSync(path.join(prepared.dir + '-original', '.git'), path.join(prepared.dir, '.git'))
  fs.writeFileSync(path.join(prepared.dir, 'precious.txt'), 'foreign copied gitfile')
  await expect(cleanupPreparedWorktree(repo, prepared)).rejects.toThrow(/root directory identity changed/)
  expect(fs.readFileSync(path.join(prepared.dir, 'precious.txt'), 'utf8')).toBe('foreign copied gitfile')
})


it('retains an existing scratch directory that Room has no creation receipt for', () => {
  const { repo } = realRepo(), source = path.join(repo, 'scratch-source'), target = path.join(repo, '.room/scratch/user')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'new.log'), 'new scratch')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'precious.log'), 'existing user scratch')
  const result = saveWorkerScratch(repo, [{ tag: 'user', root: source, paths: ['new.log'] }])
  expect(fs.readFileSync(path.join(target, 'precious.log'), 'utf8')).toBe('existing user scratch')
  expect(result.skipped[0]?.reason).toMatch(/ownership|receipt/)
})

it('removes only a witnessed absent-owner stale admin and preserves unrelated user metadata', async () => {
  const { repo, git, head } = realRepo()
  const prepared = await prepareWorktree(repo, 'owned-stale', 'lead', { carry: false })
  const other = path.join(repo, 'user-stale')
  git('worktree', 'add', '-q', '--detach', other)
  const otherAdmin = git('-C', other, 'rev-parse', '--absolute-git-dir')
  fs.writeFileSync(path.join(otherAdmin, 'precious-sentinel'), 'user registration')
  fs.rmSync(other, { recursive: true })
  fs.rmSync(prepared.dir, { recursive: true })
  git('update-ref', '--no-deref', '-d', `refs/heads/${prepared.branch}`, head)
  const retry = await prepareWorktree(repo, 'owned-stale', 'lead', { carry: false })
  expect(fs.readFileSync(path.join(otherAdmin, 'precious-sentinel'), 'utf8')).toBe('user registration')
  expect(retry.witness?.token).not.toBe(prepared.witness?.token)
})


it('exact-name CAS never dereferences a replacement symbolic ref', () => {
  const { repo, git, head } = realRepo(), common = path.join(repo, '.git')
  writeWorkerRef(common, 'refs/heads/room/cas', head, 'w_cas', '0'.repeat(head.length))
  git('update-ref', 'refs/heads/precious-target', head)
  git('symbolic-ref', 'refs/heads/room/cas', 'refs/heads/precious-target')
  deleteWorkerRef(common, 'refs/heads/room/cas', 'w_cas')
  expect(git('rev-parse', 'refs/heads/precious-target')).toBe(head)
  expect(git('branch', '--list', 'room/cas')).toBe('')
})

it('retains unknown branch expectations and reports them until the name is actually gone', () => {
  const { repo, git, head } = realRepo(), common = path.join(repo, '.git')
  git('update-ref', 'refs/heads/room/unknown', head)
  const result = deleteWorkerRef(common, 'refs/heads/room/unknown', 'w_unknown')
  expect(result).toContain('no durable authorized-write expectation')
  expect(git('rev-parse', 'refs/heads/room/unknown')).toBe(head)
  expect(retainedWorkerLines(common).join('\n')).toContain('refs/heads/room/unknown')
  git('update-ref', '--no-deref', '-d', 'refs/heads/room/unknown', head)
  expect(retainedWorkerLines(common).join('\n')).not.toContain('refs/heads/room/unknown')
})


// Lead-defined boundary: an empty replacement in the mkdir-to-first-stat window at Room's reserved path has no foreign content.
it.fails('refuses a foreign root swapped after mkdir succeeds but before the first identity read', async () => {
  const { repo } = realRepo(), target = path.join(repo, '.room/workers/mkdir-receipt-gap')
  const mkdir = fs.mkdirSync
  let replaced = false
  const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((...args: Parameters<typeof fs.mkdirSync>) => {
    const result = (mkdir as (...values: Parameters<typeof fs.mkdirSync>) => unknown)(...args)
    if (!replaced && String(args[0]) === target) {
      fs.renameSync(target, target + '-room-created')
      mkdir(target)
      replaced = true
    }
    return result
  }) as typeof fs.mkdirSync)
  try {
    await expect(prepareWorktree(repo, 'mkdir-receipt-gap', 'lead', { carry: false })).rejects.toThrow()
    expect(replaced).toBe(true)
    expect(fs.existsSync(target)).toBe(true)
  } finally { spy.mockRestore() }
})


it('preserves foreign files placed in the mkdir-to-first-identity-read window', async () => {
  const { repo } = realRepo(), target = path.join(repo, '.room/workers/mkdir-content')
  const mkdir = fs.mkdirSync
  let replaced = false
  const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((...args: Parameters<typeof fs.mkdirSync>) => {
    const result = (mkdir as (...values: Parameters<typeof fs.mkdirSync>) => unknown)(...args)
    if (!replaced && String(args[0]) === target) {
      fs.renameSync(target, target + '-room-created')
      mkdir(target)
      fs.writeFileSync(path.join(target, 'precious.txt'), 'foreign content before add')
      replaced = true
    }
    return result
  }) as typeof fs.mkdirSync)
  try {
    await expect(prepareWorktree(repo, 'mkdir-content', 'lead', { carry: false })).rejects.toThrow()
    expect(replaced).toBe(true)
    expect(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8')).toBe('foreign content before add')
  } finally { spy.mockRestore() }
})


async function realLifecycleCleanup() {
  const actual = await vi.importActual<typeof workerGit>('../src/worker-git.js')
  const loaded = await import('../src/worker-git.js')
  if (vi.isMockFunction(loaded.cleanupWorker)) loaded.cleanupWorker.mockImplementation(actual.cleanupWorker)
  if (vi.isMockFunction(loaded.ignoredWorkerArtifacts)) loaded.ignoredWorkerArtifacts.mockImplementation(actual.ignoredWorkerArtifacts)
  if (vi.isMockFunction(loaded.saveDiscardRecovery)) loaded.saveDiscardRecovery.mockImplementation(actual.saveDiscardRecovery)
}

it.each(['collect', 'discard'] as const)('retains a new established worker with a missing marker during %s and shows it in state', async action => {
  await realLifecycleCleanup()
  const { repo, head } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  expect(await t.leadTools.call('room_spawn', { tag: 'new-marker', task: 'x', carry: false })).toContain('spawned new-marker')
  const record = (await registry.reserved('new-marker'))!
  fs.rmSync(path.join(record.prep.witness!.adminDir, 'room-preparation.json'))
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
  const reply = await t.leadTools.call('room_collect', { tag: record.tag, ...(action === 'discard' ? { discard: true } : {}) })
  expect(fs.existsSync(record.dir), reply).toBe(true)
  expect(reply).toContain(record.dir)
  expect(reply).toContain(record.prep.witness!.adminDir)
  expect(await t.leadTools.call('room_state', {})).toContain('kept worktree ' + record.dir)
  vi.spyOn(doctor, 'runDoctor').mockResolvedValue('doctor skipped for focused reporting test')
  expect(await t.leadTools.call('room_state', { check: true })).toContain('kept worktree ' + record.dir)
  await closeRegistryForDir(repo)
  expect(retainedWorkerLines(path.join(repo, '.git')).join('\n')).toContain(record.dir)
})

it('collects worker commits and permits immediate tag reuse without retained-item diagnostics', async () => {
  await realLifecycleCleanup()
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  expect(await t.leadTools.call('room_spawn', { tag: 'own-commit', task: 'x', carry: false })).toContain('spawned own-commit')
  const record = (await registry.reserved('own-commit'))!
  fs.writeFileSync(path.join(record.dir, 'modified.txt'), 'worker commit output')
  git('-C', record.dir, 'commit', '-qam', 'worker changed tracked file')
  const tip = git('-C', record.dir, 'rev-parse', 'HEAD')
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
  const reply = await t.leadTools.call('room_collect', { tag: record.tag })
  expect(fs.existsSync(record.dir), reply).toBe(false)
  expect(fs.readFileSync(path.join(repo, 'modified.txt'), 'utf8')).toBe('worker commit output')
  expect(git('branch', '--list', record.branch)).toBe('')
  expect(git('rev-parse', `refs/room/recovery/${record.tag}/${tip}^{commit}`)).toBe(tip)
  expect(reply).not.toContain('left in place because Room cannot confirm')
  expect(await t.leadTools.call('room_spawn', { tag: record.tag, task: 'again' })).toContain('spawned ' + record.tag)
})


it('retains foreign content replacing an input link before rollback', async () => {
  const { repo } = realRepo(), prepared = await prepareWorktree(repo, 'input-links', 'lead', { carry: false })
  fs.mkdirSync(path.join(repo, 'inputs'))
  fs.writeFileSync(path.join(repo, 'inputs/one'), 'input one')
  fs.writeFileSync(path.join(repo, 'inputs/two'), 'input two')
  const first = path.join(fs.realpathSync(prepared.dir), 'inputs/one'), second = path.join(fs.realpathSync(prepared.dir), 'inputs/two')
  const link = fs.symlinkSync
  const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation((...args: Parameters<typeof fs.symlinkSync>) => {
    if (String(args[1]) === second) {
      fs.unlinkSync(first)
      fs.writeFileSync(first, 'foreign input-link replacement')
      throw new Error('injected second link failure')
    }
    return link(...args)
  })
  try {
    expect(() => prepareWorkerLinks(repo, prepared.dir, ['inputs/one', 'inputs/two'])).toThrow('second link failure')
    expect(fs.readFileSync(first, 'utf8')).toBe('foreign input-link replacement')
  } finally { spy.mockRestore() }
})

it('names the retained recorded admin even when its backlink can no longer identify the checkout', async () => {
  const { repo } = realRepo(), prepared = await prepareWorktree(repo, 'changed-backlink', 'lead', { carry: false })
  const admin = prepared.witness!.adminDir
  fs.writeFileSync(path.join(admin, 'gitdir'), path.join(repo, 'elsewhere', '.git') + '\n')
  await expect(cleanupPreparedWorktree(repo, prepared)).rejects.toThrow()
  expect(fs.existsSync(prepared.dir)).toBe(true)
  expect(fs.existsSync(admin)).toBe(true)
  expect(retainedWorkerLines(path.join(repo, '.git')).join('\n')).toContain('kept registration ' + admin)
})

for (const action of ['collect', 'discard'] as const) {
  it(`${action}s committed workers and reuses their tag without a manual step`, async () => {
    await realLifecycleCleanup()
    const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
    expect(await t.leadTools.call('room_spawn', { tag: 'reuse', task: 'x', carry: false })).toContain('spawned reuse')
    const record = (await registry.reserved('reuse'))!
    fs.writeFileSync(path.join(record.dir, 'modified.txt'), 'first commit')
    git('-C', record.dir, 'commit', '-qam', 'worker commit')
    fs.writeFileSync(path.join(record.dir, 'modified.txt'), 'second commit')
    git('-C', record.dir, 'commit', '-qam', 'second worker commit')
    const tip = git('-C', record.dir, 'rev-parse', 'HEAD')
    t.exits[0](0)
    await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
    const reply = await t.leadTools.call('room_collect', { tag: record.tag, ...(action === 'discard' ? { discard: true } : {}) })
    expect(git('branch', '--list', record.branch), reply).toBe('')
    expect(git('rev-parse', `refs/room/recovery/${record.tag}/${tip}^{commit}`)).toBe(tip)
    expect(reply).not.toContain('left in place because Room cannot confirm')
    expect(await t.leadTools.call('room_spawn', { tag: record.tag, task: 'again' })).toContain('spawned ' + record.tag)
  })

  it(`retains and reports a branch moved after ${action}'s read while preserving the read commit`, async () => {
    await realLifecycleCleanup()
    const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
    await t.leadTools.call('room_spawn', { tag: 'move-tip', task: 'x', carry: false })
    const record = (await registry.reserved('move-tip'))!
    git('-C', record.dir, 'commit', '--allow-empty', '-qm', 'worker commit')
    const tip = git('-C', record.dir, 'rev-parse', 'HEAD')
    git('commit', '--allow-empty', '-qm', 'foreign commit')
    const foreign = git('rev-parse', 'HEAD')
    t.exits[0](0)
    await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
    const baseline = await import('@room/roomd/baseline'), run = baseline.boundedGitSync
    let moved = false
    const spy = vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
      if (!moved && args[1].includes('update-ref') && args[1].includes('--stdin') && args[2]?.input?.toString().includes(`delete refs/heads/${record.branch} `)) {
        git('update-ref', `refs/heads/${record.branch}`, foreign)
        moved = true
      }
      return run(...args)
    })
    try {
      const reply = await t.leadTools.call('room_collect', { tag: record.tag, ...(action === 'discard' ? { discard: true } : {}) })
      expect(moved, reply).toBe(true)
      expect(git('rev-parse', record.branch)).toBe(foreign)
      expect(git('rev-parse', `refs/room/recovery/${record.tag}/${tip}^{commit}`)).toBe(tip)
      expect(reply).toContain(`kept branch refs/heads/${record.branch}`)
    } finally { spy.mockRestore() }
  })

  it(`does not follow a symbolic branch during ${action}`, async () => {
    await realLifecycleCleanup()
    const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
    await t.leadTools.call('room_spawn', { tag: 'sym-tip', task: 'x', carry: false })
    const record = (await registry.reserved('sym-tip'))!
    git('branch', 'user-target', head)
    t.exits[0](0)
    await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
    const baseline = await import('@room/roomd/baseline'), run = baseline.boundedGitSync
    let replaced = false
    const spy = vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
      if (!replaced && args[1].some(value => value.includes('%(symref)')) && args[1].includes(`refs/heads/${record.branch}`)) {
        git('symbolic-ref', `refs/heads/${record.branch}`, 'refs/heads/user-target')
        replaced = true
      }
      return run(...args)
    })
    try {
      const reply = await t.leadTools.call('room_collect', { tag: record.tag, ...(action === 'discard' ? { discard: true } : {}) })
      expect(replaced, reply).toBe(true)
      expect(git('rev-parse', 'user-target'), reply).toBe(head)
      expect(git('symbolic-ref', `refs/heads/${record.branch}`)).toBe('refs/heads/user-target')
      expect(git('for-each-ref', '--format=%(refname)', `refs/room/recovery/${record.tag}/`)).toBe('')
      expect(reply).toContain(`kept branch refs/heads/${record.branch}`)
    } finally { spy.mockRestore() }
  })

  it(`retains its branch if ${action} cannot write the recovery ref`, async () => {
    await realLifecycleCleanup()
    const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
    await t.leadTools.call('room_spawn', { tag: 'pin-fails', task: 'x', carry: false })
    const record = (await registry.reserved('pin-fails'))!
    git('-C', record.dir, 'commit', '--allow-empty', '-qm', 'worker commit')
    const tip = git('-C', record.dir, 'rev-parse', 'HEAD')
    t.exits[0](0)
    await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
    const baseline = await import('@room/roomd/baseline'), run = baseline.boundedGitSync
    let pinAttempted = false
    const spy = vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
      if (args[1].includes('update-ref') && args[1].some(value => value.startsWith(`refs/room/recovery/${record.tag}/`))) { pinAttempted = true; throw new Error('injected recovery ref write failure') }
      return run(...args)
    })
    try {
      const reply = await t.leadTools.call('room_collect', { tag: record.tag, ...(action === 'discard' ? { discard: true } : {}) })
      expect(pinAttempted, reply).toBe(true)
      expect(git('rev-parse', record.branch)).toBe(tip)
      expect(reply).toContain(`kept branch refs/heads/${record.branch}`)
    } finally { spy.mockRestore() }
  })
}

it('collects keep then plain collect and reuses the committed worker tag', async () => {
  await realLifecycleCleanup()
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  await t.leadTools.call('room_spawn', { tag: 'kept-commits', task: 'x', carry: false })
  const record = (await registry.reserved('kept-commits'))!
  fs.writeFileSync(path.join(record.dir, 'modified.txt'), 'kept worker commit')
  git('-C', record.dir, 'commit', '-qam', 'worker commit')
  const tip = git('-C', record.dir, 'rev-parse', 'HEAD')
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
  expect(await t.leadTools.call('room_collect', { tag: record.tag, keep: true })).not.toContain('left in place because Room cannot confirm')
  const reply = await t.leadTools.call('room_collect', { tag: record.tag })
  expect(git('branch', '--list', record.branch), reply).toBe('')
  expect(git('rev-parse', `refs/room/recovery/${record.tag}/${tip}^{commit}`)).toBe(tip)
  expect(reply).not.toContain('left in place because Room cannot confirm')
  expect(await t.leadTools.call('room_spawn', { tag: record.tag, task: 'again' })).toContain('spawned ' + record.tag)
})
