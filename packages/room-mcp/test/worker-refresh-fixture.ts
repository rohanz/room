import { requireWorkerInventory } from '../src/worker-store.js'
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
import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest'
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
let prepared: string | undefined, preparedHead: string
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
  if (!prepared) {
    prepared = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-refresh-base-')))
    git(prepared, 'init', '-q', '-b', 'main'); git(prepared, 'config', 'user.name', 'rohanz'); git(prepared, 'config', 'user.email', 'rohanz@example.test')
    put(prepared, 'shared.txt', 'a\nb\nc\n'); put(prepared, 'keep.txt', 'k1\nk2\n'); put(prepared, '.gitignore', 'build/\n')
    preparedHead = commit(prepared, 'base')
    fs.appendFileSync(path.join(prepared, '.git', 'info', 'exclude'), '.room/\n')
  }
  // Only the prepared template is shared; each case still owns a complete, mutable repository.
  repo = path.join(root, 'lead'); fs.cpSync(prepared, repo, { recursive: true }); head = preparedHead
})
afterAll(() => { if (prepared) fs.rmSync(prepared, { recursive: true, force: true }) })
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {})
  clearFixtureProcesses()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) delete process.env[key]
  Object.assign(process.env, roomEnv)
})

function fakeSession(room: RoomDoc, me: Identity, dir: string, base = head): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  const graph = new GraphIndex(room, me.name, dir); graph.start()
  return {
    graph, room, awareness, me, dir, roomUrl: 'ws://127.0.0.1:1/local%2Fx', roomName: 'local/x', browserUrl: 'http://x',
    ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base, fence: '1' } as never,
    shareMax: 'full', shareRequested: 'full',
    local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} },
  } as Session
}

function world(context = { repo, head }) {
  // Capture ownership: an interrupted case must never follow the next case's globals.
  const { repo, head } = context
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  const ra = new RoomDoc(a), rb = new RoomDoc(b)
  ra.setMeta({ repo: 'x' })
  setParticipantBase(ra, 'rohanz', head)
  let ls: Session | null = fakeSession(ra, lead, repo, head)
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
  const leadSession = ls
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    await leadTools.shutdown()
    leadSession?.graph?.stop(); leadSession?.awareness.destroy()
    a.destroy(); b.destroy()
  })()
  cleanups.push(close)
  const call = (tool: string, args: Record<string, unknown>) => leadTools.call(tool, args) as Promise<string>
  async function spawn(tag: string, extra: Record<string, unknown> = {}) {
    const reply = await call('room_spawn', { tag, task: `task ${tag}`, ...extra })
    const w = (await workerByTag(repo, tag))
    expect(w, reply).toBeTruthy()
    return w!
  }
  /**
   * The worker calls room_done once per summary, all at once from one MCP server (the first post held back
   * `slowFirstPost` ms); unless `exit` is false, its host then exits.
   */
  async function finish(tag: string, summary: string | string[] = `${tag} finished`, exit = true, slowFirstPost = 0) {
    const w = (await workerByTag(repo, tag))!
    let ws: Session | null = fakeSession(rb, { name: `rohanz+${tag}`, kind: 'agent', owner: 'rohanz', label: tag }, w.dir, head)
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
    const record = (requireWorkerInventory(await registry.list())).find(record => record.tag === tag)!
    const run = record.runs.at(-1)!
    if (!(await registry.reports(record.id)).some(report => report.run === run.n)) await registry.admit({ id: record.id, run: run.n, nonce: run.nonce, dir: record.dir, chain: [] })
    process.env.ROOM_WORKER_ID = record.id
    try {
      for (const reply of await Promise.all([summary].flat().map(text => tools.call('room_done', { summary: text })))) expect(reply).toContain('marked done')
    } finally { delete process.env.ROOM_WORKER_ID }
    const workerSession = ws!
    await tools.shutdown()
    workerSession.graph?.stop(); workerSession.awareness.destroy()
    expect(b.isDestroyed, 'retiring a worker transport must retain the replica used by its next report').toBe(false)
    if (!exit) return
    exits.get(tag)!(0)
    await vi.waitFor(async () => expect((await workerByTag(repo, tag))).toMatchObject({ status: 'done', exitCode: 0 }), { timeout: 15_000 })
  }
  return { close, call, spawn, finish, launches, leadSession: () => ls!, messages: () => ra.messages(),
    retire: () => autoRetire(ls!, { probe: () => undefined, log: (line: string) => { process.stderr.write(`[room] ${line}\n`) }, hasHandle: () => false, tracking: () => true, project: async () => {} } as never) }
}

/** Everything about a worker that a refused refresh must leave as it was. */
const snapshot = async (dir: string, tag: string, extraPaths: string[] = []) => ({
  head: git(dir, 'rev-parse', 'HEAD'), status: status(dir), index: git(dir, 'write-tree'),
  files: Object.fromEntries(['shared.txt', 'keep.txt', 'follow-up.txt', ...extraPaths].map(p => [p, fs.existsSync(path.join(dir, p)) ? read(dir, p) : null])),
  base: (await workerByTag(repo, tag))!.base, carriedBase: (await workerByTag(repo, tag))!.carriedBase,
  rebasing: fs.existsSync(path.join(git(dir, 'rev-parse', '--absolute-git-dir'), 'rebase-merge')),
})

const collectionRefs = async (tag: string) => {
  const record = (requireWorkerInventory(await (await registryForDir(repo)).list())).find(r => r.tag === tag)!
  return Object.fromEntries(['collect-head', 'collect-base'].map(kind => [kind,
    git(repo, 'rev-parse', `refs/room/${kind}/${tag}/${record.id}`)]))
}

async function expectKeptRefreshRefused(t: ReturnType<typeof world>, dir: string, reason: string, paths: string[] = []) {
  const before = (await snapshot(dir, 'kept', paths)), refsBefore = await collectionRefs('kept')
  const leadBefore = (await snapshot(repo, 'kept', paths)), launchesBefore = t.launches.get('kept')!.length
  const reply = await t.call('room_send', { type: 'note', to: 'kept', text: 'continue', refresh: true })
  expect(reply).toContain('did not refresh kept')
  expect(reply).toContain(reason)
  expect((await snapshot(dir, 'kept', paths))).toEqual(before)
  expect(await collectionRefs('kept')).toEqual(refsBefore)
  expect((await snapshot(repo, 'kept', paths))).toEqual(leadBefore)
  expect(t.launches.get('kept')).toHaveLength(launchesBefore)
  expect((await workerByTag(repo, 'kept'))?.status).toBe('done')
}

export { collectionRefs, commit, expectKeptRefreshRefused, git, head, put, read, repo, snapshot, status, world }
