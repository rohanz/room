import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { previewCachePath, runInMergedTree, waitForPreviewSweepForTests } from '../src/tools/files.js'
import type { Session } from '../src/session.js'

const roots: string[] = []
afterEach(async () => {
  await waitForPreviewSweepForTests()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-config-'))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
  return { root, git, session: { dir: root } as Session }
}

it('checks the full tracked tree for sparse sources and leaves their sparse settings intact', async () => {
  const { root, git, session } = fixture()
  fs.mkdirSync(path.join(root, 'tests')); fs.mkdirSync(path.join(root, 'regression'))
  fs.writeFileSync(path.join(root, 'tests', 'ok.test'), 'PASS')
  fs.writeFileSync(path.join(root, 'regression', 'bad.test'), 'FAIL')
  fs.writeFileSync(path.join(root, 'x'), 'base')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  git('sparse-checkout', 'init', '--cone'); git('sparse-checkout', 'set', 'tests')
  const sparseFile = path.join(git('rev-parse', '--absolute-git-dir'), 'info', 'sparse-checkout')
  const before = fs.readFileSync(sparseFile)
  const cmd = `node -e 'const fs=require("fs");const tests=fs.readdirSync(".",{recursive:true}).filter(f=>f.endsWith(".test"));const failed=tests.some(f=>fs.readFileSync(f,"utf8")==="FAIL");console.log(failed?"1 failed":"1 passed");process.exit(failed?1:0)'`
  const run = () => runInMergedTree(session, head, new Map([['x', 'merged']]), cmd)
  const first = await run()
  expect(first.passed, first.text).toBe(false)
  expect(first.text).toContain('fresh base')
  const cache = await previewCachePath(root)
  expect(fs.existsSync(cache)).toBe(false)
  // A second call exercises the same safe path without altering the source.
  const second = await run()
  expect(second.passed, second.text).toBe(first.passed)
  expect(git('config', '--get', 'core.sparseCheckout')).toBe('true')
  expect(fs.readFileSync(sparseFile)).toEqual(before)
}, 30_000)

it('abandons a warm slot when source worktree checkout conversion changes', async () => {
  const { root, git, session } = fixture()
  git('config', 'extensions.worktreeConfig', 'true')
  git('config', '--worktree', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(root, 'x'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  expect((await runInMergedTree(session, head, new Map(), 'echo "1 passed"')).passed).toBe(true)
  const old = await previewCachePath(root)
  expect(fs.existsSync(old)).toBe(true)
  git('config', '--worktree', 'core.autocrlf', 'true')
  const cmd = `node -e 'const x=require("fs").readFileSync("x","utf8");const failed=x.includes("\\r\\n");console.log(failed?"1 failed":"1 passed");process.exit(failed?1:0)'`
  const result = await runInMergedTree(session, head, new Map(), cmd)
  expect(result.passed, result.text).toBe(false)
  expect(git('config', '--get', 'core.autocrlf')).toBe('true')
  expect(await previewCachePath(root)).not.toBe(old)
  await waitForPreviewSweepForTests()
  expect(fs.existsSync(old)).toBe(false)
}, 30_000)

it('rejects a sparse cached slot even when the source is a full checkout', async () => {
  const { root, git, session } = fixture()
  fs.mkdirSync(path.join(root, 'tests')); fs.mkdirSync(path.join(root, 'regression'))
  fs.writeFileSync(path.join(root, 'tests', 'ok.test'), 'PASS')
  fs.writeFileSync(path.join(root, 'regression', 'bad.test'), 'FAIL')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  expect((await runInMergedTree(session, head, new Map(), 'echo "1 passed"')).passed).toBe(true)
  const old = await previewCachePath(root)
  execFileSync('git', ['-C', old, 'sparse-checkout', 'init', '--cone'])
  execFileSync('git', ['-C', old, 'sparse-checkout', 'set', 'tests'])
  const cmd = `node -e 'const fs=require("fs");const bad=fs.existsSync("regression/bad.test")&&fs.readFileSync("regression/bad.test","utf8")==="FAIL";console.log(bad?"1 failed":"1 passed");process.exit(bad?1:0)'`
  const result = await runInMergedTree(session, head, new Map(), cmd)
  expect(result.passed, result.text).toBe(false)
  expect(result.text).toContain('fresh base after cache failure')
  expect(await previewCachePath(root)).not.toBe(old)
}, 30_000)

it('applies source info attributes when creating a cache slot', async () => {
  const { root, git, session } = fixture()
  fs.writeFileSync(path.join(root, 'x'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(git('rev-parse', '--absolute-git-dir'), 'info', 'attributes'), 'x text eol=crlf\n')
  const cmd = `node -e 'const x=require("fs").readFileSync("x","utf8");const ok=x.includes("\\r\\n");console.log(ok?"1 passed":"1 failed");process.exit(ok?0:1)'`
  const first = await runInMergedTree(session, head, new Map(), cmd)
  expect(first.passed, first.text).toBe(true)
  const second = await runInMergedTree(session, head, new Map(), cmd)
  expect(second.passed, second.text).toBe(true)
  expect(second.text).toContain('cached base')
}, 30_000)

it('replaces a slot when source info attributes change after warming', async () => {
  const { root, git, session } = fixture()
  fs.writeFileSync(path.join(root, 'x'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  expect((await runInMergedTree(session, head, new Map(), 'echo "1 passed"')).passed).toBe(true)
  const old = await previewCachePath(root)
  fs.writeFileSync(path.join(git('rev-parse', '--absolute-git-dir'), 'info', 'attributes'), 'x text eol=crlf\n')
  const cmd = `node -e 'const x=require("fs").readFileSync("x","utf8");const ok=x.includes("\\r\\n");console.log(ok?"1 passed":"1 failed");process.exit(ok?0:1)'`
  const result = await runInMergedTree(session, head, new Map(), cmd)
  expect(result.passed, result.text).toBe(true)
  expect(await previewCachePath(root)).not.toBe(old)
  await waitForPreviewSweepForTests()
  expect(fs.existsSync(old)).toBe(false)
}, 30_000)

it('keeps a healthy clone slot reachable after another clone abandons a generation', async () => {
  const healthy = fixture(), faulty = fixture()
  for (const repo of [healthy, faulty]) { fs.writeFileSync(path.join(repo.root, 'x'), 'base\n'); repo.git('add', '.'); repo.git('commit', '-qm', 'base') }
  const healthyHead = healthy.git('rev-parse', 'HEAD'), faultyHead = faulty.git('rev-parse', 'HEAD')
  const original = fs.promises.open.bind(fs.promises)
  let fault = ''
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) === fault) { fault = ''; throw Object.assign(new Error('one-shot fault'), { code: 'EBUSY' }) }
    return original(...args)
  })
  for (let i = 0; i < 3; i++) {
    const healthySlot = await previewCachePath(healthy.root)
    const good = await runInMergedTree(healthy.session, healthyHead, new Map(), 'echo "1 passed"')
    expect(good.passed, good.text).toBe(true)
    expect(await previewCachePath(healthy.root)).toBe(healthySlot)
    const badSlot = await previewCachePath(faulty.root)
    const bad = await runInMergedTree(faulty.session, faultyHead, new Map([['x', 'merged\n']]), 'echo "1 passed"', new Map(), { mergedWrite() { fault = `${badSlot}/.git` } })
    expect(bad.passed, bad.text).toBe(true)
    await waitForPreviewSweepForTests()
  }
  const key = path.dirname(await previewCachePath(healthy.root))
  expect(fs.readdirSync(key).filter(name => /^\d+-.*-\d+$/.test(name) && fs.statSync(path.join(key, name)).isDirectory())).toHaveLength(1)
}, 30_000)
