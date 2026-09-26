import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { RetainedDeclaredPaths } from '../src/retained-declared.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

it('stores declared paths in the private git dir and restores additions, deletions and withdrawal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-retained-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'base'])
  const sibling = path.join(dir, 'sibling')
  execFileSync('git', ['-C', dir, 'worktree', 'add', '-qb', 'sibling', sibling])
  const first = new RetainedDeclaredPaths(dir)
  first.add('src/a.py')
  first.add('src/b.py')
  expect([...new RetainedDeclaredPaths(dir)]).toEqual(['src/a.py', 'src/b.py'])
  expect([...new RetainedDeclaredPaths(sibling)]).toEqual([])
  first.delete('src/a.py')
  expect([...new RetainedDeclaredPaths(dir)]).toEqual(['src/b.py'])
  first.clear()
  expect([...new RetainedDeclaredPaths(dir)]).toEqual([])
  expect(fs.existsSync(path.join(dir, '.git', 'room-retained-declared.json'))).toBe(false)
})
