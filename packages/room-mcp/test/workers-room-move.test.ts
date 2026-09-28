// Room moves and workers: a move with workers is refused; worker operations never interleave with a move.
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, type Identity } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { JoinOptions, Session } from '../src/session.js'
import { GraphIndex } from '../src/graph-index.js'

let dir: string
let base: string
const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }

function fakeSession(room: RoomDoc, roomName: string, local: boolean): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...lead, color: '#000' }, status: 'idle' })
  const graph = new GraphIndex(room, lead.name, dir); graph.start()
  return {
    graph, room, awareness, me: lead, dir, roomName, roomUrl: `${local ? 'ws://127.0.0.1:1' : 'wss://team.example'}/${encodeURIComponent(roomName)}`, browserUrl: 'http://x',
    provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: lead.name, roomDoc: room, provider: null as never, branch: 'main', base, skipped: () => ({ share: [], size: [], budget: [], ignore: [] }) } as never,
    shareMax: 'full', shareRequested: 'full',
    ...(local ? { local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} } } : {}),
  } as Session
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'room-promote-')))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'rohanz')
  git('remote', 'add', 'origin', 'https://github.com/rohanz/x.git')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function setup(opts: { leaveFails?: (s: Session) => boolean; gate?: Promise<void>; worktreeGate?: Promise<void> } = {}) {
  const team = new RoomDoc(new Y.Doc()), local = new RoomDoc(new Y.Doc())
  team.setMeta({ repo: 'x', branch: 'main', base }); local.setMeta({ repo: 'x', branch: 'main', base })
  let session: Session | null = fakeSession(team, 'github.com/rohanz/x/main', false)
  const teamSession = session
  const joins: JoinOptions[] = [], left: Session[] = [], events: string[] = []
  const exits: ((code: number | null) => void)[] = []
  let joinsBeforeGate = 1
  const tools = createTools({
    getSession: () => session, setSession: s => { session = s }, cwd: dir, conflictDebounceMs: 0, probe: () => undefined, listCwdProcesses: () => [],
    join: async o => {
      joins.push(o)
      if (opts.gate && joins.length > joinsBeforeGate) { events.push('join waits'); await opts.gate; events.push('join done') }
      return fakeSession(local, `local/${basename(dir)}/main`, true)
    },
    leave: async s => { if (opts.leaveFails?.(s)) throw new Error('stop failed'); left.push(s) },
    spawner: () => { events.push('spawned'); return { pid: 99, started: Promise.resolve(), onExit: cb => { exits.push(cb) }, kill: () => true } },
    worktree: async (repo, tag) => { if (opts.worktreeGate) { events.push('preparing'); await opts.worktreeGate }; return { dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true } },
  })
  return { tools, team, local, teamSession, joins, left, events, exits, session: () => session, setJoinsBeforeGate: (n: number) => { joinsBeforeGate = n } }
}
const STILL = ' You\'re still in github.com/rohanz/x/main.'

it('refuses to move while a finished worker is uncollected, then moves once it is discarded', async () => {
  const t = setup()
  await t.tools.call('room_spawn', { tag: 'money', task: 'cents', where: 'local' })
  expect(t.joins).toHaveLength(1) // the workers room
  t.exits[0](0) // the worker exits; it is finished but not collected
  await new Promise(r => setTimeout(r, 50))

  expect(await t.tools.call('room_join', { where: 'local' })).toBe(`You have 1 worker(s) (money). Collect or discard them first (room_collect, or room_collect discard=true), then move rooms.${STILL}`)
  expect(t.left).toEqual([])
  expect(t.session()).toBe(t.teamSession)

  await t.tools.call('room_collect', { tag: 'money', discard: true })
  expect(await t.tools.call('room_join', { where: 'local' })).toContain(`joined local/${basename(dir)}/main as rohanz`)
  expect(t.left).toHaveLength(2) // the workers room, then the team room
  expect(t.left[1]).toBe(t.teamSession)
  await t.tools.call('room_leave', { force: true })
})

it('keeps a workers room whose shutdown fails, and does not move', async () => {
  let failing = true
  const t = setup({ leaveFails: s => failing && !!s.local })
  await t.tools.call('room_spawn', { tag: 'money', task: 'cents', where: 'local' })
  t.exits[0](0)
  await new Promise(r => setTimeout(r, 50))
  await t.tools.call('room_collect', { tag: 'money', discard: true })
  expect(await t.tools.call('room_join', { where: 'local' })).toBe(`error: closing the workers room failed (stop failed); Room did not move.${STILL}`)
  expect(t.session()).toBe(t.teamSession)
  // Still registered: the next local spawn reuses it instead of joining a second workers room.
  await t.tools.call('room_spawn', { tag: 'more', task: 'again', where: 'local' })
  expect(t.joins).toHaveLength(1)
  failing = false
  t.exits[1](0)
  await t.tools.call('room_leave', { force: true })
})

it('a spawn requested during a move waits for it, and starts in the room the move reached', async () => {
  let open!: () => void
  const t = setup({ gate: new Promise<void>(r => { open = r }) })
  t.setJoinsBeforeGate(0)
  const moving = t.tools.call('room_join', { where: 'local' })
  await vi.waitFor(() => expect(t.events).toContain('join waits'))
  const spawning = t.tools.call('room_spawn', { tag: 'late', task: 'after the move', where: 'local' })
  await new Promise(r => setTimeout(r, 50))
  expect(t.events).toEqual(['join waits']) // the spawn has not started
  open()
  await moving
  await spawning
  expect(t.events).toEqual(['join waits', 'join done', 'spawned'])
  expect(t.session()!.local).toBeTruthy()
  expect(t.local.workers.get('late')?.lead).toBe('rohanz')
  expect(t.team.workers.get('late')).toBeUndefined()
  t.exits[0](0)
  await t.tools.call('room_leave', { force: true })
})

it('a move asked for while a spawn is being prepared waits for it, then refuses because of the new worker', async () => {
  let open!: () => void
  const t = setup({ worktreeGate: new Promise<void>(r => { open = r }) })
  const spawning = t.tools.call('room_spawn', { tag: 'early', task: 'before the move', where: 'local' })
  await vi.waitFor(() => expect(t.events).toContain('preparing'))
  let moved: string | undefined
  const moving = t.tools.call('room_join', { where: 'local' }).then(r => { moved = r })
  await new Promise(r => setTimeout(r, 50))
  expect(moved).toBeUndefined() // waiting for the spawn
  open()
  await spawning
  await moving
  expect(moved).toBe(`You have 1 worker(s) (early). Collect or discard them first (room_collect, or room_collect discard=true), then move rooms.${STILL}`)
  expect(t.left).toEqual([])
  t.exits[0](0)
  await t.tools.call('room_leave', { force: true })
})

it('a room_send asked for during a move waits for it, and posts in the room the move reached', async () => {
  let open!: () => void
  const t = setup({ gate: new Promise<void>(r => { open = r }) })
  t.setJoinsBeforeGate(0)
  const moving = t.tools.call('room_join', { where: 'local' })
  await vi.waitFor(() => expect(t.events).toContain('join waits'))
  const sending = t.tools.call('room_send', { type: 'note', text: 'after the move' })
  await new Promise(r => setTimeout(r, 50))
  expect(t.team.messages().some(m => m.type === 'note' && m.text === 'after the move')).toBe(false)
  open()
  await moving
  await sending
  expect(t.local.messages().some(m => m.type === 'note' && m.text === 'after the move')).toBe(true)
  expect(t.team.messages().some(m => m.type === 'note' && m.text === 'after the move')).toBe(false)
  await t.tools.call('room_leave', { force: true })
})

it('a move asked for while room_collect is discarding a worker waits for it, then moves', async () => {
  const t = setup()
  await t.tools.call('room_spawn', { tag: 'money', task: 'cents', where: 'local' })
  const discarding = t.tools.call('room_collect', { tag: 'money', discard: true }) // waits for the process to exit
  await vi.waitFor(() => expect(t.local.workers.get('money')?.dismissedAt).toBeDefined())
  let moved: string | undefined
  const moving = t.tools.call('room_join', { where: 'local' }).then(r => { moved = r })
  await new Promise(r => setTimeout(r, 50))
  expect(moved).toBeUndefined()
  expect(t.left).toEqual([])
  t.exits[0](1)
  expect(await discarding).toContain('discarded money')
  await moving
  expect(moved).toContain(`joined local/${basename(dir)}/main as rohanz`)
  await t.tools.call('room_leave', { force: true })
})
