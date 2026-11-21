import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import childProcess from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { prepareWorkerSubmodules } from '../src/worker-submodules.js'
import { commit, git, put, read, repo, world } from './worker-refresh-fixture.js'

const subpath = "vendor/large lib's"
function fixture() {
  const child = path.join(path.dirname(repo), 'child')
  fs.mkdirSync(child)
  git(child, 'init', '-q', '-b', 'main'); git(child, 'config', 'user.name', 'test'); git(child, 'config', 'user.email', 'test@example.test')
  put(child, '.gitignore', 'build/\n'); put(child, 'library.txt', 'first\n')
  put(child, 'exec.sh', '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(child, 'exec.sh'), 0o755)
  fs.writeFileSync(path.join(child, 'binary.dat'), Buffer.from([0, 255, 13, 10, 7]))
  const first = commit(child, 'first')
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

it('exports recorded raw bytes and executable modes with readonly files, writable directories and no Git metadata', async () => {
  const f = fixture(), dir = f.worktree(), before = f.unchanged()
  const result = await prepareWorkerSubmodules(repo, dir), at = path.join(dir, subpath)
  expect(result.prompt).toContain(`read-only copy of ${f.first.slice(0, 10)}, not a Git checkout`)
  expect(result.reply).toHaveLength(1); expect(result.prompt).toBe(result.reply.join('\n'))
  expect(read(at, 'library.txt')).toBe('first\n')
  expect(fs.readFileSync(path.join(at, 'binary.dat'))).toEqual(Buffer.from([0, 255, 13, 10, 7]))
  expect(fs.statSync(path.join(at, 'library.txt')).mode & 0o222).toBe(0)
  expect(fs.statSync(path.join(at, 'exec.sh')).mode & 0o111).not.toBe(0)
  expect(fs.statSync(at).mode & 0o200).not.toBe(0)
  expect(fs.existsSync(path.join(at, '.git'))).toBe(false)
  expect(fs.statSync(path.join(at, 'library.txt')).ino).not.toBe(fs.statSync(path.join(f.source, 'library.txt')).ino)
  put(at, 'build/output', 'generated in-tree build data')
  expect(read(at, 'build/output')).toBe('generated in-tree build data')
  expect(f.unchanged()).toEqual(before)
})

it.each(['dirty', 'different commit'])('exports the recorded commit when the lead is %s without running lead filters', async state => {
  const f = fixture()
  put(f.source, '.gitattributes', 'library.txt filter=sideeffect\n')
  const recorded = commit(f.source, 'filter attribute'); commit(repo, 'record filtered child')
  const marker = path.join(f.source, 'lead-was-modified'), script = path.join(f.sourceGit, 'filter.cjs')
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'); process.stdin.pipe(process.stdout)`)
  if (state === 'different commit') git(f.source, 'checkout', '-q', f.second)
  git(f.source, 'config', 'filter.sideeffect.clean', `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`)
  put(f.source, 'library.txt', 'other\n')
  const before = f.unchanged(), dir = f.worktree(), calls: { cwd: string; args: string[] }[] = []
  const exec = childProcess.execFile
  const spy = vi.spyOn(childProcess, 'execFile').mockImplementation(((file: string, args: string[], options: any, callback: any) => {
    calls.push({ cwd: options.cwd, args }); return (exec as any)(file, args, options, callback)
  }) as typeof exec)
  try {
    expect((await prepareWorkerSubmodules(repo, dir)).prompt).toContain(recorded.slice(0, 10))
    expect(read(path.join(dir, subpath), 'library.txt')).toBe('first\n')
    expect(fs.existsSync(marker)).toBe(false)
    expect(calls.some(call => call.cwd === f.source || call.cwd === repo)).toBe(false)
    expect(calls.some(call => ['status', 'clone', 'checkout', 'update-index'].some(command => call.args.includes(command)))).toBe(false)
    expect(f.unchanged()).toEqual(before)
  } finally { spy.mockRestore() }
})

it('exports raw LFS pointers, stored line endings and files marked export-ignore/export-subst', async () => {
  const f = fixture()
  put(f.source, '.gitattributes', 'library.txt text eol=crlf\npointer.dat filter=lfs\nomitted.txt export-ignore\nformat.txt export-subst\n')
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 100000\n'
  put(f.source, 'pointer.dat', pointer); put(f.source, 'omitted.txt', 'must be exported\n'); put(f.source, 'format.txt', '$Format:%H$\n')
  commit(f.source, 'attributes and LFS pointer'); commit(repo, 'update child')
  const dir = f.worktree(), result = await prepareWorkerSubmodules(repo, dir), at = path.join(dir, subpath)
  expect(read(at, 'library.txt')).toBe('first\n')
  expect(read(at, 'pointer.dat')).toBe(pointer)
  expect(read(at, 'omitted.txt')).toBe('must be exported\n')
  expect(read(at, 'format.txt')).toBe('$Format:%H$\n')
  expect(result.prompt).toContain('no filters/LFS/EOL conversion')
})

it('leaves nested gitlinks empty and says so', async () => {
  const f = fixture()
  git(f.source, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', f.child, 'nested/lib')
  commit(f.source, 'nested dependency'); commit(repo, 'updated library')
  const dir = f.worktree(), before = f.unchanged(), result = await prepareWorkerSubmodules(repo, dir)
  expect(result.prompt).toContain('1 nested submodule folder(s) empty')
  expect(result.prompt).toContain('empty (nested submodule)')
  expect(result.prompt).toContain('git -C')
  expect(result.prompt).toContain(f.second)
  expect(result.prompt).toContain(JSON.stringify(subpath + '/nested/lib'))
  expect(fs.readdirSync(path.join(dir, subpath, 'nested/lib'))).toEqual([])
  expect(f.unchanged()).toEqual(before)
})

it('uses locally available alternates and leaves missing objects empty with commands', async () => {
  const f = fixture(), dir = f.worktree()
  fs.writeFileSync(path.join(f.sourceGit, 'objects/info/alternates'), path.join(f.child, '.git/objects') + '\n')
  expect((await prepareWorkerSubmodules(repo, dir)).prompt).toContain('read-only copy')
  fs.unlinkSync(path.join(f.sourceGit, 'objects/info/alternates'))
  const blob = git(f.source, 'rev-parse', f.first + ':library.txt')
  fs.unlinkSync(path.join(f.sourceGit, 'objects', blob.slice(0, 2), blob.slice(2)))
  const missing = f.worktree('missing'), result = await prepareWorkerSubmodules(repo, missing)
  expect(result.prompt).toContain('otherwise empty')
  expect(result.prompt).toContain('git fetch <remote> ' + f.first)
  expect(fs.readdirSync(path.join(missing, subpath))).toEqual([])
  expect(fs.readdirSync(path.join(missing, 'vendor')).some(name => name.startsWith('.room-submodule-'))).toBe(false)
})

it('preserves existing destinations and refuses linked source/destination paths', async () => {
  const f = fixture(), dir = f.worktree()
  put(dir, subpath + '/precious', 'existing data')
  expect((await prepareWorkerSubmodules(repo, dir)).prompt).toContain('existing contents kept')
  expect(read(dir, subpath + '/precious')).toBe('existing data')
  const linked = f.worktree('linked')
  fs.rmSync(path.join(linked, subpath), { recursive: true })
  fs.symlinkSync(f.source, path.join(linked, subpath), process.platform === 'win32' ? 'junction' : 'dir')
  const before = f.unchanged()
  expect((await prepareWorkerSubmodules(repo, linked)).prompt).toContain('linked export path')
  expect(f.unchanged()).toEqual(before)
})

it.skipIf(process.platform === 'win32')('preserves contained symlinks and declines symlink-chain escapes', async () => {
  const f = fixture()
  fs.symlinkSync('library.txt', path.join(f.source, 'alias'))
  put(f.source, '\ufefftarget', 'BOM filename\n')
  fs.symlinkSync('\ufefftarget', path.join(f.source, 'bom-alias'))
  commit(f.source, 'internal link'); commit(repo, 'child link')
  const dir = f.worktree()
  expect((await prepareWorkerSubmodules(repo, dir)).prompt).toContain('read-only copy')
  expect(fs.readlinkSync(path.join(dir, subpath, 'alias'))).toBe('library.txt')
  expect(read(path.join(dir, subpath), 'alias')).toBe('first\n')
  expect(fs.readlinkSync(path.join(dir, subpath, 'bom-alias'))).toBe('\ufefftarget')
  fs.mkdirSync(path.join(f.source, 'deep'))
  fs.symlinkSync('..', path.join(f.source, 'deep/back'))
  fs.symlinkSync('deep/back/../outside', path.join(f.source, 'escape'))
  commit(f.source, 'escaping chain'); commit(repo, 'unsafe child')
  const unsafe = f.worktree('unsafe')
  expect((await prepareWorkerSubmodules(repo, unsafe)).prompt).toContain('symlink chain leaves export')
  expect(fs.readdirSync(path.join(unsafe, subpath))).toEqual([])
})

it.skipIf(process.platform === 'win32')('does not block the event loop on FIFO metadata', async () => {
  const f = fixture(), dir = f.worktree(), original = fs.readFileSync(path.join(f.sourceGit, 'HEAD'))
  fs.unlinkSync(path.join(f.sourceGit, 'HEAD'))
  childProcess.execFileSync('mkfifo', [path.join(f.sourceGit, 'HEAD')])
  let ticks = 0
  const timer = setInterval(() => ticks++, 10), started = performance.now()
  try {
    const result = await prepareWorkerSubmodules(repo, dir, { timeoutMs: 250 })
    expect(result.prompt).toContain('otherwise empty')
    expect(performance.now() - started).toBeLessThan(2000)
    expect(ticks).toBeGreaterThan(0)
    expect(fs.readdirSync(path.join(dir, subpath))).toEqual([])
  } finally { clearInterval(timer); fs.unlinkSync(path.join(f.sourceGit, 'HEAD')); fs.writeFileSync(path.join(f.sourceGit, 'HEAD'), original) }
})

it('removes a partial readonly export after a killed object read', async () => {
  const f = fixture()
  for (let n = 0; n < 260; n++) put(f.source, `many/file-${String(n).padStart(3, '0')}`, 'small\n')
  commit(f.source, 'many blobs'); commit(repo, 'updated child')
  const dir = f.worktree(), exec = childProcess.execFile
  let batches = 0
  const spy = vi.spyOn(childProcess, 'execFile').mockImplementation(((file: string, args: string[], options: any, callback: any) => {
    if (args.includes('cat-file') && ++batches === 2)
      return exec(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { ...options, timeout: 25 }, callback)
    return (exec as any)(file, args, options, callback)
  }) as typeof exec)
  try {
    expect((await prepareWorkerSubmodules(repo, dir)).prompt).toContain('export time limit reached')
    expect(batches).toBe(2)
    expect(fs.readdirSync(path.join(dir, subpath))).toEqual([])
    expect(fs.readdirSync(path.join(dir, 'vendor')).some(name => name.startsWith('.room-submodule-'))).toBe(false)
  } finally { spy.mockRestore() }
})

it('does no Git work without .gitmodules even with a 40,000-entry index', async () => {
  const blob = git(repo, 'hash-object', '-w', '--stdin')
  const entries = Array.from({ length: 40_000 }, (_, n) => `100644 ${blob}\t${n}-${'x'.repeat(100)}\0`).join('')
  childProcess.execFileSync('git', ['-C', repo, 'update-index', '-z', '--index-info'], { input: entries, stdio: ['pipe', 'pipe', 'pipe'] })
  const spy = vi.spyOn(childProcess, 'execFile')
  try { expect(await prepareWorkerSubmodules(repo, repo)).toEqual({ reply: [] }); expect(spy).not.toHaveBeenCalled() }
  finally { spy.mockRestore() }
})

it('spawn, preview and collection treat the export as an unchanged gitlink and remove in-tree output', async () => {
  const f = fixture(), t = world({ repo, head: f.head }), before = f.unchanged()
  const reply = await t.call('room_spawn', { tag: 'collect', task: 'build', host: 'claude' })
  expect(reply).toContain('read-only copy of ' + f.first.slice(0, 10))
  expect(t.launches.get('collect')!.join('\n')).toContain('not a Git checkout')
  const dir = path.join(repo, '.room/workers/collect')
  put(dir, 'keep.txt', 'deliverable\n'); put(dir, subpath + '/build/output', 'generated\n')
  expect(git(dir, 'status', '--porcelain')).not.toContain(subpath)
  await t.finish('collect')
  expect(await t.call('room_preview_merge', { people: ['rohanz+collect'] })).toContain('keep.txt')
  const result = await t.call('room_collect', { tag: 'collect' })
  expect(result).toContain('collected'); expect(fs.existsSync(dir), result).toBe(false)
  expect(read(repo, 'keep.txt')).toBe('deliverable\n'); expect(f.unchanged()).toEqual(before)
})

it('discard removes the export and in-tree build output without a submodule-state retention rule', async () => {
  const f = fixture(), t = world({ repo, head: f.head }), before = f.unchanged(), worker = await t.spawn('discard')
  put(worker.dir, subpath + '/build/output', 'generated\n')
  await t.finish('discard')
  const result = await t.call('room_collect', { tag: 'discard', discard: true })
  expect(fs.existsSync(worker.dir), result).toBe(false)
  expect(f.unchanged()).toEqual(before)
})

it('declines a blob above the memory ceiling before requesting its contents', async () => {
  const f = fixture(), dir = f.worktree(), exec = childProcess.execFile
  const spy = vi.spyOn(childProcess, 'execFile').mockImplementation(((file: string, args: string[], options: any, callback: any) => {
    if (args.includes('ls-tree')) return exec(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(`100644 blob ${'a'.repeat(40)} 67108865\thuge.bin\0`)})`], options, callback)
    return (exec as any)(file, args, options, callback)
  }) as typeof exec)
  try {
    expect((await prepareWorkerSubmodules(repo, dir)).prompt).toContain('blob exceeds 64 MiB export limit')
    expect(spy.mock.calls.some(call => (call[1] as string[]).includes('cat-file'))).toBe(false)
    expect(fs.readdirSync(path.join(dir, subpath))).toEqual([])
  } finally { spy.mockRestore() }
})

it('keeps optional setup non-fatal when initial filesystem inspection fails', async () => {
  const spy = vi.spyOn(fsp, 'lstat').mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
  try { expect((await prepareWorkerSubmodules(repo, repo)).prompt).toContain('export unavailable (permission denied)') }
  finally { spy.mockRestore() }
})

it('a zero time budget leaves an empty folder with guidance and no Git command', async () => {
  const f = fixture(), dir = f.worktree(), spy = vi.spyOn(childProcess, 'execFile')
  try {
    expect((await prepareWorkerSubmodules(repo, dir, { timeoutMs: 0 })).prompt).toContain('export time limit reached')
    expect(spy).not.toHaveBeenCalled()
    expect(fs.readdirSync(path.join(dir, subpath))).toEqual([])
  } finally { spy.mockRestore() }
})

it('keep collection retains exports and later collection removes them without inspecting submodule Git state', async () => {
  const f = fixture(), t = world({ repo, head: f.head }), worker = await t.spawn('kept')
  put(worker.dir, 'keep.txt', 'first delivery\n')
  await t.finish('kept')
  expect(await t.call('room_collect', { tag: 'kept', keep: true })).toContain('collected')
  expect(read(path.join(worker.dir, subpath), 'library.txt')).toBe('first\n')
  expect(await t.call('room_preview_merge', { people: ['rohanz+kept'] })).toContain('no conflicts')
  expect(await t.call('room_collect', { tag: 'kept' })).toContain('collected')
  expect(fs.existsSync(worker.dir)).toBe(false)
})

it('does not treat gitlinks beneath a mapped ordinary directory as configured modules', async () => {
  const f = fixture()
  put(repo, '.gitmodules', '[submodule "incorrect mapping"]\npath = vendor\n')
  commit(repo, 'map an ordinary ancestor')
  const dir = f.worktree(), spy = vi.spyOn(childProcess, 'execFile')
  try {
    expect(await prepareWorkerSubmodules(repo, dir)).toEqual({ reply: [] })
    expect(spy.mock.calls.some(call => (call[1] as string[]).includes('ls-tree'))).toBe(false)
    expect(fs.readdirSync(path.join(dir, subpath))).toEqual([])
  } finally { spy.mockRestore() }
})

it('keeps optional setup non-fatal when canonical path resolution fails', async () => {
  const f = fixture(), dir = f.worktree()
  const spy = vi.spyOn(fsp, 'realpath').mockRejectedValueOnce(new Error('canonical path unavailable'))
  try { expect((await prepareWorkerSubmodules(repo, dir)).prompt).toContain('export unavailable (canonical path unavailable)') }
  finally { spy.mockRestore() }
})

it('reports failed temporary cleanup without rejecting optional setup', async () => {
  const f = fixture(), dir = f.worktree()
  const spy = vi.spyOn(fsp, 'rm').mockRejectedValueOnce(new Error('cleanup denied'))
  try {
    const result = await prepareWorkerSubmodules(repo, dir)
    expect(result.prompt).toContain('read-only copy')
    expect(result.prompt).toContain('temporary export could not be removed')
    expect(read(path.join(dir, subpath), 'library.txt')).toBe('first\n')
  } finally { spy.mockRestore() }
})

it('staged gitlink changes still require manual collection and can be discarded', async () => {
  const f = fixture(), t = world({ repo, head: f.head }), worker = await t.spawn('pointer')
  git(worker.dir, 'update-index', '--cacheinfo', '160000', f.second, subpath)
  put(worker.dir, 'keep.txt', 'ordinary edit\n')
  await t.finish('pointer')
  expect(await t.call('room_preview_merge', { people: ['rohanz+pointer'] })).toContain('NOT previewed (directory or nested repository): ' + subpath)
  const result = await t.call('room_collect', { tag: 'pointer' })
  expect(result).toContain('files need manual collection')
  expect(fs.existsSync(worker.dir)).toBe(true)
  expect(read(repo, 'keep.txt')).toBe('k1\nk2\n')
  expect(git(repo, 'ls-files', '--stage', '--', subpath)).toContain(f.first)
  await t.call('room_collect', { tag: 'pointer', discard: true })
  expect(fs.existsSync(worker.dir)).toBe(false)
})

it('bounds nested module outcomes before a large dependency can inflate the worker prompt', async () => {
  const f = fixture()
  for (let n = 0; n < 64; n++) git(f.source, 'update-index', '--add', '--cacheinfo', '160000', f.first, `nested/lib-${n}`)
  git(f.source, 'commit', '-qm', 'many nested gitlinks'); commit(repo, 'record many nested dependencies')
  const dir = f.worktree(), result = await prepareWorkerSubmodules(repo, dir)
  expect(result.prompt).toContain('nested submodules exceed the 64-module export limit')
  expect(result.reply).toHaveLength(1)
  expect(fs.readdirSync(path.join(dir, subpath))).toEqual([])
  expect(fs.readdirSync(path.join(dir, 'vendor')).some(name => name.startsWith('.room-submodule-'))).toBe(false)
})
