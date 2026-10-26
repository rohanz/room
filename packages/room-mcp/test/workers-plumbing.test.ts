import { base, createTools, dir, fakeSession, lead, pair, realRepo, scratchRepos } from './workers-fixture.js'
import { setParticipantBase } from '@room/shared/testing'
import { execFileSync } from 'node:child_process'
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import type { Session } from '../src/session.js'
import { validTag, workerCommand, workerPrompt } from '../src/worker-config.js'
import { cleanupPreparedWorktree, prepareWorktree } from '../src/worker-git.js'

describe('worker plumbing', () => {
  it('validates tags and builds host commands', () => {
    expect(validTag('money')).toBe('money'); expect(validTag('a b')).toBeUndefined(); expect(validTag('')).toBeUndefined()
    const c = workerCommand('claude', 'claude-sonnet-5', 'do it')
    expect(c.cmd).toBe('claude'); expect(c.args).toContain('--model'); expect(c.args.slice(0, 2)).toEqual(['-p', 'do it'])
    const x = workerCommand('codex', undefined, 'do it')
    expect(x.cmd).toBe('codex'); expect(x.args.slice(0, 3)).toEqual(['exec', '-s', 'workspace-write'])
    expect(x.args).toContain('--json')
    const prompt = workerPrompt('rohanz', 'money', 'switch to cents')
    expect(prompt).toContain('Ask the peer responsible for a dependency directly with room_send(type "question", to "<returned peer name>")')
    expect(prompt).toContain('ask rohanz for scope decisions or unresolved ownership')
    expect(prompt).toContain('Continue independent work while an answer is pending')
    expect(prompt).toContain('TASK: switch to cents')
    expect(prompt).toContain("write only inside it, never into the lead's checkout or another worker's worktree")
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

  it('refuses an unmanaged surviving branch and preserves its commits, carry refs and lead WIP', async () => {
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
    writeFileSync(join(repo, 'modified.txt'), 'lead WIP')

    const { a } = pair()
    a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, git('rev-parse', 'HEAD'))
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
      expect(readFileSync(join(repo, 'modified.txt'), 'utf8')).toBe('lead WIP')
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
