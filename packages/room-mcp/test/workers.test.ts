import { claudeWakeUnavailable } from '../src/prompt.js'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import fs, { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync, lstatSync, realpathSync, chmodSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, shouldWakeOnMsg } from '@room/shared'
import type { Identity, Msg } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { resolveConfig } from '../src/config.js'
import { GraphIndex } from '../src/graph-index.js'
import { prepareWorkerLinks, workerLogTail, workerBudget, workerPriority, defaultSpawner, pidAlive, prepareWorktree, cleanupPreparedWorktree, workerCommand, workerPrompt, validTag, pidIsOurWorker, workerEnv, type SpawnSpec } from '../src/workers.js'

// Disk cleanup and patch restoration are exercised with real worktrees in collect.test.ts.
// These lifecycle tests use synthetic worker directories and controlled process callbacks.
vi.mock('../src/workers.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/workers.js')>(),
  ignoredWorkerArtifacts: vi.fn(async () => []),
  saveDiscardPatch: vi.fn(async () => undefined),
  cleanupWorker: vi.fn(async () => true),
}))

let dir: string
let base: string
const scratchRepos: string[] = []
const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
const workerId: Identity = { name: 'rohanz+money', kind: 'agent', owner: 'rohanz', label: 'money' }

let roomEnv: Record<string, string | undefined>
beforeEach(() => {
  roomEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('ROOM_')))
  for (const key of Object.keys(roomEnv)) delete process.env[key]
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) delete process.env[key]
  Object.assign(process.env, roomEnv)
  for (const repo of scratchRepos.splice(0)) rmSync(repo, { recursive: true, force: true })
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
    provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base } as never,
    shareMax: 'full', shareRequested: 'full',
    ...(local ? { local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} } } : {}),
  } as Session
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-workers-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'rohanz')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})

describe('worker plumbing', () => {
  it('validates tags and builds host commands', () => {
    expect(validTag('money')).toBe('money'); expect(validTag('a b')).toBeUndefined(); expect(validTag('')).toBeUndefined()
    const c = workerCommand('claude', 'claude-sonnet-5', 'do it')
    expect(c.cmd).toBe('claude'); expect(c.args).toContain('--model'); expect(c.args.slice(0, 4)).toEqual(['--dangerously-load-development-channels', 'plugin:room@room', '-p', 'do it'])
    const x = workerCommand('codex', undefined, 'do it')
    expect(x.cmd).toBe('codex'); expect(x.args.slice(0, 3)).toEqual(['exec', '-s', 'workspace-write'])
    expect(workerPrompt('rohanz', 'money', 'switch to cents')).toContain('to "rohanz"')
  })

  it('uses the resolved channel override and supports disabling it', async () => {
    for (const channel of ['plugin:custom@market', '']) {
      const config = await resolveConfig({ dir, env: { ROOM_CLAUDE_CHANNEL: channel } })
      const c = workerCommand('claude', undefined, 'task', config.claudeChannel)
      expect(c.args.slice(0, channel ? 4 : 2)).toEqual(channel ? ['--dangerously-load-development-channels', channel, '-p', 'task'] : ['-p', 'task'])
      expect(workerCommand('codex', undefined, 'task', config.claudeChannel).args).not.toContain('--dangerously-load-development-channels')
    }
  })

  it('creates a worktree on branch room/<tag> and reuses it', async () => {
    const w1 = await prepareWorktree(dir, 'money')
    expect(w1.base).toBe(base); expect(w1.created).toBe(true); expect(w1.branch).toBe('room/money'); expect(existsSync(join(w1.dir, 'app.py'))).toBe(true)
    const w2 = await prepareWorktree(dir, 'money')
    expect(w2.created).toBe(false); expect(w2.dir).toBe(w1.dir)
  })

  it('prunes a stale registration when a worker directory was deleted', async () => {
    const first = await prepareWorktree(dir, 'deleted')
    rmSync(first.dir, { recursive: true, force: true })
    const recreated = await prepareWorktree(dir, 'deleted')
    expect(recreated).toMatchObject({ dir: first.dir, branch: 'room/deleted', created: true })
    expect(existsSync(join(recreated.dir, 'app.py'))).toBe(true)
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

  it('does not make a carry commit for a clean lead or a reused worktree', async () => {
    const { repo, git, head } = realRepo()
    const first = await prepareWorktree(repo, 'clean', 'rohanz')
    expect(first).toMatchObject({ base: head, created: true })
    expect(first.carried).toBeUndefined()
    writeFileSync(join(repo, 'later.txt'), 'later')
    const reused = await prepareWorktree(repo, 'clean', 'rohanz')
    expect(reused.created).toBe(false)
    expect(reused.carried).toBeUndefined()
    expect(existsSync(join(first.dir, 'later.txt'))).toBe(false)
    expect(git('rev-parse', 'room/clean')).toBe(head)
  })

  it('refuses a second room owner for the same worker directory and recovers carry provenance on reuse', async () => {
    const { repo } = realRepo()
    writeFileSync(join(repo, 'modified.txt'), 'lead WIP\n')
    writeFileSync(join(repo, 'untracked.txt'), 'untracked WIP\n')
    const first = await prepareWorktree(repo, 'occupied', 'rohanz', [], 'room-A/rohanz/occupied')
    const reused = await prepareWorktree(repo, 'occupied', 'rohanz', [], 'room-A/rohanz/occupied')
    expect(reused).toMatchObject({ created: false, base: first.base, carriedBase: first.carriedBase, carriedUntracked: first.carriedUntracked })
    await expect(prepareWorktree(repo, 'occupied', 'rohanz', [], 'room-B/rohanz/occupied')).rejects.toThrow(/another room|owned/)
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
    const first = await prepareWorktree(repo, 'retry', 'rohanz', [], 'room-A/retry')
    await cleanupPreparedWorktree(repo, first)
    expect(existsSync(first.dir)).toBe(false)
    expect(git('branch', '--list', first.branch)).toBe('')
    expect(() => git('rev-parse', '--verify', 'refs/room/carry/retry')).toThrow()
    writeFileSync(join(repo, 'modified.txt'), 'second WIP\n')
    const second = await prepareWorktree(repo, 'retry', 'rohanz', [], 'room-A/retry')
    expect(readFileSync(join(second.dir, 'modified.txt'), 'utf8')).toBe('second WIP\n')
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
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, maxWorkers,
      spawner: spec => { specs.push(spec); return { pid: 4242 + specs.length, onExit: cb => { exits.push(cb) }, kill: () => { killed.push(1); return true } } },
      worktree: worktree ?? (async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true, base })),
    })
    let ws: Session | null = fakeSession(b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    return { a, b, leadTools, workerTools, specs, exits, killed }
  }

  it('inherits the caller host and explains worker reporting only once', async () => {
    vi.stubEnv('ROOM_HOST', 'codex')
    try {
      const t = setup()
      const first = await t.leadTools.call('room_spawn', { tag: 'first', task: 'x' })
      const second = await t.leadTools.call('room_spawn', { tag: 'second', task: 'y' })
      expect(t.a.workers.get('first')?.host).toBe('codex')
      expect(first).toContain('reports through room_done'); expect(second).not.toContain('reports through room_done')
      expect(first).not.toContain('tip:')
      expect(first).toContain('browser view: http://x')
      expect(second).not.toContain('browser view:')
      expect(t.specs[0].args.join(' ')).toContain('one-line summary')
      await t.leadTools.shutdown()
    } finally { vi.unstubAllEnvs() }
  })

  it.each(['plugin:custom@market', ''])('passes ROOM_CLAUDE_CHANNEL through room_spawn (%s)', async channel => {
    vi.stubEnv('ROOM_CLAUDE_CHANNEL', channel)
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
      expect(first).toMatch(/carried your 1 uncommitted change into its worktree \(commit [0-9a-f]{10}\)/)
      expect(first).not.toContain('starts from HEAD')
      expect(t.a.workers.get('wip1')?.base).toBe(execFileSync('git', ['-C', join(dir, '.room', 'workers', 'wip1'), 'rev-parse', 'HEAD']).toString().trim())
      expect(await t.leadTools.call('room_spawn', { tag: 'wip2', task: 'b' })).toMatch(/carried your 1 uncommitted change into its worktree/)
      expect(t.a.workers.get('wip2')?.base).toBe(base)
      expect(t.a.workers.get('wip2')?.carriedUntracked?.map(x => x.path)).toEqual(['wip.txt'])
    } finally { rmSync(join(dir, 'wip.txt'), { force: true }) }
    expect(await setup().leadTools.call('room_spawn', { tag: 'wip3', task: 'c' })).not.toMatch(/uncommitted change/)
  })

  it('keeps the 0.10.2 missing-work note on every carry fallback', async () => {
    const t = setup(async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true,
      ...(tag === 'carried' ? { base: 'f'.repeat(40), carried: { count: 1, commit: 'f'.repeat(40) } } : { base, carryFailed: true }) }), 3)
    writeFileSync(join(dir, 'wip.txt'), 'work in progress\n')
    try {
      expect(await t.leadTools.call('room_spawn', { tag: 'carried', task: 'first' })).toContain('carried your 1 uncommitted change')
      const first = await t.leadTools.call('room_spawn', { tag: 'fallback1', task: 'a' })
      expect(first).toContain('1 uncommitted change in your clone is not in this worktree, which starts from HEAD')
      expect(first).not.toContain('carried your')
      expect(await t.leadTools.call('room_spawn', { tag: 'fallback2', task: 'b' })).toContain('1 uncommitted change in your clone is not in this worktree')
    } finally { rmSync(join(dir, 'wip.txt'), { force: true }) }
  })

  it('preserves a surviving worker branch without carrying lead WIP into it', async () => {
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
      expect(out).not.toContain('carried your')
      expect(out).toContain('1 uncommitted change in your clone is not in this worktree')
      expect(t.a.workers.get('reusedbranch')?.base).toBe(base)
      expect(execFileSync('git', ['-C', initial.dir, 'rev-parse', 'HEAD']).toString().trim()).toBe(oldHead)
      expect(readFileSync(join(initial.dir, 'branch.txt'), 'utf8')).toBe('old worker work')
      expect(existsSync(join(initial.dir, 'wip.txt'))).toBe(false)
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
    const w = t.a.workers.get('money')
    expect(w).toMatchObject({ name: 'rohanz+money', status: 'running', lead: 'rohanz', branch: 'room/money', base, host: 'codex', model: 'gpt-5.6', effort: 'medium' })
    const st = await t.leadTools.call('room_state', { all: true })
    expect(st).toContain('workers (1):')
    expect(st).toContain('money (codex gpt-5.6 · medium, running')
    expect(st).toContain('agent of rohanz · money · codex · gpt-5.6 · medium')
    expect(await t.leadTools.call('room_state', {})).toContain('codex · gpt-5.6 · medium')
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'again' })).toContain('already running')
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
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0,
      join: async o => { joins.push({ server: o.server, name: o.name }); return fakeSession(local.a, lead) },
      leave: async s => { left.push(s.roomName) },
      spawner: spec => { specs.push(spec); return { pid: 99, onExit: () => {}, kill: () => true } },
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    const out = await leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents', where: 'local' })
    expect(joins).toEqual([{ server: 'local', name: 'rohanz' }])
    expect(out).toContain('local workers room local/x/main')
    expect(specs[0].env).toMatchObject({ ROOM_SERVER: 'local', ROOM_ROOM: 'local/x/main', ROOM_LEAD: 'rohanz' })
    expect(local.a.workers.get('money')).toMatchObject({ status: 'running', lead: 'rohanz' })
    expect(team.a.workers.get('money')).toBeUndefined()
    // the worker declares a scope and claims in the local room; the team room sees both as the lead's
    local.b.setScope({ by: workerId.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/models.py'] })
    local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: workerId.name, byKind: 'agent', intent: 'bump' })
    expect(team.b.scope('rohanz')?.paths).toEqual(['api/models.py'])
    expect(team.b.openClaims().map(c => c.intent)).toEqual(['[money] bump'])
    expect(team.b.scopes.has(workerId.name)).toBe(false)
    const st = await leadTools.call('room_state', { all: true })
    expect(st).toContain('workers room: local (local/x/main')
    expect(st).toContain('money (claude, running')
    // a worker's done message reaches the lead through the workers room inbox
    let ws: Session | null = fakeSession(local.b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    await workerTools.call('room_done', { summary: 'cents done' })
    expect(await leadTools.call('room_state', {})).toContain('finished: cents done')
    // its process (never exited in this test) is still alive: a plain leave refuses, force dismisses it
    expect(await leadTools.call('room_leave', {})).toContain('still running: money')
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
    expect(t.a.workers.get('money')).toMatchObject({ status: 'failed', exitCode: 0 })
  })

  it('refuses beyond the worker budget', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    await t.leadTools.call('room_spawn', { tag: 'b', task: 'y' })
    expect(await t.leadTools.call('room_spawn', { tag: 'c', task: 'z' })).toContain('max 2')
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

  it.each([{ workerId: 'old-spawn' }, { gen: '0' }])('uses resolved worker identity to protect a newer spawn: %j', async identity => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const s = fakeSession(t.b, workerId)
    const config = { ...await resolveConfig({ dir, env: {} }), ...identity }
    const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, config })
    await tools.call('room_done', { summary: 'old task finished' })
    expect(t.a.workers.get('money')?.status).toBe('running')
    expect(t.a.messages().some(m => m.type === 'done' && m.summary.includes('earlier generation'))).toBe(true)
  })

  it("a worker's room_done reaches its lead as an addressed done message that wakes it, and marks the worker done", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    t.b.setOverlay('rohanz+money', 'app.py', 'x = 100\n')
    const out = await t.workerTools.call('room_done', { summary: 'Money type in cents, 7 tests pass' })
    expect(out).toContain('Your lead rohanz has been told (worker money)')
    const done = t.a.messages().find(m => m.type === 'done') as Msg & { type: 'done' }
    expect(done).toBeTruthy()
    expect(done.to).toBe('rohanz'); expect(done.tag).toBe('money'); expect(done.changed).toEqual(['app.py'])
    expect(shouldWakeOnMsg(lead, done).wake).toBe(true)
    expect(shouldWakeOnMsg({ name: 'someone', kind: 'agent' }, done).wake).toBe(false)
    expect(t.a.workers.get('money')).toMatchObject({ status: 'done', summary: 'Money type in cents, 7 tests pass' })
    // The lead's next tool call shows the done line in its inbox.
    const st = await t.leadTools.call('room_state', {})
    expect(st).toContain('finished: Money type in cents')
    // A later process exit keeps the done status and records the code.
    t.exits[0](0)
    expect(t.a.workers.get('money')).toMatchObject({ status: 'done', exitCode: 0 })
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
    leadSession.lastPreview = { clean: true }
    const textOnly = await tools.call('room_done', { summary: 'local tests failed' })
    expect(textOnly).not.toContain('combined preview passed')
    leadSession.lastPreview = { clean: true, testsPassed: true, testsCommand: 'npm test' }
    const tested = await tools.call('room_done', { summary: 'local tests failed' })
    expect(tested).toContain('The combined preview passed `npm test`.')
    expect(tested).not.toContain('caused by')
  })

  it('a worker that exits without room_done is marked failed regardless of exit code; dismiss kills a running one', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    await t.leadTools.call('room_spawn', { tag: 'b', task: 'y' })
    t.exits[0](1)
    expect(t.a.workers.get('a')).toMatchObject({ status: 'failed', exitCode: 1 })
    await vi.waitFor(() => expect(t.a.messages().some(m => m.type === 'note' && m.to === 'rohanz' && /worker a died .*exit 1/.test(m.text))).toBe(true))
    const discarding = t.leadTools.call('room_collect', { discard: true, tag: 'b' })
    await vi.waitFor(() => expect(t.killed).toHaveLength(1))
    t.exits[1](0)
    const d = await discarding
    expect(d).toContain('discarded b')
    expect(t.killed).toHaveLength(1)
    expect(t.a.workers.has('b')).toBe(false)
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
    let s2: Session | null = derived
    const t2 = createTools({ getSession: () => s2, setSession: x => { s2 = x }, cwd: dir, join: async o => ({ ...fakeSession(a, lead, false), roomName: o.room ?? '?' }), leave: async () => {} })
    expect(await t2.call('room_state', { all: true })).toContain('switched to branch main')
  })
})

function setupLead() {
  const { a, b } = pair()
  a.setMeta({ repo: 'x', branch: 'main', base })
  let ls: Session | null = fakeSession(a, lead)
  const specs: SpawnSpec[] = []
  const exits: ((code: number | null) => void)[] = []
  const killed: number[] = []
  const leadTools = createTools({
    getSession: () => ls, setSession: s => { ls = s }, cwd: dir, maxWorkers: 2,
    spawner: spec => { specs.push(spec); return { pid: 4242 + specs.length, onExit: cb => { exits.push(cb) }, kill: () => { killed.push(1); return true } } },
    worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
  })
  return { a, b, session: ls, leadTools, specs, exits, killed }
}

describe('worker safety', () => {
  it('a pid this session did not spawn is signalled only if it started with the worker record and runs a worker command', () => {
    const rec = { startedAt: 1_000_000, tag: 'money', dir: '/repo/.room/workers/money' }
    const me = process.pid // alive; the probe decides the rest
    expect(pidIsOurWorker(-1, rec)).toBe(false)
    expect(pidIsOurWorker(0, rec)).toBe(false)
    expect(pidIsOurWorker(me, rec, () => ({ start: 1_002_000, command: 'claude -p You are worker "money", dispatched by rohanz' }))).toBe(true)
    expect(pidIsOurWorker(me, rec, () => ({ start: 1_002_000, command: '/usr/local/bin/codex exec -s workspace-write worker money' }))).toBe(true)
    // recycled pid: right command line, wrong start time
    expect(pidIsOurWorker(me, rec, () => ({ start: 1_020_000, command: 'claude -p worker money' }))).toBe(false)
    // right time, unrelated process
    expect(pidIsOurWorker(me, rec, () => ({ start: 1_001_000, command: 'vim README.md' }))).toBe(false)
    // a worker command that does not mention this worker
    expect(pidIsOurWorker(me, rec, () => ({ start: 1_001_000, command: 'claude -p something else' }))).toBe(false)
    expect(pidIsOurWorker(me, rec, () => undefined)).toBe(false)
    // pid 1 is alive but a real probe will never match a worker record
    expect(pidIsOurWorker(1, rec)).toBe(false)
  })

  it('dismissing a worker whose process is unknown and old leaves the pid alone and keeps its status', async () => {
    const { a, b } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    // a worker record left by a lead that has since restarted: pid 1 is alive but not ours
    a.setWorker({ tag: 'ghost', name: 'rohanz+ghost', host: 'claude', task: 'x', dir, branch: 'room/ghost', pid: 1, startedAt: Date.now(), status: 'running', lead: 'rohanz' })
    let ls: Session | null = fakeSession(b, lead)
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir })
    const out = await tools.call('room_collect', { discard: true, tag: 'ghost' })
    expect(out).toMatch(/^could not discard ghost: pid 1 not signalled/)
    expect(a.workers.get('ghost')?.status).toBe('running') // nothing was signalled, so nothing changed
  })

  it('room_leave refuses while workers run, force dismisses them; shutdown dismisses too', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    const refused = await t.leadTools.call('room_leave', {})
    expect(refused).toContain('error: 1 worker(s) still running: a')
    expect(t.a.workers.get('a')?.status).toBe('running')
    const left = await t.leadTools.call('room_leave', { force: true })
    expect(left).toContain('left local/x/main')
    expect(t.killed).toHaveLength(1)
    expect(t.a.workers.get('a')?.status).toBe('dismissed')
    expect(t.a.messages().some(m => m.type === 'note' && /dismissed worker a .*the lead left/.test((m as { text: string }).text))).toBe(true)
    // shutdown path
    const t2 = setupLead()
    await t2.leadTools.call('room_spawn', { tag: 'b', task: 'y' })
    await t2.leadTools.shutdown()
    expect(t2.killed).toHaveLength(1)
    expect(t2.a.workers.get('b')).toMatchObject({ status: 'dismissed', stopReason: 'lead-session-ended' })
    t2.exits[0](null)
    await vi.waitFor(() => expect(t2.a.workers.get('b')?.exitCode).toBe(-1))
    expect(t2.a.messages().some(m => m.type === 'note' && m.text.includes('died'))).toBe(false)
    const session = fakeSession(t2.a, lead)
    const next = createTools({ getSession: () => session, setSession: () => {}, cwd: dir })
    expect(await next.call('room_state', {})).toContain('stopped when your last session ended; its partial work is in its worktree')
    await next.shutdown()
  })

  it('a worker that cannot start is marked failed', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead)
    let onErr: ((e: Error) => void) | undefined
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir,
      spawner: () => ({ pid: -1, onExit: () => {}, onError: cb => { onErr = cb }, kill: () => { throw new Error('must not signal') } }),
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    await tools.call('room_spawn', { tag: 'nope', task: 'x', host: 'codex' })
    onErr!(new Error('spawn codex ENOENT'))
    expect(a.workers.get('nope')).toMatchObject({ status: 'failed', exitCode: -1 })
    await vi.waitFor(() => expect(a.messages().some(m => m.type === 'note' && /could not start codex: spawn codex ENOENT/.test((m as { text: string }).text))).toBe(true))
    // dismissing it never signals anything
    expect(await tools.call('room_collect', { discard: true, tag: 'nope' })).toContain('discarded nope')
  })

  it('room_spawn refuses a dir outside the repo unless allowOutside, and then skips worktree bookkeeping', async () => {
    const t = setupLead()
    const outside = mkdtempSync(join(tmpdir(), 'room-outside-'))
    execFileSync('git', ['-C', outside, 'init', '-q', '-b', 'elsewhere'], { stdio: 'pipe' })
    writeFileSync(join(outside, 'f.txt'), 'x\n')
    execFileSync('git', ['-C', outside, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { stdio: 'pipe' })
    execFileSync('git', ['-C', outside, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { stdio: 'pipe' })
    const refused = await t.leadTools.call('room_spawn', { tag: 'far', task: 'x', dir: outside })
    expect(refused).toContain('outside this repo')
    expect(t.specs).toHaveLength(0)
    const ok = await t.leadTools.call('room_spawn', { tag: 'far', task: 'x', dir: outside, allowOutside: true })
    expect(ok).toContain('outside this repo, so no worktree was made')
    expect(t.a.workers.get('far')).toMatchObject({ dir: outside, branch: 'elsewhere' })
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
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0,
      join: async () => fakeSession(local.a, teamLead),
      leave: async () => {},
      spawner: spec => { specs.push(spec); return { pid: 99, onExit: () => {}, kill: () => true } },
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    await leadTools.call('room_spawn', { tag: 'money', task: 't', where: 'local' })
    expect(specs[0].env.ROOM_OWNER).toBe('rohanz')
    expect(local.a.workers.get('money')!.name).toBe('rohanz+money')
    await leadTools.call('room_leave', { force: true })
  })

  it('a shared-token server reaches the worker as a bare URL plus ROOM_TOKEN, whatever way the lead got the token (fix 10, W1)', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'main', base })
    // A short hex token (e.g. abc) can occur in the Git SHA printed by room_state.
    const token = 'worker-test-secret-token'
    // The lead joined with a token in the URL: only the session knows it, not the environment.
    let ls: Session | null = { ...fakeSession(a, lead, false), roomUrl: 'ws://team.example/local%2Fx%2Fmain', token } as Session
    const specs: SpawnSpec[] = []
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir, spawner: spec => { specs.push(spec); return { pid: 5, onExit: () => {}, kill: () => true } }, worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }) })
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
    expect(t.a.workers.get('money')!.status).toBe('done')
    setTimeout(() => t.exits[0](0), 10)
    expect(await t.leadTools.call('room_collect', { discard: true, tag: 'money' })).toContain('discarded money')
    expect(t.killed).toHaveLength(1)
    expect(t.a.workers.has('money')).toBe(false)
    // shutdown with a live process behind a done record signals it as well
    await t.leadTools.call('room_spawn', { tag: 'tiers', task: 't' })
    let ws2: Session | null = fakeSession(t.b, { name: 'rohanz+tiers', kind: 'agent', owner: 'rohanz', label: 'tiers' })
    const tiersTools = createTools({ getSession: () => ws2, setSession: s => { ws2 = s }, cwd: dir })
    await tiersTools.call('room_done', { summary: 'x' })
    await t.leadTools.shutdown()
    expect(t.killed).toHaveLength(2)
  })

  it('a reused tag refuses while the old process lives, and a stale exit callback cannot touch the new record (fix 9)', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'first' })
    expect(t.a.workers.get('money')!.gen).toBe(1)
    // Discard must not report success until its process exits.
    const discarding = t.leadTools.call('room_collect', { discard: true, tag: 'money' })
    await new Promise(resolve => setTimeout(resolve, 1))
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'second' })).toContain('process is still alive')
    t.exits[0](1)
    expect(await discarding).toContain('discarded money')
    await vi.waitFor(() => expect(t.a.workers.has('money')).toBe(false))
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'second' })
    const second = t.a.workers.get('money')!
    expect(second).toMatchObject({ status: 'running', task: 'second', gen: second.gen })
    t.exits[0](1) // the first process finally dies
    expect(t.a.workers.get('money')).toMatchObject({ status: 'running', task: 'second', gen: second.gen })
    t.exits[1](0)
    expect(t.a.workers.get('money')).toMatchObject({ status: 'failed', gen: second.gen })
    // and while a process is alive the tag cannot be reused
    await t.leadTools.call('room_spawn', { tag: 'x', task: 't' })
    expect(await t.leadTools.call('room_spawn', { tag: 'x', task: 'again' })).toContain('already running')
  })
})

describe('review fixes: the workers room', () => {
  function setupBridged(queue?: (id: string, text: string) => Promise<void>) {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(team.a, lead, false)
    ls!.roomName = 'github.com/rohanz/x/main'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx%2Fmain'
    const attached: string[] = []
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0, queue,
      attachChannel: s => { attached.push(s.roomName) },
      join: async () => fakeSession(local.a, lead),
      leave: async () => {},
      spawner: () => ({ pid: 99, onExit: () => {}, kill: () => true }),
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    let ws: Session | null = fakeSession(local.b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    return { team, local, leadTools, workerTools, attached }
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
    writeFileSync(join(dir, '.git', 'room-session.json'), JSON.stringify({ session_id: 'thread-lead', at: Date.now(), cwd: dir, host: 'codex' }))
    await t.leadTools.call('room_spawn', { tag: 'money', task: 't', where: 'local' })
    expect(t.attached).toEqual(['local/x/main'])
    await t.workerTools.call('room_send', { type: 'question', text: 'which field?', to: 'rohanz' })
    await new Promise(r => setTimeout(r, 200))
    expect(woken.some(x => x.includes('which field?'))).toBe(true)
    await t.workerTools.call('room_done', { summary: 'all in cents' })
    await new Promise(r => setTimeout(r, 200))
    expect(woken.some(x => x.includes('all in cents'))).toBe(true)
    await t.leadTools.call('room_leave', { force: true })
  })
})

describe('workers review: env, keys, sessions, reservation, signals', () => {
  it('W1: a worker gets exactly its own room variables; the lead\'s ROOM_URL/ROOM_NAME/ROOM_DIR and token never leak', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 't' })
    const env = t.specs[0].env
    expect(Object.keys(env).filter(k => k.startsWith('ROOM_')).sort()).toEqual(['ROOM_DIR', 'ROOM_GEN', 'ROOM_LEAD', 'ROOM_LOG_FILE', 'ROOM_OWNER', 'ROOM_ROOM', 'ROOM_SERVER', 'ROOM_SHARE', 'ROOM_TAG', 'ROOM_WORKER_HOST', 'ROOM_WORKER_ID', 'ROOM_WORKER_MEM_GB', 'ROOM_WORKER_THREADS'])
    expect(env).toMatchObject({ ROOM_SERVER: 'local', ROOM_ROOM: 'local/x/main', ROOM_TAG: 'money', ROOM_LEAD: 'rohanz', ROOM_OWNER: 'rohanz', ROOM_GEN: '1', ROOM_SHARE: 'full' })
    expect(env.ROOM_DIR).toBe(join(dir, '.room', 'workers', 'money'))
    expect(env.ROOM_LOG_FILE).toBe(join(dir, '.room', 'workers', 'money.mcp.log'))
    // the real spawner strips the lead's own room variables from the inherited environment before applying the spec's
    const merged = workerEnv({ PATH: '/bin', ROOM_URL: 'ws://lead/room', ROOM_NAME: 'rohanz', ROOM_DIR: '/lead', ROOM_TOKEN: 'secret', ROOM_TAG: 'lead', ROOM_MAX_WORKERS: '3' }, env)
    expect(merged.ROOM_URL).toBeUndefined(); expect(merged.ROOM_NAME).toBeUndefined(); expect(merged.ROOM_TOKEN).toBeUndefined()
    expect(merged).toMatchObject({ PATH: '/bin', ROOM_MAX_WORKERS: '3', ROOM_DIR: env.ROOM_DIR, ROOM_TAG: 'money' })
    // a second spawn of a reused tag carries the next generation
    t.exits[0](0)
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'again' })).toContain('still holds its room state')
    await t.leadTools.call('room_collect', { discard: true, tag: 'money' })
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'again' })
    expect(Number(t.specs[1].env.ROOM_GEN)).toBeGreaterThan(1)
  })

  it('W2/W3: the same tag in the lead\'s room and the workers room are two processes; reads and diffs of a local worker come from the workers room', async () => {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(team.a, lead, false)
    ls!.roomName = 'github.com/rohanz/x/main'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx%2Fmain'
    const killed: string[] = []
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0,
      join: async () => fakeSession(local.a, lead),
      leave: async () => {},
      spawner: spec => ({ pid: 99, onExit: () => {}, kill: () => { killed.push(spec.env.ROOM_ROOM); return true } }),
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', `routing-${tag}`), branch: `room/${tag}`, created: true }),
    })
    await leadTools.call('room_spawn', { tag: 'money', task: 'team side' })
    await leadTools.call('room_spawn', { tag: 'money', task: 'local side', where: 'local' })
    expect(team.a.workers.get('money')?.task).toBe('team side')
    expect(local.a.workers.get('money')?.task).toBe('local side')
    // the local worker edits in the workers room; the team-room lead reads and diffs its version
    local.b.setOverlay('rohanz+money', 'app.py', 'x = 100\n')
    local.b.setOverlay('rohanz+tiers', 'tiers.py', 'tier = "gold"\n')
    const read = await leadTools.call('room_read', { path: 'app.py', person: 'rohanz+money' })
    expect(read).toContain('x = 100')
    expect(read).toContain('as rohanz+money sees it')
    expect(await leadTools.call('room_read', { diff: true, path: 'app.py', person: 'rohanz+money' })).toContain('+x = 100')
    expect(await leadTools.call('room_state', { path: 'app.py' })).toContain('uncommitted changes by: rohanz+money')
    const pm = await leadTools.call('room_preview_merge', { person: 'rohanz+money' })
    expect(pm, pm).toContain('no conflicts')
    const all = await leadTools.call('room_preview_merge', { people: ['rohanz+money', 'rohanz+tiers'], run: 'cat app.py tiers.py' })
    expect(all).toContain('x = 100')
    expect(all).toContain('tier = "gold"')
    expect(all).toContain('exit 0')
    expect(all).toMatch(/tests: exit 0 \(no test summary recognised\)$/)
    const failed = await leadTools.call('room_preview_merge', { people: ['rohanz+money', 'rohanz+tiers'], run: "printf 'Tests: 1 failed, 1 total\\n'; exit 3" })
    expect(failed).toMatch(/Tests: 1 failed, 1 total\ntests: FAILED \(exit 3\)$/)
    // dismissing the team-room worker signals only the team-room process; the local one is untouched
    await leadTools.call('room_collect', { discard: true, tag: 'money' })
    expect(killed).toEqual(['github.com/rohanz/x/main'])
    expect(local.a.workers.get('money')?.status).toBe('running')
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
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir,
      spawner: spec => { specs.push(spec); return { pid: 7, onExit: () => {}, kill: () => true } },
      worktree: async (repo, tag) => { entered(); await gate; return { dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true } },
    })
    const first = tools.call('room_spawn', { tag: 'money', task: 'one' })
    await preparing // the first spawn holds the reservation before the second races it
    const second = await tools.call('room_spawn', { tag: 'money', task: 'two' })
    expect(second).toContain('being spawned right now')
    release()
    expect(await first).toContain('spawned money')
    expect(specs).toHaveLength(1)
    expect(a.workers.get('money')?.task).toBe('one')
    // the reservation is released once the spawn has finished (or failed)
    expect(await tools.call('room_spawn', { tag: 'money', task: 'three' })).toContain('already running')
  })

  it('W5: after a lead restart, a done worker whose process is still ours can be stopped by dismiss, leave and shutdown', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'main', base })
    const startedAt = Date.now()
    // a stand-in for the worker process that outlived the lead: its own process group, so the signal cannot reach the test runner
    const child = spawn('sleep', ['100'], { detached: true, stdio: 'ignore' }); child.unref()
    const exited = new Promise<void>(r => child.once('exit', () => r()))
    // a record from before the restart: no entry in procs, but ps says this pid is the worker's claude
    a.setWorker({ tag: 'money', name: 'rohanz+money', host: 'claude', task: 'x', dir: '/repo/.room/workers/money', branch: 'room/money', pid: child.pid!, startedAt, status: 'done', lead: 'rohanz', gen: 1, summary: 'done but alive' })
    let ls: Session | null = fakeSession(a, lead)
    const probe = () => ({ start: startedAt, command: 'claude -p You are worker "money"' })
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir, probe })
    expect(await tools.call('room_leave', {})).toContain('still running: money')
    expect(await tools.call('room_spawn', { tag: 'money', task: 'again' })).toContain('done but its process is still alive')
    const out = await tools.call('room_collect', { discard: true, tag: 'money' })
    expect(out).toContain('discarded money')
    expect(a.workers.has('money')).toBe(false)
    await exited
  })

  it('W8: dismiss marks a worker dismissed only when the signal was delivered', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead)
    let deliverable = false
    let exit: (code: number | null) => void = () => {}
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir,
      spawner: () => ({ pid: 8, onExit: cb => { exit = cb }, kill: () => { if (deliverable) setTimeout(() => exit(0), 1); return deliverable } }),
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    await tools.call('room_spawn', { tag: 'money', task: 't' })
    const refused = await tools.call('room_collect', { discard: true, tag: 'money' })
    expect(refused).toMatch(/^could not discard money: pid 8 not signalled:/)
    expect(a.workers.get('money')?.status).toBe('running')
    expect(a.messages().some(m => m.type === 'note' && /could not dismiss worker money/.test((m as { text: string }).text))).toBe(true)
    deliverable = true
    expect(await tools.call('room_collect', { discard: true, tag: 'money' })).toContain('discarded money')
    expect(a.workers.has('money')).toBe(false)
  })
})

describe('review round 3', () => {
  it("a tag held by another lead's running worker is refused, and its record is never touched", async () => {
    const t = setupLead()
    t.a.setWorker({ tag: 'money', name: 'kieran+money', host: 'claude', task: 'theirs', dir: '/x', branch: 'room/money', pid: 4242, startedAt: Date.now(), status: 'running', lead: 'kieran', gen: 1 })
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'mine' })).toContain("in use by kieran's worker")
    expect(t.a.workers.get('money')).toMatchObject({ lead: 'kieran', status: 'running' })
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
    expect(replies.some(r => r.includes('2 workers already running'))).toBe(true)
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

it('passes explicit effort to Codex and leaves Claude effort in the prompt', () => {
  expect(workerCommand('claude', undefined, 'task', '', 'medium').args).not.toContain('--effort')
  expect(workerCommand('claude', undefined, 'task').args).not.toContain('--effort')
  expect(workerCommand('codex', undefined, 'task', '', 'medium').args).toContain('model_reasoning_effort=medium')
  expect(workerCommand('codex', undefined, 'task').args).not.toContain('-c')
  expect(workerEnv({ ROOM_WORKER_HOST: 'claude', ROOM_WORKER_MODEL: 'old', ROOM_WORKER_EFFORT: 'high' }, {})).toEqual({})
})

describe('retirement integration', () => {
  it('archives a done worker only after its dismissed process exits, preserving its summary and files', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'archive me' })
    t.a.setOverlay('rohanz+money', 'app.py', 'x = 2\n')
    t.a.updateWorker('money', { status: 'done', summary: 'implemented money', finishedAt: Date.now() })
    const discarding = t.leadTools.call('room_collect', { discard: true, tag: 'money' })
    await new Promise(resolve => setTimeout(resolve, 1))
    expect(t.a.retiredWorkers()).toEqual([])
    t.exits[0](0)
    expect(await discarding).toContain('discarded money')
    await vi.waitFor(() => expect(t.a.workers.has('money')).toBe(false))
    expect(t.a.retiredWorkers()).toMatchObject([{ name: 'rohanz+money', summary: 'discarded', files: [], outcome: 'dismissed' }])
    expect(t.a.changedPaths('rohanz+money')).toEqual([])
    await t.leadTools.shutdown()
  })

  it('a merge preview retains a done worker with uncommitted work and zero commits', async () => {
    const t = setupLead()
    execFileSync('git', ['-C', dir, 'branch', 'room/finished'])
    writeFileSync(join(dir, 'uncommitted-retirement-check'), 'dirty')
    t.a.setWorker({ tag: 'finished', name: 'rohanz+finished', host: 'codex', task: 'x', dir, branch: 'room/finished', pid: -1, startedAt: 1, status: 'done', lead: 'rohanz', exitCode: 0 })
    await t.leadTools.call('room_preview_merge', {})
    expect(t.a.retiredWorkers()).toEqual([])
    expect(t.a.workers.has('finished')).toBe(true)
    await t.leadTools.call('room_collect', { discard: true, tag: 'finished' })
    const retired = t.a.retiredWorkers()[0]
    expect(retired).toMatchObject({ tag: 'finished', outcome: 'dismissed' })
    expect(retired.uncommitted).toBeUndefined()
    expect(await t.leadTools.call('room_state', { all: true })).toContain('discarded')
    expect(existsSync(join(dir, 'uncommitted-retirement-check'))).toBe(true)
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
      expect(t.a.workers.get('linked')?.link).toEqual([source])
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
