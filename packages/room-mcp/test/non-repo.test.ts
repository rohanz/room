// Room in a folder that is not (yet) a usable git repository, and remembered state that belongs to another repository.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AutoJoin } from '../src/auto-join.js'
import { findRoomFile, startupJoinOptions, type Session } from '../src/session.js'
import { NotARepository, repositoryProblem, repositoryRoot, type GitRun } from '../src/repository.js'
import { codexWorkspace, fallbackWorkspace } from '../src/workspace.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=Ada', '-c', 'user.email=a@a', ...a], { stdio: 'pipe' })
function initRepo(dir: string, commit = true): string {
  git(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\n')
  if (commit) { git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'init') }
  return dir
}

/** A room-mcp process as Claude Code starts it: in the session's folder, with whatever PWD the host inherited. */
async function startMcp(cwd: string, env: Record<string, string> = {}) {
  const home = tempDir('room-nonrepo-home-')
  const full: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ROOM_') && !k.startsWith('CLAUDE')) full[k] = v
  Object.assign(full, { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PWD: cwd, ROOM_HOST: 'claude' }, env)
  const lines: string[] = []
  const transport = new StdioClientTransport({ command: path.join(ROOT, 'node_modules/.bin/tsx'), args: [path.join(ROOT, 'packages/room-mcp/src/index.ts')], env: full, cwd, stderr: 'pipe' })
  transport.stderr?.on('data', d => { lines.push(...String(d).split('\n').filter(Boolean)) })
  const client = new Client({ name: 'claude-code', version: '1' })
  await client.connect(transport)
  cleanups.push(() => client.close())
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })).content as { text: string }[])[0].text
  return { call, lines }
}

const notRepo = (dir: string) => `Room works inside a git repository, and ${dir} isn't one. Run \`git init\` and make a first commit, or open the project's repository folder, then say 'join the room' again.`

describe('a folder that is not a git repository', () => {
  it('answers every room tool with one plain message, never retries, and joins once the folder becomes a repository', async () => {
    const dir = tempDir('room-nonrepo-')
    fs.writeFileSync(path.join(dir, 'a.py'), 'x = 1\n')
    const mcp = await startMcp(dir)
    const started = Date.now()
    expect(await mcp.call('room_join')).toBe(notRepo(dir))
    expect(await mcp.call('room_state')).toBe(notRepo(dir))
    expect(await mcp.call('room_send', { text: 'hi' })).toBe(notRepo(dir))
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(mcp.lines.filter(l => /retrying/.test(l))).toEqual([])

    // git init without a commit: Room needs a base commit.
    initRepo(dir, false)
    const noCommit = await mcp.call('room_join')
    expect(noCommit).toBe(`Room needs a first commit: ${dir} is a git repository with no commits yet. Make a first commit (git add -A && git commit -m "first commit"), then say 'join the room' again.`)
    expect(await mcp.call('room_state')).toBe(noCommit)

    // After the first commit, a later call joins in the same session, without room_join.
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'init')
    expect(await mcp.call('room_state')).toContain(`room: local/${path.basename(dir)}/main`)
    expect(mcp.lines.filter(l => /retrying/.test(l))).toEqual([])
  }, 60_000)

  it('never falls back to another repository named by an inherited PWD', async () => {
    const dir = tempDir('room-nonrepo-')
    const other = initRepo(tempDir('room-other-'))
    const mcp = await startMcp(dir, { PWD: other })
    expect(await mcp.call('room_join')).toBe(notRepo(dir))
    expect(await mcp.call('room_state')).toBe(notRepo(dir))
    expect(mcp.lines.join('\n')).not.toContain(path.basename(other))
  }, 60_000)

  it('still resolves the repository root from a subfolder', async () => {
    const repo = initRepo(tempDir('room-sub-'))
    const sub = path.join(repo, 'pkg', 'inner')
    fs.mkdirSync(sub, { recursive: true })
    const mcp = await startMcp(sub)
    expect(await mcp.call('room_state')).toContain(`room: local/${path.basename(repo)}/main`)
  }, 60_000)
})

describe('repositoryProblem', () => {
  it('names a missing repository and a repository without commits, and nothing for a subfolder of a repository', async () => {
    const plain = tempDir('room-problem-')
    expect(await repositoryProblem(plain)).toBe(notRepo(plain))
    const empty = initRepo(tempDir('room-problem-'), false)
    expect(await repositoryProblem(empty)).toMatch(/^Room needs a first commit: /)
    const repo = initRepo(tempDir('room-problem-'))
    fs.mkdirSync(path.join(repo, 'sub'))
    expect(await repositoryProblem(path.join(repo, 'sub'))).toBeUndefined()
  })

  it('explains a bare repository and a .git folder, which have no working tree', async () => {
    const repo = initRepo(tempDir('room-problem-'))
    const bare = path.join(tempDir('room-bare-'), 'shop.git')
    execFileSync('git', ['clone', '-q', '--bare', repo, bare])
    expect(await repositoryProblem(bare)).toBe(`Room works in a repository's working tree (the folder with your files), and ${bare} is a bare repository, which has none. Open the checkout folder, then say 'join the room' again.`)
    const dotGit = path.join(repo, '.git')
    expect(await repositoryProblem(dotGit)).toBe(`Room works in a repository's working tree (the folder with your files), and ${dotGit} is inside a repository's .git folder, which has none. Open the checkout folder, then say 'join the room' again.`)
  })

  it('resolves a linked worktree and a submodule to their own roots', async () => {
    const repo = initRepo(tempDir('room-problem-'))
    const linked = path.join(tempDir('room-wt-'), 'linked')
    git(repo, 'worktree', 'add', '-q', '-b', 'side', linked)
    fs.mkdirSync(path.join(linked, 'sub'))
    expect(await repositoryRoot(path.join(linked, 'sub'))).toEqual({ root: fs.realpathSync(linked) })
    const lib = initRepo(tempDir('room-lib-'))
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib')
    expect(await repositoryRoot(path.join(repo, 'vendor', 'lib'))).toEqual({ root: path.join(repo, 'vendor', 'lib') })
  })

  it('leaves git execution failures to the join instead of calling them a missing first commit', async () => {
    const repo = initRepo(tempDir('room-problem-'))
    const answers = (head: Awaited<ReturnType<GitRun>>, ref: Awaited<ReturnType<GitRun>> = { status: 0, stdout: '', stderr: '' }): GitRun => async (_dir, args) =>
      args[0] === 'symbolic-ref' ? head : args[0] === 'show-ref' ? ref
        : { status: 0, stdout: args.includes('--show-toplevel') ? `${repo}\n` : 'false\ntrue\n', stderr: '' }
    expect(await repositoryRoot(repo, answers({ status: 'EAGAIN', stdout: '', stderr: '' }))).toEqual({ root: repo })
    expect(await repositoryRoot(repo, answers({ status: 0, stdout: 'refs/heads/main\n', stderr: '' }, { status: 'EAGAIN', stdout: '', stderr: '' }))).toEqual({ root: repo })
    expect(await repositoryRoot(repo, answers({ status: 0, stdout: 'refs/heads/main\n', stderr: '' }, { status: 128, stdout: '', stderr: 'fatal: Input/output error' }))).toEqual({ root: repo })
    expect(await repositoryRoot(repo, answers({ status: 1, stdout: '', stderr: '' }))).toEqual({ root: repo }) // detached HEAD
    const denied: GitRun = async () => ({ status: 128, stdout: '', stderr: "fatal: cannot change to '/x': Permission denied" })
    expect(await repositoryRoot(repo, denied)).toEqual({ root: repo })
  })

  it('does not call an existing branch whose objects git cannot read a missing first commit', async () => {
    const repo = initRepo(tempDir('room-problem-'))
    vi.stubEnv('GIT_OBJECT_DIRECTORY', '/dev')
    try { expect(await repositoryRoot(repo)).toEqual({ root: repo }) } finally { vi.unstubAllEnvs() }
  })
})

describe('AutoJoin and a missing repository', () => {
  it('does not retry, reports nothing, and checks again on the very next call', async () => {
    let calls = 0, repo = false
    const reports: string[] = [], logs: string[] = []
    let current: Session | null = null
    const a = new AutoJoin({ local: true, delaysMs: [10], deadlineMs: 2000, retryAfterMs: 60_000,
      attempt: async () => { calls++; if (!repo) throw new NotARepository('/x', notRepo('/x')); return { name: 's' } as unknown as Session },
      adopt: async s => { current = s }, discard: async () => {}, joined: () => current !== null, log: l => logs.push(l), report: l => reports.push(l) })
    await a.ensure()
    expect(calls).toBe(1)
    expect(a.failure).toBe(notRepo('/x'))
    expect(reports).toEqual([])
    repo = true
    await a.ensure() // well inside retryAfterMs: a missing repository is re-checked, not rate-limited
    expect(calls).toBe(2)
    expect(current).not.toBeNull()
    expect(a.failure).toBeUndefined()
  })
})

describe('remembered state is only used for the same repository', () => {
  it('ignores a PWD that names a different folder than the one Claude Code started Room in', () => {
    const cwd = tempDir('room-cwd-')
    const other = tempDir('room-pwd-')
    expect(fallbackWorkspace({ PWD: other, ROOM_HOST: 'claude' }, cwd)).toBe(cwd)
    expect(fallbackWorkspace({ PWD: other }, cwd)).toBe(cwd)
    // A PWD that spells the same folder (a symlinked path) is kept.
    const alias = path.join(tempDir('room-alias-'), 'link')
    fs.symlinkSync(cwd, alias)
    expect(fallbackWorkspace({ PWD: alias }, cwd)).toBe(alias)
    // Codex starts Room in the plugin folder, so its PWD names the session's folder.
    expect(fallbackWorkspace({ PWD: other, ROOM_HOST: 'codex' }, cwd)).toBe(other)
  })

  it("never reads another repository's room metadata from a nested repository", () => {
    const outer = initRepo(tempDir('room-outer-'))
    fs.writeFileSync(path.join(outer, '.room.json'), JSON.stringify({ room: 'ws://team/outer/main', name: 'Ada', dir: outer }))
    fs.mkdirSync(path.join(outer, 'vendor'))
    const inner = initRepo(path.join(outer, 'vendor'))
    fs.mkdirSync(path.join(inner, 'src'))
    expect(findRoomFile(path.join(inner, 'src'))).toBeUndefined()
    // The same repository's metadata is still found from a nested folder.
    fs.mkdirSync(path.join(outer, 'docs'))
    expect(findRoomFile(path.join(outer, 'docs'))).toMatchObject({ room: 'ws://team/outer/main', dir: outer })
  })

  it("joins a copied checkout from its own folder, not the folder its copied room metadata names", async () => {
    const original = initRepo(tempDir('room-orig-'))
    fs.writeFileSync(path.join(original, '.git', 'room.json'), JSON.stringify({ room: 'ws://team/example%2Fshop%2Fmain', name: 'Ada', dir: original }))
    const copy = path.join(tempDir('room-copy-'), 'shop')
    fs.cpSync(original, copy, { recursive: true })
    expect(await startupJoinOptions(copy, 'ws://team')).toEqual({ dir: copy, name: 'Ada', room: 'example/shop/main', server: 'ws://team' })
  })

  it('binds a Codex call whose only workspace is not a repository to that folder, not to a fallback repository', () => {
    const dir = tempDir('room-codex-')
    const params = { _meta: { 'x-codex-turn-metadata': { workspaces: { [dir]: {} } } } }
    expect(codexWorkspace(params)).toBe(dir)
  })
})
