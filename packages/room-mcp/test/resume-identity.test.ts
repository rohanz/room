// rc12 review round 5: a resume recorded the new host's identity through the registry's wrapper around the shared,
// cached probe, so a pid still cached from an exited process could be recorded with that predecessor's identity.
import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'

const identities = vi.hoisted(() => ({ cached: { startTime: 'darwin:1:100', executable: 'claude' }, fresh: { startTime: 'darwin:1:200', executable: 'claude' } }))
vi.mock('@room/relay/process', async importOriginal => {
  const actual = await importOriginal<typeof import('@room/relay/process')>()
  return { ...actual, probeProcess: (pid: number) => pid > 6000 ? identities.cached : actual.probeProcess(pid),
    probeProcessNow: (pid: number) => pid > 6000 ? identities.fresh : actual.probeProcessNow(pid) }
})
import { createTools } from '../src/tools.js'
import { prepareWorktree } from '../src/worker-git.js'
import type { Session } from '../src/session.js'
import type { PreparedWorktree } from '../src/worker-git.js'
import type { SpawnSpec } from '../src/worker-process.js'
import { registerWorkers, type FixtureWorker } from './registry-fixture.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

const scratch: string[] = []
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  for (const dir of scratch.splice(0)) { await closeRegistryForDir(dir); rmSync(dir, { recursive: true, force: true }) }
})

function setup(maxWorkers = 2, worktree?: (repo: string, tag: string) => Promise<PreparedWorktree>, probe?: (pid: number) => { startTime?: string; executable?: string } | undefined, failStart = false, started: Promise<void> = Promise.resolve(), failWatch = false, stop: { term?: boolean; exitOnTerm?: boolean; exitOnForce?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'room-resume-'))
  scratch.push(dir)
  vi.stubEnv('XDG_CONFIG_HOME', dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@test')
  git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.')
  git('commit', '-qm', 'initial')
  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ repo: 'x', branch: 'main', base: git('rev-parse', 'HEAD') })
  const me = { name: 'rohanz', kind: 'agent' as const, owner: 'rohanz' }
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  const session = {
    room, awareness, me, dir, roomName: 'local/x/main', roomUrl: 'ws://127.0.0.1:1/local%2Fx%2Fmain', browserUrl: 'http://x',
    ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true, awareness },
    daemon: { touch() {}, async stop() {}, share: 'full', dir, name: me.name, roomDoc: room, branch: 'main', fence: 'test-fence' },
    shareMax: 'full', shareRequested: 'full',
    local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} },
  } as unknown as Session
  let current: Session | null = session
  const specs: SpawnSpec[] = []
  const logs: string[] = []
  const exits: ((code: number | null) => void)[] = []
  const errors: ((error: Error) => void)[] = []
  const kills: number[] = []
  let notifySpawn!: () => void
  const spawned = new Promise<void>(resolve => { notifySpawn = resolve })
  const tools = createTools({
    getSession: () => current, setSession: s => { current = s }, cwd: dir, maxWorkers, log: line => logs.push(line), probe, listCwdProcesses: () => [],
    spawner: spec => { if (failStart) throw new Error('host unavailable'); specs.push(spec); notifySpawn(); return { pid: 6000 + specs.length, started, onExit: cb => { if (failWatch) throw new Error('could not watch exit'); exits.push(cb) }, onError: cb => { errors.push(cb) }, kill: () => { kills.push(1); if (stop.exitOnTerm) queueMicrotask(() => exits.at(-1)?.(0)); return stop.term ?? true }, killForce: () => { kills.push(9); if (stop.exitOnForce) queueMicrotask(() => exits.at(-1)?.(null)); return true } } },
    worktree: worktree ?? ((repo, tag) => prepareWorktree(repo, tag, 'rohanz')),
  })
  const seed = async (tag: string, patch: Partial<FixtureWorker> = {}) => {
    const workerDir = join(dir, '.room', 'workers', tag)
    mkdirSync(join(dir, '.room', 'workers'), { recursive: true })
    execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', `room/${tag}`, workerDir, 'HEAD'])
    await registerWorkers(session, [{
      id: `rohanz/${tag}#1`, tag, name: `rohanz+${tag}`, lead: 'rohanz', host: 'claude',
      hostSessionId: '550e8400-e29b-41d4-a716-446655440000',
      budget: { threads: 1, memGb: 1, nice: 0 }, task: 'test', dir: workerDir,
      branch: `room/${tag}`, pid: -1, startedAt: 1, status: 'done', exitCode: 0, ...patch,
    }])
  }
  /** The worker's registry record under a tag (spawned or seeded), for run facts the lifecycle view does not carry. */
  const record = async (tag: string) => (await registryForDir(dir)).list().find(r => r.tag === tag)
  return { dir, room, session, tools, record, specs, spawned, exits, errors, kills, logs, seed, portFile: (port: number) => join(dir, 'room', 'ports', String(port)) }
}

it('records a resumed host\'s identity from a fresh read, not the shared cache', async () => {
  const t = setup(2, undefined, undefined as never)
  await t.seed('again')
  expect(await t.tools.call('room_send', { type: 'note', to: 'again', text: 'follow up' })).toContain('resumed again')
  const run = (await t.record('again'))!.runs.at(-1)!
  expect(run.launch).toMatchObject({ outcome: 'launched', process: { startTime: identities.fresh.startTime, executable: 'claude' } })
})
