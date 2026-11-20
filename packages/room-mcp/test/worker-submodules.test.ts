import fs from 'node:fs'
import path from 'node:path'
import childProcess from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { changedWorkerSubmodules, prepareWorkerSubmodules } from '../src/worker-submodules.js'
import { commit, git, put, read, repo, world } from './worker-refresh-fixture.js'

const subpath = "vendor/large lib's"
function fixture() {
  const child = path.join(path.dirname(repo), 'child')
  fs.mkdirSync(child)
  git(child, 'init', '-q', '-b', 'main'); git(child, 'config', 'user.name', 'test'); git(child, 'config', 'user.email', 'test@example.test')
  put(child, '.gitignore', 'build/\n'); put(child, 'library.txt', 'first\n')
  const first = commit(child, 'first')
  put(child, 'library.txt', 'second\n'); const second = commit(child, 'second')
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, subpath)
  const source = path.join(repo, subpath)
  git(source, 'checkout', '-q', first)
  const head = commit(repo, 'submodule')
  const worktree = (tag = 'test') => {
    const dir = path.join(repo, '.room/workers', tag)
    git(repo, 'worktree', 'add', '-qb', `room/${tag}`, dir)
    return dir
  }
  const sourceGit = git(source, 'rev-parse', '--absolute-git-dir')
  const unchanged = () => ({
    head: fs.readFileSync(path.join(sourceGit, 'HEAD')),
    index: fs.readFileSync(path.join(sourceGit, 'index')),
    config: fs.readFileSync(path.join(sourceGit, 'config')),
    refs: git(source, 'show-ref'), contents: read(source, 'library.txt'),
    parentConfig: fs.readFileSync(path.join(repo, '.git/config')),
  })
  return { child, source, sourceGit, first, second, head, worktree, unchanged }
}

it('creates a pinned independent checkout, hardlinks objects, and survives source object pruning', async () => {
  const f = fixture(), dir = f.worktree(), before = f.unchanged()
  const result = await prepareWorkerSubmodules(repo, dir), at = path.join(dir, subpath)
  expect(result.prompt).toContain('ready at ' + f.first.slice(0, 10))
  expect(result.prompt).toBe(result.reply.join('\n'))
  expect(result.reply).toHaveLength(2) // One outcome and one cleanup rule, not setup documentation.
  expect(result.reply.every(line => line.length < 160)).toBe(true)
  expect(read(at, 'library.txt')).toBe('first\n')
  expect(fs.lstatSync(path.join(at, '.git')).isDirectory()).toBe(true)
  expect(git(at, 'remote')).toBe('')
  expect(fs.existsSync(path.join(at, '.git/objects/info/alternates'))).toBe(false)
  const oidPath = path.join('objects', f.first.slice(0, 2), f.first.slice(2))
  const sourceObject = path.join(f.sourceGit, oidPath), targetObject = path.join(at, '.git', oidPath)
  const a = fs.statSync(sourceObject), b = fs.statSync(targetObject)
  expect([b.dev, b.ino]).toEqual([a.dev, a.ino])
  expect(f.unchanged()).toEqual(before)
  fs.unlinkSync(sourceObject) // Source GC unlink cannot invalidate the worker's hardlink.
  expect(git(at, 'cat-file', '-t', f.first)).toBe('commit')
  expect(await changedWorkerSubmodules(dir)).toEqual([])
})

it('leaves dirty or mismatched lead checkouts alone and explains empty directories and pinned local setup', async () => {
  const f = fixture()
  put(f.source, 'library.txt', 'lead WIP\n')
  const dirtyBefore = f.unchanged(), dirty = f.worktree('dirty')
  const result = await prepareWorkerSubmodules(repo, dirty)
  expect(result.prompt).toContain('empty (lead submodule has local changes')
  expect(result.prompt).toContain('clone --local --no-checkout')
  expect(result.prompt).toContain('checkout --detach ' + f.first)
  expect(result.prompt).toContain(process.platform === 'win32' ? "''" : "'\\''")
  expect(fs.readdirSync(path.join(dirty, subpath))).toEqual([])
  expect(f.unchanged()).toEqual(dirtyBefore)
  git(f.source, 'checkout', '--', 'library.txt'); git(f.source, 'checkout', '-q', f.second)
  const mismatchBefore = f.unchanged()
  const mismatch = await prepareWorkerSubmodules(repo, f.worktree('mismatch'))
  expect(mismatch.prompt).toContain('lead checkout differs from its recorded gitlink')
  expect(mismatch.prompt).toContain(f.first)
  expect(f.unchanged()).toEqual(mismatchBefore)
})

it('does not adopt existing worker contents, an uninitialized source, or symlinked paths', async () => {
  const f = fixture(), dir = f.worktree()
  put(dir, subpath + '/precious', 'worker data')
  expect((await prepareWorkerSubmodules(repo, dir)).prompt).toContain('existing worker contents left untouched')
  expect(read(dir, subpath + '/precious')).toBe('worker data')
  const uninitialized = f.worktree('empty-source')
  fs.renameSync(path.join(f.source, '.git'), path.join(f.source, '.git-away'))
  expect((await prepareWorkerSubmodules(repo, uninitialized)).prompt).toContain('lead submodule is not initialized')
  fs.renameSync(path.join(f.source, '.git-away'), path.join(f.source, '.git'))
  const linked = f.worktree('linked')
  fs.rmSync(path.join(linked, subpath), { recursive: true })
  fs.symlinkSync(f.source, path.join(linked, subpath), process.platform === 'win32' ? 'junction' : 'dir')
  const before = f.unchanged()
  expect((await prepareWorkerSubmodules(repo, linked)).prompt).toContain('linked submodule path')
  expect(f.unchanged()).toEqual(before)
})

it('declines alternate-backed sources and missing recorded objects without a network fallback', async () => {
  const f = fixture(), dir = f.worktree()
  fs.writeFileSync(path.join(f.sourceGit, 'objects/info/alternates'), path.join(f.child, '.git/objects') + '\n')
  expect((await prepareWorkerSubmodules(repo, dir)).prompt).toContain('borrows alternates')
  expect(fs.readdirSync(path.join(dir, subpath))).toEqual([])
  fs.unlinkSync(path.join(f.sourceGit, 'objects/info/alternates'))
  // A sparse/missing local object must not trigger a network fallback.
  const tree = git(f.source, 'rev-parse', f.first + '^{tree}')
  fs.unlinkSync(path.join(f.sourceGit, 'objects', tree.slice(0, 2), tree.slice(2)))
  const result = await prepareWorkerSubmodules(repo, f.worktree('missing-object'))
  expect(result.prompt).not.toContain('ready at')
  expect(result.prompt).toContain('local Git inspection or checkout failed')
})

it('prepares nested submodules without using shared superproject module metadata', async () => {
  const f = fixture()
  git(f.source, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', f.child, 'nested/lib')
  commit(f.source, 'nested dependency'); commit(repo, 'updated library')
  const dir = f.worktree(), before = f.unchanged()
  const result = await prepareWorkerSubmodules(repo, dir)
  expect(result.prompt).toContain(JSON.stringify(subpath + '/nested/lib') + ': ready')
  expect(read(path.join(dir, subpath, 'nested/lib'), 'library.txt')).toBe('second\n')
  expect(f.unchanged()).toEqual(before)
  expect(await changedWorkerSubmodules(dir)).toEqual([])
  put(path.join(dir, subpath, 'nested/lib'), 'build/precious', 'nested ignored work')
  expect(await changedWorkerSubmodules(dir)).toEqual([subpath + '/nested/lib'])
})

it('leaves an empty dependency with local guidance when object hardlinks are unavailable', async () => {
  const f = fixture(), dir = f.worktree(), before = f.unchanged()
  const exec = childProcess.execFile, clones: string[][] = []
  const spy = vi.spyOn(childProcess, 'execFile').mockImplementation(((file: string, args: string[], options: unknown, callback: (...args: unknown[]) => void) => {
    if (args.includes('clone')) {
      clones.push(args)
      queueMicrotask(() => callback(Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' }), '', ''))
      return {} as ReturnType<typeof exec>
    }
    return (exec as any)(file, args, options, callback)
  }) as typeof exec)
  try {
    const result = await prepareWorkerSubmodules(repo, dir)
    expect(result.prompt).toContain('empty (local Git inspection or checkout failed)')
    expect(result.reply).toHaveLength(2)
    expect(result.reply[0]).toContain('in worker run:')
    expect(result.reply[0]).not.toContain(repo)
    expect(clones).toHaveLength(1)
    expect(clones[0]).toContain('--local')
    expect(clones[0]).not.toContain('--no-hardlinks')
    expect(clones[0]).not.toContain('--shared')
    expect(fs.readdirSync(path.join(dir, subpath))).toEqual([])
    expect(f.unchanged()).toEqual(before)
  } finally { spy.mockRestore() }
})

it('real spawn and preview preserve opaque gitlinks; collection removes clean populated worktrees', async () => {
  const f = fixture(), t = world({ repo, head: f.head }), before = f.unchanged()
  const reply = await t.call('room_spawn', { tag: 'collect', task: 'build library', host: 'claude' })
  expect(reply).toContain('ready at ' + f.first.slice(0, 10))
  expect(t.launches.get('collect')!.join('\n')).toContain('ready at ' + f.first.slice(0, 10))
  const dir = path.join(repo, '.room/workers/collect')
  put(dir, 'keep.txt', 'worker edit\n')
  await t.finish('collect')
  const preview = await t.call('room_preview_merge', { people: ['rohanz+collect'] })
  expect(preview).toContain('keep.txt')
  const collected = await t.call('room_collect', { tag: 'collect' })
  expect(collected).toContain('collected')
  expect(read(repo, 'keep.txt')).toBe('worker edit\n')
  expect(fs.existsSync(dir), collected).toBe(false)
  expect(git(repo, 'ls-files', '--stage', '--', subpath)).toContain('160000 ' + f.first)
  expect(f.unchanged()).toEqual(before)
})

it('discard removes a clean populated worktree without modifying the source', async () => {
  const f = fixture(), t = world({ repo, head: f.head }), before = f.unchanged()
  const discard = await t.spawn('discard')
  await t.finish('discard')
  const discarded = await t.call('room_collect', { tag: 'discard', discard: true })
  expect(fs.existsSync(discard.dir), discarded).toBe(false)
  expect(f.unchanged()).toEqual(before)
})

it('retains submodule edits, new commits and ignored output because collection/discard cannot recover them', async () => {
  const f = fixture(), t = world({ repo, head: f.head }), w = await t.spawn('dirty')
  const at = path.join(w.dir, subpath)
  put(at, 'library.txt', 'precious child work\n')
  expect(await changedWorkerSubmodules(w.dir)).toEqual([subpath])
  put(w.dir, 'keep.txt', 'ordinary worker edit\n')
  await t.finish('dirty')
  const reply = await t.call('room_collect', { tag: 'dirty' })
  expect(reply).toContain('manual collection')
  expect(read(repo, 'keep.txt')).toBe('k1\nk2\n')
  expect(read(at, 'library.txt')).toBe('precious child work\n')
  const discarded = await t.call('room_collect', { tag: 'dirty', discard: true })
  expect(discarded).toContain('submodule work is not collected')
  expect(read(at, 'library.txt')).toBe('precious child work\n')
  git(at, '-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qam', 'local child commit')
  expect(await changedWorkerSubmodules(w.dir)).toEqual([subpath])
  git(at, 'checkout', '-q', f.first)
  put(at, 'build/precious', 'ignored child result')
  expect(await changedWorkerSubmodules(w.dir)).toEqual([subpath])
})

it('retains a stash in an otherwise clean populated submodule during discard', async () => {
  const f = fixture(), t = world({ repo, head: f.head }), w = await t.spawn('stash')
  const at = path.join(w.dir, subpath)
  put(at, 'library.txt', 'recoverable stash\n')
  git(at, '-c', 'user.name=test', '-c', 'user.email=test@example.test', 'stash', 'push', '-qm', 'save child work')
  const stash = git(at, 'rev-parse', 'refs/stash')
  expect(git(at, 'status', '--porcelain')).toBe('')
  expect(await changedWorkerSubmodules(w.dir)).toEqual([subpath])
  await t.finish('stash')
  const reply = await t.call('room_collect', { tag: 'stash', discard: true })
  expect(reply).toContain('submodule work is not collected')
  expect(git(at, 'rev-parse', 'refs/stash')).toBe(stash)
})

it('retains commits reachable only from a submodule reflog after refs and working files return to creation', async () => {
  const f = fixture(), dir = f.worktree()
  await prepareWorkerSubmodules(repo, dir)
  const at = path.join(dir, subpath)
  put(at, 'library.txt', 'reflog-only work\n')
  git(at, 'add', '-A')
  git(at, '-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'reflog work')
  const saved = git(at, 'rev-parse', 'HEAD')
  git(at, 'reset', '--hard', '-q', f.first)
  expect(git(at, 'status', '--porcelain')).toBe('')
  expect(git(at, 'rev-parse', 'HEAD')).toBe(f.first)
  expect(git(at, 'reflog')).toContain(saved.slice(0, 7))
  expect(await changedWorkerSubmodules(dir)).toEqual([subpath])
})

it('does no Git work for setup or cleanup of a 40,000-entry ordinary index', async () => {
  // An actual 5+ MiB index, made without creating 40,000 files or processes.
  const blob = git(repo, 'hash-object', '-w', '--stdin')
  const entries = Array.from({ length: 40_000 }, (_, n) => `100644 ${blob}\t${String(n).padStart(6, '0')}-${'x'.repeat(100)}\0`).join('')
  const input = path.join(repo, '.room/index-entries')
  fs.mkdirSync(path.dirname(input), { recursive: true }); fs.writeFileSync(input, entries)
  childProcess.execFileSync('git', ['-C', repo, 'update-index', '-z', '--index-info'], { input: entries, stdio: ['pipe', 'pipe', 'pipe'] })
  const spy = vi.spyOn(childProcess, 'execFile')
  try {
    expect(await changedWorkerSubmodules(repo)).toEqual([])
    expect(await prepareWorkerSubmodules(repo, repo)).toEqual({ reply: [] })
    expect(spy).not.toHaveBeenCalled()
  } finally { spy.mockRestore() }
})

it('removes private staging after checkout times out and leaves an empty path with guidance', async () => {
  const f = fixture(), dir = f.worktree(), before = f.unchanged()
  const exec = childProcess.execFile
  let checkout: string | undefined
  const spy = vi.spyOn(childProcess, 'execFile').mockImplementation(((file: string, args: string[], options: any, callback: any) => {
    if (args.includes('checkout')) {
      checkout = options.cwd
      // Real killed child exercises callback/cleanup ordering; it cannot write the destination.
      return exec(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { ...options, timeout: 25 }, callback)
    }
    return (exec as any)(file, args, options, callback)
  }) as typeof exec)
  try {
    const result = await prepareWorkerSubmodules(repo, dir)
    expect(checkout).toBeDefined()
    expect(result.prompt).toContain('empty (submodule setup time limit reached)')
    expect(result.prompt).toContain('clone --local --no-checkout')
    expect(fs.readdirSync(path.join(dir, subpath))).toEqual([])
    expect(fs.existsSync(checkout!)).toBe(false)
    expect(f.unchanged()).toEqual(before)
  } finally { spy.mockRestore() }
})

it('ignores incidental Git metadata but retains new private branches and missing creation evidence', async () => {
  const f = fixture(), dir = f.worktree()
  const result = await prepareWorkerSubmodules(repo, dir)
  expect(result.prompt).toContain('ready at ' + f.first.slice(0, 10))
  const at = path.join(dir, subpath)
  put(at, '.git/FETCH_HEAD', f.first + '\t\ttrial\n')
  put(at, '.git/ORIG_HEAD', f.first + '\n')
  git(at, 'status', '--porcelain') // A normal index refresh is allowed.
  expect(await changedWorkerSubmodules(dir)).toEqual([])
  git(at, 'branch', 'saved-child-work', f.first)
  expect(await changedWorkerSubmodules(dir)).toEqual([subpath])
  fs.unlinkSync(path.join(dir, '.gitmodules'))
  expect(await changedWorkerSubmodules(dir)).toEqual([subpath])
  git(at, 'branch', '-D', 'saved-child-work')
  fs.writeFileSync(path.join(dir, '.gitmodules'), fs.readFileSync(path.join(repo, '.gitmodules')))
  fs.unlinkSync(path.join(git(dir, 'rev-parse', '--absolute-git-dir'), 'room-submodules.json'))
  expect(await changedWorkerSubmodules(dir)).toEqual([subpath])
})

it('retains unverifiable refs instead of treating a Git warning as an unchanged clone', async () => {
  const f = fixture(), dir = f.worktree()
  const result = await prepareWorkerSubmodules(repo, dir)
  expect(result.prompt).toContain('ready at ' + f.first.slice(0, 10))
  put(path.join(dir, subpath), '.git/refs/heads/broken', 'not-an-object-id\n')
  expect(await changedWorkerSubmodules(dir)).toEqual([subpath])
})

it.each(['--assume-unchanged', '--skip-worktree'])('retains work hidden by %s without changing the real index', async flag => {
  const f = fixture(), t = world({ repo, head: f.head }), w = await t.spawn('hidden')
  const at = path.join(w.dir, subpath)
  git(at, 'update-index', flag, '--', 'library.txt')
  expect(await changedWorkerSubmodules(w.dir)).toEqual([subpath])
  put(at, 'library.txt', 'hidden child work\n')
  expect(git(at, 'status', '--porcelain')).toBe('')
  const index = fs.readFileSync(path.join(at, '.git/index'))
  expect(await changedWorkerSubmodules(w.dir)).toEqual([subpath])
  expect(fs.readFileSync(path.join(at, '.git/index'))).toEqual(index)
  await t.finish('hidden')
  const reply = await t.call('room_collect', { tag: 'hidden', discard: true })
  expect(reply).toContain('submodule work is not collected')
  expect(read(at, 'library.txt')).toBe('hidden child work\n')
})

it('preserves staged work even when the on-disk bytes match HEAD', async () => {
  const f = fixture(), dir = f.worktree()
  await prepareWorkerSubmodules(repo, dir)
  const at = path.join(dir, subpath)
  put(at, 'library.txt', 'staged child work\n'); git(at, 'add', 'library.txt')
  put(at, 'library.txt', 'first\n')
  const index = fs.readFileSync(path.join(at, '.git/index'))
  expect(await changedWorkerSubmodules(dir)).toEqual([subpath])
  expect(fs.readFileSync(path.join(at, '.git/index'))).toEqual(index)
})

it.each(['local', 'global'])('allows clean CRLF checkouts under %s core.autocrlf', async scope => {
  const f = fixture(), dir = f.worktree()
  await prepareWorkerSubmodules(repo, dir)
  const at = path.join(dir, subpath)
  if (scope === 'local') git(at, 'config', 'core.autocrlf', 'true')
  else {
    const config = path.join(path.dirname(repo), 'autocrlf.gitconfig')
    fs.writeFileSync(config, '[core]\n\tautocrlf = true\n')
    vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  }
  fs.unlinkSync(path.join(at, 'library.txt'))
  git(at, 'checkout', 'HEAD', '--', 'library.txt')
  expect(read(at, 'library.txt')).toBe('first\r\n')
  expect(git(at, 'status', '--porcelain')).toBe('')
  expect(await changedWorkerSubmodules(dir)).toEqual([])
})
