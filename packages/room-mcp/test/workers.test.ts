import { publishFixture } from './fixtures/manifest.js'
import { claudeWakeUnavailable } from '../src/prompt.js'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import fs, { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync, lstatSync, realpathSync, chmodSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, manifestPaths, shouldWakeOnMsg } from '@room/shared'
import type { Identity, Msg } from '@room/shared'
import { createTools as createRoomTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { resolveConfig } from '../src/config.js'
import { GraphIndex } from '../src/graph-index.js'
import { prepareWorkerLinks, prepareWorktree, cleanupPreparedWorktree } from '../src/worker-git.js'
import { workerBudget, workerPriority, workerCommand, workerPrompt, validTag, workerEnv } from '../src/worker-config.js'
import { workerLogTail, defaultSpawner, pidAlive, pidIsOurWorker, workerProcessOwnership, probeProcess, parsePsLstartUtc, type SpawnSpec } from '../src/worker-process.js'
import { reserveWorkerPort } from '../src/port-reservations.js'
import { registerWorkers, workerByTag } from './registry-fixture.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import type { WorkerRecord } from '../src/worker-status.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'
import { hubAppend } from '@room/shared/testing'

/** No release notices to send here. */
const ignore = () => {}

/** The worker reports room_done for its current run (a done report), while its process may still be alive. */
async function reportDone(tag: string, summary = ''): Promise<void> {
  const registry = await registryForDir(dir)
  const record = registry.list().find(r => r.tag === tag && !['retired', 'abandoned'].includes(r.phase))!, run = record.runs.at(-1)!
  await registry.writeReport(record.id, { run: run.n, nonce: run.nonce, chain: [], joinedAt: record.createdAt, done: { at: Date.now(), summary, changed: [] } })
}

// Lifecycle workers and worktrees in this file are synthetic. Never scan host processes.
const createTools = (ctx: Parameters<typeof createRoomTools>[0]) => {
  const tools = createRoomTools({ listCwdProcesses: () => [], ...ctx })
  return { ...tools, call: async (...args: Parameters<typeof tools.call>) => {
    const session = ctx.getSession()
    if (session && args[0] === 'room_done' && !ctx.config?.workerId && !process.env.ROOM_WORKER_ID) {
      const registry = await registryForDir(session.dir)
      const record = registry.list().find(record => record.name === session.me.name)
      const run = record?.runs.at(-1)
      if (record && run) {
        if (!registry.reports(record.id).some(report => report.run === run.n)) await registry.admit({
          id: record.id, run: run.n, nonce: run.nonce, dir: record.dir,
          chain: [], hostSessionId: record.hostSessionId,
        })
        process.env.ROOM_WORKER_ID = record.id
        try { return await tools.call(...args) }
        finally { delete process.env.ROOM_WORKER_ID }
      }
    }
    return tools.call(...args)
  } }
}

// Disk cleanup and patch restoration are exercised with real worktrees in collect.test.ts.
// These lifecycle tests use synthetic worker directories and controlled process callbacks.
vi.mock('../src/worker-git.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/worker-git.js')>(),
  ignoredWorkerArtifacts: vi.fn(async () => []),
  saveDiscardPatch: vi.fn(async () => undefined),
  cleanupWorker: vi.fn(async () => true),
}))

let dir: string
let base: string
const scratchRepos: string[] = []
const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
const workerId: Identity = { name: 'rohanz+money', kind: 'agent', owner: 'rohanz', label: 'money' }

const isRoomTestEnv = (key: string) => key.startsWith('ROOM_') || key === 'CLAUDE_CODE_MESSAGING_SOCKET' || key === 'CLAUDE_CODE_MESSAGING_TOKEN'
let roomEnv: Record<string, string | undefined>
beforeEach(() => {
  roomEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => isRoomTestEnv(key)))
  for (const key of Object.keys(roomEnv)) delete process.env[key]
  const configHome = mkdtempSync(join(tmpdir(), 'room-worker-config-'))
  scratchRepos.push(configHome)
  vi.stubEnv('XDG_CONFIG_HOME', configHome)
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const key of Object.keys(process.env)) if (isRoomTestEnv(key)) delete process.env[key]
  Object.assign(process.env, roomEnv)
  for (const repo of scratchRepos.splice(0)) {
    await closeRegistryForDir(repo).catch(() => {})
    rmSync(repo, { recursive: true, force: true })
  }
  await closeRegistryForDir(dir)
  rmSync(join(dir, '.git', 'room', 'registry'), { recursive: true, force: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim()
  const worktrees = git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9))
  for (const worktree of worktrees) if (!existsSync(worktree) || realpathSync(worktree) !== realpathSync(dir)) {
    try { git('worktree', 'remove', '--force', worktree) } catch { /* a test may have removed it already */ }
  }
  git('worktree', 'prune')
  for (const branch of git('for-each-ref', '--format=%(refname:short)', 'refs/heads/room').split('\n').filter(Boolean)) git('branch', '-D', branch)
})

function realRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'room-carry-'))
  scratchRepos.push(repo)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@test')
  git('config', 'user.name', 'tester')
  writeFileSync(join(repo, '.gitignore'), '.room/\nignored.txt\n')
  writeFileSync(join(repo, 'modified.txt'), 'before\n')
  writeFileSync(join(repo, 'staged.txt'), 'before\n')
  writeFileSync(join(repo, 'deleted.txt'), 'before\n')
  writeFileSync(join(repo, 'renamed.txt'), 'before\n')
  writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
  writeFileSync(join(repo, 'executable.sh'), '#!/bin/sh\necho before\n', { mode: 0o755 })
  git('add', '.'); git('commit', '-qm', 'initial')
  return { repo, git, head: git('rev-parse', 'HEAD') }
}

function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}
function fakeSession(room: RoomDoc, me: Identity, local = true): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  const graph = new GraphIndex(room, me.name, dir); graph.start()
  return {
    graph, room, awareness, me, dir, roomUrl: 'ws://127.0.0.1:1/local%2Fx%2Fmain', roomName: 'local/x/main', browserUrl: 'http://x',
    ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base, fence: 'test-fence' } as never,
    shareMax: 'full', shareRequested: 'full',
    ...(local ? { local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} } } : {}),
  } as Session
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-workers-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'rohanz')
  fs.appendFileSync(join(dir, '.git', 'info', 'exclude'), '.room/\n')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})

describe('worker plumbing', () => {
  it('validates tags and builds host commands', () => {
    expect(validTag('money')).toBe('money'); expect(validTag('a b')).toBeUndefined(); expect(validTag('')).toBeUndefined()
    const c = workerCommand('claude', 'claude-sonnet-5', 'do it')
    expect(c.cmd).toBe('claude'); expect(c.args).toContain('--model'); expect(c.args.slice(0, 2)).toEqual(['-p', 'do it'])
    const x = workerCommand('codex', undefined, 'do it')
    expect(x.cmd).toBe('codex'); expect(x.args.slice(0, 3)).toEqual(['exec', '-s', 'workspace-write'])
    expect(x.args).toContain('--json')
    expect(workerPrompt('rohanz', 'money', 'switch to cents')).toContain('to "rohanz"')
  })

  it('uses the resolved channel override and supports disabling it', async () => {
    for (const channel of ['plugin:custom@market', '']) {
      const config = await resolveConfig({ dir, env: { ROOM_CLAUDE_CHANNEL: channel } })
      const c = workerCommand('claude', undefined, 'task', config.claudeChannel)
      expect(c.args.slice(0, 2)).toEqual(['-p', 'task'])
      const channels = workerCommand('claude', undefined, 'task', config.claudeChannel, undefined, { wakeChannels: true })
      expect(channels.args.slice(0, channel ? 4 : 2)).toEqual(channel ? ['--dangerously-load-development-channels', channel, '-p', 'task'] : ['-p', 'task'])
      expect(workerCommand('codex', undefined, 'task', config.claudeChannel).args).not.toContain('--dangerously-load-development-channels')
    }
  })

  it('creates a worktree on branch room/<tag> and refuses an unmanaged reuse', async () => {
    const w1 = await prepareWorktree(dir, 'money')
    expect(w1.base).toBe(base); expect(w1.created).toBe(true); expect(w1.branch).toBe('room/money'); expect(existsSync(join(w1.dir, 'app.py'))).toBe(true)
    await expect(prepareWorktree(dir, 'money')).rejects.toThrow(/unmanaged/)
  })

  it('refuses a stale branch when a worker directory was deleted', async () => {
    const first = await prepareWorktree(dir, 'deleted')
    rmSync(first.dir, { recursive: true, force: true })
    await expect(prepareWorktree(dir, 'deleted')).rejects.toThrow(/branch room\/deleted is unmanaged/)
  })

  it('carries tracked and non-ignored untracked work into a worker-local base commit', async () => {
    const { repo, git, head } = realRepo()
    writeFileSync(join(repo, 'modified.txt'), 'after\n')
    writeFileSync(join(repo, 'staged.txt'), 'staged\n'); git('add', 'staged.txt')
    rmSync(join(repo, 'deleted.txt'))
    git('mv', 'renamed.txt', 'moved.txt')
    writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 255, 1, 254, 0]))
    writeFileSync(join(repo, 'executable.sh'), '#!/bin/sh\necho after\n'); chmodSync(join(repo, 'executable.sh'), 0o755)
    writeFileSync(join(repo, 'new.sh'), '#!/bin/sh\necho new\n', { mode: 0o755 })
    writeFileSync(join(repo, 'ignored.txt'), 'private')
    mkdirSync(join(repo, '.room'), { recursive: true }); writeFileSync(join(repo, '.room', 'private'), 'private')
    const leadStatus = git('status', '--porcelain')
    const prepared = await prepareWorktree(repo, 'carry', 'rohanz')
    expect(prepared.carried?.count).toBeGreaterThan(0)
    expect(prepared.base).toBe(git('rev-parse', 'room/carry'))
    expect(prepared.base).not.toBe(head)
    expect(execFileSync('git', ['-C', prepared.dir, 'log', '-1', '--format=%s']).toString().trim()).toBe('room: carried-in uncommitted work from rohanz')
    expect(readFileSync(join(prepared.dir, 'modified.txt'), 'utf8')).toBe('after\n')
    expect(readFileSync(join(prepared.dir, 'staged.txt'), 'utf8')).toBe('staged\n')
    expect(existsSync(join(prepared.dir, 'deleted.txt'))).toBe(false)
    expect(existsSync(join(prepared.dir, 'moved.txt'))).toBe(true)
    expect(existsSync(join(prepared.dir, 'renamed.txt'))).toBe(false)
    expect(readFileSync(join(prepared.dir, 'binary.bin'))).toEqual(Buffer.from([0, 255, 1, 254, 0]))
    expect(lstatSync(join(prepared.dir, 'new.sh')).mode & 0o111).toBeTruthy()
    expect(prepared.carriedUntracked).toContainEqual({ path: 'new.sh', sha: git('hash-object', 'new.sh'), mode: 0o755 })
    expect(git('ls-tree', 'refs/room/carry-untracked/carry', 'new.sh')).toContain('100755 blob')
    expect(existsSync(join(prepared.dir, 'ignored.txt'))).toBe(false)
    expect(existsSync(join(prepared.dir, '.room', 'private'))).toBe(false)
    expect(execFileSync('git', ['-C', prepared.dir, 'status', '--porcelain']).toString().trim()).toBe('?? new.sh')
    expect(git('status', '--porcelain')).toBe(leadStatus)
  })

  it('keeps carried untracked bytes out of every branch and push --all', async () => {
    const { repo, git } = realRepo()
    writeFileSync(join(repo, 'modified.txt'), 'tracked WIP\n')
    writeFileSync(join(repo, 'private.txt'), 'untracked private bytes\n')
    const prepared = await prepareWorktree(repo, 'private', 'rohanz')
    expect(readFileSync(join(prepared.dir, 'private.txt'), 'utf8')).toBe('untracked private bytes\n')
    expect(prepared.carriedUntracked).toEqual([{ path: 'private.txt', sha: git('hash-object', 'private.txt'), mode: lstatSync(join(repo, 'private.txt')).mode & 0o777 }])
    expect(prepared.carried?.count).toBe(2)
    expect(git('ls-tree', '-r', '--name-only', 'refs/heads/room/private')).not.toContain('private.txt')
    const heads = git('for-each-ref', '--format=%(refname)', 'refs/heads').split('\n')
    expect(heads).toContain('refs/heads/room/private')
    expect(git('log', '--all', '--source', '--format=%H', '--', 'private.txt')).toBe('')
    expect(git('rev-list', '--objects', ...heads)).not.toContain(prepared.carriedUntracked![0].sha)
    expect(git('cat-file', '-p', prepared.carriedUntracked![0].sha)).toBe('untracked private bytes')
    expect(git('ls-tree', '-r', '--name-only', 'refs/room/carry-untracked/private')).toBe('private.txt')
    const remote = mkdtempSync(join(tmpdir(), 'room-carry-remote-')); scratchRepos.push(remote)
    execFileSync('git', ['init', '--bare', '-q', remote])
    git('push', '--all', remote)
    expect(() => execFileSync('git', [`--git-dir=${remote}`, 'cat-file', '-e', 'refs/heads/room/private:private.txt'], { stdio: 'ignore' })).toThrow()
    expect(execFileSync('git', [`--git-dir=${remote}`, 'for-each-ref', '--format=%(refname)']).toString()).not.toContain('refs/room/')
  })

  it('carries despite hostile diff config and suppresses every commit hook', async () => {
    const { repo, git } = realRepo()
    for (const [key, value] of Object.entries({ 'color.ui': 'always', 'diff.noprefix': 'true', 'diff.external': '/bin/echo', 'diff.mnemonicPrefix': 'true', 'core.autocrlf': 'true', 'commit.gpgsign': 'true' })) git('config', key, value)
    for (const hook of ['prepare-commit-msg', 'post-commit', 'reference-transaction']) {
      writeFileSync(join(repo, '.git', 'hooks', hook), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    }
    writeFileSync(join(repo, 'modified.txt'), 'tracked WIP\r\n')
    const prepared = await prepareWorktree(repo, 'configured', 'rohanz')
    expect(prepared.carried?.commit).toBe(prepared.base)
    expect(readFileSync(join(prepared.dir, 'modified.txt'), 'utf8')).toBe('tracked WIP\r\n')
  })

  it('does not make a carry commit for a clean lead and refuses unmanaged reuse', async () => {
    const { repo, git, head } = realRepo()
    const first = await prepareWorktree(repo, 'clean', 'rohanz')
    expect(first).toMatchObject({ base: head, created: true })
    expect(first.carried).toBeUndefined()
    writeFileSync(join(repo, 'later.txt'), 'later')
    await expect(prepareWorktree(repo, 'clean', 'rohanz')).rejects.toThrow(/unmanaged/)
    expect(existsSync(join(first.dir, 'later.txt'))).toBe(false)
    expect(git('rev-parse', 'room/clean')).toBe(head)
  })

  it('refuses another spawn into an existing worker worktree', async () => {
    const { repo } = realRepo()
    writeFileSync(join(repo, 'modified.txt'), 'lead WIP\n')
    writeFileSync(join(repo, 'untracked.txt'), 'untracked WIP\n')
    await prepareWorktree(repo, 'occupied', 'rohanz')
    await expect(prepareWorktree(repo, 'occupied', 'rohanz')).rejects.toThrow(/unmanaged/)
  })

  it('skips linked inputs, oversized files, nested repos and escaping symlinks with names', async () => {
    const { repo, git } = realRepo()
    mkdirSync(join(repo, 'data')); writeFileSync(join(repo, 'data', 'input.txt'), 'linked')
    writeFileSync(join(repo, 'large.bin'), Buffer.alloc(5 * 1024 * 1024 + 1))
    mkdirSync(join(repo, 'vendor', 'nested'), { recursive: true })
    execFileSync('git', ['init', '-q', join(repo, 'vendor', 'nested')])
    const externalDir = mkdtempSync(join(tmpdir(), 'room-outside-')); scratchRepos.push(externalDir)
    const outside = join(externalDir, 'outside.txt'); writeFileSync(outside, 'outside')
    symlinkSync(outside, join(repo, 'escape.txt'))
    symlinkSync(join(repo, 'modified.txt'), join(repo, 'absolute-internal.txt'))
    symlinkSync('missing.txt', join(repo, 'dangling.txt'))
    writeFileSync(join(repo, 'keep-new.txt'), 'small')
    const prepared = await prepareWorktree(repo, 'skips', 'rohanz', ['data'])
    expect(prepared.carried?.paths).toContain('keep-new.txt')
    expect(prepared.skippedCarry?.map(x => x.path)).toEqual(expect.arrayContaining(['data/input.txt', 'large.bin', 'vendor/nested/', 'escape.txt', 'absolute-internal.txt', 'dangling.txt']))
    for (const p of ['data', 'large.bin', 'vendor/nested', 'escape.txt', 'absolute-internal.txt', 'dangling.txt']) expect(existsSync(join(prepared.dir, p))).toBe(false)
    expect(git('status', '--porcelain')).toContain('keep-new.txt')
  })

  it('stops untracked copying at the 50 MB total budget', async () => {
    const { repo } = realRepo()
    for (let i = 0; i < 11; i++) writeFileSync(join(repo, `part-${String(i).padStart(2, '0')}.bin`), Buffer.alloc(5 * 1024 * 1024, i))
    const prepared = await prepareWorktree(repo, 'budget')
    expect(prepared.carriedUntracked).toHaveLength(10)
    expect(prepared.skippedCarry).toContainEqual({ path: 'part-10.bin', reason: 'size budget' })
    expect(existsSync(join(prepared.dir, 'part-10.bin'))).toBe(false)
  })

  it('cleans a failed prepared spawn without removing lead work and retries fresh', async () => {
    const { repo, git } = realRepo()
    writeFileSync(join(repo, 'modified.txt'), 'first WIP\n')
    const first = await prepareWorktree(repo, 'retry', 'rohanz')
    await cleanupPreparedWorktree(repo, first)
    expect(existsSync(first.dir)).toBe(false)
    expect(git('branch', '--list', first.branch)).toBe('')
    expect(() => git('rev-parse', '--verify', 'refs/room/carry/retry')).toThrow()
    writeFileSync(join(repo, 'modified.txt'), 'second WIP\n')
    const second = await prepareWorktree(repo, 'retry', 'rohanz')
    expect(readFileSync(join(second.dir, 'modified.txt'), 'utf8')).toBe('second WIP\n')
  })

  it('keeps an existing branch and its unmerged commit when launch fails after recreating its checkout', async () => {
    const { repo, git } = realRepo()
    writeFileSync(join(repo, 'modified.txt'), 'carried input\n')
    writeFileSync(join(repo, 'untracked-input.txt'), 'private input\n')
    const first = await prepareWorktree(repo, 'survivor', 'rohanz')
    writeFileSync(join(first.dir, 'worker.txt'), 'preserved worker work\n')
    git('-C', first.dir, 'add', 'worker.txt')
    git('-C', first.dir, 'commit', '-qm', 'preserve worker work')
    const workerHead = git('rev-parse', 'room/survivor')
    const carryHead = git('rev-parse', 'refs/room/carry/survivor')
    const untrackedTree = git('rev-parse', 'refs/room/carry-untracked/survivor')
    rmSync(first.dir, { recursive: true, force: true })

    const { a } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base: git('rev-parse', 'HEAD') })
    let session: Session | null = fakeSession(a, lead)
    session.dir = repo
    const tools = createTools({
      getSession: () => session, setSession: s => { session = s }, cwd: repo,
      worktree: (root, tag) => prepareWorktree(root, tag, 'rohanz'),
      spawner: () => { throw new Error('forced launch failure') },
    })
    try {
      expect(await tools.call('room_spawn', { tag: 'survivor', task: 'continue work' })).toContain('unmanaged')
      expect(git('rev-parse', '--verify', 'refs/heads/room/survivor')).toBe(workerHead)
      expect(git('show', 'room/survivor:worker.txt')).toBe('preserved worker work')
      expect(git('rev-parse', 'refs/room/carry/survivor')).toBe(carryHead)
      expect(git('rev-parse', 'refs/room/carry-untracked/survivor')).toBe(untrackedTree)
    } finally { await tools.shutdown() }
  })

  it('retries against a new HEAD when the lead commits during the snapshot', async () => {
    const { repo, git } = realRepo()
    writeFileSync(join(repo, 'modified.txt'), 'dirty\n')
    writeFileSync(join(repo, 'new.txt'), 'new\n')
    const copy = fs.promises.copyFile
    let advanced = false
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (src, dest, mode) => {
      if (!advanced && String(src).endsWith('new.txt')) {
        advanced = true
        writeFileSync(join(repo, 'staged.txt'), 'committed mid-snapshot\n')
        git('add', 'staged.txt'); git('commit', '-qm', 'advance')
      }
      return copy(src, dest, mode)
    })
    const prepared = await prepareWorktree(repo, 'moving', 'rohanz')
    expect(prepared.carryFailed).toBeUndefined()
    expect(readFileSync(join(prepared.dir, 'staged.txt'), 'utf8')).toBe('committed mid-snapshot\n')
    expect(readFileSync(join(prepared.dir, 'modified.txt'), 'utf8')).toBe('dirty\n')
    expect(git('rev-parse', `${prepared.base}^`)).toBe(git('rev-parse', 'HEAD'))
  })

  it('explains unborn HEAD and refuses a lead mid-merge', async () => {
    const unborn = mkdtempSync(join(tmpdir(), 'room-unborn-')); scratchRepos.push(unborn)
    execFileSync('git', ['init', '-q', '-b', 'main', unborn])
    await expect(prepareWorktree(unborn, 'empty')).rejects.toThrow('make a first commit')
    const { repo, git } = realRepo()
    writeFileSync(join(repo, '.git', 'MERGE_HEAD'), 'f'.repeat(40) + '\n')
    await expect(prepareWorktree(repo, 'merging')).rejects.toThrow('finish the merge or rebase')
    expect(existsSync(join(repo, '.room', 'workers', 'merging'))).toBe(false)
  })

  it('spawns from detached HEAD and carries tracked and untracked work', async () => {
    const { repo, git, head } = realRepo()
    git('checkout', '--detach', '-q')
    writeFileSync(join(repo, 'modified.txt'), 'detached tracked WIP\n')
    writeFileSync(join(repo, 'detached-new.txt'), 'detached untracked WIP\n')
    const leadStatus = git('status', '--porcelain')
    const prepared = await prepareWorktree(repo, 'detached', 'rohanz')
    expect(prepared).toMatchObject({ branch: 'room/detached', created: true })
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(() => git('symbolic-ref', '-q', 'HEAD')).toThrow()
    expect(git('rev-parse', `${prepared.base}^`)).toBe(head)
    expect(readFileSync(join(prepared.dir, 'modified.txt'), 'utf8')).toBe('detached tracked WIP\n')
    expect(readFileSync(join(prepared.dir, 'detached-new.txt'), 'utf8')).toBe('detached untracked WIP\n')
    expect(prepared.carriedUntracked?.map(f => f.path)).toContain('detached-new.txt')
    expect(git('status', '--porcelain')).toBe(leadStatus)
  })

  it('commits carry without git identity and despite a failing pre-commit hook', async () => {
    const { repo, git } = realRepo()
    git('config', '--unset', 'user.email'); git('config', '--unset', 'user.name')
    const home = mkdtempSync(join(tmpdir(), 'room-empty-home-')); scratchRepos.push(home)
    vi.stubEnv('HOME', home); vi.stubEnv('GIT_CONFIG_GLOBAL', join(home, 'empty')); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(repo, 'modified.txt'), 'carried\n')
    const prepared = await prepareWorktree(repo, 'hooked', 'rohanz')
    expect(prepared.carried?.commit).toBe(prepared.base)
    expect(execFileSync('git', ['-C', prepared.dir, 'log', '-1', '--format=%an <%ae>']).toString().trim()).toBe('Room <room@localhost>')
  })

  it('rolls back a partial carry and leaves a clean HEAD worktree when copying fails', async () => {
    const { repo, git, head } = realRepo()
    writeFileSync(join(repo, 'modified.txt'), 'after\n')
    writeFileSync(join(repo, 'new.txt'), 'new\n')
    const copy = fs.promises.copyFile
    vi.spyOn(fs.promises, 'copyFile').mockImplementation((src, dest, mode) => {
      if (String(src).endsWith('new.txt')) throw new Error('forced copy failure')
      return copy(src, dest, mode)
    })
    const prepared = await prepareWorktree(repo, 'fallback', 'rohanz')
    expect(prepared).toMatchObject({ base: head, carryFailed: true })
    expect(prepared.carried).toBeUndefined()
    expect(readFileSync(join(prepared.dir, 'modified.txt'), 'utf8')).toBe('before\n')
    expect(existsSync(join(prepared.dir, 'new.txt'))).toBe(false)
    expect(execFileSync('git', ['-C', prepared.dir, 'status', '--porcelain']).toString()).toBe('')
    expect(git('rev-parse', 'room/fallback')).toBe(head)
  })
})

describe('room_spawn / room_done / room_collect discard', () => {
  function setup(worktree?: typeof prepareWorktree, maxWorkers = 2) {
    const { a, b } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead)
    const specs: SpawnSpec[] = []
    const exits: ((code: number | null) => void)[] = []
    const killed: number[] = []
    const live = new Set<number>()
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, maxWorkers, probe: pid => live.has(pid) ? { startTime: 'test:worker', executable: 'node' } : undefined,
      spawner: spec => { specs.push(spec); const pid = 4242 + specs.length; live.add(pid)
        const callbacks: ((code: number | null) => void)[] = []
        exits.push(code => { live.delete(pid); for (const callback of callbacks) callback(code) })
        return { pid, started: Promise.resolve(), onExit: cb => { callbacks.push(cb) }, kill: () => { killed.push(1); return true } } },
      worktree: worktree ?? ((repo, tag) => prepareWorktree(repo, tag, 'rohanz')),
    })
    let ws: Session | null = fakeSession(b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    return { a, b, leadTools, workerTools, workerSession: ws!, specs, exits, killed }
  }

  it('inherits the caller host and explains worker reporting only once', async () => {
    vi.stubEnv('ROOM_HOST', 'codex')
    try {
      const t = setup()
      const first = await t.leadTools.call('room_spawn', { tag: 'first', task: 'x' })
      const second = await t.leadTools.call('room_spawn', { tag: 'second', task: 'y' })
      expect(workerByTag(dir, 'first')?.host).toBe('codex')
      expect(first).toContain('reports through room_done'); expect(second).not.toContain('reports through room_done')
      expect(first).not.toContain('tip:')
      expect(first).toContain('browser view: http://x')
      expect(second).not.toContain('browser view:')
      expect(t.specs[0].args.join(' ')).toContain('one-line summary')
      await t.leadTools.shutdown()
    } finally { vi.unstubAllEnvs() }
  })

  it('assigns distinct dev-server ports to running workers and includes each in its brief', async () => {
    const t = setup()
    try {
      const first = await t.leadTools.call('room_spawn', { tag: 'first', task: 'serve the app' })
      const second = await t.leadTools.call('room_spawn', { tag: 'second', task: 'test the app' })
      const firstPort = workerByTag(dir, 'first')?.port
      const secondPort = workerByTag(dir, 'second')?.port
      expect(firstPort).toBe(4400)
      expect(secondPort).toBe(4401)
      expect(t.specs.map(spec => spec.env.PORT)).toEqual(['4400', '4401'])
      expect(t.specs[0].args.join(' ')).toContain('Your dev-server port is 4400')
      expect(t.specs[1].args.join(' ')).toContain('Your dev-server port is 4401')
      expect(first).toContain('port 4400')
      expect(second).toContain('port 4401')
    } finally { await t.leadTools.shutdown() }
  })

  it('keeps ports distinct across independent lead registries', async () => {
    const first = setup(), second = setup()
    try {
      await Promise.all([
        first.leadTools.call('room_spawn', { tag: 'one', task: 'serve' }),
        second.leadTools.call('room_spawn', { tag: 'two', task: 'serve' }),
      ])
      expect(first.specs[0].env.PORT).not.toBe(second.specs[0].env.PORT)
    } finally {
      await first.leadTools.shutdown()
      await second.leadTools.shutdown()
    }
  })

  it('does not assign a nested worker its parent dev-server port', async () => {
    const configHome = process.env.XDG_CONFIG_HOME!
    const parent = reserveWorkerPort('lead/parent', [], configHome)
    const { a } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    let session: Session | null = fakeSession(a, workerId)
    await registerWorkers(session, [{ id: 'lead/parent', tag: 'money', name: workerId.name, lead: lead.name, host: 'codex', task: 'parent task', dir: join(dir, '.room', 'workers', 'money'), branch: 'room/money', pid: process.pid, port: parent.port, startedAt: Date.now(), status: 'running' }])
    const specs: SpawnSpec[] = []
    const tools = createTools({
      getSession: () => session, setSession: s => { session = s }, cwd: dir, probe: () => undefined,
      spawner: spec => { specs.push(spec); return { pid: 4243, started: Promise.resolve(), onExit: () => {}, kill: () => true } },
      worktree: (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    try {
      expect(parent.port).toBe(4400)
      expect(await tools.call('room_spawn', { tag: 'child', task: 'serve' })).toContain('spawned child')
      expect(specs[0].env.PORT).toBe('4401')
    } finally { await tools.shutdown(); parent.release() }
  })

  it('does not treat the caller\'s PORT as a Room reservation', async () => {
    vi.stubEnv('PORT', '4400')
    const t = setup()
    try {
      await t.leadTools.call('room_spawn', { tag: 'first', task: 'serve' })
      expect(t.specs[0].env.PORT).toBe('4400')
    } finally { await t.leadTools.shutdown() }
  })

  it('releases the reserved port on exit, collect, discard and stop', async () => {
    const file = (port: string) => join(process.env.XDG_CONFIG_HOME!, 'room', 'ports', port)
    const exited = setup()
    await exited.leadTools.call('room_spawn', { tag: 'exited', task: 'x' })
    expect(existsSync(file(exited.specs[0].env.PORT))).toBe(true)
    exited.exits[0](0)
    expect(existsSync(file(exited.specs[0].env.PORT))).toBe(false)
    await exited.leadTools.shutdown()

    const collected = setup()
    await collected.leadTools.call('room_spawn', { tag: 'collected', task: 'x' })
    await reportDone('collected', 'done')
    collected.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'collected')?.exitCode).toBe(0))
    await collected.leadTools.call('room_collect', { tag: 'collected' })
    expect(existsSync(file(collected.specs[0].env.PORT))).toBe(false)
    await collected.leadTools.shutdown()

    const discarded = setup()
    await discarded.leadTools.call('room_spawn', { tag: 'discarded', task: 'x' })
    const discarding = discarded.leadTools.call('room_collect', { tag: 'discarded', discard: true })
    setTimeout(() => discarded.exits[0](null), 10)
    expect(await discarding).toContain('discarded discarded')
    expect(existsSync(file(discarded.specs[0].env.PORT))).toBe(false)
    await discarded.leadTools.shutdown()

    const stopped = setup()
    await stopped.leadTools.call('room_spawn', { tag: 'stopped', task: 'x' })
    expect(await stopped.leadTools.call('room_leave', { force: true })).toContain('left local/x/main')
    expect(existsSync(file(stopped.specs[0].env.PORT))).toBe(true)
    stopped.exits[0](null)
    expect(existsSync(file(stopped.specs[0].env.PORT))).toBe(false)
  })

  it('room_leave and shutdown stop only workers that are still running', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'finished', task: 'x' })
    await t.leadTools.call('room_spawn', { tag: 'busy', task: 'y' })
    await reportDone('finished', 'done')
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'finished')?.exitCode).toBe(0))
    expect(await t.leadTools.call('room_leave', {})).toMatch(/(^|\n)error: 1 worker\(s\) still running: busy\. /)
    expect(t.killed).toEqual([])
    await t.leadTools.shutdown()
    expect(t.killed).toEqual([1])
    // §9: the stop is recorded before the signal; §6 row 8 shows it running ("stopping") until the exit.
    expect(workerByTag(dir, 'busy')).toMatchObject({ status: 'running', stopReason: 'lead-session-ended' })
    const registry = await registryForDir(dir)
    const busy = registry.list().find(record => record.tag === 'busy')!
    t.exits[1](null)
    await vi.waitFor(() => expect(registry.status(busy.id)?.status).toBe('stopped'))
    expect(workerByTag(dir, 'finished')).toMatchObject({ status: 'done' })
    expect(workerByTag(dir, 'finished')?.stopReason).toBeUndefined()
  })

  it('releases a reserved port when spawning fails', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    let session: Session | null = fakeSession(a, lead)
    const tools = createTools({
      getSession: () => session, setSession: s => { session = s }, cwd: dir,
      spawner: () => { throw new Error('spawn failed') },
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: false }),
    })
    expect(await tools.call('room_spawn', { tag: 'failed', task: 'x' })).toContain('spawn failed')
    expect(existsSync(join(process.env.XDG_CONFIG_HOME!, 'room', 'ports', '4400'))).toBe(false)
    await tools.shutdown()
  })

  it.each(['plugin:custom@market', ''])('passes ROOM_CLAUDE_CHANNEL only with ROOM_WAKE=channels (%s)', async channel => {
    vi.stubEnv('ROOM_CLAUDE_CHANNEL', channel)
    vi.stubEnv('ROOM_WAKE', 'channels')
    vi.stubEnv('ROOM_WORKER_NICE', '0')
    try {
      const t = setup()
      expect(await t.leadTools.call('room_spawn', { tag: 'channel', task: 'check channels' })).toContain('spawned channel')
      const args = t.specs[0].args
      expect(args[0]).toBe(channel ? '--dangerously-load-development-channels' : '-p')
      if (channel) expect(args[1]).toBe(channel)
      else expect(args).not.toContain('--dangerously-load-development-channels')
      await t.leadTools.shutdown()
    } finally { vi.unstubAllEnvs() }
  })

  it('names each worker\'s carried files in its spawn reply', async () => {
    const t = setup(prepareWorktree)
    writeFileSync(join(dir, 'wip.txt'), 'work in progress\n')
    try {
      const first = await t.leadTools.call('room_spawn', { tag: 'wip1', task: 'a' })
      expect(first).toContain('carried your uncommitted work into its worktree: 1 untracked file copied')
      expect(first).not.toContain('starts from HEAD')
      expect(workerByTag(dir, 'wip1')?.base).toBe(execFileSync('git', ['-C', join(dir, '.room', 'workers', 'wip1'), 'rev-parse', 'HEAD']).toString().trim())
      expect(await t.leadTools.call('room_spawn', { tag: 'wip2', task: 'b' })).toContain('carried your uncommitted work into its worktree: 1 untracked file copied')
      expect(workerByTag(dir, 'wip2')?.base).toBe(base)
      expect(workerByTag(dir, 'wip2')?.carriedUntracked?.map(x => x.path)).toEqual(['wip.txt'])
    } finally { rmSync(join(dir, 'wip.txt'), { force: true }) }
    expect(await setup().leadTools.call('room_spawn', { tag: 'wip3', task: 'c' })).not.toMatch(/uncommitted change/)
  })

  it('keeps the 0.10.2 missing-work note on every carry fallback', async () => {
    const t = setup(async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true,
      ...(tag === 'carried' ? { base: 'f'.repeat(40), carried: { count: 1, commit: 'f'.repeat(40) } } : { base, carryFailed: true }) }), 3)
    writeFileSync(join(dir, 'wip.txt'), 'work in progress\n')
    try {
      expect(await t.leadTools.call('room_spawn', { tag: 'carried', task: 'first' })).toContain('carried your uncommitted work into its worktree: 1 tracked change')
      const first = await t.leadTools.call('room_spawn', { tag: 'fallback1', task: 'a' })
      expect(first).toContain('1 uncommitted change in your clone is not in this worktree, which starts from HEAD')
      expect(first).not.toContain('carried your')
      expect(await t.leadTools.call('room_spawn', { tag: 'fallback2', task: 'b' })).toContain('1 uncommitted change in your clone is not in this worktree')
    } finally { rmSync(join(dir, 'wip.txt'), { force: true }) }
  })

  it('refuses an unmanaged surviving branch without altering its worker commits or lead WIP', async () => {
    const initial = await prepareWorktree(dir, 'reusedbranch', 'rohanz')
    writeFileSync(join(initial.dir, 'branch.txt'), 'old worker work')
    execFileSync('git', ['-C', initial.dir, 'add', 'branch.txt'])
    execFileSync('git', ['-C', initial.dir, 'commit', '-qm', 'old worker change'])
    const oldHead = execFileSync('git', ['-C', initial.dir, 'rev-parse', 'HEAD']).toString().trim()
    rmSync(initial.dir, { recursive: true, force: true })
    writeFileSync(join(dir, 'wip.txt'), 'lead WIP')
    try {
      const t = setup(prepareWorktree)
      const out = await t.leadTools.call('room_spawn', { tag: 'reusedbranch', task: 'resume' })
      expect(out).toContain('branch room/reusedbranch is unmanaged')
      expect(workerByTag(dir, 'reusedbranch')).toBeUndefined()
      expect(execFileSync('git', ['-C', dir, 'rev-parse', 'room/reusedbranch']).toString().trim()).toBe(oldHead)
      expect(execFileSync('git', ['-C', dir, 'show', 'room/reusedbranch:branch.txt']).toString().trim()).toBe('old worker work')
      expect(readFileSync(join(dir, 'wip.txt'), 'utf8')).toBe('lead WIP')
    } finally { rmSync(join(dir, 'wip.txt'), { force: true }) }
  })

  it('spawns a worker with the room passed through the environment, records it, and shows it in room_state', async () => {
    const t = setup()
    const out = await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents', host: 'codex', model: 'gpt-5.6', effort: 'medium' })
    expect(out).toContain('spawned money: rohanz+money (codex gpt-5.6, pid 4243)')
    const priority = workerPriority(workerCommand('codex', 'gpt-5.6', 'unused'))
    expect(t.specs[0].cmd).toBe(priority.cmd)
    if (priority.nice) expect(t.specs[0].args.slice(0, 3)).toEqual(['-n', '10', 'codex'])
    expect(out).toContain(` · priority ${priority.nice ? 'nice 10' : 'normal'}`)
    expect(t.specs[0].env).toMatchObject({ ROOM_WORKER_HOST: 'codex', ROOM_WORKER_MODEL: 'gpt-5.6', ROOM_WORKER_EFFORT: 'medium', ROOM_TAG: 'money', ROOM_SERVER: 'local', ROOM_ROOM: 'local/x/main', ROOM_LEAD: 'rohanz' })
    expect(t.specs[0].cwd).toBe(join(dir, '.room', 'workers', 'money'))
    const w = workerByTag(dir, 'money')
    expect(w).toMatchObject({ name: 'rohanz+money', status: 'running', lead: 'rohanz', branch: 'room/money', base, host: 'codex', model: 'gpt-5.6', effort: 'medium' })
    const st = await t.leadTools.call('room_state', { all: true })
    expect(st).toContain('workers (1):')
    expect(st).toContain('money (codex gpt-5.6 · medium, running')
    expect(st).toContain('agent of rohanz · money · codex · gpt-5.6 · medium')
    expect(await t.leadTools.call('room_state', {})).toContain('codex · gpt-5.6 · medium')
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'again' })).toContain('tag in use: money')
    expect(await t.leadTools.call('room_spawn', { tag: 'bad tag', task: 'x' })).toContain('error: tag')
  })

  it('room_spawn where=local from a team room opens a local workers room, bridges it, and tears it down on leave', async () => {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(team.a, lead, false)
    ls!.roomName = 'github.com/rohanz/x/main'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx%2Fmain'
    const specs: SpawnSpec[] = []
    const joins: { server?: string; name?: string }[] = []
    const left: string[] = []
    let onExit: ((code: number | null) => void) | undefined
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0, probe: () => undefined,
      join: async o => { joins.push({ server: o.server, name: o.name }); return fakeSession(local.a, lead) },
      leave: async s => { left.push(s.roomName) },
      spawner: spec => { specs.push(spec); return { pid: 99, started: Promise.resolve(), onExit: cb => { onExit = cb }, kill: () => { onExit?.(null); return true } } },
      worktree: (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    const out = await leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents', where: 'local' })
    expect(joins).toEqual([{ server: 'local', name: 'rohanz' }])
    expect(out).toContain('local workers room local/x/main')
    expect(specs[0].env).toMatchObject({ ROOM_SERVER: 'local', ROOM_ROOM: 'local/x/main', ROOM_LEAD: 'rohanz' })
    expect(workerByTag(dir, 'money')).toMatchObject({ status: 'running', lead: 'rohanz' })
    expect(local.a.workerViewOf('rohanz+money')).toMatchObject({ status: 'running', lead: 'rohanz' })
    // The lead's bridge projects its local worker's view into the team room (registry §13).
    expect(team.a.workerViewOf('rohanz+money')).toMatchObject({ mode: 'local', status: 'running', lead: 'rohanz' })
    // the worker declares a scope and claims in the local room; the team room sees both as the lead's
    local.b.setScope({ by: workerId.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/models.py'] })
    local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: workerId.name, byKind: 'agent', intent: 'bump' })
    // The bridge publishes the workers' paths as the lead's coordination record, never as the lead's scope (manifest §5.6).
    await vi.waitFor(() => expect(team.b.coordination.get('rohanz')?.paths).toEqual(['api/models.py']))
    expect(team.b.openClaims().map(c => c.intent)).toEqual(['[money] bump'])
    expect(team.b.scopes.has(workerId.name)).toBe(false)
    const st = await leadTools.call('room_state', { all: true })
    expect(st).toContain('workers room: local (local/x/main')
    expect(st).toContain('money (claude, running')
    // a worker's done message reaches the lead through the workers room inbox
    let ws: Session | null = fakeSession(local.b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    await workerTools.call('room_done', { summary: 'cents done' })
    const current = await leadTools.call('room_state', {})
    expect(current).toContain('workers (1):')
    // §6 row 8: a done report with the process still alive reads as running until it exits.
    expect(current).toContain('money (claude, running')
    expect(current).toContain('finished: cents done')
    // A reported worker with a live launch handle still blocks an unforced leave.
    expect(await leadTools.call('room_leave', {})).toContain('worker(s) still running: money')
    expect(await leadTools.call('room_leave', { force: true })).toContain('left github.com/rohanz/x/main')
    expect(left).toEqual(['local/x/main', 'github.com/rohanz/x/main'])
    expect(team.b.openClaims()).toEqual([])
  })

  it("the lead's room_wait also returns on a question addressed to it", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const waiting = t.leadTools.call('room_wait', { timeoutMs: 3000 })
    await new Promise(r => setTimeout(r, 50))
    await t.workerTools.call('room_send', { type: 'question', text: 'which field carries the price?', to: 'rohanz' })
    const out = await waiting
    expect(out).toContain('question for you')
    expect(out).toContain('which field carries the price?')
  })

  it("a worker that exits without room_done ends the lead's wait with one interrupt", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const waiting = t.leadTools.call('room_wait', { timeoutMs: 3000 })
    await new Promise(r => setTimeout(r, 50))
    t.exits[0](0)
    const out = await waiting
    expect(out).toContain('[interrupt]')
    expect(out).toContain('exited without room_done')
    expect(workerByTag(dir, 'money')).toMatchObject({ status: 'failed', exitCode: 0 })
  })

  it('refuses beyond the worker budget', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    await t.leadTools.call('room_spawn', { tag: 'b', task: 'y' })
    expect(await t.leadTools.call('room_spawn', { tag: 'c', task: 'z' })).toContain('worker capacity reached')
  })

  it("the lead's room_wait returns as soon as a worker's done message arrives", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const waiting = t.leadTools.call('room_wait', { timeoutMs: 3000 })
    await new Promise(r => setTimeout(r, 50))
    await t.workerTools.call('room_done', { summary: 'done in cents' })
    const out = await waiting
    expect(out).toContain('worker done:')
    expect(out).toContain('done in cents')
  })

  it('refuses a stale worker ID without posting a completion', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const s = fakeSession(t.b, workerId)
    t.b.setScope({ by: workerId.name, byKind: 'agent', area: 'api', summary: 'still working', paths: ['app.py'] })
    const claim = t.b.addClaim({ path: 'app.py', from: 1, to: 1, by: workerId.name, byKind: 'agent', intent: 'edit' })
    const config = { ...await resolveConfig({ dir, env: {} }), workerId: 'old-spawn' }
    const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, config })
    expect(await tools.call('room_done', { summary: 'old task finished' })).toContain('invalid worker id')
    expect(workerByTag(dir, 'money')?.status).toBe('running')
    expect(t.a.messages().some(m => m.type === 'done')).toBe(false)
    expect(t.b.openClaims().some(c => c.id === claim.id)).toBe(true)
    expect(t.b.scope(workerId.name)).toBeDefined()
  })

  it('refuses a superseded run without releasing its current claims', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const id = workerByTag(dir, 'money')!.id
    const s = fakeSession(t.b, workerId)
    const claim = t.b.addClaim({ path: 'app.py', from: 1, to: 1, by: workerId.name, byKind: 'agent', intent: 'edit' })
    const config = { ...await resolveConfig({ dir, env: {} }), workerId: id }
    const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, config })
    vi.stubEnv('ROOM_WORKER_RUN', '2')
    try {
      expect(await tools.call('room_done', { summary: 'old run' })).toContain('superseded')
      expect(t.b.openClaims().some(c => c.id === claim.id)).toBe(true)
      expect(t.a.messages().some(m => m.type === 'done')).toBe(false)
    } finally { vi.unstubAllEnvs() }
  })

  it("a worker's room_done reaches its lead as an addressed done message that wakes it, and marks the worker done", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    publishFixture(t.b, 'rohanz+money', 'app.py', 'x = 100\n')
    const out = await t.workerTools.call('room_done', { summary: 'Money type in cents, 7 tests pass' })
    expect(out).toContain('Your lead rohanz has been told (worker money)')
    const done = t.a.messages().find(m => m.type === 'done') as Msg & { type: 'done' }
    expect(done).toBeTruthy()
    expect(done.to).toBe('rohanz'); expect(done.tag).toBe('money'); expect(done.changed).toEqual(['app.py'])
    expect(shouldWakeOnMsg(lead, done).wake).toBe(true)
    expect(shouldWakeOnMsg({ name: 'someone', kind: 'agent' }, done).wake).toBe(false)
    // §6 row 8: the process is still alive, so the worker reads as running with its report's summary.
    expect(workerByTag(dir, 'money')).toMatchObject({ status: 'running', summary: 'Money type in cents, 7 tests pass' })
    // The lead's next tool call shows the done line in its inbox.
    const st = await t.leadTools.call('room_state', {})
    expect(st).toContain('finished: Money type in cents')
    // A later process exit keeps the done status and records the code.
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')).toMatchObject({ status: 'done', exitCode: 0 }))
  })

  it('saves a refused room_done report and posts its completion from the exit callback (F-S3)', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'finish' })
    vi.spyOn(t.workerSession, 'post').mockImplementation(async () => ({ ok: false, text: 'not sent: hub unreachable' }))
    const reply = await t.workerTools.call('room_done', { summary: 'finished' })
    expect(reply).toContain('worker report saved; your lead has not been told yet')
    expect(reply).toContain('Call room_done again')
    const registry = await registryForDir(dir)
    const record = registry.reserved('money')!
    expect(registry.reports(record.id)[0]?.done?.summary).toBe('finished')
    expect(registry.reports(record.id)[0]?.posted).toBeUndefined()
    t.exits[0](0)
    await vi.waitFor(() => expect(registry.read(record.id)?.runs[0].posted).toBe(`wk:${record.id}:1`))
    expect(t.a.messages().filter(message => message.type === 'done' && message.id === `wk:${record.id}:1`)).toHaveLength(1)
  })

  it('does not promise a wake-up when a non-worker finishes', async () => {
    const t = setup()
    const out = await t.leadTools.call('room_done', { summary: 'finished' })
    expect(out).toContain('You remain in the room.')
    expect(out).not.toContain('will be woken')
  })

  it('credits only an actual passing preview test command, never a text-only preview or an inferred cause', async () => {
    const t = setup()
    const leadSession = fakeSession(t.a, lead)
    let current: Session | null = leadSession
    const tools = createTools({ getSession: () => current, setSession: s => { current = s }, cwd: dir })
    leadSession.lastPreview = { clean: true, complete: true }
    const textOnly = await tools.call('room_done', { summary: 'local tests failed' })
    expect(textOnly).not.toContain('combined preview passed')
    leadSession.lastPreview = { clean: true, complete: true, testsPassed: true, testsCommand: 'npm test' }
    const tested = await tools.call('room_done', { summary: 'local tests failed' })
    expect(tested).toContain('The combined preview passed `npm test`.')
    expect(tested).not.toContain('caused by')
  })

  it('a worker that exits without room_done is marked failed regardless of exit code; dismiss kills a running one', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    await t.leadTools.call('room_spawn', { tag: 'b', task: 'y' })
    t.exits[0](1)
    await vi.waitFor(() => expect(workerByTag(dir, 'a')).toMatchObject({ status: 'failed', exitCode: 1 }))
    await vi.waitFor(() => expect(t.a.messages().some(m => m.type === 'note' && m.to === 'rohanz' && /worker a failed: exit 1/.test(m.text))).toBe(true))
    const discarding = t.leadTools.call('room_collect', { discard: true, tag: 'b' })
    await vi.waitFor(() => expect(t.killed).toHaveLength(1), { timeout: 10_000 })
    t.exits[1](0)
    const d = await discarding
    expect(d).toContain('discarded b')
    expect(t.killed).toHaveLength(1)
    expect(workerByTag(dir, 'b')).toBeUndefined()
    await vi.waitFor(() => expect(t.a.retiredWorkers().some(w => w.tag === 'b')).toBe(true))
  })
})

describe('pinned rooms', () => {
  it('a local or explicitly named room does not follow the clone branch; a derived one does', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    const pinned = { ...fakeSession(a, lead), roomName: 'local/x/other', pinnedRoom: true } as Session
    let s1: Session | null = pinned
    const t1 = createTools({ getSession: () => s1, setSession: x => { s1 = x }, cwd: dir })
    expect(await t1.call('room_state', { all: true })).not.toContain('switched to branch')
    const derived = { ...fakeSession(a, lead, false), roomName: 'github.com/o/x/other' } as Session
    const oldWarning = hubAppend(a, { name: 'room', kind: 'bot' }, { type: 'note', to: lead.name, priority: 'notify', text: 'you switched to main; the room is for other; commits here are not the room base' })
    const destination = pair().a
    destination.setMeta({ repo: 'x', branch: 'main', base })
    let s2: Session | null = derived
    const t2 = createTools({ getSession: () => s2, setSession: x => { s2 = x }, cwd: dir, join: async o => ({ ...fakeSession(destination, lead, false), roomName: o.room ?? '?' }), leave: async () => {} })
    const switched = await t2.call('room_state', { all: true })
    expect(switched.match(/your clone switched to branch main/g)).toHaveLength(1)
    // Read-time relevance hides the old branch note once the clone leaves that branch; no receipt is written.
    expect(a.seen(lead.name).has(oldWarning.id)).toBe(false)
    expect(destination.messages().filter(m => m.type === 'note' && m.to === lead.name && m.text?.includes('switched to branch main'))).toHaveLength(0)
    await t2.call('room_state', { all: true })
    expect(destination.messages().filter(m => m.type === 'note' && m.to === lead.name && m.text?.includes('switched to branch main'))).toHaveLength(0)
  })
})

function setupLead() {
  const { a, b } = pair()
  a.setMeta({ repo: 'x', branch: 'main', base })
  let ls: Session | null = fakeSession(a, lead)
  const specs: SpawnSpec[] = []
  const exits: ((code: number | null) => void)[] = []
  const killed: number[] = []
  const live = new Set<number>()
  const leadTools = createTools({
    getSession: () => ls, setSession: s => { ls = s }, cwd: dir, maxWorkers: 2, probe: pid => live.has(pid) ? { startTime: 'test:worker', executable: 'node' } : undefined,
    spawner: spec => { specs.push(spec); const pid = 4242 + specs.length; live.add(pid)
      const callbacks: ((code: number | null) => void)[] = []
      exits.push(code => { live.delete(pid); for (const callback of callbacks) callback(code) })
      return { pid, started: Promise.resolve(), onExit: cb => { callbacks.push(cb) }, kill: () => { killed.push(1); return true } } },
    worktree: (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
  })
  return { a, b, session: ls, leadTools, specs, exits, killed }
}

async function ownedLegacyWorker(room: RoomDoc, tag: string, status: 'running' | 'done' | 'failed' | 'dismissed', pid: number): Promise<void> {
  const prepared = await prepareWorktree(dir, tag, 'rohanz')
  // A finished worker's recorded identity no longer matches the live pid, so §6 rows 10, 11 and 14 apply.
  await registerWorkers(fakeSession(room, lead), [{ tag, name: `rohanz+${tag}`, host: 'claude', task: 'x', dir: prepared.dir,
    branch: prepared.branch, base: prepared.base, pid, processStartTime: status === 'running' ? probeProcess(pid)?.startTime : undefined,
    startedAt: Date.now(), status, lead: 'rohanz' }])
}

describe('worker safety', () => {
  it('uses exact OS start identity, host executable, and liveness after a lead restart', () => {
    const rec = { host: 'claude' as const, processStartTime: 'linux:boot-a:12345', hostSessionId: 'session-1' }
    const info = { startTime: rec.processStartTime, executable: '/usr/local/bin/claude' }
    expect(workerProcessOwnership(process.pid, rec, () => info)).toBe('ours')
    expect(workerProcessOwnership(process.pid, rec, () => ({ ...info, startTime: 'linux:boot-a:12346' }))).toBe('not-ours')
    expect(workerProcessOwnership(process.pid, rec, () => ({ ...info, startTime: 'linux:boot-b:12345' }))).toBe('not-ours')
    expect(workerProcessOwnership(process.pid, rec, () => ({ ...info, executable: '/usr/bin/vim' }))).toBe('not-ours')
    expect(workerProcessOwnership(process.pid, { ...rec, processStartTime: undefined }, () => info)).toBe('unknown')
    expect(workerProcessOwnership(process.pid, rec, () => ({}))).toBe('unknown')
    expect(workerProcessOwnership(process.pid, rec, () => undefined)).toBe('not-ours')
    expect(workerProcessOwnership(-1, rec, () => info)).toBe('not-ours')
  })

  it('ignores prompt and session text even when they contain the worker session id', () => {
    const rec = { host: 'codex' as const, processStartTime: 'linux:boot-a:12345', hostSessionId: 'session-1' }
    expect(workerProcessOwnership(process.pid, rec, () => ({ startTime: rec.processStartTime, executable: 'codex',
      command: 'codex exec --json "please mention session-1"', args: ['codex', 'exec', '--json', 'session-1'] }))).toBe('ours')
    expect(workerProcessOwnership(process.pid, rec, () => ({ startTime: 'linux:boot-a:12346', executable: 'codex',
      command: 'codex exec resume session-1' }))).toBe('not-ours')
    expect(workerProcessOwnership(process.pid, rec, () => ({ startTime: rec.processStartTime, executable: 'node' }))).toBe('ours')
  })

  it('reads Linux stat field 22 with an injected boot id and executable reader', () => {
    const stat = `42 (worker with ) in name) S ${Array(18).fill('0').join(' ')} 987654 0`
    expect(probeProcess(42, { platform: 'linux', readFile: file => file.endsWith('/stat') ? stat : 'boot-123\n',
      readLink: () => '/usr/local/bin/codex', exec: () => { throw new Error('unexpected') } }))
      .toEqual({ startTime: 'linux:boot-123:987654', executable: 'codex' })
  })

  it('reads macOS lstart to the second with an injected boot-time guard', () => {
    const line = 'Mon Sep 21 12:34:56 2026'
    expect(parsePsLstartUtc(line)).toBe(Date.UTC(2026, 8, 21, 12, 34, 56) / 1000)
    expect(probeProcess(42, { platform: 'darwin', readFile: () => { throw new Error('unexpected') }, readLink: () => '',
      exec: (file, args) => file === 'sysctl' ? '{ sec = 1234567, usec = 0 }' : args[1] === 'lstart=' ? line : '/opt/homebrew/bin/node' }))
      .toEqual({ startTime: `darwin:1234567:${Date.UTC(2026, 8, 21, 12, 34, 56) / 1000}`, executable: 'node' })
  })

  it('keeps the worker record and disk stop reason untouched if shutdown dismissal errors', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'erroring', task: 'x' })
    const before = { ...workerByTag(dir, 'erroring')! }
    const post = t.session.post
    vi.spyOn(t.session, 'post').mockImplementation(((...args: Parameters<typeof post>) => {
      if ((args[1] as { type?: string }).type === 'note') throw new Error('note failed')
      return post(...args)
    }) as typeof post)
    await t.leadTools.shutdown()
    expect(t.killed).toEqual([1])
    // §9: the durable stop is mirrored even though the note failed; §6 row 8 keeps it running.
    expect(workerByTag(dir, 'erroring')).toEqual({ ...before, stopReason: 'lead-session-ended' })
    expect((await registryForDir(dir)).read(before.id!)?.stop?.reason).toBe('lead-session-ended')
  })

  it('dismissing a worker whose process is unknown and old leaves the pid alone and keeps its status', async () => {
    const { a, b } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    // a worker record left by a lead that has since restarted: pid 1 is alive but not ours
    await registerWorkers(fakeSession(a, lead), [{ tag: 'ghost', name: 'rohanz+ghost', host: 'claude', task: 'x', dir, branch: 'room/ghost', pid: 1, startedAt: Date.now(), status: 'running', lead: 'rohanz' }])
    let ls: Session | null = fakeSession(b, lead)
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir })
    const out = await tools.call('room_collect', { discard: true, tag: 'ghost' })
    expect(out).toContain('no local worker capability')
    expect(workerByTag(dir, 'ghost')?.status).toBe('running') // nothing was signalled, so nothing changed
  })

  it('shutdown reports an unreadable live pid and preserves the running record', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    await ownedLegacyWorker(a, 'unknown', 'running', process.pid)
    let session: Session | null = fakeSession(a, lead)
    const tools = createTools({ getSession: () => session, setSession: s => { session = s }, cwd: dir, probe: () => ({}), leave: async () => {} })
    await tools.shutdown()
    expect(workerByTag(dir, 'unknown')?.status).toBe('running')
    expect((await registryForDir(dir)).list().find(record => record.tag === 'unknown')?.stop?.reason).toBe('lead-session-ended')
    expect(a.messages().some(m => m.type === 'note' && m.to === 'rohanz' && m.text === `could not verify unknown's process (pid ${process.pid}); left running, not stopped`)).toBe(true)
  })

  it.each(['done', 'failed', 'dismissed'] as const)('shutdown leaves a terminal %s worker without verified live identity alone', async status => {
    const { a } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    await ownedLegacyWorker(a, 'finished', status, process.pid)
    let session: Session | null = fakeSession(a, lead)
    const tools = createTools({ getSession: () => session, setSession: s => { session = s }, cwd: dir, probe: () => ({}), leave: async () => {} })
    await tools.shutdown()
    expect(a.messages().some(m => m.type === 'note' && m.text.includes('dismissed worker finished'))).toBe(false)
    expect(workerByTag(dir, 'finished')?.status).toBe(status)
  })

  it('leave does not signal a finished worker without verified live identity', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    await ownedLegacyWorker(a, 'finished', 'done', process.pid)
    let session: Session | null = fakeSession(a, lead)
    const tools = createTools({ getSession: () => session, setSession: s => { session = s }, cwd: dir, probe: () => ({}), leave: async () => {} })
    expect(await tools.call('room_leave', {})).toContain('left local/x/main')
    expect(workerByTag(dir, 'finished')?.status).toBe('done')
  })

  it('a registry transition with no mirror at its call site (reconcile, another writer) still reaches the Worker doc', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    const id = workerByTag(dir, 'a')!.id
    expect(workerByTag(dir, 'a')?.status).toBe('running')
    const registry = await registryForDir(dir)
    await registry.writeExit(id, { run: 1, code: 3, witnessed: true, at: Date.now() })
    // §6 row 14: a witnessed nonzero exit is `failed`.
    expect(registry.status(id)?.status).toBe('failed')
    expect(workerByTag(dir, 'a')).toMatchObject({ status: 'failed', exitCode: 3 })
  })

  it('room_leave refuses while workers run, force dismisses them; shutdown dismisses too', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    const refused = await t.leadTools.call('room_leave', {})
    expect(refused).toContain('error: 1 worker(s) still running: a')
    expect(workerByTag(dir, 'a')?.status).toBe('running')
    expect(t.killed).toHaveLength(0)
    const left = await t.leadTools.call('room_leave', { force: true })
    expect(left).toContain('left local/x/main')
    expect(t.killed).toHaveLength(1)
    // §9 / §6 row 8: stopping until the exit is witnessed.
    expect(workerByTag(dir, 'a')).toMatchObject({ status: 'running', stopReason: 'lead-session-ended' })
    expect(t.a.messages().some(m => m.type === 'note' && /dismissed worker a .*the lead left/.test((m as { text: string }).text))).toBe(true)
    // shutdown path
    const t2 = setupLead()
    await t2.leadTools.call('room_spawn', { tag: 'b', task: 'y' })
    await t2.leadTools.shutdown()
    expect(t2.killed).toHaveLength(1)
    expect(workerByTag(dir, 'b')).toMatchObject({ status: 'running', stopReason: 'lead-session-ended' })
    t2.exits[0](null)
    await vi.waitFor(async () => {
      const registry = await registryForDir(dir)
      const record = registry.list().find(record => record.tag === 'b')!
      expect(registry.exits(record.id)).toMatchObject([{ code: null, witnessed: true }])
    })
    expect(t2.a.messages().some(m => m.type === 'note' && m.text.includes('died'))).toBe(false)
    const session = fakeSession(t2.a, lead)
    const next = createTools({ getSession: () => session, setSession: () => {}, cwd: dir })
    // Worker facts are this clone's registry, so the next session sees both stopped workers, a and b.
    expect(await next.call('room_state', {})).toContain('workers (2):')
    expect(await next.call('room_state', {})).toContain('stopped when your last session ended; its partial work is in its worktree')
    expect(await next.call('room_state', { all: true })).toContain('stopped when your last session ended; its partial work is in its worktree')
    await next.shutdown()
  })

  it('an asynchronous start failure leaves no worker record or launch message', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead)
    let failStart!: (error: Error) => void
    let launchAttempted = false
    const started = new Promise<void>((_, reject) => { failStart = reject })
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir,
      spawner: () => { launchAttempted = true; return { pid: -1, started, onExit: () => {}, kill: () => { throw new Error('must not signal') } } },
      worktree: (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    const spawning = tools.call('room_spawn', { tag: 'nope', task: 'x', host: 'codex' })
    await vi.waitFor(() => expect(launchAttempted).toBe(true), { timeout: 10_000 })
    // The launcher's write-ahead record exists (registry §3); the room shows at most a starting worker, never a running one.
    expect([undefined, 'starting']).toContain(a.workerViewOf('rohanz+nope')?.status)
    failStart(new Error('spawn codex ENOENT'))
    expect(await spawning).toContain('could not start codex: spawn codex ENOENT')
    expect(workerByTag(dir, 'nope')).toBeUndefined()
    expect(a.workerViewOf('rohanz+nope')).toBeUndefined()
    expect(a.messages()).toHaveLength(0)
  })

  it('refuses an outside checkout before intent (S3)', async () => {
    const t = setupLead()
    const outside = mkdtempSync(join(tmpdir(), 'room-outside-'))
    execFileSync('git', ['-C', outside, 'init', '-q', '-b', 'elsewhere'], { stdio: 'pipe' })
    writeFileSync(join(outside, 'f.txt'), 'x\n')
    execFileSync('git', ['-C', outside, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { stdio: 'pipe' })
    execFileSync('git', ['-C', outside, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { stdio: 'pipe' })
    const refused = await t.leadTools.call('room_spawn', { tag: 'far', task: 'x', dir: outside })
    expect(refused).toContain('outside this repo')
    expect(t.specs).toHaveLength(0)
    const ok = await t.leadTools.call('room_spawn', { tag: 'far', task: 'x', dir: outside })
    expect(ok).toContain('is outside this repo')
    expect(t.specs).toHaveLength(0)
    expect((await registryForDir(dir)).reserved('far')).toBeUndefined()
  })
  it('refuses a supplied lead checkout before writing intent or starting a worker (S3)', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead)
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir,
      spawner: () => { throw new Error('should not spawn') } })
    const reply = await tools.call('room_spawn', { tag: 'existing', task: 'x', dir, host: 'codex' })
    expect(reply).toContain('not an owned Room worktree')
    expect(existsSync(dir)).toBe(true)
    const registry = await registryForDir(dir)
    expect(registry.reserved('existing')).toBeUndefined()
    expect(registry.occupancy()).toBe(0)
  })
  it('collects the new worker after an abandoned record reused its tag (F-M4)', async () => {
    const t = setupLead()
    const registry = await registryForDir(dir)
    const abandoned: WorkerRecord = {
      v: 1, id: 'w_000_abandoned', tag: 'money', name: 'rohanz+money', mode: 'here', room: t.session!.roomName,
      lead: { participant: 'rohanz', room: t.session!.roomName, instance: registry.instance },
      host: 'codex', budget: { threads: 1, memGb: 1, nice: 10 }, share: 'intent', task: 'old',
      dir: join(dir, '.room/workers/money'), outside: false, branch: 'room/money', prep: { step: 'plan' },
      capabilities: { resume: true, signal: true, collect: 'delta' }, phase: 'intent',
      runs: [{ n: 1, mode: 'fresh', intentAt: 1, nonce: 'old', busFrontier: 0, promptMsgIds: [], launcher: registry.instance, logStart: 0 }],
      createdAt: 1, seq: 1,
    }
    await registry.writeIntent(abandoned)
    await registry.abandonPreparation(abandoned.id)
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'new', host: 'codex' })).toContain('spawned money')
    const current = registry.reserved('money')!
    expect(current.id).not.toBe(abandoned.id)
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')?.status).toBe('failed'))
    expect(await t.leadTools.call('room_collect', { tag: 'money', discard: true })).toContain('discarded money')
  })
  it('does not relaunch a preexisting Room checkout as a new supplied-dir worker', async () => {
    const t = setupLead()
    const prepared = await prepareWorktree(dir, 'same', 'rohanz')
    writeFileSync(join(dir, 'lead-only.txt'), 'lead edit')
    try {
      const reply = await t.leadTools.call('room_spawn', { tag: 'same', task: 'inspect', dir: prepared.dir, host: 'codex', model: 'worker-model' })
      expect(reply).toContain('tag in use: same')
      expect(t.specs).toHaveLength(0)
    } finally { rmSync(join(dir, 'lead-only.txt'), { force: true }) }
  })
})

describe('review fixes: workers', () => {
  it('a worker is named after the lead\'s owner and told so through ROOM_OWNER (fix 5)', async () => {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    const teamLead: Identity = { name: 'rohanz+lead', kind: 'agent', owner: 'rohanz', label: 'lead' }
    let ls: Session | null = fakeSession(team.a, teamLead, false)
    ls!.roomName = 'github.com/rohanz/x/main'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx%2Fmain'
    const specs: SpawnSpec[] = []
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0, probe: () => undefined,
      join: async () => fakeSession(local.a, teamLead),
      leave: async () => {},
      spawner: spec => { specs.push(spec); return { pid: 99, started: Promise.resolve(), onExit: () => {}, kill: () => true } },
      worktree: async (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    await leadTools.call('room_spawn', { tag: 'money', task: 't', where: 'local' })
    expect(specs[0].env.ROOM_OWNER).toBe('rohanz')
    expect(workerByTag(dir, 'money')!.name).toBe('rohanz+money')
    await leadTools.call('room_leave', { force: true })
  })

  it('a shared-token server reaches the worker as a bare URL plus ROOM_TOKEN, whatever way the lead got the token (fix 10, W1)', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'main', base })
    // A short hex token (e.g. abc) can occur in the Git SHA printed by room_state.
    const token = 'worker-test-secret-token'
    // The lead joined with a token in the URL: only the session knows it, not the environment.
    let ls: Session | null = { ...fakeSession(a, lead, false), roomUrl: 'ws://team.example/local%2Fx%2Fmain', token } as Session
    const specs: SpawnSpec[] = []
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir, probe: () => undefined, spawner: spec => { specs.push(spec); return { pid: 5, started: Promise.resolve(), onExit: () => {}, kill: () => true } }, worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }) })
    await tools.call('room_spawn', { tag: 'w', task: 't' })
    expect(specs[0].env.ROOM_SERVER).toBe('ws://team.example')
    expect(specs[0].env.ROOM_TOKEN).toBe(token)
    // the join reply and room_state never print the token
    expect(await tools.call('room_state', {})).not.toContain(token)
  })

  it('a finished worker whose process is alive can still be stopped; leave and shutdown stop it too (fix 8)', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 't' })
    let ws: Session | null = fakeSession(t.b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    await workerTools.call('room_done', { summary: 'done but still running' })
    // §6 row 8 precedes row 10: a live process reads as running even after its done report.
    expect(workerByTag(dir, 'money')).toMatchObject({ status: 'running', summary: 'done but still running' })
    const discarding = t.leadTools.call('room_collect', { discard: true, tag: 'money' })
    await vi.waitFor(() => expect(t.killed).toHaveLength(1), { timeout: 10_000 })
    t.exits[0](0)
    expect(await discarding).toContain('discarded money')
    expect(t.killed).toHaveLength(1)
    expect(workerByTag(dir, 'money')).toBeUndefined()
    // shutdown with a live process behind a done record signals it as well
    await t.leadTools.call('room_spawn', { tag: 'tiers', task: 't' })
    let ws2: Session | null = fakeSession(t.b, { name: 'rohanz+tiers', kind: 'agent', owner: 'rohanz', label: 'tiers' })
    const tiersTools = createTools({ getSession: () => ws2, setSession: s => { ws2 = s }, cwd: dir })
    await tiersTools.call('room_done', { summary: 'x' })
    await t.leadTools.shutdown()
    expect(t.killed).toHaveLength(2)
  })

  it('a discarded tag remains reserved until retirement, and a stale exit cannot clear its record (fix 9)', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'first' })
    const firstId = workerByTag(dir, 'money')!.id
    // Discard must not report success until its process exits.
    const discarding = t.leadTools.call('room_collect', { discard: true, tag: 'money' })
    await vi.waitFor(async () => expect((await registryForDir(dir)).read(firstId)?.stop?.reason).toBe('discarded'), { timeout: 10_000 })
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'second' })).toContain('tag in use: money')
    t.exits[0](1)
    expect(await discarding).toContain('discarded money')
    await vi.waitFor(() => expect(workerByTag(dir, 'money')).toBeUndefined())
    // Retirement cleanup finished in the lead's only room (§12), releasing the tag; the respawn is refused only
    // by the worktree this file's mocked cleanupWorker leaves behind.
    expect((await registryForDir(dir)).read(firstId)?.phase).toBe('retired')
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'second' })).toContain('worktree money is unmanaged')
    t.exits[0](1) // the first process finally dies
    expect((await registryForDir(dir)).read(firstId)).toMatchObject({ id: firstId, tag: 'money' })
    // and while a process is alive the tag cannot be reused
    await t.leadTools.call('room_spawn', { tag: 'x', task: 't' })
    expect(await t.leadTools.call('room_spawn', { tag: 'x', task: 'again' })).toContain('tag in use: x')
  })
})

describe('review fixes: the workers room', () => {
  function setupBridged(wake?: (id: string, text: string) => Promise<void>) {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(team.a, lead, false)
    ls!.roomName = 'github.com/rohanz/x/main'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx%2Fmain'
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, binding: { bound: () => ({ id: 'thread-lead', host: 'codex' as const }), id: () => 'thread-lead', dir: () => undefined, commonDir: () => undefined }, conflictDebounceMs: 0, probe: () => undefined,
      ...(wake ? { wake: async (target: { id: string }, text: string) => { await wake(target.id, text); return 'queue' as const } } : {}),
      join: async () => fakeSession(local.a, lead),
      leave: async () => {},
      spawner: () => ({ pid: 99, started: Promise.resolve(), onExit: () => {}, kill: () => true }),
      worktree: async (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    let ws: Session | null = fakeSession(local.b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    return { team, local, leadTools, workerTools }
  }

  it("the lead's answer to a worker's question lands in the workers room, and room_wait finds the answer there (fix 6)", async () => {
    const t = setupBridged()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 't', where: 'local' })
    const asked = await t.workerTools.call('room_send', { type: 'question', text: 'which field?', to: 'rohanz' })
    const qid = asked.match(/questionId=(m_\w+)/)![1]
    const sent = await t.leadTools.call('room_send', { type: 'answer', inReplyTo: qid, text: 'price_cents' })
    expect(sent).toContain('(in the workers room)')
    expect(t.local.b.messages().some(m => m.type === 'answer' && m.inReplyTo === qid)).toBe(true)
    expect(t.team.b.messages().some(m => m.type === 'answer')).toBe(false)
    // a plain note addressed to the worker goes there too
    await t.leadTools.call('room_send', { type: 'note', text: 'keep going', to: 'rohanz+money' })
    expect(t.local.b.messages().at(-1)).toMatchObject({ type: 'note', to: 'rohanz+money' })
    // the worker's wait on its question resolves with the answer
    expect(await t.workerTools.call('room_wait', { questionId: qid, timeoutMs: 1000 })).toContain('answered: ')
    await t.leadTools.call('room_leave', { force: true })
  })

  it("questions and done messages from the workers room wake the lead through its host (fix 7)", async () => {
    const woken: string[] = []
    const t = setupBridged(async (_id, text) => { woken.push(text) })
    await t.leadTools.call('room_spawn', { tag: 'money', task: 't', where: 'local' })
    await t.workerTools.call('room_send', { type: 'question', text: 'which field?', to: 'rohanz' })
    await vi.waitFor(() => expect(woken.some(x => x.includes('rohanz+money asked a question'))).toBe(true))
    await t.workerTools.call('room_done', { summary: 'all in cents' })
    // The follow-up waits out the five-second window after the first wake.
    await vi.waitFor(() => expect(woken.some(x => x.includes('rohanz+money finished'))).toBe(true), { timeout: 8_000 })
    expect(woken.join('\n')).not.toMatch(/which field\?|all in cents/)
    await t.leadTools.call('room_leave', { force: true })
  }, 15_000)
})

describe('workers review: env, keys, sessions, reservation, signals', () => {
  it('W1: a worker gets exactly its own room variables; the lead\'s ROOM_URL/ROOM_NAME/ROOM_DIR and token never leak', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 't' })
    const env = t.specs[0].env
    expect(Object.keys(env).filter(k => k.startsWith('ROOM_')).sort()).toEqual(['ROOM_DIR', 'ROOM_LAUNCH_NONCE', 'ROOM_LEAD', 'ROOM_LOG_FILE', 'ROOM_OWNER', 'ROOM_REGISTRY', 'ROOM_ROOM', 'ROOM_SERVER', 'ROOM_SHARE', 'ROOM_TAG', 'ROOM_WORKER_HOST', 'ROOM_WORKER_ID', 'ROOM_WORKER_MEM_GB', 'ROOM_WORKER_RUN', 'ROOM_WORKER_THREADS'])
    expect(env).toMatchObject({ ROOM_SERVER: 'local', ROOM_ROOM: 'local/x/main', ROOM_TAG: 'money', ROOM_LEAD: 'rohanz', ROOM_OWNER: 'rohanz', ROOM_WORKER_RUN: '1', ROOM_SHARE: 'full' })
    expect(env.ROOM_DIR).toBe(join(dir, '.room', 'workers', 'money'))
    expect(env.ROOM_LOG_FILE).toBe(join(dir, '.room', 'workers', 'money.mcp.log'))
    // the real spawner strips the lead's own room variables from the inherited environment before applying the spec's
    const merged = workerEnv({ PATH: '/bin', ROOM_URL: 'ws://lead/room', ROOM_NAME: 'rohanz', ROOM_DIR: '/lead', ROOM_TOKEN: 'secret', ROOM_TAG: 'lead', ROOM_MAX_WORKERS: '3' }, env)
    expect(merged.ROOM_URL).toBeUndefined(); expect(merged.ROOM_NAME).toBeUndefined(); expect(merged.ROOM_TOKEN).toBeUndefined()
    expect(merged).toMatchObject({ PATH: '/bin', ROOM_MAX_WORKERS: '3', ROOM_DIR: env.ROOM_DIR, ROOM_TAG: 'money' })
    // The durable tag remains reserved until retirement cleanup finishes.
    t.exits[0](0)
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'again' })).toContain('tag in use: money')
    await t.leadTools.call('room_collect', { discard: true, tag: 'money' })
    // Retirement cleanup has finished (§12); only the worktree left by the mocked cleanupWorker refuses the tag now.
    expect((await registryForDir(dir)).list().find(record => record.tag === 'money')?.phase).toBe('retired')
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'again' })).toContain('worktree money is unmanaged')
  })

  it('W2/W3: distinct tags route workers to their rooms; local reads and diffs use the workers room', async () => {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(team.a, lead, false)
    ls!.roomName = 'github.com/rohanz/x/main'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx%2Fmain'
    const killed: string[] = []
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0, probe: () => undefined,
      join: async () => fakeSession(local.a, lead),
      leave: async () => {},
      // Like SIGTERM, a signal ends the fake process, so a discard sees it exit.
      spawner: spec => { let exit: ((code: number | null) => void) | undefined
        return { pid: 99, started: Promise.resolve(), onExit: cb => { exit = cb }, kill: () => { killed.push(spec.env.ROOM_ROOM); exit?.(null); return true } } },
      worktree: async (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    await leadTools.call('room_spawn', { tag: 'team-money', task: 'team side' })
    await leadTools.call('room_spawn', { tag: 'money', task: 'local side', where: 'local' })
    expect(await leadTools.call('room_spawn', { tag: 'money', task: 'duplicate', where: 'here' })).toContain('tag in use: money')
    expect(workerByTag(dir, 'team-money')?.task).toBe('team side')
    expect(workerByTag(dir, 'money')?.task).toBe('local side')
    // the local worker edits in the workers room; the team-room lead reads and diffs its version
    publishFixture(local.b, 'rohanz+money', 'app.py', 'x = 100\n')
    // §14: a local worker's preview reads its trusted worktree, so the edit is on disk as well.
    writeFileSync(join(workerByTag(dir, 'money')!.dir, 'app.py'), 'x = 100\n')
    publishFixture(local.b, 'rohanz+tiers', 'tiers.py', 'tier = "gold"\n')
    const read = await leadTools.call('room_read', { path: 'app.py', person: 'rohanz+money' })
    expect(read).toContain('x = 100')
    expect(read).toContain('as rohanz+money sees it')
    expect(await leadTools.call('room_read', { diff: true, path: 'app.py', person: 'rohanz+money' })).toContain('+x = 100')
    expect(await leadTools.call('room_state', { path: 'app.py' })).toContain('uncommitted changes by: rohanz+money')
    const pm = await leadTools.call('room_preview_merge', { person: 'rohanz+money' })
    expect(pm, pm).toContain('no conflicts')
    const includingLead = await leadTools.call('room_preview_merge', { people: ['rohanz', 'rohanz+money'] })
    expect(includingLead).toContain('step 1: merge rohanz+money')
    const byTag = await leadTools.call('room_preview_merge', { people: ['money'] })
    expect(byTag).toContain('step 1: merge rohanz+money')
    expect(byTag).toContain('from rohanz, rohanz+money')
    const all = await leadTools.call('room_preview_merge', { people: ['rohanz+money', 'rohanz+tiers'], run: 'cat app.py tiers.py' })
    expect(all).toContain('x = 100')
    expect(all).toContain('tier = "gold"')
    expect(all).toContain('exit 0')
    expect(all).toMatch(/tests: exit 0 \(no test summary recognised\)$/)
    const failed = await leadTools.call('room_preview_merge', { people: ['rohanz+money', 'rohanz+tiers'], run: "printf 'Tests: 1 failed, 1 total\\n'; exit 3" })
    expect(failed).toMatch(/Tests: 1 failed, 1 total\ntests: FAILED \(exit 3\)$/)
    // dismissing the team-room worker signals only the team-room process; the local one is untouched
    await leadTools.call('room_collect', { discard: true, tag: 'team-money' })
    expect(killed).toEqual(['github.com/rohanz/x/main'])
    expect(workerByTag(dir, 'money')?.status).toBe('running')
    expect(await leadTools.call('room_leave', {})).toContain('worker(s) still running: money')
    expect(killed).toEqual(['github.com/rohanz/x/main'])
    expect(workerByTag(dir, 'money')?.status).toBe('running')
    await leadTools.call('room_leave', { force: true })
    expect(killed).toEqual(['github.com/rohanz/x/main', 'local/x/main'])
  })

  it('W4: two concurrent spawns of one tag cannot both pass the tag check', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let entered!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const specs: SpawnSpec[] = []
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, probe: () => undefined,
      spawner: spec => { specs.push(spec); return { pid: 7, started: Promise.resolve(), onExit: () => {}, kill: () => true } },
      worktree: async (repo, tag) => { entered(); await gate; return { dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true } },
    })
    const first = tools.call('room_spawn', { tag: 'money', task: 'one' })
    await preparing // the first spawn holds the reservation before the second races it
    const second = await tools.call('room_spawn', { tag: 'money', task: 'two' })
    expect(second).toContain('tag in use: money')
    release()
    expect(await first).toContain('spawned money')
    expect(specs).toHaveLength(1)
    expect(workerByTag(dir, 'money')?.task).toBe('one')
    // the reservation is released once the spawn has finished (or failed)
    expect(await tools.call('room_spawn', { tag: 'money', task: 'three' })).toContain('tag in use: money')
  })

  it('drops a cancelled spawn after delayed worktree preparation and removes the prepared tree', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const specs: SpawnSpec[] = []
    let prepared: Awaited<ReturnType<typeof prepareWorktree>> | undefined
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, probe: () => undefined,
      spawner: spec => { specs.push(spec); return { pid: 7, started: Promise.resolve(), onExit: () => {}, kill: () => true } },
      worktree: async (repo, tag) => { entered(); await gate; prepared = await prepareWorktree(repo, tag); return prepared },
    })
    const controller = new AbortController()
    const call = tools.call as (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<string>
    const spawning = call('room_spawn', { tag: 'cancelled-preparation', task: 'never start' }, controller.signal)
    await preparing
    controller.abort()
    release()
    try {
      expect(await spawning).toContain('tool call cancelled')
      expect(specs).toHaveLength(0)
      expect(workerByTag(dir, 'cancelled-preparation')).toBeUndefined()
      expect(existsSync(join(dir, '.room/workers/cancelled-preparation'))).toBe(false)
    } finally {
      if (prepared?.created && existsSync(prepared.dir)) await cleanupPreparedWorktree(dir, prepared)
      await tools.shutdown()
    }
  })

  it.each([true, false])('keeps a fresh worker checkout after cancellation following process start (stop confirmed: %s)', async stopped => {
    const { repo, head } = realRepo()
    const previousDir = dir, previousBase = base
    dir = repo; base = head
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead)
    const controller = new AbortController()
    let onExit: ((code: number | null) => void) | undefined
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: repo, now: () => 500, probe: () => ({ startTime: 'injected' }),
      worktree: async (_repo, tag) => prepareWorktree(repo, tag, 'rohanz', [], undefined, 0, false),
      spawner: spec => {
        writeFileSync(join(spec.cwd, 'partial.txt'), 'keep me')
        return { pid: 8123, started: Promise.resolve(), onExit: cb => { onExit = cb; controller.abort() },
          kill: () => { if (stopped) onExit?.(0); return stopped } }
      },
    })
    try {
      const call = tools.call as (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<string>
      const reply = await call('room_spawn', { tag: 'after-start', task: 'write', host: 'codex' }, controller.signal)
      const checkout = join(repo, '.room', 'workers', 'after-start')
      expect(reply).toContain(stopped ? 'stopped after' : 'stop unconfirmed')
      expect(existsSync(checkout)).toBe(true)
      expect(readFileSync(join(checkout, 'partial.txt'), 'utf8')).toBe('keep me')
      // §9: an unconfirmed stop leaves it running ("stopping", §6 row 8).
      expect(workerByTag(dir, 'after-start')?.status).toBe(stopped ? 'dismissed' : 'running')
    } finally { dir = previousDir; base = previousBase }
  })

  it('W5: after a lead restart, an unreadable process identity is never signalled', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'main', base })
    // a stand-in for the worker process that outlived the lead: its own process group, so the signal cannot reach the test runner
    const child = spawn('sleep', ['100'], { detached: true, stdio: 'ignore' }); child.unref()
    const exited = new Promise<void>(r => child.once('exit', () => r()))
    // a record from before the restart: no process handle and no recorded start identity, so the
    // registry cannot tie the live pid to it and §6 row 10 reads it as done
    const prepared = await prepareWorktree(dir, 'money', 'rohanz')
    const processStartTime = probeProcess(child.pid!)!.startTime!
    await registerWorkers(fakeSession(a, lead), [{ tag: 'money', name: 'rohanz+money', host: 'claude', hostSessionId: 'e1be43be-03a3-45b8-b267-cd48780e2a0b', task: 'x', dir: prepared.dir, branch: prepared.branch, pid: child.pid!, startedAt: Date.now(), status: 'done', lead: 'rohanz', summary: 'done but alive' }])
    let ls: Session | null = fakeSession(a, lead)
    const probe = () => pidAlive(child.pid!) ? { startTime: processStartTime, executable: 'claude' } : undefined
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir, probe })
    expect(await tools.call('room_leave', {})).toContain('left local/x/main')
    expect(pidAlive(child.pid!)).toBe(true)
    expect((await registryForDir(dir)).list().find(r => r.tag === 'money')).toBeDefined()
    process.kill(-child.pid!, 'SIGTERM')
    await exited
  })

  it('W8: dismiss marks a worker dismissed only when the signal was delivered', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead)
    let deliverable = false
    let exit: (code: number | null) => void = () => {}
    let live = true
    let clock = 0
    const realKill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === 8 && signal === 0) {
        const error = new Error('synthetic worker has no OS process') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      }
      return realKill(pid, signal)
    })
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, now: () => clock,
      sleep: async ms => { clock += ms },
      probe: pid => pid === 8 && live ? { startTime: 'test:worker:8', executable: 'claude' } : undefined,
      spawner: () => ({ pid: 8, started: Promise.resolve(), onExit: cb => { exit = code => { live = false; cb(code) } }, kill: () => { if (deliverable) exit(0); return deliverable } }),
      worktree: (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
    })
    await tools.call('room_spawn', { tag: 'money', task: 't' })
    expect(workerByTag(dir, 'money')?.processStartTime).toBe('test:worker:8')
    const refused = await tools.call('room_collect', { discard: true, tag: 'money' })
    expect(refused).toContain('worker process has not stopped')
    const registry = await registryForDir(dir)
    const interrupted = registry.reserved('money')!
    expect(interrupted.stop?.reason).toBe('discarded')
    expect(interrupted.phase).toBe('active')
    expect(interrupted.interrupted?.op).toBe('discard')
    await registry.reconcile()
    expect(registry.read(interrupted.id)?.phase).toBe('active')
    expect(existsSync(join(dir, '.room/workers/money'))).toBe(true)
    expect(a.messages().some(m => m.type === 'note' && /could not dismiss worker money/.test((m as { text: string }).text))).toBe(true)
    deliverable = true
    expect(await tools.call('room_collect', { discard: true, tag: 'money' })).toContain('discarded money')
    expect(workerByTag(dir, 'money')).toBeUndefined()
  })

  it('does not replay a parent discard after nested-worker disposal was refused (F-S2)', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'parent', task: 'parent task' })
    const parent = workerByTag(dir, 'parent')!
    await registerWorkers(fakeSession(t.a, lead), [{ tag: 'child', name: `${parent.name}+child`, lead: parent.name,
      host: 'codex', task: 'nested', dir: join(dir, '.room/workers/absent-child'),
      branch: 'room/child', pid: 0, startedAt: Date.now(), status: 'done' }])
    const reply = await t.leadTools.call('room_collect', { tag: 'parent', discard: true, force: true })
    expect(reply).toContain('could not dispose of nested worker child')
    const registry = await registryForDir(dir)
    const record = registry.reserved('parent')!
    expect(record.phase).toBe('active')
    expect(record.interrupted?.op).toBe('discard')
    await registry.reconcile()
    expect(registry.read(record.id)?.phase).toBe('active')
  })
})

describe('review round 3', () => {
  it("a tag held by another lead's running worker is refused, and its record is never touched", async () => {
    const t = setupLead()
    const prepared = await prepareWorktree(dir, 'money', 'kieran')
    await registerWorkers(fakeSession(t.a, lead), [{ tag: 'money', name: 'kieran+money', host: 'claude', task: 'theirs', dir: prepared.dir, branch: prepared.branch, pid: 4242, startedAt: Date.now(), status: 'running', lead: 'kieran' }])
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'mine' })).toContain('tag in use: money')
    expect(workerByTag(dir, 'money')).toMatchObject({ lead: 'kieran', status: 'running' })
  })
})


describe('worker compute budgets', () => {
  it('recounts concurrent spawns before budgeting and enforces capacity', async () => {
    vi.spyOn(os, 'availableParallelism').mockReturnValue(12)
    vi.spyOn(os, 'totalmem').mockReturnValue(24 * 1024 ** 3)
    const t = setupLead() // maxWorkers = 2, so reserve six threads each
    const replies = await Promise.all(['a', 'b', 'c'].map(tag => t.leadTools.call('room_spawn', { tag, task: 'train' })))
    expect(t.specs).toHaveLength(2)
    expect(t.specs.map(s => s.env.ROOM_WORKER_THREADS)).toEqual(['6', '6'])
    expect(t.specs.map(s => s.env.ROOM_WORKER_MEM_GB)).toEqual(['12', '12'])
    expect(replies.filter(r => r.includes('budget in prompt:'))).toHaveLength(2)
    expect(t.specs.every(s => s.args.some(a => a.includes('Compute budget: 6 threads, ~12 GB')))).toBe(true)
    expect(replies.some(r => r.includes('worker capacity reached'))).toBe(true)
    await t.leadTools.shutdown()
  })

  it.each([
    [12, 8, 0, 3], [12, 8, 1, 3], [12, 8, 3, 3], [12, 8, 4, 2],
    [12, 8, 7, 1], [12, 2, 0, 6], [12, 1, 0, 12], [12, 2, 5, 2],
    [2, 8, 0, 1], [1, 8, 4, 1],
  ])('%i cores, max %i, running %i -> %i threads', (cores, maxWorkers, running, threads) => {
    expect(workerBudget({ cores, maxWorkers, running, memBytes: 17.9 * 1024 ** 3 })).toEqual({
      // Memory uses the same reservation as threads: at least four intended workers, bounded by maxWorkers.
      threads, memGb: Math.max(1, Math.floor(17.9 / Math.max(1, Math.min(maxWorkers, Math.max(running + 1, 4)), running + 1))),
    })
    expect(threads).toBeLessThanOrEqual(cores)
    if (running + 1 <= cores) expect(threads * (running + 1)).toBeLessThanOrEqual(cores)
  })

  it('floors memory to one GB on a small machine', () => {
    expect(workerBudget({ cores: 1, maxWorkers: 8, running: 12, memBytes: 512 * 1024 ** 2 }).memGb).toBe(1)
  })

  it.each(['claude', 'codex'])('passes caps through the %s path while preserving explicit library settings', async host => {
    vi.stubEnv('OMP_NUM_THREADS', '7')
    vi.stubEnv('ROOM_WORKER_THREADS', '5')
    vi.stubEnv('ROOM_WORKER_MEM_GB', '9')
    for (const key of ['OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'NUMEXPR_NUM_THREADS', 'LOKY_MAX_CPU_COUNT', 'RAYON_NUM_THREADS']) vi.stubEnv(key, undefined)
    const t = setupLead()
    const reply = await t.leadTools.call('room_spawn', { tag: 'budget', task: 'train', host, threads: 2 })
    const spec = t.specs[0]
    expect(spec.cmd).toBe(workerPriority({ cmd: host, args: [] }).cmd)
    const env = workerEnv(process.env, spec.env)
    expect(env).toMatchObject({ OMP_NUM_THREADS: '7', ROOM_WORKER_THREADS: '2', ROOM_WORKER_MEM_GB: '9',
      OPENBLAS_NUM_THREADS: '2', MKL_NUM_THREADS: '2', VECLIB_MAXIMUM_THREADS: '2', NUMEXPR_NUM_THREADS: '2', LOKY_MAX_CPU_COUNT: '2', RAYON_NUM_THREADS: '2' })
    const priority = workerPriority({ cmd: host, args: [] })
    expect(reply).toContain(`budget in prompt: 2 threads, ~9 GB · priority ${priority.nice ? 'nice 10' : 'normal'}`)
    expect(spec.args.some(a => a.includes('Compute budget: 2 threads, ~9 GB RAM; scheduling priority:') && a.includes('reasoning effort: host default'))).toBe(true)
    expect(process.env.ROOM_WORKER_THREADS).toBe('5')
    expect(process.env.OPENBLAS_NUM_THREADS).toBeUndefined()
    await t.leadTools.call('room_spawn', { tag: 'inherited', task: 'train', host })
    expect(t.specs[1].env.ROOM_WORKER_THREADS).toBe('5')
    await t.leadTools.shutdown()
  })

  it.each([0, -1, 1.5, '2', null])('rejects invalid threads %s before spawning', async threads => {
    const t = setupLead()
    expect(await t.leadTools.call('room_spawn', { tag: 'bad', task: 'train', threads })).toContain('error: threads must be an integer >= 1')
    expect(t.specs).toHaveLength(0)
  })

  it('rejects supplied directories without an owned Room worktree before intent (S3 re-review)', async () => {
    const t = setupLead()
    const nested = join(dir, 'nested-checkout')
    mkdirSync(nested, { recursive: true })
    execFileSync('git', ['init', '-q', nested])
    const ordinary = join(dir, 'ordinary-directory')
    mkdirSync(ordinary, { recursive: true })
    const external = mkdtempSync(join(tmpdir(), 'room-linked-checkout-'))
    const linked = join(dir, 'linked-checkout')
    symlinkSync(external, linked)
    try {
      for (const supplied of [nested, ordinary, linked]) {
        const reply = await t.leadTools.call('room_spawn', { tag: 'supplied', task: 'work', dir: supplied })
        expect(reply).toMatch(/error:.*(?:Room worktree|worker directory|outside this repo)/)
        expect(t.specs).toHaveLength(0)
        expect((await registryForDir(dir)).list()).toHaveLength(0)
      }
    } finally {
      rmSync(nested, { recursive: true, force: true })
      rmSync(ordinary, { recursive: true, force: true })
      rmSync(linked, { force: true })
      rmSync(external, { recursive: true, force: true })
    }
  })
})

describe('worker scheduling priority', () => {
  const command = { cmd: 'fake-worker', args: ['task with spaces'] }
  it.each([[undefined, 10], ['0', 0], ['-5', 0], ['50', 19], ['3.9', 3], ['bad', 10], ['', 10]])
    ('normalises ROOM_WORKER_NICE=%s to %i', (value, expected) => {
      const result = workerPriority(command, { PATH: '/usr/bin:/bin', ROOM_WORKER_NICE: value }, 'linux')
      expect(result.nice).toBe(expected)
      if (expected) expect(result.args).toEqual(['-n', String(expected), command.cmd, ...command.args])
      else expect(result).toEqual({ ...command, nice: 0 })
    })

  it('does not wrap on Windows and falls back with one warning when nice is missing', () => {
    const log = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(workerPriority(command, { PATH: '/missing' }, 'win32')).toEqual({ ...command, nice: 0 })
    expect(log).not.toHaveBeenCalled()
    for (let i = 0; i < 2; i++) expect(workerPriority(command, { PATH: '/missing' }, 'linux')).toEqual({ ...command, nice: 0 })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')('tracks the real execed worker pid and can dismiss it', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'room-nice-'))
    const pidFile = join(scratch, 'pid')
    const cmd = workerPriority({ cmd: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`] })
    expect(cmd.nice).toBe(10)
    expect(cmd.args.slice(0, 2)).toEqual(['-n', '10'])
    const child = defaultSpawner({ cmd: cmd.cmd, args: cmd.args, cwd: scratch, env: {}, logFile: join(scratch, 'worker.log') })
    const exited = new Promise<void>((resolve, reject) => { child.onExit(() => resolve()); child.onError?.(reject) })
    try {
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true))
      expect(Number(readFileSync(pidFile, 'utf8'))).toBe(child.pid)
      expect(pidAlive(child.pid)).toBe(true)
      expect(os.getPriority(child.pid)).toBeGreaterThanOrEqual(10)
      expect(child.kill()).toBe(true)
      await exited
      expect(pidAlive(child.pid)).toBe(false)
    } finally { child.kill(); await exited; rmSync(scratch, { recursive: true, force: true }) }
  })
})

it('passes documented effort and session flags to Claude and Codex', () => {
  expect(workerCommand('claude', undefined, 'task', '', 'medium', { tag: 'money', sessionId: '550e8400-e29b-41d4-a716-446655440000', maxBudgetUsd: '2.50' }).args)
    .toEqual(['-p', 'task', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__room__*,mcp__plugin_room_room__*,Edit,Write,Read,Bash,Glob,Grep', '--effort', 'medium', '--name', 'money', '--session-id', '550e8400-e29b-41d4-a716-446655440000', '--max-budget-usd', '2.50'])
  expect(workerCommand('claude', undefined, 'task').args).not.toContain('--effort')
  expect(workerCommand('claude', undefined, 'task', '', 'minimal').args).toContain('low')
  expect(workerCommand('codex', undefined, 'task', '', 'medium').args).toContain('model_reasoning_effort=medium')
  expect(workerCommand('codex', undefined, 'task').args).not.toContain('-c')
  expect(workerCommand('claude', 'opus', 'fix', '', 'high', { tag: 'money', sessionId: '550e8400-e29b-41d4-a716-446655440000', resume: true }).args)
    .toEqual(['-p', '--resume', '550e8400-e29b-41d4-a716-446655440000', 'fix', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__room__*,mcp__plugin_room_room__*,Edit,Write,Read,Bash,Glob,Grep', '--model', 'opus', '--effort', 'high', '--name', 'money'])
  expect(workerCommand('codex', 'gpt-6-sol', 'fix', '', 'high', { sessionId: '550e8400-e29b-41d4-a716-446655440000', resume: true }).args)
    .toEqual(['exec', 'resume', '550e8400-e29b-41d4-a716-446655440000', '-c', 'sandbox_mode="workspace-write"', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=high', '--json', 'fix'])
  expect(workerEnv({ ROOM_WORKER_HOST: 'claude', ROOM_WORKER_MODEL: 'old', ROOM_WORKER_EFFORT: 'high' }, {})).toEqual({})
})

describe('retirement integration', () => {
  it('archives a done worker only after its dismissed process exits, preserving its summary and files', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'archive me' })
    publishFixture(t.a, 'rohanz+money', 'app.py', 'x = 2\n')
    await reportDone('money', 'implemented money')
    const discarding = t.leadTools.call('room_collect', { discard: true, tag: 'money' })
    await new Promise(resolve => setTimeout(resolve, 1))
    expect(t.a.retiredWorkers()).toEqual([])
    await vi.waitFor(async () => expect((await registryForDir(dir)).list().find(record => record.tag === 'money')?.stop?.reason).toBe('discarded'), { timeout: 10_000 })
    expect(await t.leadTools.call('room_state', {})).toContain('money (claude, discard pending (collecting)')
    t.exits[0](0)
    expect(await discarding).toContain('discarded money')
    expect(t.a.messages().some(m => m.type === 'note' && m.to === lead.name && /dismissed worker money/.test(m.text))).toBe(false)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')).toBeUndefined())
    expect(t.a.retiredWorkers()).toMatchObject([{ name: 'rohanz+money', summary: 'discarded', files: [], outcome: 'dismissed' }])
    expect(manifestPaths(t.a, 'rohanz+money')).toEqual([])
    await t.leadTools.shutdown()
  })

  it('a merge preview retains a done worker with uncommitted work and zero commits', async () => {
    const t = setupLead()
    const prepared = await prepareWorktree(dir, 'finished', 'rohanz')
    writeFileSync(join(prepared.dir, 'uncommitted-retirement-check'), 'dirty')
    await registerWorkers(t.session!, [{ tag: 'finished', name: 'rohanz+finished', host: 'codex', task: 'x', dir: prepared.dir, branch: prepared.branch, pid: -1, startedAt: 1, status: 'done', lead: 'rohanz', exitCode: 0 }])
    await t.leadTools.call('room_preview_merge', {})
    expect(t.a.retiredWorkers()).toEqual([])
    expect(workerByTag(dir, 'finished')).toBeDefined()
    await t.leadTools.call('room_collect', { discard: true, tag: 'finished' })
    const retired = t.a.retiredWorkers()[0]
    expect(retired).toMatchObject({ tag: 'finished', outcome: 'dismissed' })
    expect(retired.uncommitted).toBeUndefined()
    expect(await t.leadTools.call('room_state', { all: true })).toContain('discarded')
    expect(existsSync(join(dir, 'uncommitted-retirement-check'))).toBe(false)
    await t.leadTools.shutdown()
  })
})

describe('spawn inputs and effort', () => {
  it.each(['minimal', 'low', 'medium', 'high'])('passes valid Codex effort %s into config and the worker prompt', async effort => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'effort', task: 'reason carefully', host: 'codex', effort })
    expect(t.specs[0].args).toContain(`model_reasoning_effort=${effort}`)
    expect(t.specs[0].args.some(a => a.includes(`reasoning effort: ${effort}`))).toBe(true)
    await t.leadTools.shutdown()
  })

  it.each(['max', '', 'HIGH', 2, null])('rejects invalid effort %s before spawning', async effort => {
    const t = setupLead()
    expect(await t.leadTools.call('room_spawn', { tag: 'effort', task: 'x', effort })).toContain('error: effort must be')
    expect(t.specs).toEqual([])
    await t.leadTools.shutdown()
  })

  it('uses .roomlinks defaults, records links and describes them as read-only in the actual prompt', async () => {
    const t = setupLead()
    const source = 'spawn-linked-input'
    const dest = join(dir, '.room', 'workers', 'linked')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dir, source), 'training data')
    writeFileSync(join(dir, '.roomlinks'), `# shared inputs\n\n${source} # comment\n`)
    try {
      expect(await t.leadTools.call('room_spawn', { tag: 'linked', task: 'read inputs' })).toContain(`inputs ${source}`)
      expect(workerByTag(dir, 'linked')?.link).toEqual([source])
      expect(lstatSync(join(dest, source)).isSymbolicLink()).toBe(true)
      expect(t.specs[0].args.some(a => a.includes(`Read-only inputs linked from the lead's clone: ${source}`))).toBe(true)
      expect(prepareWorkerLinks(dir, dest, [])).toEqual([])
    } finally {
      rmSync(join(dir, '.roomlinks'), { force: true })
      rmSync(join(dir, source), { force: true })
      rmSync(dest, { recursive: true, force: true })
      await t.leadTools.shutdown()
    }
  })

  it('validates the entire link list before mutating and never overwrites a destination', () => {
    const root = mkdtempSync(join(tmpdir(), 'room-links-'))
    const target = join(root, 'worktree')
    mkdirSync(target)
    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, 'data', 'in.txt'), 'input')
    writeFileSync(join(target, 'present'), 'keep')
    try {
      expect(() => prepareWorkerLinks(root, target, ['data', 'missing'])).toThrow()
      expect(existsSync(join(target, 'data'))).toBe(false)
      expect(() => prepareWorkerLinks(root, target, ['data', 'data/in.txt'])).toThrow('overlapping')
      for (const p of ['../escape', '/tmp', '.', '.git', '.room', 'data/../../escape']) expect(() => prepareWorkerLinks(root, target, [p])).toThrow()
      symlinkSync(tmpdir(), join(root, 'outside'))
      expect(() => prepareWorkerLinks(root, target, ['outside'])).toThrow('escapes repo')
      symlinkSync(join(root, 'data'), join(target, 'data'))
      expect(() => prepareWorkerLinks(root, target, ['data/in.txt'])).toThrow('destination')
      expect(() => prepareWorkerLinks(root, target, ['data'])).toThrow('destination')
      rmSync(join(target, 'data'))
      expect(prepareWorkerLinks(root, target, ['data/in.txt'])).toEqual(['data/in.txt'])
      expect(realpathSync(join(target, 'data', 'in.txt'))).toBe(realpathSync(join(root, 'data', 'in.txt')))
      writeFileSync(join(root, 'present'), 'do not replace')
      expect(() => prepareWorkerLinks(root, target, ['present'])).toThrow('destination')
      expect(readFileSync(join(target, 'present'), 'utf8')).toBe('keep')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('guides a Claude lead only on the first spawn, after a silent solo room_state', async () => {
    expect(claudeWakeUnavailable(dir, 'claude', 'claude')).toBe(true)
    expect(claudeWakeUnavailable(dir, 'codex', 'codex')).toBe(false)
    expect(claudeWakeUnavailable(dir, 'claude', 'claude --dangerously-load-development-channels plugin:room@room')).toBe(false)
    expect(claudeWakeUnavailable(dir, 'claude', 'claude --channels plugin:unrelated@other')).toBe(true)
    vi.stubEnv('ROOM_HOST', 'claude')
    vi.stubEnv('SHELL', '/bin/bash')
    const t = setupLead()
    expect(await t.leadTools.call('room_state', {})).not.toContain('For your human:')
    const reply = await t.leadTools.call('room_spawn', { tag: 'warning', task: 'x' })
    expect(reply.split('\n')[0]).toBe('Block on room_wait in a loop to receive worker questions and completions.')
    expect(reply.split('\n')[1]).toMatch(/^For your human:/)
    expect(reply).toContain('>> ~/.bashrc')
    const second = await t.leadTools.call('room_spawn', { tag: 'another', task: 'y' })
    expect(second).not.toContain('For your human:')
    expect(second).not.toContain('room_wait in a loop')
    await t.leadTools.shutdown()
  })

  it('guides once when another participant is present on room_state', async () => {
    vi.stubEnv('ROOM_HOST', 'claude')
    const t = setupLead()
    const peerDoc = new Y.Doc()
    const peer = new Awareness(peerDoc)
    peer.setLocalState({ user: { name: 'teammate', kind: 'agent' }, status: 'working' })
    applyAwarenessUpdate(t.session!.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
    const first = await t.leadTools.call('room_state', {})
    expect(first).toContain('For your human:')
    expect(await t.leadTools.call('room_state', {})).not.toContain('For your human:')
    const spawn = await t.leadTools.call('room_spawn', { tag: 'after-state', task: 'x' })
    expect(spawn.split('\n')[0]).toBe('Block on room_wait in a loop to receive worker questions and completions.')
    expect(spawn).not.toContain('For your human:')
    peer.destroy()
    peerDoc.destroy()
    await t.leadTools.shutdown()
  })
})

it('reads only the last five non-empty log lines, strips ANSI, and caps output at 600 characters', () => {
  const log = join(dir, 'worker-tail.log')
  try {
    writeFileSync(log, 'old\n' + 'x'.repeat(70_000) + '\n1\n\n2\n3\n\u001b[31m4\u001b[0m\n5\n')
    expect(workerLogTail(log)).toBe('1\n2\n3\n4\n5')
    writeFileSync(log, 'x'.repeat(1000) + '\nlast')
    expect(workerLogTail(log)).toHaveLength(600)
    expect(workerLogTail(log)).toMatch(/last$/)
    expect(workerLogTail(join(dir, 'missing-log'))).toBe('(log unavailable)')
  } finally { rmSync(log, { force: true }) }
})

it('renders Codex JSONL agent and error text without raw event envelopes', () => {
  const log = join(dir, 'worker-jsonl.log')
  try {
    writeFileSync(log, [
      JSON.stringify({ type: 'thread.started', thread_id: '550e8400-e29b-41d4-a716-446655440000' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Checking the failing path.' } }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'The command failed.' } }),
      JSON.stringify({ type: 'error', message: 'Connection lost.' }),
      'process exited with status 1',
    ].join('\n'))
    expect(workerLogTail(log)).toBe('Checking the failing path.\nThe command failed.\nConnection lost.\nprocess exited with status 1')
  } finally { rmSync(log, { force: true }) }
})

describe('worker follow-up sessions', () => {
  it('reports a missing host executable through the start promise', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'room-missing-host-'))
    try {
      const proc = defaultSpawner({ cmd: join(scratch, 'missing-host'), args: [], cwd: scratch, env: {}, logFile: join(scratch, 'worker.log') })
      await expect(proc.started).rejects.toThrow(/ENOENT/)
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  })

  it('preserves Codex JSONL in the process log for recovery', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'room-thread-id-'))
    try {
      const logFile = join(scratch, 'worker.log')
      const id = '550e8400-e29b-41d4-a716-446655440000'
      const proc = defaultSpawner({ cmd: process.execPath, args: ['-e', `process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'${id}'})+'\\n')`], cwd: scratch, env: {}, logFile })
      const exited = new Promise<number | null>(resolve => proc.onExit(resolve))
      expect(await exited).toBe(0)
      expect(readFileSync(logFile, 'utf8')).toContain(`"type":"thread.started","thread_id":"${id}"`)
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  })
  it('records a Claude UUID and resumes a done worker with the same tag, worktree and budget', async () => {
    vi.stubEnv('ROOM_WORKER_NICE', '0')
    vi.stubEnv('ROOM_WORKER_MAX_BUDGET_USD', '3.25')
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'first', host: 'claude', model: 'opus', effort: 'high', threads: 2 })
    const initial = workerByTag(dir, 'money')!
    expect(initial.hostSessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(t.specs[0].args).toContain('--session-id')
    mkdirSync(initial.dir, { recursive: true })
    await reportDone('money', 'first done')
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')?.exitCode).toBe(0))
    const sent = await t.leadTools.call('room_send', { type: 'note', to: 'money', text: 'fix the review finding' })
    expect(sent).toContain("resumed money's retained conversation with your message")
    expect(t.specs[1].env).toMatchObject({ ...t.specs[0].env, ROOM_WORKER_RUN: '2', ROOM_LAUNCH_NONCE: t.specs[1].env.ROOM_LAUNCH_NONCE })
    expect(t.specs[1].env.ROOM_LAUNCH_NONCE).not.toBe(t.specs[0].env.ROOM_LAUNCH_NONCE)
    expect(t.specs[1]).toMatchObject({ cwd: initial.dir, env: { ROOM_TAG: 'money', ROOM_WORKER_THREADS: t.specs[0].env.ROOM_WORKER_THREADS, ROOM_WORKER_MEM_GB: t.specs[0].env.ROOM_WORKER_MEM_GB } })
    expect(t.specs[1].args).toEqual(['-p', '--resume', initial.hostSessionId, 'fix the review finding', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__room__*,mcp__plugin_room_room__*,Edit,Write,Read,Bash,Glob,Grep', '--model', 'opus', '--effort', 'high', '--name', 'money', '--max-budget-usd', '3.25'])
    expect(workerByTag(dir, 'money')).toMatchObject({ status: 'running', hostSessionId: initial.hostSessionId, dir: initial.dir })
  })

  it('refuses a finished-worker follow-up before launch while the hub is paused (F-S5)', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'first', host: 'claude' })
    const worker = workerByTag(dir, 'money')!
    mkdirSync(worker.dir, { recursive: true })
    await reportDone('money', 'finished')
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')?.exitCode).toBe(0))
    vi.spyOn(t.session!.hub, 'paused').mockReturnValue('hub paused')
    vi.spyOn(t.session!, 'post').mockResolvedValue({ ok: false, reason: 'unreachable', text: 'not sent: hub unreachable', msg: {} } as never)
    const reply = await t.leadTools.call('room_send', { type: 'note', to: 'money', text: 'follow up' })
    expect(reply).toContain('not sent: hub unreachable')
    expect(t.specs).toHaveLength(1)
  })

  it('does not resume a finished worker when the post refuses after a successful hello (F-S5 re-review)', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'first', host: 'claude' })
    const worker = workerByTag(dir, 'money')!
    mkdirSync(worker.dir, { recursive: true })
    await reportDone('money', 'finished')
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')?.exitCode).toBe(0))
    vi.spyOn(t.session!, 'post').mockResolvedValue({ ok: false, reason: 'unreachable', text: 'not sent: hub unreachable', msg: {} } as never)
    const reply = await t.leadTools.call('room_send', { type: 'note', to: 'money', text: 'follow up' })
    expect(reply).toContain('not sent: hub unreachable')
    expect(reply).not.toContain('resumed')
    expect(t.specs).toHaveLength(1)
  })

  it('captures the Codex thread ID and resumes a stopped worker with the documented flags', async () => {
    vi.stubEnv('ROOM_WORKER_NICE', '0')
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'first', host: 'codex', model: 'gpt-6-sol', effort: 'high', threads: 2 })
    expect(t.specs[0].args).toContain('--json')
    const registry = await registryForDir(dir), record = registry.list().find(record => record.tag === 'money')!, run = record.runs[0]
    await registry.admit({ id: record.id, run: run.n, nonce: run.nonce, dir: record.dir,
      chain: [], hostSessionId: '550e8400-e29b-41d4-a716-446655440000' })
    expect(registry.read(record.id)?.hostSessionId).toBe('550e8400-e29b-41d4-a716-446655440000')
    const initial = workerByTag(dir, 'money')!
    mkdirSync(initial.dir, { recursive: true })
    t.exits[0](1)
    await vi.waitFor(() => expect(workerByTag(dir, 'money')?.status).toBe('failed'))
    const sent = await t.leadTools.call('room_send', { type: 'note', to: 'rohanz+money', text: 'repair the failure' })
    expect(sent).toContain("resumed money's retained conversation with your message")
    expect(t.specs[1].args).toEqual(['exec', 'resume', '550e8400-e29b-41d4-a716-446655440000', '-c', 'sandbox_mode="workspace-write"', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=high', '--json', 'repair the failure'])
    expect(t.specs[1].cwd).toBe(initial.dir)
    expect(workerByTag(dir, 'money')).toMatchObject({ status: 'running', exitCode: undefined, hostSessionId: '550e8400-e29b-41d4-a716-446655440000' })
  })

  it('waits for a just-finished worker process to exit before resuming its session', async () => {
    vi.stubEnv('ROOM_WORKER_NICE', '0')
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'quickreply', task: 'first', host: 'claude' })
    const w = workerByTag(dir, 'quickreply')!
    mkdirSync(w.dir, { recursive: true })
    await reportDone('quickreply', 'done')
    // Another observer records the exit (§6 then reads done) before this session's process handle reports it.
    const registry = await registryForDir(dir), id = w.id
    await registry.writeExit(id, { run: 1, code: 0, witnessed: true, at: Date.now() })
    expect(workerByTag(dir, 'quickreply')?.status).toBe('done')
    const reply = t.leadTools.call('room_send', { type: 'note', to: 'quickreply', text: 'one more fix' })
    setTimeout(() => t.exits[0](0), 20)
    expect(await reply).toContain("resumed quickreply's retained conversation with your message")
    expect(t.specs).toHaveLength(2)
  })

  it('reserves a fresh port and names it when a resumed worker lost its old port', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'resumeport', task: 'first', host: 'claude' })
    const w = workerByTag(dir, 'resumeport')!
    mkdirSync(w.dir, { recursive: true })
    await reportDone('resumeport', 'first done')
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'resumeport')?.exitCode).toBe(0))
    const other = reserveWorkerPort('other-lead/worker', [], process.env.XDG_CONFIG_HOME, w.port)
    try {
      const reply = await t.leadTools.call('room_send', { type: 'note', to: 'resumeport', text: 'one more task' })
      expect(reply).toContain('dev-server PORT is 4401')
      expect(t.specs[1].env.PORT).toBe('4401')
      expect(t.specs[1].args.join(' ')).toContain('Your dev-server port is 4401 (PORT=4401).')
      expect(workerByTag(dir, 'resumeport')?.port).toBe(4401)
    } finally { other.release(); await t.leadTools.shutdown() }
  })

  it('explains why a collected worker or missing worktree cannot resume', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'missingfollowup', task: 'first', host: 'claude' })
    await reportDone('missingfollowup')
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(dir, 'missingfollowup')?.exitCode).toBe(0))
    rmSync(join(dir, '.room', 'workers', 'missingfollowup'), { recursive: true, force: true })
    expect(await t.leadTools.call('room_send', { type: 'note', to: 'missingfollowup', text: 'fix' })).toContain('worktree no longer exists')
    expect(t.specs).toHaveLength(1)
    const finished = workerByTag(dir, 'missingfollowup')!
    t.a.retireWorker(finished.id, { name: finished.name, tag: finished.tag, lead: finished.lead, host: finished.host, task: finished.task, startedAt: finished.startedAt,
      id: finished.id, summary: 'collected', finishedAt: finished.finishedAt!, retiredAt: Date.now(), files: [], fileCount: 0, outcome: 'dismissed' }, ignore)
    const registry = await registryForDir(dir)
    await registry.update(finished.id!, old => ({ ...old, phase: 'retired', seq: old.seq + 1 }))
    expect(await t.leadTools.call('room_send', { type: 'note', to: 'missingfollowup', text: 'fix' })).toContain('collected or discarded')
    expect(t.specs).toHaveLength(1)
  })
})
