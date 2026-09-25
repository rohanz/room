import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { roomFilePath } from '../src/room-file.js'
import { gitRoot, gitStatePath } from '../../../plugins/room/hooks/common.mjs'
import { carryRecordSync, commonGitDirFromDotGit, gitCommonDir, realGitCommonDir, worktreeGitDirFromDotGit, worktreeGitDirSync } from '../src/git-dirs.js'

const roots: string[] = []
const run = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it('places room.json in each worktree private Git directory, including from a subdirectory', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-git-dirs-')))
  roots.push(root)
  run(root, 'init', '-q')
  run(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'base')
  const worker = path.join(root, '.room', 'workers', 'one')
  fs.mkdirSync(path.dirname(worker), { recursive: true })
  run(root, 'worktree', 'add', '-qb', 'room/one', worker)
  for (const dir of [root, worker]) {
    const subdir = path.join(dir, 'subdir')
    fs.mkdirSync(subdir)
    const expected = path.join(run(dir, 'rev-parse', '--absolute-git-dir'), 'room.json')
    expect(roomFilePath(dir)).toBe(expected)
    expect(roomFilePath(subdir)).toBe(expected)
  }
  expect(roomFilePath(worker)).not.toBe(roomFilePath(root))
})

it('throws on missing Git metadata instead of guessing a room.json path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-no-git-'))
  roots.push(root)
  expect(() => roomFilePath(root)).toThrow(/git rev-parse --absolute-git-dir/)
})

it('matches the dependency-free hook over clones, nested worktrees, subdirectories, relative gitfiles and missing metadata', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-git-parity-')))
  roots.push(root)
  run(root, 'init', '-q')
  run(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'base')
  const one = path.join(root, '.room', 'workers', 'one')
  fs.mkdirSync(path.dirname(one), { recursive: true })
  run(root, 'worktree', 'add', '-qb', 'room/one', one)
  const two = path.join(one, '.room', 'workers', 'two')
  fs.mkdirSync(path.dirname(two), { recursive: true })
  run(one, 'worktree', 'add', '-qb', 'room/two', two)
  const relative = path.join(root, 'relative')
  run(root, 'worktree', 'add', '-qb', 'room/relative', relative)
  const privateRelative = run(relative, 'rev-parse', '--absolute-git-dir')
  fs.writeFileSync(path.join(relative, '.git'), `gitdir: ${path.relative(relative, privateRelative)}\n`)
  for (const dir of [root, one, two, relative]) {
    const expectedPrivate = run(dir, 'rev-parse', '--absolute-git-dir')
    const expectedCommon = path.resolve(dir, run(dir, 'rev-parse', '--git-common-dir'))
    expect(worktreeGitDirFromDotGit(dir)).toBe(expectedPrivate)
    expect(worktreeGitDirSync(dir)).toBe(expectedPrivate)
    expect(gitStatePath(dir, 'room-state.json')).toBe(path.join(expectedPrivate, 'room-state.json'))
    expect(commonGitDirFromDotGit(dir)).toBe(expectedCommon)
    expect(await gitCommonDir(dir)).toBe(expectedCommon)
    expect(carryRecordSync(dir, 'tag').file).toBe(path.join(expectedCommon, 'room-carry', 'tag.json'))
    expect(await realGitCommonDir(dir)).toBe(fs.realpathSync(expectedCommon))
    const subdir = path.join(dir, 'subdir')
    fs.mkdirSync(subdir)
    expect(gitRoot(subdir)).toBe(dir)
    expect(worktreeGitDirFromDotGit(subdir)).toBe(path.join(subdir, '.git'))
    expect(gitStatePath(subdir, 'room-state.json')).toBe(path.join(subdir, '.git', 'room-state.json'))
    expect(worktreeGitDirSync(subdir)).toBe(expectedPrivate)
    expect(await gitCommonDir(subdir)).toBe(expectedCommon)
    expect(carryRecordSync(subdir, 'tag').file).toBe(path.join(expectedCommon, 'room-carry', 'tag.json'))
  }
  const missing = path.join(root, 'missing')
  fs.mkdirSync(missing)
  expect(gitRoot(missing)).toBe(root)
  expect(gitStatePath(missing, 'room-state.json')).toBe(path.join(missing, '.git', 'room-state.json'))
  expect(worktreeGitDirFromDotGit(missing)).toBe(path.join(missing, '.git'))
  expect(worktreeGitDirSync(missing)).toBe(run(root, 'rev-parse', '--absolute-git-dir'))
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-no-git-parity-')))
  roots.push(outside)
  expect(gitRoot(outside)).toBeUndefined()
  expect(gitStatePath(outside, 'room-state.json')).toBe(path.join(outside, '.git', 'room-state.json'))
  expect(worktreeGitDirFromDotGit(outside)).toBe(path.join(outside, '.git'))
  expect(commonGitDirFromDotGit(outside)).toBe(path.join(outside, '.git'))
  expect(() => worktreeGitDirSync(outside)).toThrow()
  expect(() => carryRecordSync(outside, 'tag')).toThrow()
  await expect(gitCommonDir(outside)).rejects.toThrow()
  const malformed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-malformed-gitfile-')))
  roots.push(malformed)
  fs.writeFileSync(path.join(malformed, '.git'), 'gitdir:  \n')
  expect(worktreeGitDirFromDotGit(malformed)).toBe(path.join(malformed, '.git'))
  expect(commonGitDirFromDotGit(malformed)).toBe(path.join(malformed, '.git'))
  expect(gitStatePath(malformed, 'room-state.json')).toBe(path.join(malformed, '.git', 'room-state.json'))
})
