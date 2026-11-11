import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { realRepo, setupLead } from './workers-fixture.js'
import * as baseline from '@room/roomd/baseline'

function staleCheckout() {
  const fixture = realRepo(), dir = path.join(fixture.repo, '.room/workers/stale')
  fixture.git('worktree', 'add', '-q', '--detach', dir)
  const admin = fixture.git('-C', dir, 'rev-parse', '--absolute-git-dir')
  fs.rmSync(dir, { recursive: true })
  return { ...fixture, dir, admin }
}

it('leaves a locked missing registration untouched', async () => {
  const { repo, head, git, dir, admin } = staleCheckout()
  git('worktree', 'lock', '--reason', 'user lock', dir)
  const before = git('worktree', 'list', '--porcelain', '-z'), t = setupLead(repo, head)
  expect(await t.leadTools.call('room_spawn', { tag: 'stale', task: 'x' })).toContain('error:')
  expect(git('worktree', 'list', '--porcelain', '-z')).toBe(before)
  expect(fs.readFileSync(path.join(admin, 'locked'), 'utf8')).toContain('user lock')
  expect(t.specs).toHaveLength(0)
})

it('rechecks a directory that reappears while the registration listing is read', async () => {
  const { repo, head, git, dir } = staleCheckout(), t = setupLead(repo, head)
  const before = git('worktree', 'list', '--porcelain', '-z'), run = baseline.boundedGitSync
  let returned = false
  vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
    const result = run(...args)
    if (!returned && args[1].includes('worktree') && args[1].includes('list')) {
      returned = true
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, 'precious.txt'), 'user directory')
    }
    return result
  })
  expect(await t.leadTools.call('room_spawn', { tag: 'stale', task: 'x' })).toContain('error:')
  expect(returned).toBe(true)
  expect(fs.readFileSync(path.join(dir, 'precious.txt'), 'utf8')).toBe('user directory')
  expect(git('worktree', 'list', '--porcelain', '-z')).toBe(before)
})

// v0.17.47 loses the same returned clean/ignored files: after recreation before its
// global prune, add refuses, then guessed-created rollback removes the checkout.
// Non-force removal improves dirty-checkout preservation but is not an atomic absence guard.
for (const kind of ['plain', 'dirty', 'clean', 'ignored'] as const) {
  const check = kind === 'clean' || kind === 'ignored' ? it.fails : it
  check(`preserves a ${kind} directory that reappears just before non-force removal`, async () => {
    const { repo, head, git, dir } = staleCheckout(), t = setupLead(repo, head), run = baseline.boundedGitSync
    let returned = false
    vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
      if (!returned && args[1].includes('worktree') && args[1].includes('remove') && args[1].includes(dir)) {
        expect(args[1]).not.toContain('--force')
        returned = true
        if (kind === 'plain') fs.mkdirSync(dir)
        else {
          // Another actor clears the stale registration, then creates a user checkout.
          git('worktree', 'remove', dir)
          git('worktree', 'add', '-q', '-b', 'user-returned', dir)
        }
        fs.writeFileSync(path.join(dir, 'precious.txt'), 'user output')
        if (kind === 'clean' || kind === 'ignored') {
          git('-C', dir, 'add', 'precious.txt')
          git('-C', dir, 'commit', '-qm', 'user output')
        }
        if (kind === 'ignored') fs.writeFileSync(path.join(dir, 'ignored.txt'), 'irreplaceable ignored output')
      }
      return run(...args)
    })
    const reply = await t.leadTools.call('room_spawn', { tag: 'stale', task: 'x' })
    expect(returned).toBe(true)
    if (kind === 'ignored') expect(fs.existsSync(path.join(dir, 'ignored.txt')), reply).toBe(true)
    expect(fs.existsSync(path.join(dir, 'precious.txt')), reply).toBe(true)
    if (kind === 'ignored') expect(fs.readFileSync(path.join(dir, 'ignored.txt'), 'utf8')).toBe('irreplaceable ignored output')
    expect(t.specs, reply).toHaveLength(0)
  })
}

it.each(['list', 'remove'] as const)('reports a Git %s failure and leaves the missing registration unchanged', async command => {
  const { repo, head, git } = staleCheckout(), t = setupLead(repo, head), run = baseline.boundedGitSync
  const before = git('worktree', 'list', '--porcelain', '-z')
  vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
    if (args[1].includes('worktree') && args[1].includes(command)) throw new Error(`simulated Git ${command} unsupported`)
    return run(...args)
  })
  const reply = await t.leadTools.call('room_spawn', { tag: 'stale', task: 'x' })
  expect(reply).toContain(`could not create a worktree for stale: simulated Git ${command} unsupported`)
  expect(git('worktree', 'list', '--porcelain', '-z')).toBe(before)
  expect(t.specs).toHaveLength(0)
})
