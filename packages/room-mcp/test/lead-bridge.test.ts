/**
 * A lead's tools with a bridged workers room: room_done keeps the mirrors of running workers (B2),
 * and a worker exiting without room_done still wakes the lead's host (B3).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { Identity } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { GraphIndex } from '../src/graph-index.js'
import { hubAppend } from '@room/shared/testing'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'
import { prepareWorktree } from '../src/worker-git.js'
import { closeRegistryForDir } from '../src/worker-registry.js'

let dir: string
let base: string
const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
const workerId: Identity = { name: 'rohanz+money', kind: 'agent', owner: 'rohanz', label: 'money' }

function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}
function fakeSession(room: RoomDoc, me: Identity, local = true): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  const graph = new GraphIndex(room, me.name, dir); graph.start()
  return {
    graph, room, awareness, me, dir, roomUrl: 'ws://127.0.0.1:1/local%2Fx%2Fmain', roomName: 'local/x/main', browserUrl: 'http://x',
    ...hubSeam(room), provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base } as never,
    shareMax: 'full', shareRequested: 'full', policyStore: testPolicyStore(),
    ...(local ? { local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} } } : {}),
  } as Session
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-lead-bridge-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'rohanz')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})
afterEach(async () => {
  await closeRegistryForDir(dir)
  const worker = join(dir, '.room', 'workers', 'money')
  if (existsSync(worker)) execFileSync('git', ['-C', dir, 'worktree', 'remove', '--force', worker], { stdio: 'pipe' })
  rmSync(join(dir, '.git', 'room', 'registry'), { recursive: true, force: true })
  try { execFileSync('git', ['-C', dir, 'branch', '-D', 'room/money'], { stdio: 'pipe' }) } catch { /* no branch */ }
})

/** A lead in a team room with a local workers room; the spawned process's exit is under test control. */
function setupBridged(wake?: (id: string, text: string) => Promise<void>) {
  const team = pair(), local = pair()
  team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
  let ls: Session | null = fakeSession(team.a, lead, false)
  ls!.roomName = 'github.com/rohanz/x/main'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx%2Fmain'
  const exits: ((code: number | null) => void)[] = []
  const leadTools = createTools({
    getSession: () => ls, setSession: s => { ls = s }, cwd: dir, binding: { bound: () => ({ id: 'thread-lead', host: 'codex' as const }), id: () => 'thread-lead', dir: () => undefined, commonDir: () => undefined }, conflictDebounceMs: 0, probe: () => undefined, listCwdProcesses: () => [],
    ...(wake ? { wake: async (target: { id: string }, text: string) => { await wake(target.id, text); return 'queue' as const } } : {}),
    join: async () => fakeSession(local.a, lead),
    leave: async () => {},
    spawner: () => ({ pid: 99, started: Promise.resolve(), onExit: cb => { exits.push(cb) }, kill: () => {} }),
    worktree: async (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
  })
  let ws: Session | null = fakeSession(local.b, workerId)
  const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
  return { team, local, leadTools, workerTools, exits, lead: () => ls! }
}

describe("the lead's room_done and its workers' mirrored claims (B2)", () => {
  it('keeps mirrors of running workers, releases its own claims, and drops a finished worker\'s mirror', async () => {
    const t = setupBridged()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'cents', where: 'local' })
    await t.leadTools.call('room_scope', { area: 'api', summary: 'auth', paths: ['api/auth.py'] })
    const own = t.team.a.addClaim({ path: 'api/auth.py', from: 1, to: 1, by: lead.name, byKind: 'agent', intent: 'mine' })
    t.local.b.setOverlay(workerId.name, 'app.py', 'x = 2\n')
    t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: workerId.name, byKind: 'agent', intent: 'bump' })
    expect(t.team.b.openClaims().map(c => c.intent).sort()).toEqual(['[money] bump', 'mine'])
    const out = await t.leadTools.call('room_done', { summary: 'auth landed' })
    expect(out).toContain('released 1 claim(s) (kept 1 mirroring running workers)')
    const left = t.team.b.openClaims()
    expect(left).toHaveLength(1)
    expect(left[0]).toMatchObject({ mirrorOf: 'money', intent: '[money] bump' })
    expect(left.some(c => c.id === own.id)).toBe(false)
    // once the worker is done its mirror is fair game for the lead's next room_done
    await t.workerTools.call('room_done', { summary: 'cents done' })
    expect(t.team.b.openClaims()).toEqual([]) // the worker's room_done released its claim, so the mirror went with it
    await t.leadTools.call('room_leave', { force: true })
  })
})

describe('a worker exiting without room_done wakes the lead (B3)', () => {
  it("through the host's wake path for the workers room, content-free, without waking on the lead's own posts", async () => {
    const woken: string[] = []
    const t = setupBridged(async (_id, text) => { woken.push(text) })
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'cents', where: 'local' })
    hubAppend(t.local.a, lead, { type: 'note', to: 'rohanz+money', text: 'mine', priority: 'interrupt' } as never)
    await new Promise(r => setTimeout(r, 100))
    expect(woken).toEqual([])
    t.exits[0](0)
    await vi.waitFor(() => expect(woken).toHaveLength(1))
    expect(woken[0]).toContain('rohanz+money')
    expect(woken[0]).not.toContain('exited without room_done')
    expect(t.local.a.workers.get('money')).toMatchObject({ status: 'failed', exitCode: 0 })
    await t.leadTools.call('room_leave', { force: true })
  })
})
