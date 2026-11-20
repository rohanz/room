import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareWorkerBuildDir, workerBuildDirNote } from '../src/worker-build-dir.js'
import { workerEnv, workerProcessEnv, workerPrompt } from '../src/worker-config.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-build-dir-')))
  roots.push(dir)
  git(dir, 'init', '-q')
  return dir
}

it('ignores worker-local output without project ignore rules or shared Git-state writes, and reuses it on resume', async () => {
  const root = repo()
  const sharedExclude = path.join(root, '.git/info/exclude'), before = fs.readFileSync(sharedExclude)
  const build = await prepareWorkerBuildDir(root, 'compile')
  expect(build).toBe(path.join(root, '.room/scratch/compile'))
  fs.writeFileSync(path.join(build, 'baseline.txt'), 'private baseline')
  fs.writeFileSync(path.join(build, '.gitignore'), '!baseline.txt\n')
  expect(git(root, 'check-ignore', '.room/scratch/compile/baseline.txt')).toContain('baseline.txt')
  expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('')
  expect(await prepareWorkerBuildDir(root, 'compile')).toBe(build)
  expect(await prepareWorkerBuildDir(root, 'other')).not.toBe(build)
  expect(fs.readFileSync(sharedExclude)).toEqual(before)
  expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false)
  if (process.platform !== 'win32') expect(fs.statSync(build).mode & 0o777).toBe(0o700)
})

it.each(['.room/\n', '!.room/\n!.room/scratch/\n!.room/scratch/**\n'])('works with existing project ignore policy %j', async rules => {
  const root = repo()
  fs.writeFileSync(path.join(root, '.gitignore'), rules)
  const build = await prepareWorkerBuildDir(root, 'w')
  fs.writeFileSync(path.join(build, 'object.o'), 'output')
  expect(git(root, 'check-ignore', '.room/scratch/w/object.o')).toContain('object.o')
  expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(rules)
})

it.each(['.room', '.room/scratch', '.room/scratch/w', '.room/scratch/.gitignore'])('refuses linked %s without writing outside the worktree', async rel => {
  const root = repo(), outside = repo()
  const target = rel.endsWith('.gitignore') ? path.join(outside, 'target') : outside
  if (rel.endsWith('.gitignore')) fs.writeFileSync(target, '*\n')
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true, mode: 0o700 })
  fs.symlinkSync(target, path.join(root, rel), rel.endsWith('.gitignore') ? 'file' : process.platform === 'win32' ? 'junction' : 'dir')
  await expect(prepareWorkerBuildDir(root, 'w')).rejects.toThrow(/plain directory|directory.*symlink|expected plain file/)
  expect(fs.readdirSync(outside).sort()).toEqual(rel.endsWith('.gitignore') ? ['.git', 'target'] : ['.git'])
})

it('refuses changed ignore files, tracked scratch state and unsafe tags', async () => {
  const root = repo()
  fs.mkdirSync(path.join(root, '.room/scratch'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(root, '.room/scratch/.gitignore'), '!keep\n')
  await expect(prepareWorkerBuildDir(root, 'w')).rejects.toThrow('expected plain file')
  fs.rmSync(path.join(root, '.room/scratch/.gitignore'))
  fs.writeFileSync(path.join(root, '.room/scratch/tracked'), 'project file')
  git(root, 'add', '.room/scratch/tracked')
  await expect(prepareWorkerBuildDir(root, 'w')).rejects.toThrow('tracked .room/scratch')
  expect(fs.existsSync(path.join(root, '.room/scratch/.gitignore'))).toBe(false)
  for (const tag of ['../escape', '/absolute', 'x/y', 'x\\y', '']) await expect(prepareWorkerBuildDir(root, tag)).rejects.toThrow('invalid worker build directory tag')
})

it('exposes only the prepared path in the worker env/prompt and drops inherited values for supplied checkouts', () => {
  const options = { threads: 2, memGb: 1, host: 'codex' as const, server: 'local', room: 'local/repo', dir: '/worker', tag: 'w', owner: 'o', share: 'intent', run: 1, nonce: 'n', registry: '/registry', id: 'id', logDir: '/lead', isWorker: true }
  const inherited = { WORKER_BUILD_DIR: '/lead/do-not-touch' }
  const env = workerEnv(inherited, workerProcessEnv({ ...options, buildDir: '/worker/.room/scratch/w' }, inherited))
  expect(env.WORKER_BUILD_DIR).toBe('/worker/.room/scratch/w')
  expect(workerEnv(inherited, workerProcessEnv(options, inherited))).not.toHaveProperty('WORKER_BUILD_DIR')
  expect(workerPrompt('lead', 'w', 'compile', { threads: 2, memGb: 1, nice: 10, buildDir: env.WORKER_BUILD_DIR })).toContain(workerBuildDirNote(env.WORKER_BUILD_DIR))
  expect(workerPrompt('lead', 'w', 'compile', { threads: 2, memGb: 1, nice: 10 })).toContain('No build directory is provided for a supplied dir= checkout')
})


it.skipIf(process.platform === 'win32')('uses existing checkout directories without repairing their permissions', async () => {
  const root = repo()
  const room = path.join(root, '.room')
  fs.mkdirSync(room, { mode: 0o755 })
  fs.chmodSync(room, 0o755)
  expect(await prepareWorkerBuildDir(root, 'w')).toBe(path.join(room, 'scratch/w'))
  expect(fs.statSync(room).mode & 0o777).toBe(0o755)
})

it.skipIf(process.platform === 'win32')('does not repair checkout ancestors named room while initializing worker-owned leaves', async () => {
  const root = repo(), ancestor = path.join(root, 'room'), worker = path.join(ancestor, 'worker')
  fs.mkdirSync(ancestor, { mode: 0o755 })
  fs.chmodSync(ancestor, 0o755)
  fs.mkdirSync(worker, { mode: 0o700 })
  git(worker, 'init', '-q')
  await prepareWorkerBuildDir(worker, 'w')
  expect(fs.statSync(ancestor).mode & 0o777).toBe(0o755)
})


it('prepares build output without synchronous filesystem operations', async () => {
  const root = repo()
  const methods = ['lstatSync', 'realpathSync', 'mkdirSync', 'accessSync', 'writeFileSync', 'readFileSync', 'openSync', 'existsSync'] as const
  const spies = methods.map(method => vi.spyOn(fs, method).mockImplementation((() => { throw new Error(`unexpected synchronous filesystem call: ${method}`) }) as never))
  try {
    expect(await prepareWorkerBuildDir(root, 'w')).toBe(path.join(root, '.room/scratch/w'))
    expect(spies.map(spy => spy.mock.calls.length)).toEqual(methods.map(() => 0))
  } finally { for (const spy of spies) spy.mockRestore() }
})

it('keeps the event loop available while output-directory I/O is pending', async () => {
  const root = repo(), mkdir = fs.promises.mkdir
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const spy = vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (...args: Parameters<typeof fs.promises.mkdir>) => {
    if (String(args[0]) === path.join(root, '.room')) { enter(); await gate }
    return mkdir(...args)
  }) as typeof fs.promises.mkdir)
  const setup = prepareWorkerBuildDir(root, 'w')
  try {
    await entered
    expect(await new Promise(resolve => setImmediate(() => resolve('serviced')))).toBe('serviced')
    release()
    expect(await setup).toBe(path.join(root, '.room/scratch/w'))
  } finally { release(); spy.mockRestore(); await setup.catch(() => {}) }
})
