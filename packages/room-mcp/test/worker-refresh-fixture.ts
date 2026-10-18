// room_send refresh=true: a stopped worker's branch is rebased onto the lead's HEAD before it resumes,
// so a commit the lead made after spawn reaches the worker. Real git repositories and the real
// prepareWorktree; only the host process is stubbed (as in carry-wip.test.ts).
import type { Identity } from '@room/shared'
import { RoomDoc } from '@room/shared'
import { setParticipantBase } from '@room/shared/testing'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { GraphIndex } from '../src/graph-index.js'
import { autoRetire } from '../src/retire.js'
import type { Session } from '../src/session.js'
import { createTools } from '../src/tools.js'
import { registryForDir } from '../src/worker-registry.js'
import { hubSeam } from './fixtures/hub.js'
import { clearFixtureProcesses, fixtureLiveness } from './fixtures/process-liveness.js'
import { testPolicyStore } from './policy-fixture.js'
import { workerByTag } from './registry-fixture.js'

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

export { collectionRefs, commit, expectKeptRefreshRefused, git, head, put, read, repo, snapshot, status, world }
