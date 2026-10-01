import { afterEach, describe, expect, it } from 'vitest'
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
    expect(fs.realpathSync(path.join(worker, 'node_modules/@fx/a'))).toBe(path.join(worker, 'packages/a'))
    expect(fs.realpathSync(path.join(worker, 'node_modules/third'))).toBe(path.join(repo, 'node_modules/third'))
    // Package managers rewrite their state files; a link would let the worker write the lead's.
    expect(fs.existsSync(path.join(worker, 'node_modules/.package-lock.json'))).toBe(false)
    expect(execFileSync(path.join(worker, 'node_modules/.bin/third')).toString().trim()).toBe('third')
    expect(execFileSync('git', ['-C', worker, 'status', '--porcelain'], { stdio: 'pipe' }).toString()).toBe(' M packages/a/index.js\n')
    expect(workspaceDepsNotes(result).prompt).toContain('node_modules')
    expect(workspaceDepsNotes(result).reply.join('\n')).not.toContain('would run the lead')
  })

  it('links into a node_modules that holds only tool caches, and a rollback keeps those caches', async () => {
    const { repo, worktree } = fixture()
    const worker = worktree()
    fs.mkdirSync(path.join(worker, 'node_modules/.vite/vitest'), { recursive: true })
    fs.writeFileSync(path.join(worker, 'node_modules/.vite/vitest/results.json'), '{}')
    let clock = 0
    const timedOut = await linkWorkspaceDeps(repo, worker, { timeoutMs: 3000, now: () => (clock += 1000) })
    expect(timedOut.linked).toBe(false)
    expect(fs.readdirSync(path.join(worker, 'node_modules'))).toEqual(['.vite'])
    expect(await linkWorkspaceDeps(repo, worker)).toMatchObject({ linked: true })
    expect(requireB(worker)).toBe('worker-a:third')
    expect(fs.existsSync(path.join(worker, 'node_modules/.vite/vitest/results.json'))).toBe(true)
    const other = worktree('installed')
    fs.mkdirSync(path.join(other, 'node_modules/left-pad'), { recursive: true })
    expect((await linkWorkspaceDeps(repo, other)).reason).toBe('node_modules already exists in the worktree')
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

  it('a repository without workspaces needs no links and no warning', async () => {
    const { repo, worktree } = fixture()
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'single' }))
    const result = await linkWorkspaceDeps(repo, worktree())
    expect(result).toMatchObject({ linked: false, names: [] })
    expect(workspaceDepsNotes(result)).toEqual({ reply: [] })
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

  it('gives up past its time budget, removes partial links and warns', async () => {
    const { repo, worktree } = fixture()
    const worker = worktree()
    let clock = 0
    const result = await linkWorkspaceDeps(repo, worker, { timeoutMs: 3000, now: () => (clock += 1000) })
    expect(result.linked).toBe(false)
    expect(result.reason).toContain('timed out')
    expect(fs.existsSync(path.join(worker, 'node_modules'))).toBe(false)
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
      expect(fs.existsSync(path.join(worker, 'node_modules'))).toBe(false)
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
    const base = { threads: 1, memGb: 1, host: 'claude' as const, server: 'local', room: 'local/x', tag: 'w', lead: 'l', owner: 'l',
      share: 'full', run: 1, nonce: 'n', registry: '/r', id: 'i', logDir: lead, isWorker: false, dir: worker }
    const env = workerProcessEnv(base, { VIRTUAL_ENV: '/repo/.venv', PATH: ['/repo/.venv/bin', '/usr/bin'].join(path.delimiter) })
    expect(env.VIRTUAL_ENV).toBe(path.join(worker, '.venv'))
    expect(env.PATH).toBe([path.join(worker, '.venv', 'bin'), '/usr/bin'].join(path.delimiter))
    const tools = workerProcessEnv(base, { VIRTUAL_ENV: '/home/me/tools', PATH: '/home/me/tools/bin:/usr/bin' })
    expect(tools.VIRTUAL_ENV).toBeUndefined()
    expect(tools.PATH).toBeUndefined()
  })
})
