import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { RetainedDeclaredPaths, retainedDeclaredFile } from '../src/retained-declared.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

it('stores declared paths in the private git dir and restores additions, deletions and withdrawal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-retained-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'base'])
  const sibling = path.join(dir, 'sibling')
  execFileSync('git', ['-C', dir, 'worktree', 'add', '-qb', 'sibling', sibling])
  const first = new RetainedDeclaredPaths(dir, 'room-a', 'Alice', 'ws://server-a')
  first.add('src/a.py')
  first.add('src/b.py')
  expect([...new RetainedDeclaredPaths(dir, 'room-a', 'Alice', 'ws://server-a')]).toEqual(['src/a.py', 'src/b.py'])
  expect([...new RetainedDeclaredPaths(sibling, 'room-a', 'Alice', 'ws://server-a')]).toEqual([])
  first.delete('src/a.py')
  expect([...new RetainedDeclaredPaths(dir, 'room-a', 'Alice', 'ws://server-a')]).toEqual(['src/b.py'])
  first.clear()
  expect([...new RetainedDeclaredPaths(dir, 'room-a', 'Alice', 'ws://server-a')]).toEqual([])
  expect(fs.existsSync(retainedDeclaredFile(dir, 'room-a', 'Alice', 'ws://server-a'))).toBe(false)
})

it('keeps separate team and local workers room records in one checkout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-retained-identity-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', dir])
  const a = new RetainedDeclaredPaths(dir, 'repo/main', 'Alice', 'wss://server-a')
  a.add('secret.py')
  const b = new RetainedDeclaredPaths(dir, 'local/repo/main', 'Alice', 'ws://127.0.0.1:1234')
  b.add('public.py')
  expect([...new RetainedDeclaredPaths(dir, 'repo/main', 'Alice', 'wss://server-a')]).toEqual(['secret.py'])
  expect([...new RetainedDeclaredPaths(dir, 'local/repo/main', 'Alice', 'ws://127.0.0.1:1234')]).toEqual(['public.py'])
  b.clear()
  expect([...new RetainedDeclaredPaths(dir, 'repo/main', 'Alice', 'wss://server-a')]).toEqual(['secret.py'])
  expect(path.basename(retainedDeclaredFile(dir, 'repo/main', 'Alice', 'wss://server-a'))).toMatch(/^room-retained-declared-[a-f0-9]{64}\.json$/)
})

it('migrates a matching legacy record without letting another identity touch it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-retained-upgrade-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', dir])
  const legacy = path.join(dir, '.git', 'room-retained-declared.json')
  fs.writeFileSync(legacy, JSON.stringify({ server: 'wss://team', room: 'repo/main', participant: 'Alice', paths: ['src/kept.py'] }))
  expect([...new RetainedDeclaredPaths(dir, 'local/repo/main', 'Alice', 'ws://local')]).toEqual([])
  expect(fs.existsSync(legacy)).toBe(true)
  expect([...new RetainedDeclaredPaths(dir, 'repo/main', 'Alice', 'wss://team')]).toEqual(['src/kept.py'])
  expect(fs.existsSync(legacy)).toBe(false)
  expect(fs.existsSync(retainedDeclaredFile(dir, 'repo/main', 'Alice', 'wss://team'))).toBe(true)
})

it('does not publish retained paths from another server with the same room and participant', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-retained-server-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', dir])
  const a = new RetainedDeclaredPaths(dir, 'repo/main', 'Alice', 'wss://alice:secret@server-a.example/?token=secret')
  a.add('private/a.py')
  // The same checkout and name are switched to B. Its first publish must see no A paths.
  const b = new RetainedDeclaredPaths(dir, 'repo/main', 'Alice', 'wss://server-b.example')
  expect([...b]).toEqual([])
  b.add('public/b.py')
  expect([...new RetainedDeclaredPaths(dir, 'repo/main', 'Alice', 'wss://server-b.example/')]).toEqual(['public/b.py'])
  expect([...new RetainedDeclaredPaths(dir, 'repo/main', 'Alice', 'wss://server-a.example')]).toEqual(['private/a.py'])
})
