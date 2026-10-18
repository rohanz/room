import type { Identity } from '@room/shared'
import { RoomDoc } from '@room/shared'
import { setParticipantBase } from '@room/shared/testing'
import { execFileSync } from 'node:child_process'
import fs, { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { GraphIndex } from '../src/graph-index.js'
import type { Session } from '../src/session.js'
import { createTools as createRoomTools } from '../src/tools.js'
import { prepareWorktree } from '../src/worker-git.js'
import { type SpawnSpec } from '../src/worker-process.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import { hubSeam } from './fixtures/hub.js'
import { clearFixtureProcesses, finishFixtureProcess, fixtureLiveness, fixtureProbe, spawnFixtureProcess } from './fixtures/process-liveness.js'
import { testPolicyStore } from './policy-fixture.js'
import { registerWorkers } from './registry-fixture.js'

vi.mock('../src/leases.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/leases.js')>()
  return { ...actual, liveness: (identity: Parameters<typeof actual.liveness>[0]) => fixtureLiveness(identity, actual.liveness) }
})

// A different lead can see a fixture worker without owning its in-memory handle.
// Keep the fallback signal path in the same synthetic process model as probes
// and liveness; fixture PIDs may belong to unrelated processes on the test host.
vi.mock('../src/worker-process.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/worker-process.js')>()
  return { ...actual, signalWorker: (...args: Parameters<typeof actual.signalWorker>) => {
    const [pid, , , , worker, probe] = args
    if (probe === fixtureProbe) return !!worker && actual.pidIsOurWorker(pid, worker, probe)
    return actual.signalWorker(...args)
  } }
})

// Worker lifecycle tests exercise real worktrees and process-stop waits under concurrent suites.
vi.setConfig({ testTimeout: 30_000 })
// These sessions have synthetic publication; real daemon completion is covered in done-publication.test.ts.
vi.mock('../src/worker-publication.js', () => ({ settleWorkerPublication: async () => {} }))

/** No release notices to send here. */
const ignore = () => {}

/** The worker reports room_done for its current run (a done report), while its process may still be alive. */
async function reportDone(tag: string, summary = ''): Promise<void> {
  const registry = await registryForDir(dir)
  const record = registry.list().find(r => r.tag === tag && !['retired', 'abandoned'].includes(r.phase))!, run = record.runs.at(-1)!
  await registry.writeReport(record.id, { run: run.n, nonce: run.nonce, chain: [], joinedAt: record.createdAt, done: { at: Date.now(), summary, changed: [] } })
}

// Lifecycle workers and worktrees in this file are synthetic. Never scan host processes.
const createTools = (ctx: Parameters<typeof createRoomTools>[0]) => {
  const tools = createRoomTools({ listCwdProcesses: () => [], ...ctx })
  return { ...tools, call: async (...args: Parameters<typeof tools.call>) => {
    const session = ctx.getSession()
    if (session && args[0] === 'room_done' && !ctx.config?.workerId && !process.env.ROOM_WORKER_ID) {
      const registry = await registryForDir(session.dir)
      const record = registry.list().find(record => record.name === session.me.name)
      const run = record?.runs.at(-1)
      if (record && run) {
        if (!registry.reports(record.id).some(report => report.run === run.n)) await registry.admit({
          id: record.id, run: run.n, nonce: run.nonce, dir: record.dir,
          chain: [], hostSessionId: record.hostSessionId,
        })
        process.env.ROOM_WORKER_ID = record.id
        try { return await tools.call(...args) }
        finally { delete process.env.ROOM_WORKER_ID }
      }
    }
    return tools.call(...args)
  } }
}

// Disk cleanup and patch restoration are exercised with real worktrees in collect.test.ts.
// These lifecycle tests use synthetic worker directories and controlled process callbacks.
vi.mock('../src/worker-git.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/worker-git.js')>(),
  ignoredWorkerArtifacts: vi.fn(async () => []),
  saveDiscardPatch: vi.fn(async () => undefined),
  cleanupWorker: vi.fn(async () => true),
}))

let dir: string
let base: string
const scratchRepos: string[] = []
const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
const workerId: Identity = { name: 'rohanz+money', kind: 'agent', owner: 'rohanz', label: 'money' }

const isRoomTestEnv = (key: string) => key.startsWith('ROOM_') || key === 'CLAUDE_CODE_MESSAGING_SOCKET' || key === 'CLAUDE_CODE_MESSAGING_TOKEN'
let roomEnv: Record<string, string | undefined>
beforeEach(() => {
  clearFixtureProcesses()
  roomEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => isRoomTestEnv(key)))
  for (const key of Object.keys(roomEnv)) delete process.env[key]
  const configHome = mkdtempSync(join(tmpdir(), 'room-worker-config-'))
  scratchRepos.push(configHome)
  vi.stubEnv('XDG_CONFIG_HOME', configHome)
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const key of Object.keys(process.env)) if (isRoomTestEnv(key)) delete process.env[key]
  Object.assign(process.env, roomEnv)
  for (const repo of scratchRepos.splice(0)) {
    await closeRegistryForDir(repo).catch(() => {})
    rmSync(repo, { recursive: true, force: true })
  }
  await closeRegistryForDir(dir)
  rmSync(join(dir, '.git', 'room', 'registry'), { recursive: true, force: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim()
  const worktrees = git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9))
  for (const worktree of worktrees) if (!existsSync(worktree) || realpathSync(worktree) !== realpathSync(dir)) {
    try { git('worktree', 'remove', '--force', worktree) } catch { /* a test may have removed it already */ }
  }
  git('worktree', 'prune')
  for (const branch of git('for-each-ref', '--format=%(refname:short)', 'refs/heads/room').split('\n').filter(Boolean)) git('branch', '-D', branch)
})

function realRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'room-carry-'))
  scratchRepos.push(repo)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@test')
  git('config', 'user.name', 'tester')
  writeFileSync(join(repo, '.gitignore'), '.room/\nignored.txt\n')
  writeFileSync(join(repo, 'modified.txt'), 'before\n')
  writeFileSync(join(repo, 'staged.txt'), 'before\n')
  writeFileSync(join(repo, 'deleted.txt'), 'before\n')
  writeFileSync(join(repo, 'renamed.txt'), 'before\n')
  writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
  writeFileSync(join(repo, 'executable.sh'), '#!/bin/sh\necho before\n', { mode: 0o755 })
  git('add', '.'); git('commit', '-qm', 'initial')
  return { repo, git, head: git('rev-parse', 'HEAD') }
}

function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}
function fakeSession(room: RoomDoc, me: Identity, local = true, repoDir = dir, repoBase = base): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  const graph = new GraphIndex(room, me.name, repoDir); graph.start()
  return {
    graph, room, awareness, me, dir: repoDir, roomUrl: 'ws://127.0.0.1:1/local%2Fx', roomName: 'local/x', browserUrl: 'http://x',
    ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir: repoDir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base: repoBase, fence: 'test-fence' } as never,
    shareMax: 'full', shareRequested: 'full',
    ...(local ? { local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} } } : {}),
  } as Session
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-workers-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'rohanz')
  fs.appendFileSync(join(dir, '.git', 'info', 'exclude'), '.room/\n')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})

function setupLead(repoDir = dir, repoBase = base) {
  const { a, b } = pair()
  a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, repoBase)
  let ls: Session | null = fakeSession(a, lead, true, repoDir, repoBase)
  const specs: SpawnSpec[] = []
  const exits: ((code: number | null) => void)[] = []
  const killed: number[] = []
  const leadTools = createTools({
    getSession: () => ls, setSession: s => { ls = s }, cwd: repoDir, maxWorkers: 2, probe: fixtureProbe,
    spawner: spec => { specs.push(spec); const pid = 4242 + specs.length; spawnFixtureProcess(pid)
      const callbacks: ((code: number | null) => void)[] = []
      exits.push(code => { finishFixtureProcess(pid); for (const callback of callbacks) callback(code) })
      return { pid, started: Promise.resolve(), onExit: cb => { callbacks.push(cb) }, kill: () => { killed.push(1); return true } } },
    worktree: (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
  })
  return { a, b, session: ls, leadTools, specs, exits, killed }
}

async function ownedLegacyWorker(room: RoomDoc, tag: string, status: 'running' | 'done' | 'failed' | 'dismissed', pid: number): Promise<void> {
  // Finish the one-time discovery pass before creating a synthetic checkout. These
  // records model launched workers; the migration adapter would import an unowned one.
  await registryForDir(dir)
  const prepared = await prepareWorktree(dir, tag, 'rohanz')
  // Synthetic registry identity and liveness agree for every lifecycle reader.
  await registerWorkers(fakeSession(room, lead), [{ tag, name: `rohanz+${tag}`, host: 'claude', task: 'x', dir: prepared.dir,
    branch: prepared.branch, base: prepared.base, pid, startedAt: Date.now(), status, lead: 'rohanz' }])
}

export { base, createTools, dir, fakeSession, ignore, lead, ownedLegacyWorker, pair, realRepo, reportDone, scratchRepos, setupLead, workerId }

export function setFixtureRepo(nextDir: string, nextBase: string) { dir = nextDir; base = nextBase }
