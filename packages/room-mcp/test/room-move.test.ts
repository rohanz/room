// A room move preflights the target, leaves, joins, and goes back to the old room if the join still fails.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { NoRoom, NotLoggedIn, type JoinOptions, type Session } from '../src/session.js'
import { createTools } from '../src/tools.js'
import { readChoice, writeChoice } from '../src/choice.js'
import { resolveConfig } from '../src/config.js'

let dir: string
const dispose: (() => void)[] = []
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) vi.stubEnv(key, undefined)
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'room-move-')))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Ada', '-c', 'user.email=a@a', 'commit', '-q', '--allow-empty', '-m', 'init'])
})
afterEach(() => { dispose.splice(0).forEach(fn => fn()); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

function fakeSession(roomName: string, local: boolean, at = dir): Session {
  const doc = new Y.Doc(), room = new RoomDoc(doc), awareness = new Awareness(doc)
  dispose.push(() => { awareness.destroy(); doc.destroy() })
  const roomUrl = `${local ? 'ws://127.0.0.1:1' : 'ws://team'}/${encodeURIComponent(roomName)}`
  return {
    dir: at, room, awareness, roomName, roomUrl, browserUrl: 'http://localhost/', me: { name: 'Ada', kind: 'agent' }, provider: { synced: true, awareness },
    daemon: { touch() {}, async stop() {}, skipped: () => ({ share: [], size: [], budget: [], ignore: [] }) }, shareMax: 'full', shareRequested: 'full',
    ...(local ? { local: { url: 'ws://127.0.0.1:1' } } : {}),
  } as unknown as Session
}

function setup(join: (o: JoinOptions) => Promise<Session>, opts: { cur?: Session; leave?: (s: Session) => Promise<void> } = {}) {
  const cur = opts.cur ?? fakeSession(`local/${basename(dir)}/main`, true)
  let session: Session | null = cur
  const events: string[] = []
  const joiner = vi.fn(async (o: JoinOptions) => { events.push(`join ${o.server === 'local' ? 'local' : o.server}${o.room ? ` ${o.room}` : ''}${o.dir && o.dir !== dir ? ` ${o.dir}` : ''}`); return join(o) })
  const tools = createTools({ cwd: dir, getSession: () => session, setSession: s => { session = s }, join: joiner, leave: async s => { events.push(`leave ${s.roomName}`); await opts.leave?.(s) } })
  return { tools, cur, joiner, events, session: () => session }
}
function clone(): string {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'room-move-other-')))
  dispose.push(() => rmSync(other, { recursive: true, force: true }))
  const shop = join(other, basename(dir)) // same basename: both clones host local/<name>/main
  execFileSync('git', ['clone', '-q', dir, shop])
  return shop
}

/** A team server over HTTP: auth mode and whether the room exists (view-token). Each test uses its own host (auth config is cached per server). */
function teamServer(host: string, view: () => Response = () => Response.json({ view: 'v' })) {
  const server = `ws://${host}`
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const p = new URL(url).pathname
    if (p === '/auth/config') return Response.json({})
    if (p === '/view-token') return view()
    return new Response('not found', { status: 404 })
  }))
  return server
}
const LOCAL_ROOM = () => `local/${basename(dir)}/main`
const STILL = () => ` You're still in this machine's local room (${LOCAL_ROOM()}), which works for agents on this computer.`

it('keeps the local room and says why when a team room needs an origin this clone lacks', async () => {
  const t = setup(async () => { throw new Error('unexpected join') })
  const reply = await t.tools.call('room_join', { where: 'team' })
  expect(reply).toBe(`Team rooms need a shared server and a git origin remote to name the room, and ${dir} has no origin.${STILL()} To use a team room, add an origin (git remote add origin <url>) and say 'join the room' again, or name a room: room_join(where="team", room="<name>").`)
  expect(t.events).toEqual([])
  expect(t.session()).toBe(t.cur)
})

it('does not leave when the team preflight finds no login', async () => {
  const server = 'ws://nologin.example'
  vi.stubEnv('ROOM_CREDENTIALS', join(dir, 'credentials.json'))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new URL(url).pathname === '/auth/config' ? Response.json({ github: 'device' }) : new Response('', { status: 404 })))
  const t = setup(async () => { throw new Error('unexpected join') })
  const reply = await t.tools.call('room_join', { where: server, room: 'github.com/example/repo/main' })
  expect(reply).toBe(`error: not logged in to ${server}. Call room_login server="${server}", show its code/URL, then call room_login with the same server again to wait; retry room_join where="${server}" afterward.${STILL()}`)
  expect(t.events).toEqual([])
  expect(t.session()).toBe(t.cur)
})

it('does not leave when the team preflight finds no room', async () => {
  const server = teamServer('noroom.example', () => new Response('no room for example/repo/main yet', { status: 404 }))
  const t = setup(async () => { throw new Error('unexpected join') })
  const reply = await t.tools.call('room_join', { where: server, room: 'example/repo/main' })
  expect(reply).toMatch(/^No room for example\/repo on ws:\/\/noroom\.example yet\./)
  expect(reply.endsWith(STILL())).toBe(true)
  expect(t.events).toEqual([])
})

it('does not leave when the team server refuses this login', async () => {
  const server = teamServer('refuses.example', () => new Response('not a collaborator', { status: 403 }))
  const t = setup(async () => { throw new Error('unexpected join') })
  expect(await t.tools.call('room_join', { where: server, room: 'example/repo/main' })).toBe(`error: ${server} refused example/repo/main: not a collaborator.${STILL()}`)
  expect(t.events).toEqual([])
})

it('goes back to the previous room when the join fails after the preflight passed', async () => {
  const server = teamServer('drops.example')
  const back = fakeSession(LOCAL_ROOM(), true)
  const t = setup(async o => { if (o.server !== 'local') throw new Error(`could not sync with ${server}/example%2Frepo%2Fmain within 15000ms`); return back })
  const reply = await t.tools.call('room_join', { where: server, room: 'example/repo/main' })
  expect(reply).toBe(`couldn't join example/repo/main (could not sync with ${server}/example%2Frepo%2Fmain within 15000ms); back in ${LOCAL_ROOM()}.`)
  expect(t.events).toEqual([`leave ${LOCAL_ROOM()}`, `join ${server} example/repo/main`, `join local ${LOCAL_ROOM()}`])
  expect(t.session()).toBe(back)
})

it('says so plainly when going back fails too', async () => {
  const server = teamServer('drops2.example')
  const t = setup(async () => { throw new Error('relay gone') })
  const reply = await t.tools.call('room_join', { where: server, room: 'example/repo/main' })
  expect(reply).toBe(`couldn't join example/repo/main (relay gone), and rejoining ${LOCAL_ROOM()} failed too (relay gone); this session is in no room. Say 'join the room' to try again.`)
  expect(t.session()).toBeNull()
})

it('goes back when moving to another clone that hosts a local room of the same name fails', async () => {
  const other = clone()
  const back = fakeSession(LOCAL_ROOM(), true)
  const t = setup(async o => { if (o.dir === other) throw new Error('participant name must be nonempty and contain no control characters'); return back })
  const reply = await t.tools.call('room_join', { where: 'local', dir: other })
  expect(reply).toBe(`couldn't join ${LOCAL_ROOM()} (participant name must be nonempty and contain no control characters); back in ${LOCAL_ROOM()}.`)
  expect(t.events).toEqual([`leave ${LOCAL_ROOM()}`, `join local ${LOCAL_ROOM()} ${other}`, `join local ${LOCAL_ROOM()}`])
  expect(t.session()).toBe(back)
})

it('treats another spelling of the same checkout as the room it is already in', async () => {
  const alias = join(realpathSync(mkdtempSync(join(tmpdir(), 'room-move-alias-'))), basename(dir)) // as /tmp/x is to /private/tmp/x
  symlinkSync(dir, alias)
  dispose.push(() => rmSync(dirname(alias), { recursive: true, force: true }))
  const t = setup(async () => { throw new Error('unexpected join') })
  const reply = await t.tools.call('room_join', { where: 'local', dir: alias })
  expect(reply).toContain(`room: ${LOCAL_ROOM()}`)
  expect(t.events).toEqual([])
  expect(t.session()).toBe(t.cur)
})

it('does not move, and keeps the old session, when leaving it fails', async () => {
  const server = teamServer('leavefail.example')
  const t = setup(async () => { throw new Error('unexpected join') }, { leave: async () => { throw new Error('daemon stop failed') } })
  const reply = await t.tools.call('room_join', { where: server, room: 'example/repo/main' })
  expect(reply).toBe(`error: leaving ${LOCAL_ROOM()} failed (daemon stop failed); Room did not move.${STILL()}`)
  expect(t.session()).toBe(t.cur)
})

it('refuses to leave when a worker started while the preflight ran', async () => {
  const server = 'ws://slow.example'
  const t = setup(async () => { throw new Error('unexpected join') })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const p = new URL(url).pathname
    if (p === '/view-token') t.cur.room.setWorker({ id: 'Ada/w#1', tag: 'w', name: 'Ada+w', lead: 'Ada', host: 'codex', task: 't', dir, branch: 'room/w', pid: 0, startedAt: Date.now(), status: 'running' })
    return p === '/auth/config' ? Response.json({}) : Response.json({ view: 'v' })
  }))
  const reply = await t.tools.call('room_join', { where: server, room: 'example/repo/main' })
  expect(reply).toBe(`You have 1 worker(s) (w). Collect or discard them first (room_collect, or room_collect discard=true), then move rooms.${STILL()}`)
  expect(t.events).toEqual([])
})

it('runs concurrent moves one at a time, so no displaced target is left running', async () => {
  const server = teamServer('concurrent.example')
  const joined: Session[] = [], left: Session[] = []
  const t = setup(async () => { await new Promise(r => setTimeout(r, 30)); const s = fakeSession('example/repo/main', false); joined.push(s); return s }, { leave: async s => { left.push(s) } })
  await Promise.all([t.tools.call('room_join', { where: server, room: 'example/repo/main' }), t.tools.call('room_join', { where: server, room: 'example/repo/main' })])
  expect(joined.filter(s => s !== t.session() && !left.includes(s))).toEqual([])
  expect(left[0]).toBe(t.cur)
})

it('a cancelled request stops waiting for a move in progress', async () => {
  const server = teamServer('abort.example')
  let finish!: () => void
  const t = setup(() => new Promise(r => { finish = () => r(fakeSession('example/repo/main', false)) }))
  const moving = t.tools.call('room_join', { where: server, room: 'example/repo/main' })
  await vi.waitFor(() => expect(finish).toBeDefined())
  const controller = new AbortController()
  const leaving = t.tools.call('room_leave', {}, controller.signal)
  controller.abort()
  expect(await leaving).toBe('error: tool call cancelled')
  finish()
  expect(await moving).toContain('moved from')
})

it('refuses to move while a finished worker is not yet collected, before any preflight or leave', async () => {
  const server = teamServer('finished.example')
  const t = setup(async () => { throw new Error('unexpected join') })
  t.cur.room.setWorker({ id: 'Ada/done#1', tag: 'done', name: 'Ada+done', lead: 'Ada', host: 'codex', task: 't', dir, branch: 'room/done', pid: -1, startedAt: 1, status: 'done', exitCode: 0 })
  const reply = await t.tools.call('room_join', { where: server, room: 'example/repo/main' })
  expect(reply).toBe(`You have 1 worker(s) (done). Collect or discard them first (room_collect, or room_collect discard=true), then move rooms.${STILL()}`)
  expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  expect(t.events).toEqual([])
})

it('a rollback restores the exact identity: unpinned stays unpinned, and an untagged name stays untagged', async () => {
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/example/repo.git'])
  const team = fakeSession('github.com/example/repo/main', false)
  const back = fakeSession('github.com/example/repo/main', false)
  back.pinnedRoom = true // a join with an explicit room pins it
  const calls: JoinOptions[] = []
  const t = setup(async o => { calls.push(o); if (o.server === 'local') throw new Error('relay down'); return back }, { cur: team })
  const reply = await t.tools.call('room_join', { where: 'local' })
  expect(reply.endsWith("couldn't join " + LOCAL_ROOM() + " (relay down); back in github.com/example/repo/main.")).toBe(true)
  expect(calls[1]).toMatchObject({ room: 'github.com/example/repo/main', name: 'Ada', tag: '', server: 'ws://team' })
  expect(t.session()).toBe(back)
  expect(back.pinnedRoom).toBeUndefined()
})

it('a request cancelled before leaving leaves nothing; one cancelled while joining goes back', async () => {
  const server = teamServer('cancel.example')
  const controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (new URL(url).pathname === '/view-token') controller.abort(); return new URL(url).pathname === '/auth/config' ? Response.json({}) : Response.json({ view: 'v' }) }))
  const t = setup(async () => { throw new Error('unexpected join') })
  expect(await t.tools.call('room_join', { where: server, room: 'example/repo/main' }, controller.signal)).toBe('error: tool call cancelled')
  expect(t.events).toEqual([])
  expect(t.session()).toBe(t.cur)

  const again = new AbortController()
  const back = fakeSession(LOCAL_ROOM(), true)
  const target = fakeSession('example/repo/main', false)
  const u = setup(async o => { if (o.server === 'local') return back; again.abort(); return target })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new URL(url).pathname === '/auth/config' ? Response.json({}) : Response.json({ view: 'v' })))
  expect(await u.tools.call('room_join', { where: server, room: 'example/repo/main' }, again.signal)).toBe('error: tool call cancelled')
  expect(u.events).toEqual([`leave ${LOCAL_ROOM()}`, `join ${server} example/repo/main`, 'leave example/repo/main', `join local ${LOCAL_ROOM()}`])
  expect(u.session()).toBe(back)
})

it('remembers the concrete server "team" resolved to, so a restart goes back to it', async () => {
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://git.example.com/example/repo.git'])
  const server = teamServer('self-hosted.example:1266')
  await writeChoice(dir, server)
  await writeChoice(dir, 'local') // went local; ROOM_SERVER names the team's own server
  vi.stubEnv('ROOM_SERVER', `${server}/?token=secret`)
  const t = setup(async () => fakeSession('github.com/example/repo/main', false))
  expect(await t.tools.call('room_join', { where: 'team' })).toContain('moved from')
  vi.stubEnv('ROOM_SERVER', undefined)
  expect((await readChoice(dir))?.where).toBe(server) // no token, not the word "team"
  expect((await resolveConfig({ dir, env: {} })).server).toBe(server) // a restart with nothing set
})

it('a cancelled move whose target cannot be left keeps the target, and starts no second session', async () => {
  const server = teamServer('cancel-stuck.example')
  const controller = new AbortController()
  const target = fakeSession('example/repo/main', false)
  const t = setup(async o => { if (o.server === 'local') throw new Error('unexpected rollback'); controller.abort(); return target }, { leave: async s => { if (s === target) throw new Error('daemon stop failed') } })
  expect(await t.tools.call('room_join', { where: server, room: 'example/repo/main' }, controller.signal)).toBe('error: tool call cancelled')
  expect(t.events).toEqual([`leave ${LOCAL_ROOM()}`, `join ${server} example/repo/main`, 'leave example/repo/main'])
  expect(t.session()).toBe(target)
})
