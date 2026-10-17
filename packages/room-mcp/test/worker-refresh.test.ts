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
import { autoRetire } from '../src/retire.js'
import type { Session } from '../src/session.js'
import { GraphIndex } from '../src/graph-index.js'
import { hubSeam } from './fixtures/hub.js'
import { publishFixture } from './fixtures/manifest.js'
import { keptPublicationMatches } from '../src/kept-publication.js'
import { testPolicyStore } from './policy-fixture.js'
import { clearFixtureProcesses, fixtureLiveness } from './fixtures/process-liveness.js'

// The launcher is this test runner, which is alive even when sandboxed OS probes
// cannot identify it. Synthetic worker handles still exit through their callbacks.
vi.mock('../src/leases.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/leases.js')>()
  return { ...actual, liveness: (identity: Parameters<typeof actual.liveness>[0]) => fixtureLiveness(identity, actual.liveness) }
})

vi.setConfig({ testTimeout: 30_000 })
// These sessions have synthetic publication; real daemon completion is covered in done-publication.test.ts.
vi.mock('../src/worker-publication.js', () => ({ settleWorkerPublication: async () => {} }))

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
  clearFixtureProcesses()
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
  clearFixtureProcesses()
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
  /**
   * The worker calls room_done once per summary, all at once from one MCP server (the first post held back
   * `slowFirstPost` ms); unless `exit` is false, its host then exits.
   */
  async function finish(tag: string, summary: string | string[] = `${tag} finished`, exit = true, slowFirstPost = 0) {
    const w = workerByTag(repo, tag)!
    let ws: Session | null = fakeSession(rb, { name: `rohanz+${tag}`, kind: 'agent', owner: 'rohanz', label: tag }, w.dir)
    if (slowFirstPost) {
      const post = ws.post
      let first = true
      ws.post = (async (...args: Parameters<Session['post']>) => {
        if (first) { first = false; await new Promise(resolve => setTimeout(resolve, slowFirstPost)) }
        return post(...args)
      }) as Session['post']
    }
    const tools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: w.dir })
    const registry = await registryForDir(repo)
    const record = registry.list().find(record => record.tag === tag)!
    const run = record.runs.at(-1)!
    if (!registry.reports(record.id).some(report => report.run === run.n)) await registry.admit({ id: record.id, run: run.n, nonce: run.nonce, dir: record.dir, chain: [] })
    process.env.ROOM_WORKER_ID = record.id
    try {
      for (const reply of await Promise.all([summary].flat().map(text => tools.call('room_done', { summary: text })))) expect(reply).toContain('marked done')
    } finally { delete process.env.ROOM_WORKER_ID }
    await tools.shutdown(); ws?.graph?.stop()
    if (!exit) return
    exits.get(tag)!(0)
    await vi.waitFor(() => expect(workerByTag(repo, tag)).toMatchObject({ status: 'done', exitCode: 0 }), { timeout: 15_000 })
  }
  return { call, spawn, finish, launches, leadSession: () => ls!, messages: () => ra.messages(),
    retire: () => autoRetire(ls!, { probe: () => undefined, hasHandle: () => false, tracking: () => true, project: async () => {} } as never) }
}

/** Everything about a worker that a refused refresh must leave as it was. */
const snapshot = (dir: string, tag: string, extraPaths: string[] = []) => ({
  head: git(dir, 'rev-parse', 'HEAD'), status: status(dir), index: git(dir, 'write-tree'),
  files: Object.fromEntries(['shared.txt', 'keep.txt', 'follow-up.txt', ...extraPaths].map(p => [p, fs.existsSync(path.join(dir, p)) ? read(dir, p) : null])),
  base: workerByTag(repo, tag)!.base, carriedBase: workerByTag(repo, tag)!.carriedBase,
  rebasing: fs.existsSync(path.join(git(dir, 'rev-parse', '--absolute-git-dir'), 'rebase-merge')),
})

const collectionRefs = async (tag: string) => {
  const record = (await registryForDir(repo)).list().find(r => r.tag === tag)!
  return Object.fromEntries(['collect-head', 'collect-base'].map(kind => [kind,
    git(repo, 'rev-parse', `refs/room/${kind}/${tag}/${record.id}`)]))
}

async function expectKeptRefreshRefused(t: ReturnType<typeof world>, dir: string, reason: string, paths: string[] = []) {
  const before = snapshot(dir, 'kept', paths), refsBefore = await collectionRefs('kept')
  const leadBefore = snapshot(repo, 'kept', paths), launchesBefore = t.launches.get('kept')!.length
  const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })
  expect(reply).toContain('did not refresh kept')
  expect(reply).toContain(reason)
  expect(snapshot(dir, 'kept', paths)).toEqual(before)
  expect(await collectionRefs('kept')).toEqual(refsBefore)
  expect(snapshot(repo, 'kept', paths)).toEqual(leadBefore)
  expect(t.launches.get('kept')).toHaveLength(launchesBefore)
  expect(workerByTag(repo, 'kept')?.status).toBe('done')
}

describe('room_send refresh=true', () => {
  it('preserves tracked and untracked carried WIP through refused kept refresh, plain resume and commit-then-accept (CARRY)', async () => {
    put(repo, 'shared.txt', 'a\ncarried\nc\n'); put(repo, 'notes.md', 'lead scratch\n')
    const t = world(), w = await t.spawn('kept')
    expect(w.carriedBase).toBeTruthy()
    expect(read(w.dir, 'shared.txt')).toBe('a\ncarried\nc\n')
    expect(read(w.dir, 'notes.md')).toBe('lead scratch\n')
    put(w.dir, 'keep.txt', 'k1\ndelivered\n')
    await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    git(repo, 'add', '--', 'keep.txt'); git(repo, 'commit', '-qm', 'delivered only')
    await expectKeptRefreshRefused(t, w.dir, 'snapshot changes not contained in your HEAD: notes.md, shared.txt', ['notes.md'])
    const before = snapshot(w.dir, 'kept', ['notes.md']), refsBefore = await collectionRefs('kept')
    expect(await t.call('room_send', { type: 'note', to: 'kept', text: 'plain resume' })).toContain('resumed kept')
    expect(snapshot(w.dir, 'kept', ['notes.md'])).toEqual(before)
    expect(await collectionRefs('kept')).toEqual(refsBefore)
    await t.finish('kept')
    const target = commit(repo, 'commit carried WIP')
    expect(await t.call('room_send', { type: 'note', to: 'kept', text: 'refresh', refresh: true })).toContain('rebased kept onto your HEAD')
    expect(read(w.dir, 'shared.txt')).toBe('a\ncarried\nc\n')
    expect(read(w.dir, 'notes.md')).toBe('lead scratch\n')
    expect(read(w.dir, 'keep.txt')).toBe('k1\ndelivered\n')
    expect(git(w.dir, 'rev-parse', 'HEAD')).toBe(target)
    expect(workerByTag(repo, 'kept')!.base).toBe(target)
    expect(workerByTag(repo, 'kept')!.carriedBase).toBeUndefined()
    expect(await collectionRefs('kept')).toEqual({ ...refsBefore, 'collect-head': target })
    expect(status(w.dir)).toEqual([])
    expect(status(repo)).toEqual([])
  })

  it('refuses kept refresh when the lead discards carried WIP and the worker holds its only copy (CARRY-STASHED)', async () => {
    put(repo, 'shared.txt', 'a\ncarried\nc\n')
    const t = world(), w = await t.spawn('kept')
    expect(w.carriedBase).toBeTruthy()
    put(w.dir, 'keep.txt', 'k1\ndelivered\n')
    await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    git(repo, 'add', '--', 'keep.txt'); git(repo, 'commit', '-qm', 'delivered only')
    git(repo, 'checkout', '--', 'shared.txt')
    expect(status(repo)).toEqual([])
    expect(read(repo, 'shared.txt')).toBe('a\nb\nc\n')
    await expectKeptRefreshRefused(t, w.dir, 'snapshot changes not contained in your HEAD: shared.txt')
    expect(read(w.dir, 'shared.txt')).toBe('a\ncarried\nc\n')
  })

  it('preserves an omitted middle round across three keeps, then accepts after it is committed (MULTI3)', async () => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'r1.txt', 'one\n'); await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    git(repo, 'add', 'r1.txt'); git(repo, 'commit', '-qm', 'r1')
    await t.call('room_send', { type: 'note', to: 'kept', text: 'round 2' })
    put(w.dir, 'r2.txt', 'two\n'); await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    await t.call('room_send', { type: 'note', to: 'kept', text: 'round 3' })
    put(w.dir, 'r3.txt', 'three\n'); await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    git(repo, 'add', 'r3.txt'); git(repo, 'commit', '-qm', 'r3')
    const paths = ['r1.txt', 'r2.txt', 'r3.txt']
    await expectKeptRefreshRefused(t, w.dir, 'snapshot changes not contained in your HEAD: r2.txt', paths)
    const refsBefore = await collectionRefs('kept')
    git(repo, 'add', 'r2.txt'); git(repo, 'commit', '-qm', 'r2')
    const target = git(repo, 'rev-parse', 'HEAD')
    expect(await t.call('room_send', { type: 'note', to: 'kept', text: 'refresh', refresh: true })).toContain('rebased kept onto your HEAD')
    expect(paths.map(p => read(w.dir, p))).toEqual(['one\n', 'two\n', 'three\n'])
    expect(paths.map(p => read(repo, p))).toEqual(['one\n', 'two\n', 'three\n'])
    expect(git(w.dir, 'rev-parse', 'HEAD')).toBe(target)
    expect(workerByTag(repo, 'kept')!.base).toBe(target)
    expect(await collectionRefs('kept')).toEqual({ ...refsBefore, 'collect-head': target })
    expect(status(w.dir)).toEqual([])
    expect(status(repo)).toEqual([])
  })

  it.each(['different paths', 'different hunks'] as const)('refuses refresh after two uncommitted keeps when only round 2 is committed (%s)', async mode => {
    const t = world(), w = await t.spawn('kept')
    const sameFile = mode === 'different hunks'
    put(w.dir, sameFile ? 'shared.txt' : 'keep.txt', sameFile ? 'r1\nb\nc\n' : 'delivered\n')
    await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    expect(await t.call('room_send', { type: 'note', to: 'kept', text: 'round 2' })).toContain('resumed kept')
    put(w.dir, 'shared.txt', sameFile ? 'r1\nb\nr2\n' : 'a\nb\nr2\n')
    await t.finish('kept')
    expect(await t.call('room_collect', { tag: 'kept', keep: true })).toContain('Changes from kept: shared.txt')
    if (sameFile) {
      const blob = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: 'a\nb\nr2\n', encoding: 'utf8' }).trim()
      git(repo, 'update-index', '--cacheinfo', '100644', blob, 'shared.txt')
    } else git(repo, 'add', '--', 'shared.txt')
    git(repo, 'commit', '-qm', 'round 2 only')
    // Distinct staged and unstaged follow-up bytes must also survive refusal.
    put(w.dir, 'follow-up.txt', 'staged follow-up\n'); git(w.dir, 'add', 'follow-up.txt')
    put(w.dir, 'follow-up.txt', 'unstaged follow-up\n')
    const before = snapshot(w.dir, 'kept'), refsBefore = await collectionRefs('kept')
    const leadBefore = snapshot(repo, 'kept'), launchesBefore = t.launches.get('kept')!.length
    const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'round 3', refresh: true })
    expect(reply).toContain('did not refresh kept')
    expect(reply).toContain(`snapshot changes not contained in your HEAD: ${sameFile ? 'shared.txt' : 'keep.txt'}`)
    expect(snapshot(w.dir, 'kept')).toEqual(before)
    expect(await collectionRefs('kept')).toEqual(refsBefore)
    expect(snapshot(repo, 'kept')).toEqual(leadBefore)
    expect(t.launches.get('kept')).toHaveLength(launchesBefore)
    expect(workerByTag(repo, 'kept')?.status).toBe('done')
  })

  it.each([false, true])('reports cumulative uncommitted delivery on a no-op after a second keep with no new delta (worker committed: %s)', async committed => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'keep.txt', 'delivered\n')
    if (committed) commit(w.dir, 'worker round 1')
    await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    await t.call('room_send', { type: 'note', to: 'kept', text: 'check again' })
    await t.finish('kept')
    expect(await t.call('room_collect', { tag: 'kept', keep: true })).toContain('Changes from kept: already present')
    const before = snapshot(w.dir, 'kept'), refsBefore = await collectionRefs('kept'), leadBefore = snapshot(repo, 'kept')
    const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })
    expect(reply).toContain('already has your HEAD')
    expect(reply).toContain('its kept snapshot is unchanged; collected output is still uncommitted in your checkout')
    expect(reply).toContain('resumed kept')
    expect(snapshot(w.dir, 'kept')).toEqual(before)
    expect(await collectionRefs('kept')).toEqual(refsBefore)
    expect(snapshot(repo, 'kept')).toEqual(leadBefore)
  })

  it.each([false, true])('accepts cumulative delivery committed exactly after two keeps and replays follow-ups (worker committed: %s)', async committed => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'shared.txt', 'r1\nb\nc\n')
    if (committed) commit(w.dir, 'worker round 1')
    await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    await t.call('room_send', { type: 'note', to: 'kept', text: 'round 2' })
    put(w.dir, 'shared.txt', 'r1\nb\nr2\n')
    if (committed) commit(w.dir, 'worker round 2')
    await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    const target = commit(repo, 'integrate both rounds')
    put(w.dir, 'one.txt', 'post-keep\n'); commit(w.dir, 'post-keep commit')
    put(w.dir, 'follow-up.txt', 'unstaged follow-up\n')
    const refsBefore = await collectionRefs('kept')
    const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })
    expect(reply).toContain('rebased kept onto your HEAD')
    expect(read(w.dir, 'shared.txt')).toBe('r1\nb\nr2\n')
    expect(read(w.dir, 'one.txt')).toBe('post-keep\n')
    expect(read(w.dir, 'follow-up.txt')).toBe('unstaged follow-up\n')
    expect(git(w.dir, 'log', '--format=%s', `${target}..HEAD`)).toBe('post-keep commit')
    expect(status(w.dir)).toEqual(['?? follow-up.txt'])
    expect(workerByTag(repo, 'kept')!.base).toBe(target)
    expect(await collectionRefs('kept')).toEqual({ ...refsBefore, 'collect-head': target })
  })

  it.each(['missing', 'ambiguous'] as const)('refuses a kept refresh when the shared ancestor is %s', async mode => {
    const t = world(), w = await t.spawn('kept')
    await t.finish('kept')
    const tree = git(repo, 'rev-parse', `${head}^{tree}`)
    let parent = head, target: string
    if (mode === 'ambiguous') {
      const a = git(repo, 'commit-tree', tree, '-p', head, '-m', 'side a')
      const b = git(repo, 'commit-tree', tree, '-p', head, '-m', 'side b')
      parent = git(repo, 'commit-tree', tree, '-p', a, '-p', b, '-m', 'worker merge')
      target = git(repo, 'commit-tree', tree, '-p', b, '-p', a, '-m', 'lead merge')
    } else target = git(repo, 'commit-tree', tree, '-m', 'unrelated root')
    git(w.dir, 'reset', '--hard', parent); git(repo, 'reset', '--hard', target)
    const baseline = git(repo, 'commit-tree', tree, '-p', parent, '-m', 'room: kept collection baseline')
    const registry = await registryForDir(repo)
    await registry.update(w.id, old => ({ ...old, base: baseline, collectedKeep: true, seq: old.seq + 1 }))
    git(repo, 'update-ref', `refs/room/collect-head/kept/${w.id}`, baseline)
    git(repo, 'update-ref', `refs/room/collect-base/kept/${w.id}`, head)
    const before = snapshot(w.dir, 'kept'), refsBefore = await collectionRefs('kept'), leadBefore = snapshot(repo, 'kept')
    const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })
    expect(reply).toContain('did not refresh kept')
    expect(reply).toContain('cannot verify a unique cumulative snapshot base')
    expect(snapshot(w.dir, 'kept')).toEqual(before)
    expect(await collectionRefs('kept')).toEqual(refsBefore)
    expect(snapshot(repo, 'kept')).toEqual(leadBefore)
    expect(t.launches.get('kept')).toHaveLength(1)
  })

  it('refuses refresh when lead committed its own edit to the delivered path before keep; collected output uncommitted', async () => {
    const t = world(), w = await t.spawn('kept')
    put(repo, 'shared.txt', 'a\nb\nlead-own\n'); commit(repo, 'lead own edit before keep')
    put(w.dir, 'shared.txt', 'delivered\nb\nc\n')
    await t.finish('kept')
    expect(await t.call('room_collect', { tag: 'kept', keep: true })).toContain('kept kept')
    expect(read(repo, 'shared.txt')).toBe('delivered\nb\nlead-own\n')
    const before = snapshot(w.dir, 'kept')
    const leadBefore = { head: git(repo, 'rev-parse', 'HEAD'), status: status(repo), index: git(repo, 'write-tree') }
    const launchesBefore = t.launches.get('kept')!.length
    const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })
    expect(reply).toContain('snapshot changes not contained in your HEAD')
    expect(reply).toContain('snapshot changes not contained in your HEAD: shared.txt')
    expect(snapshot(w.dir, 'kept')).toEqual(before)
    expect(workerByTag(repo, 'kept')?.status).toBe('done')
    expect(t.launches.get('kept')).toHaveLength(launchesBefore)
    expect({ head: git(repo, 'rev-parse', 'HEAD'), status: status(repo), index: git(repo, 'write-tree') }).toEqual(leadBefore)
    expect(read(w.dir, 'shared.txt')).toBe('delivered\nb\nc\n')
  })

  it('refuses refresh when lead partially stages its own hunk after keep, leaving the delivered hunk uncommitted', async () => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'shared.txt', 'delivered\nb\nc\n')
    await t.finish('kept')
    expect(await t.call('room_collect', { tag: 'kept', keep: true })).toContain('kept kept')
    put(repo, 'shared.txt', 'delivered\nb\nlead-own\n')
    const blob = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: 'a\nb\nlead-own\n', encoding: 'utf8' }).trim()
    git(repo, 'update-index', '--cacheinfo', '100644', blob, 'shared.txt'); git(repo, 'commit', '-qm', 'lead own hunk only')
    const before = snapshot(w.dir, 'kept')
    const leadBefore = { head: git(repo, 'rev-parse', 'HEAD'), status: status(repo), index: git(repo, 'write-tree') }
    const launchesBefore = t.launches.get('kept')!.length
    const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })
    expect(reply).toContain('snapshot changes not contained in your HEAD')
    expect(reply).toContain('snapshot changes not contained in your HEAD: shared.txt')
    expect(snapshot(w.dir, 'kept')).toEqual(before)
    expect(workerByTag(repo, 'kept')?.status).toBe('done')
    expect(t.launches.get('kept')).toHaveLength(launchesBefore)
    expect({ head: git(repo, 'rev-parse', 'HEAD'), status: status(repo), index: git(repo, 'write-tree') }).toEqual(leadBefore)
    expect(read(w.dir, 'shared.txt')).toBe('delivered\nb\nc\n')
  })

  it('refuses refresh after second keep on the same file; round 1 committed, plain resume, round 2 uncommitted', async () => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'keep.txt', 'delivered\n')
    await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    commit(repo, 'commit round 1')
    expect(await t.call('room_send', { type: 'note', to: 'kept', text: 'round 2' })).toContain('resumed kept')
    put(w.dir, 'keep.txt', 'delivered\nround2\n')
    await t.finish('kept')
    const second = await t.call('room_collect', { tag: 'kept', keep: true })
    expect(second).toContain('Changes from kept: keep.txt')
    expect(read(repo, 'keep.txt')).toBe('delivered\nround2\n')
    const before = snapshot(w.dir, 'kept')
    const leadBefore = { head: git(repo, 'rev-parse', 'HEAD'), status: status(repo), index: git(repo, 'write-tree') }
    const launchesBefore = t.launches.get('kept')!.length
    const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'round 3', refresh: true })
    expect(reply).toContain('snapshot changes not contained in your HEAD')
    expect(reply).toContain('snapshot changes not contained in your HEAD: keep.txt')
    expect(snapshot(w.dir, 'kept')).toEqual(before)
    expect(workerByTag(repo, 'kept')?.status).toBe('done')
    expect(t.launches.get('kept')).toHaveLength(launchesBefore)
    expect({ head: git(repo, 'rev-parse', 'HEAD'), status: status(repo), index: git(repo, 'write-tree') }).toEqual(leadBefore)
    expect(read(w.dir, 'keep.txt')).toBe('delivered\nround2\n')
  })

  it('accepts refresh when lead commits delivered output with an unrelated own hunk; refresh succeeds and keeps it', async () => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'shared.txt', 'delivered\nb\nc\n')
    await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    put(repo, 'shared.txt', 'delivered\nb\nlead-own\n'); commit(repo, 'commit delivered plus own')
    const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })
    expect(reply).toContain('rebased kept onto your HEAD')
    expect(read(w.dir, 'shared.txt')).toBe('delivered\nb\nlead-own\n')
  })
  it.each([['unrelated lead commit', false], ['unrelated lead commit', true]] as const)('refuses a kept refresh with %s before collected output is committed (worker committed: %s)', async (mode, committed) => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'keep.txt', 'delivered\n')
    if (committed) commit(w.dir, 'worker delivered edit')
    await t.finish('kept')
    expect(await t.call('room_collect', { tag: 'kept', keep: true })).toContain('kept kept')
    expect(read(repo, 'keep.txt')).toBe('delivered\n')
    if (mode === 'unrelated lead commit') {
      put(repo, 'specs/later.md', 'spec\n')
      git(repo, 'add', 'specs'); git(repo, 'commit', '-qm', 'spec only')
    }
    const before = snapshot(w.dir, 'kept')
    const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'fix your keep.txt', refresh: true })
    expect(reply).toContain('snapshot changes not contained in your HEAD')
    expect(snapshot(w.dir, 'kept')).toEqual(before)
    expect(workerByTag(repo, 'kept')?.status).toBe('done')
    expect(t.launches.get('kept')).toHaveLength(1)
  })

  it.each([false, true])('kept worker already current safely resumes without moving its snapshot (worker committed: %s)', async committed => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'keep.txt', 'delivered\n')
    if (committed) commit(w.dir, 'worker delivered edit')
    await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    const before = snapshot(w.dir, 'kept')
    const record = (await registryForDir(repo)).list().find(record => record.tag === 'kept')!
    const ref = 'refs/room/collect-head/kept/' + record.id
    const refBefore = git(repo, 'rev-parse', ref), leadBefore = status(repo)
    const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })
    expect(reply).toContain('already has your HEAD')
    expect(reply).toContain('collected output is still uncommitted in your checkout')
    expect(reply).toContain('resumed kept')
    expect(snapshot(w.dir, 'kept')).toEqual(before)
    expect(git(repo, 'rev-parse', ref)).toBe(refBefore)
    expect(status(repo)).toEqual(leadBefore)
    put(w.dir, 'second.txt', 'second delta\n')
    await t.finish('kept')
    expect(await t.call('room_collect', { tag: 'kept', keep: true })).toContain('Changes from kept: second.txt.')
    expect(read(repo, 'keep.txt')).toBe('delivered\n')
  })

  it('keeps uncommitted delivered and independent lead edits through refused refresh, plain resume and second keep', async () => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'keep.txt', 'delivered\n')
    await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    put(repo, 'specs/later.md', 'spec\n')
    git(repo, 'add', 'specs'); git(repo, 'commit', '-qm', 'unrelated spec')
    const leadHead = git(repo, 'rev-parse', 'HEAD')
    put(repo, 'shared.txt', 'independent lead edit\nb\nc\n')
    const leadBefore = status(repo)
    const workerBefore = snapshot(w.dir, 'kept')
    expect(await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true }))
      .toContain('snapshot changes not contained in your HEAD')
    expect(snapshot(w.dir, 'kept')).toEqual(workerBefore)
    expect(status(repo)).toEqual(leadBefore)
    expect(await t.call('room_send', { type: 'note', to: 'kept', text: 'continue without refresh' })).toContain('resumed kept')
    expect(read(w.dir, 'keep.txt')).toBe('delivered\n')
    put(w.dir, 'second.txt', 'second delta\n')
    await t.finish('kept')
    expect(await t.call('room_collect', { tag: 'kept', keep: true })).toContain('Changes from kept: second.txt.')
    expect(read(repo, 'keep.txt')).toBe('delivered\n')
    expect(read(repo, 'shared.txt')).toBe('independent lead edit\nb\nc\n')
    expect(read(repo, 'second.txt')).toBe('second delta\n')
    expect(read(w.dir, 'keep.txt')).toBe('delivered\n')
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(leadHead)
    expect(git(repo, 'diff', '--cached')).toBe('')
  })

  it('leaves the kept collection ref unchanged if recording the refreshed base fails', async () => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'keep.txt', 'delivered\n')
    await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    const registry = await registryForDir(repo)
    const record = registry.list().find(record => record.tag === 'kept')!
    const ref = `refs/room/collect-head/kept/${record.id}`
    const before = git(repo, 'rev-parse', ref)
    const target = commit(repo, 'commit collected output')
    const real = WorkerRegistry.prototype.update
    const spy = vi.spyOn(WorkerRegistry.prototype, 'update').mockImplementation(function (this: WorkerRegistry, id, edit) {
      if (id === record.id && edit(this.read(id)!).base === target) return Promise.reject(new Error('injected base write failure'))
      return real.call(this, id, edit)
    })
    try {
      expect(await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })).toContain('could not record its new base')
      expect(registry.read(record.id)?.base).toBe(record.base)
      expect(git(repo, 'rev-parse', ref)).toBe(before)
    } finally { spy.mockRestore() }
  })

  it('protects a refreshed kept worker without a host session from automatic retirement', async () => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'keep.txt', 'delivered\n')
    await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    const target = commit(repo, 'commit collected output')
    expect(await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })).toContain('rebased kept onto your HEAD')
    await t.finish('kept')
    const registry = await registryForDir(repo)
    const record = registry.list().find(record => record.tag === 'kept')!
    await registry.update(record.id, old => ({ ...old, hostSessionId: undefined, seq: old.seq + 1 }))
    expect(workerByTag(repo, 'kept')?.hostSessionId).toBeUndefined()
    expect(git(repo, 'rev-parse', `refs/room/collect-head/kept/${record.id}`)).toBe(target)
    await t.retire()
    expect(registry.read(record.id)?.phase).toBe('active')
    expect(workerByTag(repo, 'kept')?.status).toBe('done')
    expect(fs.existsSync(w.dir)).toBe(true)
  })

  it.each([false, true])('refuses a kept refresh when your HEAD revises delivered lines (committed before keep: %s)', async committed => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'keep.txt', 'delivered\n')
    if (committed) commit(w.dir, 'worker delivered edit')
    await t.finish('kept')
    expect(await t.call('room_collect', { tag: 'kept', keep: true })).toContain('kept kept')
    put(repo, 'keep.txt', 'lead revises delivered line\n')
    put(repo, 'specs/later.md', 'new spec\n')
    commit(repo, 'lead revises kept output and adds spec')
    const before = snapshot(w.dir, 'kept')
    const record = (await registryForDir(repo)).list().find(record => record.tag === 'kept')!
    const ref = 'refs/room/collect-head/kept/' + record.id
    const refBefore = git(repo, 'rev-parse', ref)
    const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'implement follow-up', refresh: true })
    expect(reply).toContain('your HEAD revises snapshot lines in keep.txt; send without refresh')
    expect(snapshot(w.dir, 'kept')).toEqual(before)
    expect(git(repo, 'rev-parse', ref)).toBe(refBefore)
    expect(workerByTag(repo, 'kept')?.status).toBe('done')
    expect(t.launches.get('kept')).toHaveLength(1)
    expect(fs.existsSync(path.join(w.dir, 'specs/later.md'))).toBe(false)
  })

  it('preserves post-keep commits and uncommitted follow-ups when refreshing', async () => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'keep.txt', 'delivered\n')
    await t.finish('kept')
    expect(await t.call('room_collect', { tag: 'kept', keep: true })).toContain('kept kept')
    put(w.dir, 'one.txt', 'post-keep one\n'); commit(w.dir, 'first follow-up')
    put(w.dir, 'two.txt', 'post-keep two\n'); commit(w.dir, 'second follow-up')
    put(w.dir, 'later.txt', 'uncommitted follow-up\n')
    put(repo, 'specs/later.md', 'new spec\n')
    const target = commit(repo, 'integrate kept work and spec')
    const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })
    expect(reply).toContain('rebased kept onto your HEAD')
    expect(git(w.dir, 'log', '--format=%s', `${target}..HEAD`)).toBe('second follow-up\nfirst follow-up')
    expect(git(w.dir, 'diff', '--cached')).toBe('')
    expect(status(w.dir)).toEqual(['?? later.txt'])
    await t.finish('kept')
    expect(await t.call('room_collect', { tag: 'kept' })).toContain('Changes from kept: later.txt, one.txt, two.txt')
    expect(read(repo, 'keep.txt')).toBe('delivered\n')
  })

  it('refuses lead revisions while preserving a partially staged post-keep commit', async () => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'shared.txt', 'delivered\nb\nc\n')
    await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    put(w.dir, 'shared.txt', 'delivered\nb\npost-keep\n')
    const blob = execFileSync('git', ['-C', w.dir, 'hash-object', '-w', '--stdin'], { input: 'a\nb\npost-keep\n', encoding: 'utf8' }).trim()
    git(w.dir, 'update-index', '--cacheinfo', '100644', blob, 'shared.txt')
    git(w.dir, 'commit', '-qm', 'stage only follow-up hunk')
    put(repo, 'shared.txt', 'lead revised delivery\nb\nc\n')
    commit(repo, 'revise delivery')
    const before = snapshot(w.dir, 'kept')
    const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })
    expect(reply).toContain('your HEAD revises snapshot lines in shared.txt; send without refresh')
    expect(snapshot(w.dir, 'kept')).toEqual(before)
    expect(git(w.dir, 'log', '-1', '--format=%s')).toBe('stage only follow-up hunk')
    expect(read(w.dir, 'shared.txt')).toBe('delivered\nb\npost-keep\n')
    expect(workerByTag(repo, 'kept')?.status).toBe('done')
    expect(t.launches.get('kept')).toHaveLength(1)
  })

  it('refuses overlapping lead revisions before touching a kept worker follow-up', async () => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'keep.txt', 'delivered\n')
    await t.finish('kept')
    await t.call('room_collect', { tag: 'kept', keep: true })
    put(w.dir, 'keep.txt', 'worker follow-up\n')
    git(w.dir, 'add', 'keep.txt')
    const before = snapshot(w.dir, 'kept')
    put(repo, 'keep.txt', 'lead conflicting follow-up\n'); commit(repo, 'lead revision')
    const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })
    expect(reply).toContain('your HEAD revises snapshot lines in keep.txt; send without refresh')
    expect(snapshot(w.dir, 'kept')).toEqual(before)
    expect(workerByTag(repo, 'kept')?.status).toBe('done')
  })

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


describe('every room_done reaches the lead once', () => {
  // rc9 dogfood: a follow-up sent while a reported worker's host was still exiting reached it live, in the same
  // run; its second room_done was recorded as already posted and never reached the lead.
  it.each([
    ['a follow-up the still-running worker reads live', 'live'],
    ['a resumed worker', 'resume'],
    ['a worker resumed with refresh=true', 'refresh'],
  ] as const)('%s', async (_, how) => {
    const t = world()
    await t.spawn('again')
    await t.finish('again', 'FIRST_REPORT', how !== 'live')
    expect(await t.call('room_wait', { timeoutMs: 200 })).toContain('FIRST_REPORT')
    const launchesBefore = t.launches.get('again')!.length
    if (how === 'live') expect(workerByTag(repo, 'again')!.status).toBe('running')
    const sent = await t.call('room_send', { type: 'note', to: 'again', text: 'one more thing', ...how === 'refresh' ? { refresh: true } : {} })
    expect(sent).toContain(how === 'live' ? 'sent' : 'resumed again')
    expect(t.launches.get('again')).toHaveLength(launchesBefore + (how === 'live' ? 0 : 1))
    if (how === 'live') expect(sent).not.toContain('resumed again')
    await t.finish('again', 'SECOND_REPORT')
    const second = await t.call('room_wait', { timeoutMs: 200 })
    expect(second).toContain('SECOND_REPORT')
    expect(second).not.toContain('FIRST_REPORT')
    expect(await t.call('room_wait', { timeoutMs: 200 })).not.toMatch(/FIRST_REPORT|SECOND_REPORT/)
    const done = t.messages().filter(m => m.type === 'done')
    expect(done.map(m => m.type === 'done' && m.summary)).toEqual(['FIRST_REPORT', 'SECOND_REPORT'])
  })

  it('two room_done calls at once from one worker both reach the lead', async () => {
    const t = world()
    await t.spawn('both')
    await t.finish('both', ['FIRST_REPORT', 'SECOND_REPORT'], true, 300)
    const done = t.messages().filter(m => m.type === 'done')
    expect(done.map(m => m.type === 'done' && m.summary).sort()).toEqual(['FIRST_REPORT', 'SECOND_REPORT'])
  })
})

describe('refresh publication recovery', () => {
  function publishLead(t: ReturnType<typeof world>) {
    const s = t.leadSession()
    s.daemon.reconcileGitChanges = async () => {
      const base = git(repo, 'rev-parse', 'HEAD')
      for (const p of ['shared.txt', 'keep.txt']) if (fs.existsSync(path.join(repo, p))) publishFixture(s.room, s.me.name, p, read(repo, p), { base })
      s.room.participants.set(`${s.me.name}\0git`, { ...s.room.participants.get(`${s.me.name}\0git`)!, head: base })
    }
    s.daemon.settle = async () => {}
  }
  it('retries a pending kept proof during current refresh without moving kept refs or checkout bytes', async () => {
    const t = world(), w = await t.spawn('kept')
    put(w.dir, 'keep.txt', 'delivery\n'); await t.finish('kept')
    expect(await t.call('room_collect', { tag: 'kept', keep: true })).toContain('kept kept')
    publishLead(t)
    const before = snapshot(w.dir, 'kept'), refs = await collectionRefs('kept')
    expect(await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })).toContain('already has your HEAD')
    const registry = await registryForDir(repo), record = registry.reservedByTagOrName('kept')!
    expect(keptPublicationMatches(t.leadSession(), record.keptPublication, undefined, record.base)).toBe(true)
    expect(snapshot(w.dir, 'kept')).toEqual(before); expect(await collectionRefs('kept')).toEqual(refs)
  })
  it('retries publication for the new carried base after accepted refresh', async () => {
    put(repo, 'shared.txt', 'a\ncarried\nc\n')
    const t = world(), w = await t.spawn('carry')
    await t.finish('carry'); put(repo, 'docs/new.md', 'docs only\n')
    git(repo, 'add', '--', 'docs/new.md'); git(repo, 'commit', '-qm', 'docs only')
    publishLead(t)
    expect(await t.call('room_send', { type: 'note', to: 'carry', text: 'continue', refresh: true })).toContain('rebased carry onto your HEAD')
    const record = (await registryForDir(repo)).reservedByTagOrName('carry')!
    expect(record.carriedBase).toBe(record.base)
    expect(keptPublicationMatches(t.leadSession(), record.keptPublication, undefined, record.base)).toBe(true)
    expect(read(w.dir, 'shared.txt')).toBe('a\ncarried\nc\n')
  })
})
