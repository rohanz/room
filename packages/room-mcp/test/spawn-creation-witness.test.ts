import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { realRepo, setupLead, createTools } from './workers-fixture.js'
import { registryForDir, WorkerRegistry } from '../src/worker-registry.js'
import { requireWorkerInventory } from '../src/worker-store.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import type { WorkerRecord } from '../src/worker-status.js'

it('refuses a moved orphan whose gitfile points at missing metadata rather than treating it as a user folder', async () => {
  const { repo, head } = realRepo(), other = realRepo(), t = setupLead(repo, head)
  const orphan = path.join(other.repo, 'moved')
  other.git('worktree', 'add', '-q', '-b', 'room/lost', orphan)
  fs.writeFileSync(path.join(orphan, 'precious.txt'), 'orphan output')
  fs.writeFileSync(path.join(orphan, '.git'), `gitdir: ${path.join(other.repo, 'missing-git-metadata')}\n`)
  delete t.session!.local
  const registry = await registryForDir(repo)
  const reply = await t.leadTools.call('room_spawn', { tag: 'retry', task: 'x', dir: orphan, allowOutside: true })
  expect(t.specs.length, reply).toBe(0)
  expect(requireWorkerInventory(await registry.list())).toEqual([])
})

it('recognizes case-equivalent Room directories with a renamed branch on case-insensitive filesystems', async context => {
  const { repo, head } = realRepo(), other = realRepo(), t = setupLead(repo, head)
  const orphan = path.join(other.repo, '.ROOM/WORKERS/lost')
  other.git('worktree', 'add', '-q', '-b', 'user-renamed', orphan)
  // This adversarial form is meaningful only when the lower-case spelling resolves too.
  if (!fs.existsSync(path.join(other.repo, '.room/workers/lost'))) context.skip('requires a case-insensitive filesystem')
  delete t.session!.local
  const registry = await registryForDir(repo)
  const reply = await t.leadTools.call('room_spawn', { tag: 'retry', task: 'x', dir: orphan, allowOutside: true })
  expect(t.specs.length, reply).toBe(0)
  expect(requireWorkerInventory(await registry.list())).toEqual([])
})

it('refuses an existing empty directory instead of claiming its creation', async () => {
  const { repo, head } = realRepo(), t = setupLead(repo, head)
  const target = path.join(repo, '.room/workers/fresh')
  fs.mkdirSync(target, { recursive: true })
  const before = fs.statSync(target, { bigint: true })
  expect(await t.leadTools.call('room_spawn', { tag: 'fresh', task: 'x' })).toContain('error:')
  expect(t.specs).toHaveLength(0)
  expect(fs.statSync(target, { bigint: true }).ino).toBe(before.ino)
  expect(fs.readdirSync(target)).toEqual([])
})

it('refuses a no-dir spawn at a prunable orphan before intent and preserves its Git entry', async () => {
  const { repo, head, git } = realRepo(), orphan = path.join(repo, '.room/workers/prunable')
  git('worktree', 'add', '-q', '-b', 'room/prunable', orphan)
  fs.rmSync(orphan, { recursive: true })
  const t = setupLead(repo, head), registry = await registryForDir(repo), intent = vi.spyOn(registry, 'writeIntent')
  const listing = git('worktree', 'list', '--porcelain'), refs = git('show-ref')
  expect(await t.leadTools.call('room_spawn', { tag: 'prunable', task: 'x' })).toContain('branch room/prunable is unmanaged')
  expect(intent.mock.calls.length).toBe(0)
  expect(git('worktree', 'list', '--porcelain')).toBe(listing)
  expect(git('show-ref')).toBe(refs)
})

it.each(['plan', 'worktree'] as const)('restart does not reinterpret v0.17.47 pre-add journal (%s) as a creation witness', async step => {
  const { repo, git } = realRepo(), registry = await registryForDir(repo)
  const dir = path.join(repo, '.room/workers/pending'), id = registry.newId()
  // Exact durable state produced by v0.17.47 room_spawn before it calls prepareWorktree:
  // created is inferred from !existsSync(dir), then prepare-start changes phase only.
  const record: WorkerRecord = {
    v: 1, id, tag: 'pending', name: 'rohanz+pending', mode: 'here', room: 'local/x',
    lead: { participant: 'rohanz', room: 'local/x', instance: registry.instance }, host: 'claude',
    budget: { threads: 1, memGb: 1, nice: 10 }, share: 'full', task: 'x',
    dir, outside: false, branch: 'room/pending', prep: { step, worktreeExisted: false, created: true,
      ...(step === 'worktree' ? { branchCreated: true, branchExisted: false } : {}) },
    capabilities: { resume: true, signal: true, collect: 'delta' }, phase: 'preparing',
    runs: [{ n: 1, mode: 'fresh', intentAt: 1, nonce: 'pending', busFrontier: 0,
      promptMsgIds: [], launcher: registry.instance, logStart: 0 }], createdAt: 1, seq: 1,
  }
  await registry.writeIntent(record)
  git('worktree', 'add', '-q', '-b', 'room/pending', dir)
  fs.writeFileSync(path.join(dir, 'precious.txt'), 'created by someone else after the old intent')
  // Model restart after the dead process's operation lease has been recovered.
  await registry.finishOperation(id)
  registry.close()
  const reopened = await WorkerRegistry.open(path.join(repo, '.git'), { watch: false, liveness: () => 'dead' })
  try {
    expect(fs.existsSync(path.join(dir, 'precious.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'precious.txt'), 'utf8')).toContain('someone else')
  } finally { reopened.close() }
})

it('preserves the old not-owned refusal when an occupied tag is supplied the lead checkout', async () => {
  const { repo, head } = realRepo(), t = setupLead(repo, head)
  expect(await t.leadTools.call('room_spawn', { tag: 'occupied', task: 'x' })).toContain('spawned occupied')
  expect(await t.leadTools.call('room_spawn', { tag: 'occupied', task: 'x', dir: repo }))
    .toBe(`error: ${repo} is not an owned Room worktree for occupied; supply its .room/workers/occupied checkout or omit dir`)
})

it('leaks rather than deletes a successfully added checkout when the creation journal write fails', async () => {
  const { repo, head } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  const command = registry.command.bind(registry)
  vi.spyOn(registry, 'command').mockImplementation(async (...args) => {
    if (args[1].type === 'prepare-step' && args[1].step === 'worktree') throw new Error('journal write failed')
    return command(...args)
  })
  const tools = createTools({ getSession: () => t.session, setSession: () => {}, cwd: repo,
    spawner: () => { throw new Error('must not launch') } })
  expect(await tools.call('room_spawn', { tag: 'leaked', task: 'x' })).toContain('journal write failed')
  const record = (await registry.reserved('leaked'))!
  expect(record.prep.created).toBe(false)
  expect(fs.existsSync(path.join(record.dir, '.git'))).toBe(true)
  expect(record.phase).toBe('abandoned')
})

it.each([false, true])('restart honors the durable creation witness (%s)', async witnessed => {
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  expect(await t.leadTools.call('room_spawn', { tag: 'restart', task: 'x' })).toContain('spawned restart')
  const old = (await registry.reserved('restart'))!
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(old.id))?.status).toBe('done'))
  await mutateWorkerFixture(registry, old.id, record => ({ ...record, phase: 'preparing', prep: {
    step: 'worktree', created: witnessed, branchCreated: witnessed, branchExisted: false },
    runs: [{ ...record.runs[0], launch: undefined }], seq: record.seq + 1 }))
  const reopened = await WorkerRegistry.open(path.join(repo, '.git'), { watch: false, liveness: () => 'dead' })
  try {
    expect(fs.existsSync(old.dir)).toBe(!witnessed)
    expect(git('branch', '--list', 'room/restart') !== '').toBe(!witnessed)
    expect((await reopened.read(old.id))?.phase).toBe('abandoned')
  } finally { reopened.close() }
})

it('leaves a foreign branch that appears after plan and before Git add untouched', async () => {
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  const command = registry.command.bind(registry)
  vi.spyOn(registry, 'command').mockImplementation(async (...args) => {
    const result = await command(...args)
    if (args[1].type === 'prepare-step' && args[1].step === 'plan') git('branch', 'room/branch-race')
    return result
  })
  const tools = createTools({ getSession: () => t.session, setSession: () => {}, cwd: repo,
    spawner: () => { throw new Error('must not launch') } })
  expect(await tools.call('room_spawn', { tag: 'branch-race', task: 'x' })).toContain('error:')
  expect(git('rev-parse', 'room/branch-race')).toBe(head)
  expect((await registry.reserved('branch-race'))?.prep).toMatchObject({ created: false })
})

it('leaks safely if the process stops after clearing creation authority and before retry removal', async () => {
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  const command = registry.command.bind(registry)
  let cleared = false
  vi.spyOn(registry, 'command').mockImplementation(async (...args) => {
    const result = await command(...args)
    if (args[1].type === 'prepare-step' && args[1].step === 'worktree') {
      fs.writeFileSync(path.join(repo, 'modified.txt'), 'force snapshot retry')
      git('add', 'modified.txt'); git('commit', '-qm', 'advance lead')
    }
    if (args[1].type === 'prepare-step' && args[1].step === 'plan' && args[1].facts.created === false) {
      cleared = true
      throw new Error('stopped after clearing journal')
    }
    return result
  })
  const tools = createTools({ getSession: () => t.session, setSession: () => {}, cwd: repo,
    spawner: () => { throw new Error('must not launch') } })
  expect(await tools.call('room_spawn', { tag: 'clear-race', task: 'x' })).toContain('stopped after clearing journal')
  expect(cleared).toBe(true)
  const record = (await registry.reserved('clear-race'))!
  expect(record.prep).toMatchObject({ created: false, branchCreated: false })
  expect(fs.existsSync(path.join(record.dir, '.git'))).toBe(true)
  expect(git('rev-parse', 'room/clear-race')).toBe(head)
})

it('does not remove a foreign replacement that appears after the retry journal is cleared', async () => {
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  const command = registry.command.bind(registry), target = path.join(repo, '.room/workers/replaced')
  let replaced = false, advanced = false
  vi.spyOn(registry, 'command').mockImplementation(async (...args) => {
    const result = await command(...args)
    if (!advanced && args[1].type === 'prepare-step' && args[1].step === 'worktree') {
      advanced = true
      fs.writeFileSync(path.join(repo, 'modified.txt'), 'force snapshot retry')
      git('add', 'modified.txt'); git('commit', '-qm', 'advance lead')
    }
    if (!replaced && args[1].type === 'prepare-step' && args[1].step === 'plan' && args[1].facts.created === false) {
      replaced = true
      // Another actor replaces the original preparation while this process is between journal and cleanup.
      git('worktree', 'remove', '--force', target)
      git('worktree', 'add', '-q', '-b', 'user-replacement', target)
      fs.writeFileSync(path.join(target, 'precious.txt'), 'foreign replacement')
    }
    return result
  })
  const tools = createTools({ getSession: () => t.session, setSession: () => {}, cwd: repo,
    spawner: () => { throw new Error('must not launch') } })
  const reply = await tools.call('room_spawn', { tag: 'replaced', task: 'x' })
  expect(replaced).toBe(true)
  expect(fs.existsSync(path.join(target, 'precious.txt')), reply).toBe(true)
  expect(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8')).toBe('foreign replacement')
})
