import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { worktreeGitDirFromDotGit } from '../src/git-dirs.js'

// Run on the lead side: these use real process-identity probes (ps), denied by
// the Codex worker sandbox. No mocked identity can establish this exclusion.
const roots: string[] = [], children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-worktree-process-')), repo = path.join(root, 'repo')
  roots.push(root); fs.mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid')
  fs.writeFileSync(path.join(repo, 'tracked'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
  return { root, repo, git }
}
function launch(mode: string, repo: string, signal: string, ...args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/worktree-process.mts', import.meta.url)), mode, repo, signal, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let output = ''; child.stdout!.on('data', data => { output += data }); child.stderr!.on('data', data => { output += data })
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`fixture ${mode} exited ${code}: ${output}`)))
  })
  void exited.catch(() => {}) // failures are inspected by the test, including deliberate kills
  return { child, exited }
}
async function until(file: string, process: ReturnType<typeof launch>) {
  const deadline = performance.now() + 15_000
  while (!fs.existsSync(file)) {
    if (process.child.exitCode !== null || process.child.signalCode !== null) {
      await process.exited; throw new Error(`fixture exited before ${file}`)
    }
    if (performance.now() >= deadline) throw new Error(`fixture timed out awaiting ${file}`)
    await delay(25)
  }
}
async function kill(child: ChildProcess) {
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited
}

it('two real processes prepare 36 clean and carried worktrees without registration collisions', async () => {
  const { root, repo, git } = fixture()
  fs.writeFileSync(path.join(repo, 'tracked'), 'carried\n'); fs.writeFileSync(path.join(repo, 'untracked'), 'untracked\n')
  for (const carry of [false, true]) for (let round = 0; round < 3; round++) {
    const signals = ['a', 'b'].map(id => path.join(root, `${Number(carry)}-${round}-${id}`))
    const processes = signals.map((signal, i) => launch('prepare', repo, signal, `prep-${Number(carry)}-${round}-${i}`, String(carry)))
    await Promise.all(signals.map((signal, i) => until(`${signal}.ready`, processes[i])))
    for (const signal of signals) fs.writeFileSync(`${signal}.go`, '')
    await Promise.all(processes.map(process => process.exited))
    for (const signal of signals) expect(JSON.parse(fs.readFileSync(`${signal}.result`, 'utf8'))).toHaveLength(3)
  }
  expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(37)
}, 120_000)

it('a linked-worktree process cannot list during another process empty-commondir publication window', async () => {
  const { root, repo, git } = fixture(), linked = path.join(root, 'linked'), partial = path.join(root, 'partial')
  git('worktree', 'add', '-q', '--detach', linked, 'HEAD'); git('worktree', 'add', '-q', '--detach', partial, 'HEAD')
  const signal = path.join(root, 'writer'), readerSignal = path.join(root, 'reader')
  const writer = launch('window', repo, signal, path.join(worktreeGitDirFromDotGit(partial), 'commondir'))
  await until(`${signal}.ready`, writer)
  const reader = launch('list', linked, readerSignal)
  await until(`${readerSignal}.ready`, reader)
  // Widen the real Git sibling-admin read race: removing only the cross-process
  // layer makes this reader exit 1 before the writer restores commondir.
  try {
    // Negative control: bypassing just Room's queue/lease observes Git's real
    // failure in this same metadata window, while the guarded process waits.
    const control = launch('unguarded-list', linked, path.join(root, 'control'))
    await expect(control.exited).rejects.toThrow(/fixture unguarded-list exited 1/)
    await delay(200)
    expect(reader.child.exitCode).toBeNull(); expect(fs.existsSync(`${readerSignal}.result`)).toBe(false)
  } finally { fs.writeFileSync(`${signal}.release`, '') }
  await Promise.all([writer.exited, reader.exited])
  expect(fs.readFileSync(`${readerSignal}.result`, 'utf8')).toContain(partial)
})

it('reclaims a killed idle holder and lets a linked-worktree waiter proceed', async () => {
  const { root, repo, git } = fixture(), linked = path.join(root, 'linked')
  git('worktree', 'add', '-q', '--detach', linked, 'HEAD')
  const signal = path.join(root, 'holder'), readerSignal = path.join(root, 'reader')
  const holder = launch('hold', repo, signal); await until(`${signal}.ready`, holder)
  const reader = launch('list', linked, readerSignal); await until(`${readerSignal}.ready`, reader)
  await delay(200); expect(fs.existsSync(`${readerSignal}.result`)).toBe(false)
  await kill(holder.child); await reader.exited
  expect(fs.readFileSync(`${readerSignal}.result`, 'utf8')).toContain(linked)
  expect(fs.existsSync(path.join(repo, '.git', 'room', 'worktree-operation.guard'))).toBe(false)
})

it.skipIf(process.platform === 'win32')('documents recovery while a killed holder Git child still runs', async () => {
  const { root, repo, git } = fixture(), signal = path.join(root, 'orphan'), hookPidFile = `${signal}.hook-pid`, release = `${signal}.release`
  const hooks = path.join(root, 'hooks'); fs.mkdirSync(hooks)
  const script = path.join(root, 'hook.mjs')
  fs.writeFileSync(script, `import fs from 'node:fs'; import { setTimeout as delay } from 'node:timers/promises'; fs.writeFileSync(${JSON.stringify(hookPidFile)}, String(process.pid)); const deadline = Date.now() + 20000; while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline) await delay(25);`)
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)}\n`, { mode: 0o700 })
  git('config', 'core.hooksPath', hooks)
  const holder = launch('orphan', repo, signal, path.join(root, 'child'))
  try {
    await until(hookPidFile, holder)
    const hookPid = Number(fs.readFileSync(hookPidFile, 'utf8'))
    await kill(holder.child)
    const readerSignal = path.join(root, 'reader'), reader = launch('list', repo, readerSignal)
    await reader.exited
    // Accepted limit: the guard tracks the Room parent, not its Git child.
    // docs/superpowers/2026-11-13-cross-process-worktree-lock.md explains why
    // child-aware recovery was not built. This hook runs after registration;
    // the assertion demonstrates lost exclusion, not corrupt registration.
    expect(() => process.kill(hookPid, 0)).not.toThrow()
    expect(fs.existsSync(`${readerSignal}.result`)).toBe(true)
    expect(fs.existsSync(path.join(repo, '.git', 'room', 'worktree-operation.guard'))).toBe(false)
  } finally {
    fs.writeFileSync(release, '')
    // Git inherits the holder's pipes; close means the orphan and hook exited.
    if (!holder.child.stdout!.destroyed) await new Promise(resolve => holder.child.once('close', resolve))
  }
})

it.skipIf(process.platform === 'win32')('keeps hooks enabled and bounds unsupported worktree-operation reentry from a hook', async () => {
  const { root, repo, git } = fixture(), signal = path.join(root, 'reentry')
  const hooks = path.join(root, 'hooks'); fs.mkdirSync(hooks)
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  const script = fileURLToPath(new URL('./fixtures/worktree-process.mts', import.meta.url))
  fs.writeFileSync(path.join(hooks, 'post-checkout'), '#!/bin/sh\nexec ' +
    [process.execPath, '--import', import.meta.resolve('tsx'), script, 'reenter', repo, signal].map(quote).join(' ') + '\n', { mode: 0o700 })
  git('config', 'core.hooksPath', hooks)
  const holder = launch('add', repo, signal, path.join(root, 'child'))
  // Production's five-minute acquisition bound is shortened only in the hook
  // fixture. The outer Git command still runs the repository's actual hook.
  await expect(holder.exited).rejects.toThrow(`holder pid ${holder.child.pid}`)
  expect(fs.existsSync(`${signal}.entered`)).toBe(false)
  expect(fs.existsSync(path.join(repo, '.git', 'room', 'worktree-operation.guard'))).toBe(false)
})
