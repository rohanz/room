import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { carriedContentHash, carriedUnchanged, type Baseline } from '../src/baseline.js'
import { CARRIED_PATH, DISK_READ_PATH, LINK_INPUT_PATH, MATERIALIZED_PATH, RECORDED_PATH, containedRepoPath, isInsideRoot, validRepoPath } from '../src/repo-path.js'

let root: string, repo: string, outside: string
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-repo-path-'))
  repo = path.join(root, 'repo'); fs.mkdirSync(repo)
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@room')
  outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'outside')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

it('carriedUnchanged preserves its lexical checks and hashes a link leaf itself', () => {
  fs.writeFileSync(path.join(repo, 'inside'), 'inside')
  fs.mkdirSync(path.join(repo, 'a', '.git'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'a', '.git', 'config'), 'nested')
  fs.symlinkSync('inside', path.join(repo, 'link-inside'))
  fs.symlinkSync(outside, path.join(repo, 'link-outside'))
  const names = ['a\\b', 'a//b', 'a/./b', 'a/../b', '.git/config', 'a/.git/config', '/tmp/nope', 'link-inside', 'link-outside']
  const entries: [string, { sha: string }][] = names.map(name => [name, { sha: 'missing' }])
  // Git's link blob is the link text, not the file reached by the link.
  entries[7][1].sha = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: 'inside', encoding: 'utf8' }).trim()
  entries[8][1].sha = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: outside, encoding: 'utf8' }).trim()
  entries[4][1].sha = carriedContentHash(repo, '.git/config', true)
  entries[5][1].sha = carriedContentHash(repo, 'a/.git/config', true)
  const baseline: Baseline = { worker: 'w', sha: 'base', dir: repo, carriedCommit: false, untracked: new Map(entries) }
  for (const name of ['a\\b', 'a//b', 'a/./b', 'a/../b', '/tmp/nope']) expect(carriedUnchanged(baseline, name)).toBe(false)
  expect(carriedUnchanged(baseline, '.git/config')).toBe(true)
  expect(carriedUnchanged(baseline, 'a/.git/config')).toBe(true)
  expect(carriedUnchanged(baseline, 'link-inside')).toBe(true)
  expect(carriedUnchanged(baseline, 'link-outside')).toBe(true)
  fs.symlinkSync(root, path.join(repo, 'escape'))
  const escaped: Baseline = { ...baseline, untracked: new Map([['escape/outside', { sha: 'missing' }]]) }
  expect(carriedUnchanged(escaped, 'escape/outside')).toBe(false)
})

it('validates component syntax with caller-selected backslash, dot and .git policies', () => {
  const strict = MATERIALIZED_PATH
  for (const rel of ['a\\b', 'a//b', 'a/./b', 'a/../b', '.git/config', 'a/.git/config', '/tmp/nope', 'a\0b']) expect(validRepoPath(rel, strict)).toBe(false)
  expect(validRepoPath('a/b', strict)).toBe(true)
  const read = DISK_READ_PATH
  for (const rel of ['a\\b', 'a//b', 'a/./b', '.git/config', 'a/.git/config']) expect(validRepoPath(rel, read)).toBe(true)
  for (const rel of ['a\\..\\b', 'a/../b', '/tmp/nope']) expect(validRepoPath(rel, read)).toBe(false)
  expect(validRepoPath('a\\b', LINK_INPUT_PATH)).toBe(true)
  expect(validRepoPath('a\\b', RECORDED_PATH)).toBe(true)
  expect(validRepoPath('a\\b', CARRIED_PATH)).toBe(false)
})

it('checks lexical root containment without reading the filesystem', () => {
  const base = path.join(root, 'does-not-exist')
  expect(isInsideRoot(base, path.join(base, 'a'))).toBe(true)
  expect(isInsideRoot(base, base)).toBe(false)
  expect(isInsideRoot(base, base, { allowRoot: true })).toBe(true)
  expect(isInsideRoot(base, path.join(base, '..', 'outside'))).toBe(false)
})

it('separates reject, read-contained and replace link leaf policies', () => {
  fs.mkdirSync(path.join(repo, 'dir'))
  fs.writeFileSync(path.join(repo, 'dir', 'file'), 'inside')
  fs.symlinkSync('dir/file', path.join(repo, 'inside-link'))
  fs.symlinkSync(outside, path.join(repo, 'outside-link'))
  const inside = path.join(repo, 'inside-link'), escaping = path.join(repo, 'outside-link')
  expect(containedRepoPath(repo, inside, { leaf: 'reject-link' })).toEqual({ ok: false, reason: 'link' })
  expect(containedRepoPath(repo, inside, { leaf: 'read-contained-link' })).toEqual({ ok: true, path: fs.realpathSync(path.join(repo, 'dir', 'file')) })
  expect(containedRepoPath(repo, escaping, { leaf: 'read-contained-link' })).toEqual({ ok: false, reason: 'outside' })
  expect(containedRepoPath(repo, escaping, { leaf: 'replace-link' })).toEqual({ ok: true, path: path.join(fs.realpathSync(repo), 'outside-link') })
  fs.symlinkSync('dir', path.join(repo, 'dir-link'))
  expect(containedRepoPath(repo, path.join(repo, 'dir-link', 'file'), { leaf: 'replace-link' })).toEqual({ ok: true, path: path.join(fs.realpathSync(repo), 'dir-link', 'file') })
  expect(containedRepoPath(repo, path.join(repo, 'new'), { leaf: 'reject-link', allowMissing: true })).toEqual({ ok: true, path: path.join(fs.realpathSync(repo), 'new') })
})
