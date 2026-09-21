/**
 * The session registry: which of a process's rooms holds a participant, a question or a worker;
 * attachments start on add and stop on remove; worker ids stay distinct across a reused tag.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { Identity } from '@room/shared'
import { Rooms, workerId, workerIdBase, finishWorkerProcess } from '../src/registry.js'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'

let dir: string, base: string
const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
const worker: Identity = { name: 'rohanz+money', kind: 'agent', owner: 'rohanz', label: 'money' }

function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}
function fakeSession(room: RoomDoc, me: Identity, roomName = 'local/x/main'): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  return {
    room, awareness, me, dir, roomUrl: `ws://127.0.0.1:1/${encodeURIComponent(roomName)}`, roomName, browserUrl: 'http://x',
    provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base } as never,
    shareMax: 'full', shareRequested: 'full',
  } as Session
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-registry-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'rohanz')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})

function registry() {
  let primary: Session | null = null
  const events: string[] = []
  const rooms = new Rooms({
    primary: () => primary, setPrimary: s => { primary = s },
    observeClaims: s => events.push(`observe ${s.roomName}`),
    attach: (s, role) => { events.push(`attach ${role} ${s.roomName}`); return { stop: () => events.push(`stop ${role} ${s.roomName}`), flush: async () => { events.push(`flush ${s.roomName}`) } } },
  })
  return { rooms, events, primary: () => primary }
}

describe('Rooms: sessions and attachments', () => {
  it('add sets the primary, starts attachments once, and remove stops them and clears the primary', () => {
    const r = registry()
    const team = fakeSession(pair().a, lead, 'github.com/rohanz/x/main')
    r.rooms.add(team, 'primary')
    r.rooms.add(team, 'primary') // idempotent
    expect(r.primary()).toBe(team)
    expect(r.events).toEqual(['observe github.com/rohanz/x/main', 'attach primary github.com/rohanz/x/main'])
    const local = fakeSession(pair().a, lead)
    r.rooms.add(local, 'workers', team)
    expect(r.rooms.workers()).toBe(local)
    expect(r.rooms.all()).toEqual([team, local])
    expect(r.rooms.byName('local/x/main')).toBe(local)
    expect(r.rooms.roleOf(local)).toBe('workers')
    r.rooms.remove(local)
    expect(r.rooms.workers()).toBeNull()
    r.rooms.remove(team)
    expect(r.primary()).toBeNull()
    expect(r.events.slice(2)).toEqual(['observe local/x/main', 'attach workers local/x/main', 'stop workers local/x/main', 'stop primary github.com/rohanz/x/main'])
  })

  it('a second session in the same role replaces the first, whose attachments stop; track observes claims only', () => {
    const r = registry()
    const first = fakeSession(pair().a, lead, 'github.com/rohanz/x/main'), second = fakeSession(pair().a, lead, 'github.com/rohanz/x/feature')
    r.rooms.add(first, 'primary'); r.rooms.add(second, 'primary')
    expect(r.primary()).toBe(second)
    expect(r.events).toContain('stop primary github.com/rohanz/x/main')
    const tracked = fakeSession(pair().a, lead, 'local/other/main')
    r.rooms.track(tracked); r.rooms.track(tracked)
    expect(r.events.filter(e => e === 'observe local/other/main')).toHaveLength(1)
    expect(r.events.some(e => e.startsWith('attach') && e.endsWith('local/other/main'))).toBe(false)
  })

  it('flush reaches every attachment', async () => {
    const r = registry()
    const team = fakeSession(pair().a, lead, 'github.com/rohanz/x/main'), local = fakeSession(pair().a, lead)
    r.rooms.add(team, 'primary'); r.rooms.add(local, 'workers', team)
    await r.rooms.flush()
    expect(r.events.filter(e => e.startsWith('flush'))).toEqual(['flush github.com/rohanz/x/main', 'flush local/x/main'])
  })
})

describe('Rooms: who lives where', () => {
  function twoRooms() {
    const r = registry()
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    const t = fakeSession(team.a, lead, 'github.com/rohanz/x/main'), l = fakeSession(local.a, lead)
    r.rooms.add(t, 'primary'); r.rooms.add(l, 'workers', t)
    return { ...r, team, local, t, l }
  }

  it('holding: presence or work wins over a worker record, and the caller\'s own name stays put', () => {
    const x = twoRooms()
    // a worker present only in the local room
    x.local.b.setOverlay('rohanz+money', 'app.py', 'x = 2\n')
    expect(x.rooms.holding('rohanz+money', x.t)).toBe(x.l)
    expect(x.rooms.holding('rohanz', x.t)).toBe(x.t)
    // the same tag recorded in both rooms but active in the team room: the team room wins
    x.team.a.setWorker({ id: 'rohanz/tiers#1', tag: 'tiers', name: 'rohanz+tiers', host: 'claude', task: 't', dir, branch: 'room/tiers', pid: 1, startedAt: 1, status: 'running', lead: 'rohanz', gen: 1 })
    x.local.a.setWorker({ id: 'rohanz/tiers#1', tag: 'tiers', name: 'rohanz+tiers', host: 'claude', task: 'l', dir, branch: 'room/tiers', pid: 2, startedAt: 1, status: 'running', lead: 'rohanz', gen: 1 })
    expect(x.rooms.holding('rohanz+tiers', x.t)).toBe(x.t) // record in the caller's room, nobody active anywhere
    x.local.b.setOverlay('rohanz+tiers', 'app.py', 'y = 1\n')
    expect(x.rooms.holding('rohanz+tiers', x.t)).toBe(x.l) // now active in the local room
    expect(x.rooms.holding('nobody', x.t)).toBe(x.t)
  })

  it('holdingQuestion finds the room whose bus carries the id; holdingWorker prefers the caller\'s room', () => {
    const x = twoRooms()
    const q = x.local.b.post(worker, { type: 'question', to: 'rohanz', text: 'which base?' })
    expect(x.rooms.holdingQuestion(q.id, x.t)).toBe(x.l)
    expect(x.rooms.holdingQuestion('m_missing', x.t)).toBeUndefined()
    x.local.a.setWorker({ id: 'rohanz/money#1', tag: 'money', name: 'rohanz+money', host: 'claude', task: 'm', dir, branch: 'room/money', pid: 3, startedAt: 1, status: 'running', lead: 'rohanz', gen: 1 })
    expect(x.rooms.holdingWorker('money', x.t)).toBe(x.l)
    x.team.a.setWorker({ id: 'rohanz/money#1', tag: 'money', name: 'rohanz+money', host: 'claude', task: 'm', dir, branch: 'room/money', pid: 4, startedAt: 1, status: 'running', lead: 'rohanz', gen: 1 })
    expect(x.rooms.holdingWorker('money', x.t)).toBe(x.t)
    expect(x.rooms.holdingWorker('none', x.t)).toBe(x.t)
  })
})

describe('worker identity', () => {
  it('ids are per spawn; handles are per room; reservations are per room, lead and tag', () => {
    expect(workerId('rohanz', 'money', 1)).toBe('rohanz/money#1')
    expect(workerId('rohanz', 'money', 2)).not.toBe(workerId('rohanz', 'money', 1))
    expect(workerIdBase('local/x/main', 'rohanz', 'money')).toBe('local/x/main|rohanz/money')
    const r = registry()
    const t = fakeSession(pair().a, lead, 'github.com/rohanz/x/main'), l = fakeSession(pair().a, lead)
    const procT = { pid: 1, onExit() {}, kill: () => true }, procL = { pid: 2, onExit() {}, kill: () => true }
    r.rooms.setHandle(t, 'rohanz/money#1', procT); r.rooms.setHandle(l, 'rohanz/money#1', procL)
    expect(r.rooms.handle(t, 'rohanz/money#1')).toBe(procT)
    expect(r.rooms.handle(l, 'rohanz/money#1')).toBe(procL)
    r.rooms.dropHandle(t, 'rohanz/money#1', procL) // not the handle held there: kept
    expect(r.rooms.handle(t, 'rohanz/money#1')).toBe(procT)
    r.rooms.dropHandle(t, 'rohanz/money#1', procT)
    expect(r.rooms.handle(t, 'rohanz/money#1')).toBeUndefined()
    expect(r.rooms.reserve('local/x/main|rohanz/money')).toBe(true)
    expect(r.rooms.reserve('local/x/main|rohanz/money')).toBe(false)
    r.rooms.unreserve('local/x/main|rohanz/money')
    expect(r.rooms.reserve('local/x/main|rohanz/money')).toBe(true)
    r.rooms.add(l, 'workers', t)
    r.rooms.remove(l) // handles of a removed session go with it
    expect(r.rooms.handle(l, 'rohanz/money#1')).toBeUndefined()
  })

  it('a reused tag gets a new id, and the old process\'s exit no longer touches the new record', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead)
    const exits: ((code: number | null) => void)[] = []
    let n = 0
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir,
      spawner: () => ({ pid: 100 + ++n, onExit: cb => { exits.push(cb) }, kill: () => true }),
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    await tools.call('room_spawn', { tag: 'money', task: 'first' })
    const first = a.workers.get('money')!
    expect(first.id).toBe('rohanz/money#1')
    await tools.call('room_collect', { tag: 'money', discard: true })
    expect(await tools.call('room_spawn', { tag: 'money', task: 'second' })).toContain('process is still alive')
    exits[0](0)
    await vi.waitFor(() => expect(a.workers.has('money')).toBe(false))
    await tools.call('room_spawn', { tag: 'money', task: 'second' })
    const second = a.workers.get('money')!
    expect(second.id).not.toBe(first.id)
    expect(a.workerById('rohanz/money#1')).toBeUndefined()
    exits[0](0) // the first process finally exits: its record is gone, so nothing changes
    expect(a.workers.get('money')).toMatchObject({ id: second.id, status: 'running', task: 'second' })
    exits[1](0)
    expect(a.workers.get('money')).toMatchObject({ id: second.id, status: 'failed' })
  })
})

describe('worker process exits', () => {
  it('cleans a dead worker after lead restart and posts exactly one interrupt', async () => {
    const r = registry(), s = fakeSession(pair().a, lead)
    r.rooms.add(s, 'primary')
    const w = { id: 'dead#1', tag: 'dead', name: 'rohanz+dead', host: 'codex' as const, task: 'test', dir, branch: 'room/dead', pid: -1, startedAt: Date.now() - 100_000, status: 'running' as const, lead: 'rohanz' }
    s.room.setWorker(w)
    s.room.setScope({ by: w.name, byKind: 'agent', area: 'dead', summary: 'test', paths: ['app.py'] })
    s.room.addClaim({ path: 'app.py', from: 1, to: 1, by: w.name, byKind: 'agent', intent: 'work', plans: [{ kind: 'add', symbol: 'newFunction' }] })
    s.room.addClaim({ path: 'other.py', from: 1, to: 1, by: lead.name, byKind: 'agent', intent: 'lead work' })
    await r.rooms.retireWorkers(s)
    await r.rooms.retireWorkers(s)
    expect(s.room.workers.get('dead')).toMatchObject({ status: 'failed', exitCode: -1 })
    expect(s.room.openClaims().map(c => c.by)).toEqual([lead.name])
    expect(s.room.scope(w.name)).toBeUndefined()
    expect(s.room.messages().filter(m => m.priority === 'interrupt')).toMatchObject([{ type: 'note', to: lead.name }])
    expect(s.room.messages().filter(m => m.type === 'done')).toEqual([])
    r.rooms.remove(s)
  })

  it.each([
    ['running', 0, 120_000, true], ['done', 1, 120_000, true],
    ['done', 0, 56_000, false], ['done', 0, 90_000, false],
    ['running', 1, 5_000, true], ['running', 0, 5_000, true], ['done', 1, 720_000, true],
  ] as const)('status %s exit %i after %i ms: interrupt=%s', async (status, code, elapsed, warn) => {
    const s = fakeSession(pair().a, lead)
    s.room.setWorker({ id: 'exit#1', tag: 'exit', name: worker.name, host: 'codex', task: 'x', dir, branch: 'room/exit', pid: -1, startedAt: 1000, status, lead: lead.name, ...(status === 'done' ? { summary: 'finished' } : {}) })
    await finishWorkerProcess(s, s.room.workers.get('exit')!, code, 1000 + elapsed)
    // Process error + exit callbacks and repeated discovery must not duplicate the report.
    await finishWorkerProcess(s, s.room.workers.get('exit')!, code, 1000 + elapsed)
    expect(s.room.messages().filter(m => m.priority === 'interrupt')).toHaveLength(warn ? 1 : 0)
    if (warn) {
      const text = (s.room.messages().find(m => m.priority === 'interrupt') as { text: string }).text
      expect(text).toContain('last lines of its log:')
      expect(text).toContain(elapsed < 90_000 ? `${Math.floor(elapsed / 1000)} s after start` : `after ${Math.floor(elapsed / 60_000)}m`)
    }
    expect(s.room.workers.get('exit')).toMatchObject({ status: status === 'done' ? 'done' : 'failed', exitCode: code })
    if (status === 'done') expect(s.room.workers.get('exit')?.summary).toBe('finished')
  })
})
