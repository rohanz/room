import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pushedFacts } from '../src/base.js'
import { workerChangedPaths } from '../src/baseline.js'

it('lists both exact rename paths in worker changes and base movement facts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-rename-paths-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  const oldPath = ' café "quoted"\tline\nname.txt ', newPath = 'renamed.txt'
  try {
    git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.test')
    git('config', 'diff.renames', 'true'); git('config', 'core.quotePath', 'true')
    writeFileSync(join(dir, oldPath), 'original\n')
    git('add', '.'); git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')
    git('mv', '--', oldPath, newPath)
    expect(git('diff', '--name-status', 'HEAD')).toMatch(/^R100\s/)
    expect.soft(await workerChangedPaths({ name: 'worker', dir, base })).toEqual([oldPath, newPath].sort())
    git('commit', '-qm', 'rename')
    const facts = await pushedFacts(dir, base, git('rev-parse', 'HEAD'))
    expect(facts).toEqual({ commits: 1, paths: [oldPath, newPath].sort(), summary: 'rename' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
