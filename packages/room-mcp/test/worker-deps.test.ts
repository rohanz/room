import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { linkWorkspaceDeps, workspaceDepsNotes } from '../src/worker-deps.js'
import { workerProcessEnv } from '../src/worker-config.js'
import { requireB, workspaceRepo } from './fixtures/workspace-repo.js'

const repos: string[] = []
const fixture = (options?: Parameters<typeof workspaceRepo>[0]) => { const f = workspaceRepo(options); repos.push(f.repo); return f }
afterEach(() => { for (const repo of repos.splice(0)) fs.rmSync(repo, { recursive: true, force: true }) })

const LEAD_CODE = "cross-package tests in this worktree would run the lead's code for @fx/a, @fx/b"

describe('worker workspace links', () => {
  it('stops on EEXIST when a node_modules root appears after preflight', async () => {
    const { repo, worktree } = fixture(), worker = worktree(), modules = path.join(worker, 'node_modules')
    const realpath = fs.realpathSync
    let inserted = false
    const spy = vi.spyOn(fs, 'realpathSync').mockImplementation((...args: Parameters<typeof fs.realpathSync>) => {
      if (!inserted && String(args[0]) === repo) {
        fs.mkdirSync(modules); fs.writeFileSync(path.join(modules, 'precious'), 'existing install')
        inserted = true
      }
      return realpath(...args)
    })
    try {
      const result = await linkWorkspaceDeps(repo, worker)
      expect(inserted).toBe(true)
      expect(result.linked).toBe(false)
      expect(result.reason).toContain('EEXIST')
      expect(result.reason).toContain(modules)
      expect(fs.readdirSync(modules)).toEqual(['precious'])
      expect(fs.readFileSync(path.join(modules, 'precious'), 'utf8')).toBe('existing install')
    } finally { spy.mockRestore() }
  })

  it('refuses an existing nested install before creating any dependency output', async () => {
    const { repo, worktree } = fixture({ layout: 'pnpm' }), worker = worktree()
    const nested = path.join(worker, 'packages/b/node_modules')
    fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, 'precious'), 'nested install')
    const result = await linkWorkspaceDeps(repo, worker)
    expect(result.linked).toBe(false)
    expect(result.reason).toContain(path.join('packages/b/node_modules') + ' already exists in the worktree')
    expect(result.reason).toContain(nested)
    expect(fs.existsSync(path.join(worker, 'node_modules'))).toBe(false)
    expect(fs.readdirSync(nested)).toEqual(['precious'])
    expect(fs.readFileSync(path.join(nested, 'precious'), 'utf8')).toBe('nested install')
  })

  it('does not adopt an existing link whose symlink/.. traversal reaches the lead package', async () => {
    const { repo, worktree } = fixture(), worker = worktree()
    expect((await linkWorkspaceDeps(repo, worker)).linked).toBe(true)
    fs.mkdirSync(path.join(repo, 'alias-child'))
    fs.symlinkSync(path.join(repo, 'alias-child'), path.join(worker, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    const a = path.join(worker, 'node_modules/@fx/a'), target = '../../alias/../packages/a'
    fs.unlinkSync(a); fs.symlinkSync(target, a, process.platform === 'win32' ? 'dir' : undefined)
    expect(fs.realpathSync.native(a)).toBe(fs.realpathSync.native(path.join(repo, 'packages/a')))
    expect(fs.readFileSync(path.join(a, 'index.js'), 'utf8')).toContain('lead-a')
    const before = fs.lstatSync(a).ino
    const result = await linkWorkspaceDeps(repo, worker)
    expect(result.linked).toBe(false)
    expect(result.reason).toContain('node_modules already exists in the worktree')
    expect(fs.lstatSync(a).ino).toBe(before)
    expect(fs.readlinkSync(a)).toBe(target)
  })

  it('refuses an existing empty .bin through a foreign worktree root without extending it', async () => {
    const { repo, worktree } = fixture(), foreign = worktree()
    const root = path.join(repo, '.room/alias-worker'), modules = path.join(foreign, 'node_modules')
    fs.mkdirSync(path.join(modules, '.bin'), { recursive: true })
    fs.symlinkSync(foreign, root, process.platform === 'win32' ? 'junction' : 'dir')
    const before = fs.lstatSync(path.join(modules, '.bin')).ino
    const result = await linkWorkspaceDeps(repo, root)
    expect(result.linked).toBe(false)
    expect(result.reason).toContain('node_modules already exists in the worktree')
    expect(fs.readdirSync(modules)).toEqual(['.bin'])
    expect(fs.readdirSync(path.join(modules, '.bin'))).toEqual([])
    expect(fs.lstatSync(path.join(modules, '.bin')).ino).toBe(before)
  })

  it('refuses a partial install on retry without touching matching links or copied shims', async () => {
    const { repo, worktree } = fixture(), worker = worktree()
    fs.writeFileSync(path.join(repo, 'node_modules/.bin/shim.cmd'), 'matching shim', { mode: 0o755 })
    const link = fs.symlinkSync
    const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation((...args: Parameters<typeof fs.symlinkSync>) => {
      if (String(args[1]) === path.join(worker, 'node_modules/@fx/b')) throw new Error('injected partial setup')
      return link(...args)
    })
    try { expect((await linkWorkspaceDeps(repo, worker)).linked).toBe(false) }
    finally { spy.mockRestore() }
    const a = path.join(worker, 'node_modules/@fx/a'), shim = path.join(worker, 'node_modules/.bin/shim.cmd')
    const before = [fs.lstatSync(a).ino, fs.lstatSync(shim).ino]
    const retried = await linkWorkspaceDeps(repo, worker)
    expect(retried.linked).toBe(false)
    expect(retried.reason).toContain('node_modules already exists in the worktree')
    expect(retried.reason).toContain('discard')
    expect(retried.reason).toContain('delete')
    expect([fs.lstatSync(a).ino, fs.lstatSync(shim).ino]).toEqual(before)
    expect(fs.statSync(shim).mode & 0o111).not.toBe(0)
    expect(requireB(worker)).toBe('worker-a:third')
  })

  it.each(['package-link', 'bin-shim', 'extra-entry'] as const)('reports a retry conflict without replacing %s', async mode => {
    const { repo, worktree } = fixture(), worker = worktree()
    fs.writeFileSync(path.join(repo, 'node_modules/.bin/shim.cmd'), 'expected shim')
    expect((await linkWorkspaceDeps(repo, worker)).linked).toBe(true)
    const conflict = path.join(worker, mode === 'package-link' ? 'node_modules/@fx/a'
      : mode === 'bin-shim' ? 'node_modules/.bin/shim.cmd' : 'node_modules/unexpected')
    if (mode === 'package-link') {
      fs.unlinkSync(conflict); fs.symlinkSync(path.join(repo, 'packages/a'), conflict)
    } else fs.writeFileSync(conflict, mode === 'bin-shim' ? 'precious data' : 'precious existing bytes')
    const before = fs.lstatSync(conflict).ino
    const result = await linkWorkspaceDeps(repo, worker)
    expect(result.linked).toBe(false)
    expect(result.reason).toContain('node_modules already exists in the worktree')
    expect(fs.lstatSync(conflict).ino).toBe(before)
    if (mode === 'package-link') expect(fs.readlinkSync(conflict)).toBe(path.join(repo, 'packages/a'))
    else expect(fs.readFileSync(conflict, 'utf8')).toBe(mode === 'bin-shim' ? 'precious data' : 'precious existing bytes')
  })

  it('refuses an existing install without reading or replacing its shims', async () => {
    const { repo, worktree } = fixture(), worker = worktree()
    const source = path.join(repo, 'node_modules/.bin/shim'), target = path.join(worker, 'node_modules/.bin/shim')
    fs.writeFileSync(source, 'expected shim')
    expect((await linkWorkspaceDeps(repo, worker)).linked).toBe(true)
    const changed = Buffer.from('precious shim')
    fs.writeFileSync(target, changed)
    const inode = fs.statSync(target).ino
    const open = vi.spyOn(fs.promises, 'open')
    let result: Awaited<ReturnType<typeof linkWorkspaceDeps>>
    try { result = await linkWorkspaceDeps(repo, worker); expect(open).not.toHaveBeenCalled() }
    finally { open.mockRestore() }
    expect(result.linked).toBe(false)
    expect(result.reason).toContain('node_modules already exists in the worktree')
    expect(fs.readFileSync(target)).toEqual(changed)
    expect(fs.statSync(target).ino).toBe(inode)
    expect(fs.readFileSync(source, 'utf8')).toBe('expected shim')
  })

  it('retains and reports empty dependency directories after a source read fails', async () => {
    const { repo, worktree } = fixture(), worker = worktree()
    const read = fs.readdirSync
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]) === path.join(repo, 'node_modules/.bin')) throw new Error('injected source read failure')
      return read(...args)
    })
    try {
      const result = await linkWorkspaceDeps(repo, worker)
      expect(result.linked).toBe(false)
      const bin = path.join(worker, 'node_modules/.bin')
      expect(fs.readdirSync(bin)).toEqual([])
      expect(result.reason).toContain(bin)
    } finally { spy.mockRestore() }
  })

  it('npm workspaces: package b in the worktree requires the worktree\'s package a, third-party packages still resolve', async () => {
    const { repo, worktree } = fixture()
    const worker = worktree()
    // The bug: with no node_modules of its own, resolution walks up into the lead's install.
    expect(requireB(worker)).toBe('lead-a:third')
    const result = await linkWorkspaceDeps(repo, worker)
    expect(result).toMatchObject({ linked: true, names: ['@fx/a', '@fx/b'] })
    expect(requireB(worker)).toBe('worker-a:third')
    expect(requireB(repo)).toBe('lead-a:third')
    expect(fs.lstatSync(path.join(worker, 'node_modules')).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(worker, 'node_modules/.bin/third')).mode & 0o111).not.toBe(0)
    expect(fs.realpathSync(path.join(worker, 'node_modules/@fx/a'))).toBe(path.join(worker, 'packages/a'))
    expect(fs.realpathSync(path.join(worker, 'node_modules/third'))).toBe(path.join(repo, 'node_modules/third'))
    // Package managers rewrite their state files; a link would let the worker write the lead's.
    expect(fs.existsSync(path.join(worker, 'node_modules/.package-lock.json'))).toBe(false)
    expect(execFileSync(path.join(worker, 'node_modules/.bin/third')).toString().trim()).toBe('third')
    expect(execFileSync('git', ['-C', worker, 'status', '--porcelain'], { stdio: 'pipe' }).toString()).toBe(' M packages/a/index.js\n')
    expect(workspaceDepsNotes(result).prompt).toContain('node_modules')
    expect(workspaceDepsNotes(result).reply.join('\n')).not.toContain('would run the lead')
  })

  it('keeps caches and partial output on failure, refuses retry, and accepts only cache-only roots', async () => {
    const { repo, worktree } = fixture()
    const worker = worktree()
    fs.mkdirSync(path.join(worker, 'node_modules/.vite/vitest'), { recursive: true })
    fs.writeFileSync(path.join(worker, 'node_modules/.vite/vitest/results.json'), '{}')
    let clock = 0
    const timedOut = await linkWorkspaceDeps(repo, worker, { timeoutMs: 3000, now: () => (clock += 1000) })
    expect(timedOut.linked).toBe(false)
    expect(fs.readdirSync(path.join(worker, 'node_modules'))).toEqual(['.bin', '.vite'])
    expect(timedOut.reason).toContain(path.join(worker, 'node_modules/.bin'))
    // A partial install is retained; setup never resumes it.
    const binBefore = fs.lstatSync(path.join(worker, 'node_modules/.bin')).ino
    const retried = await linkWorkspaceDeps(repo, worker)
    expect(retried.linked).toBe(false)
    expect(retried.reason).toContain('node_modules already exists in the worktree')
    expect(fs.lstatSync(path.join(worker, 'node_modules/.bin')).ino).toBe(binBefore)
    expect(requireB(worker)).toBe('lead-a:third')
    expect(fs.existsSync(path.join(worker, 'node_modules/.vite/vitest/results.json'))).toBe(true)
    const cached = worktree('cache-only'), cache = path.join(cached, 'node_modules/.cache/precious')
    fs.mkdirSync(path.dirname(cache), { recursive: true }); fs.writeFileSync(cache, 'tool cache')
    const rootBefore = fs.lstatSync(path.join(cached, 'node_modules')).ino
    expect((await linkWorkspaceDeps(repo, cached)).linked).toBe(true)
    expect(fs.lstatSync(path.join(cached, 'node_modules')).ino).toBe(rootBefore)
    expect(fs.readFileSync(cache, 'utf8')).toBe('tool cache')
    expect(requireB(cached)).toBe('worker-a:third')
    const other = worktree('installed')
    fs.mkdirSync(path.join(other, 'node_modules/left-pad'), { recursive: true })
    expect((await linkWorkspaceDeps(repo, other)).reason).toContain('node_modules already exists in the worktree')
    expect(fs.lstatSync(path.join(other, 'node_modules/left-pad')).isDirectory()).toBe(true)
  })

  it('pnpm: nested package node_modules are rebuilt with workspace links repointed into the worktree', async () => {
    const { repo, worktree } = fixture({ layout: 'pnpm' })
    const worker = worktree()
    // pnpm keeps b's dependencies in packages/b/node_modules, which a fresh worktree lacks entirely.
    expect(() => requireB(worker)).toThrow(/Cannot find module '@fx\/a'/)
    const result = await linkWorkspaceDeps(repo, worker)
    expect(result).toMatchObject({ linked: true, names: ['@fx/a', '@fx/b'] })
    expect(requireB(worker)).toBe('worker-a:third')
    expect(requireB(repo)).toBe('lead-a:third')
    expect(fs.lstatSync(path.join(worker, 'packages/b/node_modules')).isDirectory()).toBe(true)
    expect(fs.lstatSync(path.join(worker, 'packages/b/node_modules/@fx')).isDirectory()).toBe(true)
    expect(fs.realpathSync(path.join(worker, 'packages/b/node_modules/third'))).toBe(path.join(repo, 'node_modules/.pnpm/third@1.0.0/node_modules/third'))
    expect(fs.existsSync(path.join(worker, 'node_modules/.modules.yaml'))).toBe(false)
  })

  it('without a lockfile nothing is linked and the worker is told plainly', async () => {
    const { repo, worktree } = fixture({ lockfile: false })
    const worker = worktree()
    const result = await linkWorkspaceDeps(repo, worker)
    expect(result.linked).toBe(false)
    expect(fs.existsSync(path.join(worker, 'node_modules'))).toBe(false)
    const notes = workspaceDepsNotes(result)
    expect(notes.reply.join('\n')).toContain(LEAD_CODE)
    expect(notes.prompt).toContain(LEAD_CODE)
    expect(notes.reply.join('\n')).toContain('lockfile')
  })

  it('without the lead\'s node_modules the worker is told the same', async () => {
    const { repo, worktree } = fixture({ nodeModules: false })
    const result = await linkWorkspaceDeps(repo, worktree())
    expect(result.linked).toBe(false)
    expect(workspaceDepsNotes(result).reply.join('\n')).toContain(LEAD_CODE)
  })

  it('a repository without workspaces gets links to the lead\'s install, so its .bin scripts run', async () => {
    const { repo, worktree } = fixture()
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'single' }))
    const worker = worktree()
    const result = await linkWorkspaceDeps(repo, worker)
    expect(result).toMatchObject({ linked: true, names: [], workspaces: false })
    expect(fs.lstatSync(path.join(worker, 'node_modules')).isDirectory()).toBe(true)
    expect(fs.realpathSync(path.join(worker, 'node_modules/third'))).toBe(path.join(repo, 'node_modules/third'))
    expect(execFileSync(path.join(worker, 'node_modules/.bin/third')).toString().trim()).toBe('third')
    expect(fs.existsSync(path.join(worker, 'node_modules/.package-lock.json'))).toBe(false)
    const notes = workspaceDepsNotes(result)
    expect(notes.reply).toEqual(['node_modules: links to your install'])
    expect(notes.prompt).toContain('delete node_modules first')
  })

  it('a repository without workspaces or an install stays silent; one that cannot be linked says it has no node_modules', async () => {
    const bare = fixture({ nodeModules: false })
    fs.writeFileSync(path.join(bare.repo, 'package.json'), JSON.stringify({ name: 'single' }))
    const silent = await linkWorkspaceDeps(bare.repo, bare.worktree())
    expect(silent).toMatchObject({ linked: false, names: [], workspaces: false })
    expect(workspaceDepsNotes(silent)).toEqual({ reply: [] })
    const { repo, worktree } = fixture({ lockfile: false })
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'single' }))
    const worker = worktree()
    const result = await linkWorkspaceDeps(repo, worker)
    expect(result.linked).toBe(false)
    expect(fs.existsSync(path.join(worker, 'node_modules'))).toBe(false)
    const notes = workspaceDepsNotes(result)
    expect(notes.reply.join('\n')).toContain('this worktree has no node_modules of its own, so `./node_modules/.bin/...` scripts fail there')
    expect(notes.reply.join('\n')).toContain('lockfile')
    expect(notes.prompt).toContain('no node_modules of its own')
    expect(notes.reply.join('\n')).not.toContain('would run the lead')
    const own = fixture()
    fs.writeFileSync(path.join(own.repo, 'package.json'), JSON.stringify({ name: 'single' }))
    const installed = own.worktree('installed')
    fs.mkdirSync(path.join(installed, 'node_modules/left-pad'), { recursive: true })
    const existing = await linkWorkspaceDeps(own.repo, installed)
    expect(existing).toMatchObject({ linked: false, workspaces: false })
    expect(workspaceDepsNotes(existing).reply.join('\n')).toContain('node_modules already exists in the worktree')
    expect(workspaceDepsNotes(existing).reply.join('\n')).toContain('dependency setup is incomplete')
    expect(fs.lstatSync(path.join(installed, 'node_modules/left-pad')).isDirectory()).toBe(true)
  })

  it('a lead node_modules that links to a shared install is followed, never written through', async () => {
    for (const workspaces of [true, false]) {
      const { repo, worktree } = fixture()
      if (!workspaces) fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'single' }))
      // The install lives elsewhere (a shared checkout); the lead's node_modules is a link to it.
      const shared = fs.mkdtempSync(path.join(path.dirname(repo), 'room-shared-'))
      repos.push(shared)
      fs.renameSync(path.join(repo, 'node_modules'), path.join(shared, 'node_modules'))
      fs.symlinkSync(path.join(shared, 'node_modules'), path.join(repo, 'node_modules'))
      const before = fs.readdirSync(path.join(shared, 'node_modules')).sort()
      const worker = worktree()
      const result = await linkWorkspaceDeps(repo, worker)
      expect(result).toMatchObject({ linked: true, workspaces })
      expect(fs.lstatSync(path.join(worker, 'node_modules')).isDirectory()).toBe(true)
      expect(execFileSync(path.join(worker, 'node_modules/.bin/third')).toString().trim()).toBe('third')
      expect(fs.realpathSync(path.join(worker, 'node_modules/third'))).toBe(path.join(shared, 'node_modules/third'))
      if (workspaces) expect(requireB(worker)).toBe('worker-a:third')
      fs.rmSync(path.join(worker, 'node_modules'), { recursive: true, force: true })
      expect(fs.readdirSync(path.join(shared, 'node_modules')).sort()).toEqual(before)
      expect(fs.lstatSync(path.join(repo, 'node_modules')).isSymbolicLink()).toBe(true)
    }
  })

  it('re-points a file: dependency at the worktree even when the lead path is not canonical (/tmp vs /private/tmp)', async () => {
    const { repo, git, worktree } = fixture()
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'single', dependencies: { local: 'file:libs/local' } }))
    fs.mkdirSync(path.join(repo, 'libs/local'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'libs/local/index.js'), "module.exports = 'lead'\n")
    git('add', '.'); git('commit', '-qm', 'file dependency')
    fs.symlinkSync('../libs/local', path.join(repo, 'node_modules/local'))
    const worker = worktree()
    const alias = fs.mkdtempSync(path.join(path.dirname(repo), 'room-alias-'))
    repos.push(alias)
    fs.symlinkSync(repo, path.join(alias, 'lead'))
    expect(await linkWorkspaceDeps(path.join(alias, 'lead'), worker)).toMatchObject({ linked: true })
    expect(fs.realpathSync(path.join(worker, 'node_modules/local'))).toBe(path.join(worker, 'libs/local'))
  })

  it('refuses when node_modules is not ignored by git, so collection never sees the links', async () => {
    const { repo, git, worktree } = fixture()
    fs.writeFileSync(path.join(repo, '.gitignore'), '.room/\n'); git('commit', '-qam', 'track node_modules')
    const worker = worktree()
    const result = await linkWorkspaceDeps(repo, worker)
    expect(result.linked).toBe(false)
    expect(fs.existsSync(path.join(worker, 'node_modules'))).toBe(false)
    expect(workspaceDepsNotes(result).reply.join('\n')).toContain(LEAD_CODE)
  })

  it('gives up past its time budget, retains partial links and warns', async () => {
    const { repo, worktree } = fixture()
    const worker = worktree()
    let clock = 0
    const result = await linkWorkspaceDeps(repo, worker, { timeoutMs: 3000, now: () => (clock += 1000) })
    expect(result.linked).toBe(false)
    expect(result.reason).toContain('timed out')
    expect(fs.lstatSync(path.join(worker, 'node_modules/.bin/third')).isSymbolicLink()).toBe(true)
    expect(result.reason).toContain(path.join(worker, 'node_modules'))
    expect(workspaceDepsNotes(result).prompt).toContain(LEAD_CODE)
    expect(requireB(repo)).toBe('lead-a:third')
  })

  it('a workspace package missing from the worktree is never linked back to the lead\'s sources', async () => {
    const { repo, worktree } = fixture()
    const worker = worktree()
    // The lead renamed a workspace directory without committing; the worktree starts from HEAD.
    fs.renameSync(path.join(repo, 'packages/a'), path.join(repo, 'packages/a2'))
    fs.rmSync(path.join(repo, 'node_modules/@fx/a')); fs.symlinkSync('../../packages/a2', path.join(repo, 'node_modules/@fx/a'))
    const result = await linkWorkspaceDeps(repo, worker)
    expect(result.linked).toBe(false)
    expect(result.reason).toContain('packages/a2')
    expect(fs.existsSync(path.join(worker, 'node_modules'))).toBe(false)
    expect(workspaceDepsNotes(result).reply.join('\n')).toContain('would run the lead\'s code')
  })

  it('workspace patterns it cannot expand (braces) warn instead of silently using the lead\'s code', async () => {
    const { repo, worktree } = fixture()
    const worker = worktree()
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fx-root', private: true, workspaces: ['packages/{a,b}'] }))
    const result = await linkWorkspaceDeps(repo, worker)
    expect(result.linked).toBe(false)
    expect(result.reason).toContain('packages/{a,b}')
    expect(workspaceDepsNotes(result).reply.join('\n')).toContain('would run the lead\'s code')
  })

  it('declared workspaces that match no package warn', async () => {
    const { repo, worktree } = fixture()
    const worker = worktree()
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fx-root', private: true, workspaces: ['libs/*'] }))
    const result = await linkWorkspaceDeps(repo, worker)
    expect(result.linked).toBe(false)
    expect(result.reason).toContain('libs/*')
    expect(workspaceDepsNotes(result).reply.join('\n')).toContain('would run the lead\'s code')
  })

  it.skipIf(process.getuid?.() === 0)('a discovery failure before any package is named still warns', async () => {
    const { repo, worktree } = fixture()
    const worker = worktree()
    // Workspace discovery fails (as it does past its directory or time budget) before names are known.
    fs.chmodSync(path.join(repo, 'packages'), 0o000)
    try {
      const result = await linkWorkspaceDeps(repo, worker)
      expect(result).toMatchObject({ linked: false, names: [] })
      expect(result.reason).toContain('linking failed')
      const notes = workspaceDepsNotes(result)
      expect(notes.reply.join('\n')).toContain('would run the lead\'s code for its workspace packages')
      expect(notes.prompt).toContain('would run the lead\'s code for its workspace packages')
    } finally { fs.chmodSync(path.join(repo, 'packages'), 0o755) }
  })

  it.skipIf(process.getuid?.() === 0)('an unreadable lead install is an error that warns, never a throw', async () => {
    const { repo, worktree } = fixture()
    const worker = worktree()
    fs.chmodSync(path.join(repo, 'node_modules/@fx'), 0o000)
    try {
      const result = await linkWorkspaceDeps(repo, worker)
      expect(result.linked).toBe(false)
      expect(fs.lstatSync(path.join(worker, 'node_modules/.bin/third')).isSymbolicLink()).toBe(true)
      expect(result.reason).toContain(path.join(worker, 'node_modules'))
      expect(workspaceDepsNotes(result).reply.join('\n')).toContain(LEAD_CODE)
    } finally { fs.chmodSync(path.join(repo, 'node_modules/@fx'), 0o755) }
  })

  it('removing the worktree (as cleanup, discard and git clean do) leaves the lead\'s install intact', async () => {
    const { repo, git, worktree } = fixture()
    const worker = worktree()
    await linkWorkspaceDeps(repo, worker)
    execFileSync('git', ['-C', worker, 'clean', '-fdx'], { stdio: 'pipe' })
    expect(fs.existsSync(path.join(worker, 'node_modules'))).toBe(false)
    await linkWorkspaceDeps(repo, worker)
    fs.rmSync(path.join(worker, 'node_modules'), { recursive: true, force: true })
    await linkWorkspaceDeps(repo, worker)
    git('worktree', 'remove', '--force', worker)
    expect(fs.existsSync(worker)).toBe(false)
    expect(fs.readFileSync(path.join(repo, 'node_modules/third/index.js'), 'utf8')).toBe("module.exports = 'third'\n")
    expect(fs.readlinkSync(path.join(repo, 'node_modules/.bin/third'))).toBe('../third/cli.js')
    expect(fs.readFileSync(path.join(repo, 'packages/a/index.js'), 'utf8')).toBe("module.exports = 'lead-a'\n")
    expect(requireB(repo)).toBe('lead-a:third')
  })

  it('reports editable Python installs of the lead\'s sources and tells the worker to uv sync', async () => {
    const { repo, worktree } = fixture({ nodeModules: false })
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'single' }))
    const info = path.join(repo, '.venv/lib/python3.12/site-packages/demo_service-0.1.0.dist-info')
    fs.mkdirSync(info, { recursive: true })
    fs.writeFileSync(path.join(info, 'direct_url.json'), JSON.stringify({ url: `file://${repo}`, dir_info: { editable: true } }))
    const pinned = path.join(repo, '.venv/lib/python3.12/site-packages/httpx-0.27.0.dist-info')
    fs.mkdirSync(pinned, { recursive: true })
    fs.writeFileSync(path.join(pinned, 'direct_url.json'), JSON.stringify({ url: 'https://example.invalid/httpx.whl', archive_info: {} }))
    const result = await linkWorkspaceDeps(repo, worktree())
    expect(result.python).toEqual(['demo_service'])
    const notes = workspaceDepsNotes(result)
    expect(notes.prompt).toContain('uv sync')
    expect(notes.reply.join('\n')).toContain("Python tests in this worktree would import the lead's code for demo_service")
  })

  it('points a lead-checkout VIRTUAL_ENV at the worktree\'s own .venv', () => {
    const lead = '/repo', worker = '/repo/.room/workers/w'
    const base = { threads: 1, memGb: 1, host: 'claude' as const, server: 'local', room: 'local/x', tag: 'w', owner: 'l',
      share: 'full', run: 1, nonce: 'n', registry: '/r', id: 'i', logDir: lead, isWorker: false, dir: worker }
    const env = workerProcessEnv(base, { VIRTUAL_ENV: '/repo/.venv', PATH: ['/repo/.venv/bin', '/usr/bin'].join(path.delimiter) })
    expect(env.VIRTUAL_ENV).toBe(path.join(worker, '.venv'))
    expect(env.PATH).toBe([path.join(worker, '.venv', 'bin'), '/usr/bin'].join(path.delimiter))
    const tools = workerProcessEnv(base, { VIRTUAL_ENV: '/home/me/tools', PATH: '/home/me/tools/bin:/usr/bin' })
    expect(tools.VIRTUAL_ENV).toBeUndefined()
    expect(tools.PATH).toBeUndefined()
  })
})


it('retains a node_modules replacement installed while dependency setup fails', async () => {
  const { repo, worktree } = fixture(), worker = worktree(), target = path.join(worker, 'node_modules')
  const mkdir = fs.mkdirSync
  let replaced = false
  const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((...args: Parameters<typeof fs.mkdirSync>) => {
    if (String(args[0]) === path.join(target, '.bin')) {
      fs.renameSync(target, target + '-original')
      mkdir(target)
      fs.writeFileSync(path.join(target, 'precious.txt'), 'foreign dependency directory')
      replaced = true
      throw new Error('injected linking failure after directory replacement')
    }
    return (mkdir as (...values: Parameters<typeof fs.mkdirSync>) => unknown)(...args)
  }) as typeof fs.mkdirSync)
  try {
    const result = await linkWorkspaceDeps(repo, worker)
    expect(replaced).toBe(true)
    expect(result.linked).toBe(false)
    expect(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8')).toBe('foreign dependency directory')
  } finally { spy.mockRestore() }
})
