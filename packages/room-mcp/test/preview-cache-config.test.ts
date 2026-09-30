import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { materializeGitTree, previewCachePath, runInMergedTree, waitForPreviewSweepForTests } from '../src/tools/files.js'
import type { Session } from '../src/session.js'

const roots: string[] = []
const gitEnvKeys = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_ATTR_NOSYSTEM'] as const
let previousGitEnv: Record<string, string | undefined>
let isolatedHome: string
beforeEach(() => {
  previousGitEnv = Object.fromEntries(gitEnvKeys.map(key => [key, process.env[key]]))
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-git-home-'))
  roots.push(isolatedHome)
  process.env.HOME = isolatedHome
  process.env.XDG_CONFIG_HOME = path.join(isolatedHome, '.config')
  process.env.GIT_CONFIG_GLOBAL = path.join(isolatedHome, 'global.gitconfig')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_ATTR_NOSYSTEM = '1'
})
afterEach(async () => {
  await waitForPreviewSweepForTests()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  for (const key of gitEnvKeys) {
    const value = previousGitEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-config-'))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
  return { root, git, session: { dir: root } as Session }
}

const rejectsChangedCheckout = `node -e 'const x=require("fs").readFileSync("x","utf8");const bad=x.includes("\\r\\n")||x.includes("BAD");console.log(bad?"1 failed":"1 passed");process.exit(bad?1:0)'`

async function expectPolicyChangeToAbandon(root: string, session: Session, head: string, old: string) {
  const result = await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)
  expect(result.passed, result.text).toBe(false)
  expect(await previewCachePath(root)).not.toBe(old)
  await waitForPreviewSweepForTests()
  expect(fs.existsSync(old)).toBe(false)
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-fresh-'))
  roots.push(fresh)
  await materializeGitTree(root, head, fresh)
  expect(fs.readFileSync(path.join(fresh, 'x'), 'utf8')).toMatch(/\r\n|BAD/)
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

it('abandons a linked worktree slot when shared info attributes change', async () => {
  const { root, git } = fixture()
  fs.writeFileSync(path.join(root, 'x'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-linked-'))
  roots.push(linked)
  git('worktree', 'add', '--detach', linked)
  const head = git('rev-parse', 'HEAD')
  const session = { dir: linked } as Session
  expect((await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)).passed).toBe(true)
  const old = await previewCachePath(linked)
  const effective = execFileSync('git', ['-C', linked, 'rev-parse', '--path-format=absolute', '--git-path', 'info/attributes'], { encoding: 'utf8' }).trim()
  expect(fs.realpathSync(path.dirname(effective))).toBe(fs.realpathSync(path.join(root, '.git', 'info')))
  fs.writeFileSync(effective, 'x text eol=crlf\n')
  await expectPolicyChangeToAbandon(linked, session, head, old)
}, 30_000)

it.each(['contents', 'path'] as const)('abandons a slot when core.attributesFile %s changes', async change => {
  const { root, git, session } = fixture()
  fs.writeFileSync(path.join(root, 'x'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  const first = path.join(isolatedHome, 'attributes-first')
  fs.writeFileSync(first, '')
  git('config', 'core.attributesFile', first)
  expect((await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)).passed).toBe(true)
  const old = await previewCachePath(root)
  if (change === 'contents') fs.writeFileSync(first, 'x text eol=crlf\n')
  else {
    const second = path.join(isolatedHome, 'attributes-second')
    fs.writeFileSync(second, 'x text eol=crlf\n')
    git('config', 'core.attributesFile', second)
  }
  await expectPolicyChangeToAbandon(root, session, head, old)
}, 30_000)

it('expands a ~/ core.attributesFile path', async () => {
  const { root, git, session } = fixture()
  fs.writeFileSync(path.join(root, 'x'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  const file = path.join(isolatedHome, 'attributes')
  fs.writeFileSync(file, '')
  git('config', 'core.attributesFile', '~/attributes')
  expect((await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)).passed).toBe(true)
  const old = await previewCachePath(root)
  fs.writeFileSync(file, 'x text eol=crlf\n')
  await expectPolicyChangeToAbandon(root, session, head, old)
}, 30_000)

it('keeps every byte of a core.attributesFile path, including a trailing space', async () => {
  const { root, git, session } = fixture()
  fs.writeFileSync(path.join(root, 'x'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  const file = path.join(isolatedHome, 'attributes ')
  fs.writeFileSync(file, '')
  git('config', 'core.attributesFile', file)
  expect((await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)).passed).toBe(true)
  const old = await previewCachePath(root)
  fs.writeFileSync(file, 'x text eol=crlf\n')
  await expectPolicyChangeToAbandon(root, session, head, old)
}, 30_000)

/** A git on PATH that cannot report GIT_ATTR_SYSTEM (as before Git 2.42) and runs the real git otherwise. */
function gitWithoutAttrSystem(): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'room-old-git-'))
  roots.push(bin)
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = GIT_ATTR_SYSTEM ] && { echo "fatal: unknown variable" >&2; exit 1; }; done\nexec "${real}" "$@"\n`, { mode: 0o755 })
  return bin
}

it('previews on a fresh tree when Git cannot report its system attributes file', async () => {
  const { root, git, session } = fixture()
  fs.writeFileSync(path.join(root, 'x'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  delete process.env.GIT_ATTR_NOSYSTEM
  vi.stubEnv('PATH', `${gitWithoutAttrSystem()}:${process.env.PATH}`)
  for (let i = 0; i < 2; i++) {
    const result = await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)
    expect(result.passed, result.text).toBe(true)
    expect(result.text).not.toContain('(cached base)')
  }
}, 30_000)

it('treats a nonzero integer GIT_ATTR_NOSYSTEM as disabling system attributes, as Git does', async () => {
  const { root, git, session } = fixture()
  fs.writeFileSync(path.join(root, 'x'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  process.env.GIT_ATTR_NOSYSTEM = '2'
  vi.stubEnv('PATH', `${gitWithoutAttrSystem()}:${process.env.PATH}`)
  await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)
  expect((await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)).text).toContain('(cached base)')
}, 30_000)

it('abandons a slot when a relative core.attributesFile path changes', async () => {
  const { root, git, session } = fixture()
  fs.writeFileSync(path.join(root, 'x'), 'base\n')
  fs.writeFileSync(path.join(root, 'attrs-one'), '')
  fs.writeFileSync(path.join(root, 'attrs-two'), 'x text eol=crlf\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  git('config', 'core.attributesFile', 'attrs-one')
  expect((await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)).passed).toBe(true)
  const old = await previewCachePath(root)
  git('config', 'core.attributesFile', 'attrs-two')
  const result = await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)
  expect(await previewCachePath(root)).not.toBe(old)
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-fresh-'))
  roots.push(fresh)
  await materializeGitTree(root, head, fresh)
  expect(result.passed, result.text).toBe(!fs.readFileSync(path.join(fresh, 'x'), 'utf8').includes('\r\n'))
}, 30_000)

it('abandons a slot when the default XDG attributes file changes', async () => {
  const { root, git, session } = fixture()
  fs.writeFileSync(path.join(root, 'x'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  expect((await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)).passed).toBe(true)
  const old = await previewCachePath(root)
  const file = path.join(process.env.XDG_CONFIG_HOME!, 'git', 'attributes')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'x text eol=crlf\n')
  await expectPolicyChangeToAbandon(root, session, head, old)
}, 30_000)

it('uses HOME/.config/git/attributes when XDG_CONFIG_HOME is unset', async () => {
  delete process.env.XDG_CONFIG_HOME
  const { root, git, session } = fixture()
  fs.writeFileSync(path.join(root, 'x'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  expect((await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)).passed).toBe(true)
  const old = await previewCachePath(root)
  const file = path.join(isolatedHome, '.config', 'git', 'attributes')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'x text eol=crlf\n')
  await expectPolicyChangeToAbandon(root, session, head, old)
}, 30_000)

it('preserves filter driver subsection case in the checkout fingerprint', async () => {
  const { root, git, session } = fixture()
  fs.writeFileSync(path.join(root, 'x'), 'base\n')
  fs.writeFileSync(path.join(root, '.gitattributes'), 'x filter=Upper\n')
  git('config', 'filter.Upper.smudge', 'cat')
  git('config', 'filter.upper.smudge', 'cat')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  expect((await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)).passed).toBe(true)
  const old = await previewCachePath(root)
  git('config', 'filter.Upper.smudge', 'sed s/base/BAD/')
  await expectPolicyChangeToAbandon(root, session, head, old)
}, 30_000)

it('keeps the same slot and fingerprint for unrelated config changes', async () => {
  const { root, git, session } = fixture()
  fs.writeFileSync(path.join(root, 'x'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  expect((await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)).passed).toBe(true)
  const slot = await previewCachePath(root)
  const settings = path.join(path.dirname(slot), `.checkout-${path.basename(slot)}.json`)
  const fingerprint = fs.readFileSync(settings, 'utf8')
  git('config', 'user.name', 'Changed')
  for (let i = 0; i < 3; i++) {
    const result = await runInMergedTree(session, head, new Map(), rejectsChangedCheckout)
    expect(result.passed, result.text).toBe(true)
    expect(result.text).toContain('cached base')
    expect(await previewCachePath(root)).toBe(slot)
    expect(fs.readFileSync(settings, 'utf8')).toBe(fingerprint)
  }
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
