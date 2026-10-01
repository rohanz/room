// room_send refresh=true: a stopped worker's branch is rebased onto the lead's HEAD before it resumes,
// so a commit the lead made after spawn reaches the worker. Real git repositories and the real
// prepareWorktree; only the host process is stubbed (as in carry-wip.test.ts).
import { setParticipantBase } from '@room/shared/testing'
import { workerByTag } from './registry-fixture.js'
import { registryForDir, WorkerRegistry } from '../src/worker-registry.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { Identity } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { GraphIndex } from '../src/graph-index.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

vi.setConfig({ testTimeout: 30_000 })

const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
let root: string, repo: string, head: string
const cleanups: (() => Promise<void>)[] = []
let roomEnv: Record<string, string | undefined>
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const put = (dir: string, p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text) }
const read = (dir: string, p: string) => fs.readFileSync(path.join(dir, p), 'utf8')
const status = (dir: string) => git(dir, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(l => l && !/^..\s+"?\.room\//.test(l)).sort()
const commit = (dir: string, message: string) => { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', message); return git(dir, 'rev-parse', 'HEAD') }

beforeEach(() => {
  roomEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('ROOM_')))
  for (const key of Object.keys(roomEnv)) delete process.env[key]
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-refresh-')))
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'config'))
  repo = path.join(root, 'lead'); fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'rohanz'); git(repo, 'config', 'user.email', 'rohanz@example.test')
  put(repo, 'shared.txt', 'a\nb\nc\n'); put(repo, 'keep.txt', 'k1\nk2\n'); put(repo, '.gitignore', 'build/\n')
  head = commit(repo, 'base')
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.room/\n')
})
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {})
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) delete process.env[key]
  Object.assign(process.env, roomEnv)
})

function fakeSession(room: RoomDoc, me: Identity, dir: string): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  const graph = new GraphIndex(room, me.name, dir); graph.start()
  return {
    graph, room, awareness, me, dir, roomUrl: 'ws://127.0.0.1:1/local%2Fx', roomName: 'local/x', browserUrl: 'http://x',
    ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base: head, fence: '1' } as never,
    shareMax: 'full', shareRequested: 'full',
    local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} },
  } as Session
}

function world() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  const ra = new RoomDoc(a), rb = new RoomDoc(b)
  ra.setMeta({ repo: 'x' })
  setParticipantBase(ra, 'rohanz', head)
  let ls: Session | null = fakeSession(ra, lead, repo)
  const exits = new Map<string, (code: number | null) => void>()
  /** Every launch's argv, by tag, in order: the first is the spawn, the rest are resumes. */
  const launches = new Map<string, string[]>()
  let pid = 4_100_000
  const leadTools = createTools({
    getSession: () => ls, setSession: s => { ls = s }, cwd: repo, probe: () => undefined, listCwdProcesses: () => [],
    spawner: spec => {
      launches.set(spec.env.ROOM_TAG, [...launches.get(spec.env.ROOM_TAG) ?? [], spec.args.join('\n')])
      return { pid: pid++, started: Promise.resolve(), onExit: cb => { exits.set(spec.env.ROOM_TAG, cb) }, kill: () => true }
    },
  })
  cleanups.push(() => leadTools.shutdown())
  const call = (tool: string, args: Record<string, unknown>) => leadTools.call(tool, args) as Promise<string>
  async function spawn(tag: string, extra: Record<string, unknown> = {}) {
    const reply = await call('room_spawn', { tag, task: `task ${tag}`, ...extra })
    const w = workerByTag(repo, tag)
    expect(w, reply).toBeTruthy()
    return w!
  }
  async function finish(tag: string) {
    const w = workerByTag(repo, tag)!
    let ws: Session | null = fakeSession(rb, { name: `rohanz+${tag}`, kind: 'agent', owner: 'rohanz', label: tag }, w.dir)
    const tools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: w.dir })
    const registry = await registryForDir(repo)
    const record = registry.list().find(record => record.tag === tag)!
    const run = record.runs.at(-1)!
    await registry.admit({ id: record.id, run: run.n, nonce: run.nonce, dir: record.dir, chain: [] })
    process.env.ROOM_WORKER_ID = record.id
    try { expect(await tools.call('room_done', { summary: `${tag} finished` })).toContain('marked done') }
    finally { delete process.env.ROOM_WORKER_ID }
    await tools.shutdown(); ws?.graph?.stop()
    exits.get(tag)!(0)
    await vi.waitFor(() => expect(workerByTag(repo, tag)).toMatchObject({ status: 'done', exitCode: 0 }), { timeout: 15_000 })
  }
  return { call, spawn, finish, launches }
}

/** Everything about a worker that a refused refresh must leave as it was. */
const snapshot = (dir: string, tag: string) => ({
  head: git(dir, 'rev-parse', 'HEAD'), status: status(dir), index: git(dir, 'write-tree'),
  files: Object.fromEntries(['shared.txt', 'keep.txt'].map(p => [p, read(dir, p)])),
  base: workerByTag(repo, tag)!.base, carriedBase: workerByTag(repo, tag)!.carriedBase,
  rebasing: fs.existsSync(path.join(git(dir, 'rev-parse', '--absolute-git-dir'), 'rebase-merge')),
})

describe('room_send refresh=true', () => {
  it('brings a lead commit made after spawn into a finished worker, keeps its edits, and tells it what came in', async () => {
    const t = world()
    const w = await t.spawn('fresh')
    put(w.dir, 'keep.txt', 'k1\nworker\n')
    put(w.dir, 'notes/new.txt', 'worker file\n')
    await t.finish('fresh')
    put(repo, 'specs/later.md', 'committed after spawn\n')
    const leadHead = commit(repo, 'add the later spec')

    const reply = await t.call('room_send', { type: 'note', to: 'fresh', text: 'now follow specs/later.md', refresh: true })
    expect(reply).toContain('rebased fresh onto your HEAD')
    expect(reply).toContain('add the later spec')
    expect(reply).toContain('resumed fresh')
    expect(read(w.dir, 'specs/later.md')).toBe('committed after spawn\n')
    expect(git(w.dir, 'rev-parse', 'HEAD')).toBe(leadHead)
    // The worker's own edit stays uncommitted on top of the new base.
    expect(read(w.dir, 'keep.txt')).toBe('k1\nworker\n')
    expect(git(w.dir, 'diff', '--name-only')).toBe('keep.txt')
    expect(git(w.dir, 'diff', '--cached', '--name-only')).toBe('')
    expect(status(w.dir)).toEqual(['?? notes/new.txt', 'M keep.txt'])
    expect(workerByTag(repo, 'fresh')!.base).toBe(leadHead)
    // The resumed turn carries the base-moved note with the commits that came in.
    const resumed = t.launches.get('fresh')!.at(-1)!
    expect(resumed).toContain('now follow specs/later.md')
    expect(resumed).toContain('your base moved')
    expect(resumed).toContain('add the later spec')
  })

  it('refuses when the worker\'s uncommitted edits conflict with the lead\'s commit, and changes nothing', async () => {
    const t = world()
    const w = await t.spawn('clash')
    put(w.dir, 'shared.txt', 'a\nworker\nc\n')
    await t.finish('clash')
    put(repo, 'shared.txt', 'a\nlead\nc\n')
    commit(repo, 'lead changes line b')
    const before = snapshot(w.dir, 'clash')
    const spawned = t.launches.get('clash')!.length

    const reply = await t.call('room_send', { type: 'note', to: 'clash', text: 'carry on', refresh: true })
    expect(reply).toMatch(/^error: /m)
    expect(reply).toContain('shared.txt')
    expect(reply).toContain('nothing changed')
    expect(snapshot(w.dir, 'clash')).toEqual(before)
    expect(t.launches.get('clash')!.length).toBe(spawned)
    expect(workerByTag(repo, 'clash')!.status).toBe('done')
  })

  it('refuses a worker started with dir= in another worker\'s checkout', async () => {
    const t = world()
    const owner = await t.spawn('owner')
    await t.spawn('borrower', { dir: owner.dir })
    expect(workerByTag(repo, 'borrower')!.sharedWith).toBe(owner.id)
    await t.finish('borrower')
    put(repo, 'later.txt', 'x\n'); commit(repo, 'later')
    const before = git(owner.dir, 'rev-parse', 'HEAD')
    const spawned = t.launches.get('borrower')!.length
    const reply = await t.call('room_send', { type: 'note', to: 'borrower', text: 'hi', refresh: true })
    expect(reply).toMatch(/^error: /m)
    expect(reply).toContain('dir=')
    expect(reply).toContain('nothing sent')
    expect(git(owner.dir, 'rev-parse', 'HEAD')).toBe(before)
    expect(t.launches.get('borrower')!.length).toBe(spawned)
  })

  it('refuses when a lead commit would replace an ignored file or folder in either direction', async () => {
    put(repo, '.gitignore', 'cache\nout/\n'); commit(repo, 'ignore cache and out/')
    const t = world()
    const w = await t.spawn('clobber')
    put(w.dir, 'cache', 'precious\n')
    put(w.dir, 'out/a.txt', 'built\n')
    await t.finish('clobber')
    // The lead's commit adds cache/index.ts where the worker has an ignored FILE named cache.
    put(repo, 'cache/index.ts', 'export {}\n'); git(repo, 'add', '-f', 'cache/index.ts'); git(repo, 'commit', '-qm', 'track cache/')
    const before = git(w.dir, 'rev-parse', 'HEAD')
    let reply = await t.call('room_send', { type: 'note', to: 'clobber', text: 'carry on', refresh: true })
    expect(reply).toMatch(/^error: /m)
    expect(reply).toContain('cache/index.ts')
    expect(read(w.dir, 'cache')).toBe('precious\n')
    expect(git(w.dir, 'rev-parse', 'HEAD')).toBe(before)
    // The other way: the lead's commit adds a FILE named out where the worker has an ignored folder out/.
    git(repo, 'reset', '-q', '--hard', 'HEAD~1')
    put(repo, 'out', 'a file now\n'); git(repo, 'add', '-f', 'out'); git(repo, 'commit', '-qm', 'track out')
    reply = await t.call('room_send', { type: 'note', to: 'clobber', text: 'carry on', refresh: true })
    expect(reply).toMatch(/^error: /m)
    expect(reply).toContain('out')
    expect(read(w.dir, 'out/a.txt')).toBe('built\n')
    expect(git(w.dir, 'rev-parse', 'HEAD')).toBe(before)
  })

  it('refuses when the worker untracked a file it still has as ignored output and your HEAD tracks it', async () => {
    put(repo, '.gitignore', '*.log\n'); put(repo, 'artifact.log', 'old\n'); git(repo, 'add', '-f', 'artifact.log'); commit(repo, 'track a log')
    const t = world()
    const w = await t.spawn('untracker')
    git(w.dir, 'rm', '--cached', '-q', 'artifact.log')
    put(w.dir, 'artifact.log', 'newer output\n')
    await t.finish('untracker')
    put(repo, 'later.txt', 'x\n'); commit(repo, 'unrelated')
    const before = git(w.dir, 'rev-parse', 'HEAD')
    const reply = await t.call('room_send', { type: 'note', to: 'untracker', text: 'carry on', refresh: true })
    expect(reply).toMatch(/^error: /m)
    expect(reply).toContain('artifact.log')
    expect(read(w.dir, 'artifact.log')).toBe('newer output\n')
    expect(git(w.dir, 'rev-parse', 'HEAD')).toBe(before)
  })

  it('refuses when the worker replaced a tracked file with a folder of ignored output, unstaged', async () => {
    put(repo, '.gitignore', '*.log\n'); put(repo, 'out', 'a file\n'); commit(repo, 'track out')
    const t = world()
    const w = await t.spawn('replacer')
    fs.rmSync(path.join(w.dir, 'out'))
    put(w.dir, 'out/build.log', 'built\n')
    await t.finish('replacer')
    put(repo, 'later.txt', 'x\n'); commit(repo, 'unrelated')
    const before = git(w.dir, 'rev-parse', 'HEAD')
    const reply = await t.call('room_send', { type: 'note', to: 'replacer', text: 'carry on', refresh: true })
    expect(reply).toMatch(/^error: /m)
    expect(reply).toContain('out')
    expect(read(w.dir, 'out/build.log')).toBe('built\n')
    expect(git(w.dir, 'rev-parse', 'HEAD')).toBe(before)
  })

  it('refuses when replaying the worker\'s own commits would overwrite its ignored output', async () => {
    put(repo, '.gitignore', '*.log\n'); commit(repo, 'ignore logs')
    const t = world()
    let n = 0
    for (const name of ['artifact.log', ' spaced.log']) { // a name with edge whitespace is matched as written
      const tag = `replayer${n++}`
      const w = await t.spawn(tag)
      put(w.dir, name, 'v1\n'); git(w.dir, 'add', '-f', '--', name); git(w.dir, 'commit', '-qm', 'track artifact')
      git(w.dir, 'rm', '--cached', '-q', '--', name); git(w.dir, 'commit', '-qm', 'untrack artifact')
      put(w.dir, name, 'fresh output\n')
      await t.finish(tag)
      put(repo, `later${n}.txt`, 'x\n'); commit(repo, 'unrelated')
      const before = git(w.dir, 'rev-parse', 'HEAD')
      const reply = await t.call('room_send', { type: 'note', to: tag, text: 'carry on', refresh: true })
      expect(reply).toMatch(/^error: /m)
      expect(reply).toContain(name)
      expect(read(w.dir, name)).toBe('fresh output\n')
      expect(git(w.dir, 'rev-parse', 'HEAD')).toBe(before)
    }
  })

  it('treats a case-only alias of an ignored file as the same file (case-insensitive filesystems)', async () => {
    put(repo, '.gitignore', '*.log\n'); commit(repo, 'ignore logs')
    const t = world()
    const w = await t.spawn('cased')
    put(w.dir, 'build.log', 'unsaved output\n')
    await t.finish('cased')
    put(repo, 'BUILD.log', 'tracked\n'); git(repo, 'add', '-f', 'BUILD.log'); git(repo, 'commit', '-qm', 'track BUILD.log')
    const before = git(w.dir, 'rev-parse', 'HEAD')
    const reply = await t.call('room_send', { type: 'note', to: 'cased', text: 'carry on', refresh: true })
    expect(reply).toMatch(/^error: /m)
    expect(reply).toContain('BUILD.log')
    expect(read(w.dir, 'build.log')).toBe('unsaved output\n')
    expect(git(w.dir, 'rev-parse', 'HEAD')).toBe(before)
  })

  it('refuses a worker whose history has a merge commit, which a rebase would drop', async () => {
    const t = world()
    const w = await t.spawn('merger')
    git(w.dir, 'switch', '-q', '-c', 'topic'); put(w.dir, 'topic.txt', 'topic\n'); commit(w.dir, 'topic work')
    git(w.dir, 'switch', '-q', 'room/merger'); git(w.dir, 'merge', '-q', '--no-ff', '--no-commit', 'topic')
    put(w.dir, 'integration.txt', 'fix made in the merge\n'); git(w.dir, 'add', 'integration.txt'); git(w.dir, 'commit', '-qm', 'merge topic')
    await t.finish('merger')
    put(repo, 'later.txt', 'x\n'); commit(repo, 'unrelated')
    const before = git(w.dir, 'rev-parse', 'HEAD')
    const reply = await t.call('room_send', { type: 'note', to: 'merger', text: 'carry on', refresh: true })
    expect(reply).toMatch(/^error: /m)
    expect(reply).toContain('merge')
    expect(git(w.dir, 'rev-parse', 'HEAD')).toBe(before)
    expect(read(w.dir, 'integration.txt')).toBe('fix made in the merge\n')
  })

  it('checks for dir= borrowers again under the operation lease', async () => {
    const t = world()
    const owner = await t.spawn('lender')
    await t.finish('lender')
    await t.spawn('lodger', { dir: owner.dir })
    put(repo, 'later.txt', 'x\n'); commit(repo, 'later')
    const before = git(owner.dir, 'rev-parse', 'HEAD')
    // The first check sees no borrower (as if lodger started between the check and the lease).
    const real = WorkerRegistry.prototype.checkoutUsers
    let calls = 0
    const spy = vi.spyOn(WorkerRegistry.prototype, 'checkoutUsers').mockImplementation(function (this: WorkerRegistry, o) { return calls++ === 0 ? [] : real.call(this, o) })
    try {
      const reply = await t.call('room_send', { type: 'note', to: 'lender', text: 'hi', refresh: true })
      expect(reply).toMatch(/^error: /m)
      expect(reply).toContain('lodger')
    } finally { spy.mockRestore() }
    expect(git(owner.dir, 'rev-parse', 'HEAD')).toBe(before)
  })

  it('refuses a running worker and sends nothing', async () => {
    const t = world()
    const w = await t.spawn('busy')
    put(repo, 'later.txt', 'x\n'); commit(repo, 'later')
    const before = git(w.dir, 'rev-parse', 'HEAD')
    const reply = await t.call('room_send', { type: 'note', to: 'busy', text: 'hi', refresh: true })
    expect(reply).toMatch(/^error: /m)
    expect(reply).toContain('running')
    expect(reply).toContain('nothing sent')
    expect(git(w.dir, 'rev-parse', 'HEAD')).toBe(before)
    expect(t.launches.get('busy')!.length).toBe(1)
  })

  it('collect after a refresh applies only the worker\'s own changes', async () => {
    // The lead's uncommitted edit is carried into the worker, then committed by the lead after spawn.
    put(repo, 'shared.txt', 'a\ncarried\nc\n')
    const t = world()
    const w = await t.spawn('mine')
    expect(workerByTag(repo, 'mine')!.carriedBase).toBeTruthy()
    put(w.dir, 'keep.txt', 'k1\nworker\n')
    await t.finish('mine')
    put(repo, 'later.txt', 'v1\n')
    const leadHead = commit(repo, 'commit the carried edit and add later.txt')
    // An uncommitted lead edit to a file only the lead's commit brought in.
    put(repo, 'later.txt', 'v2 lead edit\n')

    const reply = await t.call('room_send', { type: 'note', to: 'mine', text: 'later.txt is in now', refresh: true })
    expect(reply).toContain('rebased mine onto your HEAD')
    // The carried commit is now part of the lead's history; the worker's base is the lead's HEAD.
    expect(git(w.dir, 'rev-parse', 'HEAD')).toBe(leadHead)
    expect(workerByTag(repo, 'mine')).toMatchObject({ base: leadHead, carriedBase: undefined })
    await t.finish('mine')

    const collected = await t.call('room_collect', {})
    expect(collected).toContain('Changes from mine: keep.txt.')
    expect(read(repo, 'keep.txt')).toBe('k1\nworker\n')
    expect(read(repo, 'later.txt')).toBe('v2 lead edit\n')
    expect(read(repo, 'shared.txt')).toBe('a\ncarried\nc\n')
  })
})

describe('room_send refresh=true with carried work still uncommitted in the lead', () => {
  it('replays the carried commit on the new base and keeps measuring the worker from it', async () => {
    put(repo, 'shared.txt', 'a\ncarried\nc\n')
    const t = world()
    const w = await t.spawn('keep')
    put(w.dir, 'keep.txt', 'k1\nworker\n')
    await t.finish('keep')
    // The lead commits something else; its carried edit stays uncommitted.
    git(repo, 'stash', 'push', '-q', '-m', 'refresh-test-carry')
    put(repo, 'later.txt', 'v1\n')
    const leadHead = commit(repo, 'unrelated lead commit')
    git(repo, 'stash', 'pop', '-q')

    const reply = await t.call('room_send', { type: 'note', to: 'keep', text: 'go on', refresh: true })
    expect(reply).toContain('rebased keep onto your HEAD')
    const record = workerByTag(repo, 'keep')!
    expect(record.carriedBase).toBe(record.base)
    expect(git(w.dir, 'rev-parse', `${record.base}^`)).toBe(leadHead)
    expect(git(w.dir, 'log', '-1', '--format=%s', record.base!)).toBe('room: carried-in uncommitted work from rohanz')
    expect(git(repo, 'rev-parse', 'refs/room/carry/keep')).toBe(record.base)
    expect(read(w.dir, 'shared.txt')).toBe('a\ncarried\nc\n')
    expect(read(w.dir, 'later.txt')).toBe('v1\n')
    await t.finish('keep')

    const collected = await t.call('room_collect', {})
    expect(collected).toContain('Changes from keep: keep.txt.')
  })

  it('says so when the worker already has the lead\'s HEAD, and still resumes it', async () => {
    const t = world()
    await t.spawn('same')
    await t.finish('same')
    const reply = await t.call('room_send', { type: 'note', to: 'same', text: 'one more thing', refresh: true })
    expect(reply).toContain('already has your HEAD')
    expect(reply).toContain('resumed same')
  })
})

describe('brief path warnings', () => {
  it('does not warn about Room\'s own paths or paths outside the repo, but still warns about a missing ignored file', async () => {
    put(repo, 'build/spec.md', 'ignored spec\n')
    put(repo, '.claude/settings.json', '{}\n')
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.claude/\n')
    const t = world()
    await t.spawn('first')
    const reply = await t.call('room_spawn', { tag: 'second', task: [
      'Worker worktrees live in .room/workers/<tag> (this one is .room/workers/first); logs are .room/workers/first.log.',
      'Hooks are in .git/hooks and ~/.claude/settings.json, see /tmp/x/.claude/settings.json.',
      'Then follow build/spec.md.',
    ].join(' ') })
    expect(reply.split('\n').filter(line => line.includes('named in the task'))).toEqual(['warning: build/spec.md named in the task is not in this worktree (untracked or ignored in the lead clone).'])
    expect(reply).toContain('warning: build/spec.md named in the task is not in this worktree')
  })
})
