import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import childProcess from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { workerSubmoduleNotes } from '../src/worker-submodules.js'
import { commit, git, put, read, repo, world } from './worker-refresh-fixture.js'

const subpath = "vendor/large lib's $(touch BAD) `touch BAD2`"
function fixture() {
  const child = path.join(path.dirname(repo), 'child')
  fs.mkdirSync(child)
  git(child, 'init', '-q', '-b', 'main'); git(child, 'config', 'user.name', 'test'); git(child, 'config', 'user.email', 'test@example.test')
  put(child, 'library.txt', 'first\n'); const first = commit(child, 'first')
  put(child, 'library.txt', 'second\n'); const second = commit(child, 'second')
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, subpath)
  const source = path.join(repo, subpath)
  git(source, 'checkout', '-q', first)
  const head = commit(repo, 'submodule'), sourceGit = git(source, 'rev-parse', '--absolute-git-dir')
  const worktree = (tag = 'test') => {
    const dir = path.join(repo, '.room/workers', tag)
    git(repo, 'worktree', 'add', '-qb', `room/${tag}`, dir)
    return dir
  }
  const unchanged = () => ({ head: fs.readFileSync(path.join(sourceGit, 'HEAD')),
    index: fs.readFileSync(path.join(sourceGit, 'index')), config: fs.readFileSync(path.join(sourceGit, 'config')),
    refs: git(source, 'show-ref'), contents: read(source, 'library.txt'), parentConfig: fs.readFileSync(path.join(repo, '.git/config')) })
  return { child, source, sourceGit, first, second, head, worktree, unchanged }
}
const commands = (prompt: string) => prompt.split('\n').filter(line => line.startsWith('git '))

it('only reads worker metadata, leaves all folders empty and shares one concise set of instructions', async () => {
  const f = fixture(), dir = f.worktree(), before = f.unchanged(), exec = vi.spyOn(childProcess, 'execFile')
  const writes = ['mkdir', 'mkdtemp', 'writeFile', 'chmod', 'symlink', 'rename', 'rm', 'rmdir'].map(method => vi.spyOn(fsp, method as 'mkdir'))
  try {
    const result = await workerSubmoduleNotes(repo, dir)
    expect(result.prompt).toContain(`empty; repository records ${f.first}`)
    expect(result.prompt).toBe(result.reply.join('\n'))
    expect(commands(result.prompt!)).toHaveLength(2)
    expect(result.prompt).toContain('If the lead lacks that commit')
    expect(fs.readdirSync(path.join(dir, subpath))).toEqual([])
    expect(exec).toHaveBeenCalledTimes(2)
    for (const call of exec.mock.calls) {
      expect(call[2]).toMatchObject({ cwd: dir, maxBuffer: 128 * 1024 })
      expect(call[1]).not.toEqual(expect.arrayContaining(['-r']))
      expect((call[1] as string[]).some(arg => ['status', 'clone', 'checkout', 'cat-file', 'ls-files'].includes(arg))).toBe(false)
    }
    for (const spy of writes) expect(spy).not.toHaveBeenCalled()
    expect(f.unchanged()).toEqual(before)
  } finally { exec.mockRestore(); writes.forEach(spy => spy.mockRestore()) }
})

it.skipIf(process.platform === 'win32')('printed commands run verbatim, quote shell syntax and never hardlink or modify the lead', async () => {
  const f = fixture(), dir = f.worktree()
  git(f.source, 'checkout', '-q', f.second); put(f.source, 'library.txt', 'lead WIP\n')
  const before = f.unchanged(), result = await workerSubmoduleNotes(repo, dir)
  const lines = commands(result.prompt!)
  for (const command of lines) childProcess.execFileSync('/bin/sh', ['-ec', command], { cwd: dir, stdio: 'pipe' })
  const at = path.join(dir, subpath)
  expect(read(at, 'library.txt')).toBe('first\n')
  expect(git(at, 'rev-parse', 'HEAD')).toBe(f.first)
  expect(fs.statSync(path.join(at, 'library.txt')).ino).not.toBe(fs.statSync(path.join(f.source, 'library.txt')).ino)
  const object = path.join('objects', f.first.slice(0, 2), f.first.slice(2))
  expect(fs.statSync(path.join(at, '.git', object)).ino).not.toBe(fs.statSync(path.join(f.sourceGit, object)).ino)
  expect(fs.existsSync(path.join(dir, 'BAD'))).toBe(false)
  expect(fs.existsSync(path.join(dir, 'BAD2'))).toBe(false)
  expect(f.unchanged()).toEqual(before)
})

it('names missing local commits without accessing the lead submodule or its objects', async () => {
  const f = fixture(), dir = f.worktree()
  fs.rmSync(f.source, { recursive: true }); fs.rmSync(f.sourceGit, { recursive: true })
  const opens = vi.spyOn(fsp, 'open'), stats = vi.spyOn(fsp, 'lstat')
  try {
    const result = await workerSubmoduleNotes(repo, dir)
    expect(result.prompt).toContain(f.first)
    expect(result.prompt).toContain('ask for a local copy containing it, or permission to fetch it into your worker copy')
    for (const spy of [opens, stats]) for (const call of spy.mock.calls) expect(String(call[0]).startsWith(f.source)).toBe(false)
    expect(fs.readdirSync(path.join(dir, subpath))).toEqual([])
  } finally { opens.mockRestore(); stats.mockRestore() }
})

it.skipIf(process.platform === 'win32')('a failed manual clone cannot make checkout fall back to the worker superproject', async () => {
  const f = fixture()
  // The pointer deliberately names a commit available in the parent: falling back would succeed.
  git(repo, 'update-index', '--cacheinfo', '160000', git(repo, 'rev-parse', 'HEAD~1'), subpath)
  git(repo, 'commit', '-qm', 'pointer to parent commit')
  const dir = f.worktree()
  fs.rmSync(f.source, { recursive: true })
  const result = await workerSubmoduleNotes(repo, dir), before = git(dir, 'rev-parse', 'HEAD')
  const lines = commands(result.prompt!)
  for (const command of lines) expect(() => childProcess.execFileSync('/bin/sh', ['-ec', command], { cwd: dir, stdio: 'pipe' })).toThrow()
  expect(git(dir, 'rev-parse', 'HEAD')).toBe(before)
  expect(git(dir, 'symbolic-ref', 'HEAD')).toBe('refs/heads/room/test')
})

it.skipIf(process.platform === 'win32')('printed checkout suppresses configured LFS downloads', async () => {
  const f = fixture(), marker = path.join(repo, 'lfs-was-run'), global = path.join(repo, '.git/test-global')
  put(f.source, '.gitattributes', 'library.txt filter=lfs\n')
  commit(f.source, 'LFS attribute'); commit(repo, 'record attribute')
  git(repo, 'config', '--file', global, 'filter.lfs.process', `touch '${marker}'; exit 1`)
  git(repo, 'config', '--file', global, 'filter.lfs.smudge', `touch '${marker}'; cat`)
  git(repo, 'config', '--file', global, 'filter.lfs.required', 'true')
  const dir = f.worktree(), result = await workerSubmoduleNotes(repo, dir)
  for (const command of commands(result.prompt!)) childProcess.execFileSync('/bin/sh', ['-ec', command], { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: global } })
  expect(read(path.join(dir, subpath), 'library.txt')).toBe('first\n')
  expect(fs.existsSync(marker)).toBe(false)
})

it('keeps existing contents and linked worker folders without offering commands that write through them', async () => {
  const f = fixture(), dir = f.worktree()
  put(dir, subpath + '/precious', 'keep\n')
  expect(commands((await workerSubmoduleNotes(repo, dir)).prompt!)).toEqual([])
  expect(read(dir, subpath + '/precious')).toBe('keep\n')
  const linked = f.worktree('linked'), before = f.unchanged()
  fs.rmSync(path.join(linked, 'vendor'), { recursive: true })
  fs.symlinkSync(path.join(repo, 'vendor'), path.join(linked, 'vendor'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await workerSubmoduleNotes(repo, linked)
  expect(result.prompt).toContain('existing or linked folder left as found')
  expect(commands(result.prompt!)).toEqual([])
  expect(f.unchanged()).toEqual(before)
})

it('does no Git work without .gitmodules even with a 40,000-entry index', async () => {
  const blob = git(repo, 'hash-object', '-w', '--stdin')
  const entries = Array.from({ length: 40_000 }, (_, n) => `100644 ${blob}\t${n}-${'x'.repeat(100)}\0`).join('')
  childProcess.execFileSync('git', ['-C', repo, 'update-index', '-z', '--index-info'], { input: entries, stdio: 'pipe' })
  const spy = vi.spyOn(childProcess, 'execFile')
  try { expect(await workerSubmoduleNotes(repo, repo)).toEqual({ reply: [] }); expect(spy).not.toHaveBeenCalled() }
  finally { spy.mockRestore() }
})

it('does not recurse through a mapped ordinary directory or inspect nested dependencies', async () => {
  const f = fixture()
  put(repo, '.gitmodules', '[submodule "incorrect mapping"]\npath = vendor\n')
  commit(repo, 'map an ordinary ancestor')
  const dir = f.worktree(), spy = vi.spyOn(childProcess, 'execFile')
  try {
    expect(await workerSubmoduleNotes(repo, dir)).toEqual({ reply: [] })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[1][1]).not.toContain('-r')
    expect(fs.readdirSync(path.join(dir, subpath))).toEqual([])
  } finally { spy.mockRestore() }
})

it.each(['oversized', 'too many paths', 'unsafe path', 'invalid syntax'])('bounds %s configuration without querying the tree', async kind => {
  const f = fixture(), dir = f.worktree()
  const config = kind === 'oversized' ? '#'.repeat(65537)
    : kind === 'too many paths' ? Array.from({ length: 65 }, (_, n) => `[submodule "${n}"]\npath = lib${n}\n`).join('')
    : kind === 'unsafe path' ? '[submodule "bad"]\npath = ../outside\n' : '[invalid'
  put(dir, '.gitmodules', config)
  const spy = vi.spyOn(childProcess, 'execFile')
  try {
    expect((await workerSubmoduleNotes(repo, dir)).prompt).toContain('guidance unavailable')
    expect(spy.mock.calls.some(call => (call[1] as string[]).includes('ls-tree'))).toBe(false)
    expect(fs.readdirSync(path.join(dir, subpath))).toEqual([])
  } finally { spy.mockRestore() }
})

it.skipIf(process.platform === 'win32')('declines FIFO configuration without blocking the event loop', async () => {
  const f = fixture(), dir = f.worktree()
  fs.unlinkSync(path.join(dir, '.gitmodules')); childProcess.execFileSync('mkfifo', [path.join(dir, '.gitmodules')])
  expect((await workerSubmoduleNotes(repo, dir)).prompt).toContain('not a plain file')
})

it('kills a stuck metadata command while the event loop continues and never fails startup', async () => {
  const f = fixture(), dir = f.worktree(), exec = childProcess.execFile
  const spy = vi.spyOn(childProcess, 'execFile').mockImplementation(((file: string, args: string[], options: any, callback: any) =>
    exec(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], options, callback)) as typeof exec)
  let ticks = 0
  const timer = setInterval(() => ticks++, 10), started = performance.now()
  try {
    expect((await workerSubmoduleNotes(repo, dir, { timeoutMs: 100 })).prompt).toContain('discovery time limit reached')
    expect(performance.now() - started).toBeLessThan(2000); expect(ticks).toBeGreaterThan(0)
    expect(fs.readdirSync(path.join(dir, subpath))).toEqual([])
  } finally { clearInterval(timer); spy.mockRestore() }
})

it('limits command output before parsing and remains nonfatal on filesystem failures or zero budget', async () => {
  const f = fixture(), dir = f.worktree(), exec = childProcess.execFile
  const spy = vi.spyOn(childProcess, 'execFile').mockImplementation(((file: string, args: string[], options: any, callback: any) =>
    exec(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], options, callback)) as typeof exec)
  try { expect((await workerSubmoduleNotes(repo, dir)).prompt).toContain('metadata unavailable or exceeds 128 KiB') }
  finally { spy.mockRestore() }
  const open = vi.spyOn(fsp, 'open').mockRejectedValueOnce(new Error('permission denied'))
  try { expect((await workerSubmoduleNotes(repo, dir)).prompt).toContain('permission denied') }
  finally { open.mockRestore() }
  const noGit = vi.spyOn(childProcess, 'execFile')
  try {
    expect((await workerSubmoduleNotes(repo, dir, { timeoutMs: 0 })).prompt).toContain('discovery time limit reached')
    expect(noGit).not.toHaveBeenCalled()
  } finally { noGit.mockRestore() }
})

it('spawn gives the instructions once in both reply and prompt and never populates a folder', async () => {
  const f = fixture(), t = world({ repo, head: f.head })
  const reply = await t.call('room_spawn', { tag: 'instructions', task: 'build', host: 'claude' })
  const prompt = t.launches.get('instructions')![0]
  for (const text of [reply, prompt]) {
    expect(text.match(/empty; repository records/g)).toHaveLength(1)
    expect(text).toContain(f.first)
    expect(commands(text)).toHaveLength(2)
  }
  expect(fs.readdirSync(path.join(repo, '.room/workers/instructions', subpath))).toEqual([])
})

it('a refreshed base has no stale dependency files and records the new commit', async () => {
  const f = fixture(), t = world({ repo, head: f.head }), worker = await t.spawn('refresh')
  await t.finish('refresh')
  git(f.source, 'checkout', '-q', f.second); commit(repo, 'new dependency')
  expect(await t.call('room_send', { type: 'note', to: 'refresh', text: 'continue', refresh: true })).toContain('resumed')
  expect(fs.readdirSync(path.join(worker.dir, subpath))).toEqual([])
  expect((await workerSubmoduleNotes(repo, worker.dir)).prompt).toContain(f.second)
})

it('metadata failure does not fail a spawn', async () => {
  const f = fixture(), t = world({ repo, head: f.head })
  put(repo, '.gitmodules', '#'.repeat(65537)); commit(repo, 'unavailable guidance')
  const reply = await t.call('room_spawn', { tag: 'optional', task: 'build', host: 'claude' })
  expect(reply).toContain('guidance unavailable')
  expect(t.launches.has('optional')).toBe(true)
})
