/**
 * A lead's tools with a bridged workers room: room_done keeps the mirrors of running workers (B2),
 * and a worker exiting without room_done still wakes the lead's host (B3).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { Identity, Msg } from '@room/shared'
import { createTools } from '../src/tools.js'
import { shouldWake } from '../src/wake.js'
import type { Session } from '../src/session.js'
import { GraphIndex } from '../src/graph-index.js'

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
    provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base } as never,
    shareMax: 'full', shareRequested: 'full',
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

/** A lead in a team room with a local workers room; the spawned process's exit is under test control. */
function setupBridged(queue?: (id: string, text: string) => Promise<void>) {
  const team = pair(), local = pair()
  team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
  let ls: Session | null = fakeSession(team.a, lead, false)
  ls!.roomName = 'github.com/rohanz/x/main'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx%2Fmain'
  const exits: ((code: number | null) => void)[] = []
  const attached: Session[] = []
  const leadTools = createTools({
    getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0, queue, probe: () => undefined, listCwdProcesses: () => [],
    attachChannel: s => { attached.push(s) },
    join: async () => fakeSession(local.a, lead),
    leave: async () => {},
    spawner: () => ({ pid: 99, started: Promise.resolve(), onExit: cb => { exits.push(cb) }, kill: () => {} }),
    worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
  })
  let ws: Session | null = fakeSession(local.b, workerId)
  const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
  return { team, local, leadTools, workerTools, exits, attached, lead: () => ls! }
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
  it('through the codex queue of the workers-room hooks bridge', async () => {
    const woken: string[] = []
    const t = setupBridged(async (_id, text) => { woken.push(text) })
    writeFileSync(join(dir, '.git', 'room-session.json'), JSON.stringify({ session_id: 'thread-lead', at: Date.now(), cwd: dir, host: 'codex' }))
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'cents', where: 'local' })
    t.exits[0](0)
    await new Promise(r => setTimeout(r, 100))
    expect(woken.some(x => x.includes('exited without room_done'))).toBe(true)
    expect(t.local.a.workers.get('money')).toMatchObject({ status: 'failed', exitCode: 0 })
    await t.leadTools.call('room_leave', { force: true })
  })

  it('through the channel observer index.ts attaches to the workers room, without waking on the lead\'s own posts', async () => {
    const t = setupBridged()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'cents', where: 'local' })
    expect(t.attached).toHaveLength(1)
    const s = t.attached[0]
    // the same observer index.ts installs (kept in step with attachChannel there)
    const pushed: string[] = []
    s.room.bus.observe(ev => {
      for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) {
        if (ev.transaction.local && m.from === s.me.name) continue
        const w = shouldWake(s.me, { kind: 'msg', msg: m }, [])
        if (w) pushed.push(w.meta.type)
      }
    })
    s.room.post(s.me, { type: 'note', to: 'rohanz+money', text: 'mine', priority: 'interrupt' } as never)
    expect(pushed).toEqual([])
    t.exits[0](1)
    await vi.waitFor(() => expect(pushed).toEqual(['note']))
    await t.leadTools.call('room_leave', { force: true })
  })
})
