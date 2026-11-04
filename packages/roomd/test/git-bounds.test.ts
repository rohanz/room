import { afterEach, beforeAll, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GitOutputTooLarge, git, gitCatFileBatch, gitShowManyCapped } from '../src/git.js'
import { ignoredTrackedPaths, objectFormat } from '../src/disk-scan.js'

const sh = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
let repo: string
let blob: string
const realPath = process.env.PATH

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'roomd-git-bounds-'))
  sh(repo, 'init', '-q', '-b', 'main'); sh(repo, 'config', 'user.email', 't@t'); sh(repo, 'config', 'user.name', 'T')
  fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(10_000))
  sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'one')
  blob = sh(repo, 'rev-parse', 'HEAD:big.txt')
})
afterEach(() => { process.env.PATH = realPath })

/** A `git` first on PATH that runs `body` with $PIDFILE naming where it records its pid. */
function fakeGit(body: string): { pidFile: string } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'roomd-fake-git-'))
  const pidFile = path.join(bin, 'pid')
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho $$ > '${pidFile}'\n${body}\n`, { mode: 0o755 })
  process.env.PATH = `${bin}${path.delimiter}${realPath}`
  return { pidFile }
}
const gone = (pid: number) => { try { process.kill(pid, 0); return false } catch { return true } }

it('rejects an over-budget batch with a typed error before retaining it', async () => {
  const error = await gitCatFileBatch(repo, [blob], undefined, 1_000).catch(e => e)
  expect(error).toBeInstanceOf(GitOutputTooLarge)
  expect(error.limit).toBe(1_000)
})

it('derives a blob batch budget from the known blob sizes', async () => {
  // A size that understates the blob proves the limit comes from known sizes, not a fixed ceiling.
  const lying = new Map([['big.txt', { hash: blob, size: 100 }]])
  await expect(gitShowManyCapped(repo, 'HEAD', ['big.txt'], 512 * 1024, lying)).rejects.toBeInstanceOf(GitOutputTooLarge)
  const honest = new Map([['big.txt', { hash: blob, size: 10_000 }]])
  expect((await gitShowManyCapped(repo, 'HEAD', ['big.txt'], 512 * 1024, honest)).get('big.txt')).toHaveLength(10_000)
})

it('terminates a child whose output exceeds the budget and settles after it closes', async () => {
  const { pidFile } = fakeGit('exec yes')
  const error = await gitCatFileBatch(repo, ['anything'], undefined, 64 * 1024).catch(e => e)
  expect(error).toBeInstanceOf(GitOutputTooLarge)
  expect(gone(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true)
})

it('settles a timeout only once the child has exited', async () => {
  const { pidFile } = fakeGit(`exec '${process.execPath}' -e "process.on('SIGTERM', () => {}); setTimeout(() => {}, 2500)"`)
  const started = Date.now()
  await expect(gitCatFileBatch(repo, ['anything'], 1_000)).rejects.toThrow(/git cat-file --batch failed: timed out after 1000ms/)
  expect(Date.now() - started).toBeGreaterThanOrEqual(2_300)
  expect(gone(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true)
})

it('caps retained stderr separately from stdout', async () => {
  fakeGit(`head -c 1000000 /dev/zero | tr '\\0' e >&2\nexit 2`)
  const error = await ignoredTrackedPaths(repo, ['a']).catch(e => e) as Error
  expect(error.message).toMatch(/^git check-ignore --no-index -z --stdin failed: e+/)
  expect(error.message.length).toBeLessThan(70 * 1024)
})

it('ignore output cannot exceed what was asked for', async () => {
  fakeGit('exec yes')
  await expect(ignoredTrackedPaths(repo, ['a', 'b'])).rejects.toBeInstanceOf(GitOutputTooLarge)
})

it('reports execFile output overflow as too large, not as a timeout', async () => {
  fakeGit('exec yes')
  const error = await git(repo, ['log']).catch(e => e)
  expect(error).toBeInstanceOf(GitOutputTooLarge)
  expect(error.message).not.toMatch(/timed out/)
})

it('does not reuse a cached object format after the repository at that path is replaced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomd-format-'))
  sh(dir, 'init', '-q')
  expect(await objectFormat(dir)).toBe('sha1')
  fs.rmSync(path.join(dir, '.git'), { recursive: true })
  sh(dir, 'init', '-q', '--object-format=sha256')
  expect(await objectFormat(dir)).toBe('sha256')
})
