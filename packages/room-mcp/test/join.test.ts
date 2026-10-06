import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, trim, type AnswerMsg, type NoteMsg, type QuestionMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { createTools } from '../src/tools.js'
import { getCredential } from '../src/credentials.js'
import { NotLoggedIn, joinSession, startupJoinOptions, type JoinOptions, type Session } from '../src/session.js'
import { hubSeam } from './fixtures/hub.js'
import { memorySession } from './fixtures/session.js'
import { testPolicyStore } from './policy-fixture.js'
import { registerWorkers } from './registry-fixture.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { writeChoice } from '../src/choice.js'

let dir: string
const dispose: (() => void | Promise<void>)[] = []

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) vi.stubEnv(key, undefined)
  dir = mkdtempSync(join(tmpdir(), 'room-join-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Ada'])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'ada@example.com'])
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-qm', 'init'])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:example/repo.git'])
})

afterEach(async () => {
  for (const fn of dispose.splice(0).reverse()) await fn()
  await closeRegistryForDir(dir)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

function session(roomName: string, options: { local?: boolean; share?: 'full' | 'declared' | 'intent' } = {}): Session {
  const doc = new Y.Doc(), room = new RoomDoc(doc), awareness = new Awareness(doc)
  dispose.push(() => { awareness.destroy(); doc.destroy() })
  const share = options.share ?? 'full'
  const roomUrl = `${options.local ? 'ws://local' : 'ws://team'}/${encodeURIComponent(roomName)}`
  const daemon = { share, touch() {}, async stop() {}, skipped: () => ({ size: [], budget: [], ignore: [] }) }
  return {
    policyStore: testPolicyStore(share, policy => { daemon.share = policy.level }),
    dir, room, awareness, roomName, roomUrl, browserUrl: 'http://example/view',
    me: { name: 'Ada+privacy', owner: 'Ada', label: 'privacy', kind: 'agent' },
    ...hubSeam(room), provider: { synced: true, awareness }, daemon, shareMax: 'full', shareRequested: share,
    ...(options.local ? { local: { url: 'ws://local' } } : {}),
  } as Session
}

function branchTools(current: Session) {
  let active: Session | null = current
  const joiner = vi.fn(async (opts: JoinOptions) => session(opts.room ?? 'github.com/example/repo', { share: opts.share as 'full' | 'declared' | 'intent' }))
  const leave = vi.fn(async () => {})
  const tools = createTools({
    cwd: dir,
    config: { credentialsPath: join(dir, 'credentials.json') } as never,
    getSession: () => active,
    setSession: s => { active = s },
    join: joiner,
    leave,
  })
  dispose.push(() => tools.shutdown())
  return { tools, joiner, leave, active: () => active }
}

it('keeps one repository room, scope and workers when the clone switches branches', async () => {
  const current = session('github.com/example/repo', { share: 'intent' })
  current.room.setScope({ by: current.me.name, byKind: 'agent', area: 'test', summary: 'keep', paths: ['src/'] })
  await registerWorkers(current, [{ tag: 'w', name: 'Ada+privacy+w', host: 'codex', task: 'x', dir, branch: 'room/w', pid: process.pid, startedAt: Date.now(), status: 'running', lead: current.me.name }])
  execFileSync('git', ['-C', dir, 'switch', '-qc', 'feature/x'])
  const t = branchTools(current)
  await t.tools.call('room_state', {})
  expect(t.joiner).not.toHaveBeenCalled()
  expect(t.leave).not.toHaveBeenCalled()
  expect(t.active()).toBe(current)
  expect(current.room.scope(current.me.name)?.summary).toBe('keep')
})

it('room_create never returns local state through the same-room fast path', async () => {
  const server = 'ws://open.example'
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new URL(url).pathname === '/auth/config'
    ? Response.json({}) : new Response('missing', { status: 404 })))
  const current = session(`local/${dir.split('/').pop()}`, { local: true })
  const t = branchTools(current)
  const out = await t.tools.call('room_create', { confirm: true, where: server, room: 'git/example/repo' })
  expect(out).toContain('opened and joined')
  expect(t.active()).not.toBe(current)
  expect(t.joiner).toHaveBeenCalledWith(expect.objectContaining({ server, create: true, confirm: true }))
})

it('carries a requested custom destination through login and back to join', async () => {
  const server = 'ws://custom.example'
  vi.stubEnv('ROOM_CREDENTIALS', join(dir, 'credentials.json'))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/auth/config') return Response.json({ github: 'device' })
    if (path === '/auth/start') return Response.json({ user_code: 'CODE', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0, device: 'dev' })
    if (path === '/auth/poll') return Response.json({ session: 's'.repeat(64), login: 'Ada', expiresIn: 900 })
    if (path === '/view-token') return Response.json({ view: 'v', hub: 1 })
    throw new Error(`unexpected ${path}`)
  }))
  let active: Session | null = session(`local/${dir.split('/').pop()}`, { local: true })
  const joiner = vi.fn(async (opts: JoinOptions) => {
    if (!getCredential(server)) throw new NotLoggedIn(server)
    return session(opts.room!)
  })
  const tools = createTools({ cwd: dir, getSession: () => active, setSession: s => { active = s }, join: joiner, leave: async () => {} })
  dispose.push(() => tools.shutdown())

  const refused = await tools.call('room_join', { where: server, room: 'git/example/repo' })
  expect(refused).toContain(`room_login server="${server}"`)
  expect(await tools.call('room_login', { server })).toContain('CODE')
  expect(await tools.call('room_login', { server, wait: 5 })).toContain('logged in')
  expect(await tools.call('room_join', { where: server, room: 'git/example/repo' })).toContain('joined git/example/repo')
  expect(joiner.mock.calls.map(([opts]) => opts.server)).toEqual([server]) // preflight refuses before calling join
})

it('identifies an old server when the 0.17 hub is absent', async () => {
  const server = 'ws://old-hub.example'
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new URL(url).pathname === '/auth/config'
    ? Response.json({}) : Response.json({ view: 'v' })))
  const t = branchTools(session(`local/${dir.split('/').pop()}`, { local: true }))
  expect(await t.tools.call('room_join', { where: server, room: 'git/example/repo' }))
    .toContain('this Room server has no 0.17 hub; ask its operator to deploy Room 0.17')
  expect(t.joiner).not.toHaveBeenCalled()
})

it.each(['argument', 'ROOM_ROOM', 'ROOM_URL', 'remembered'] as const)('retargets a legacy GitHub %s room before preflight', async source => {
  const server = 'ws://upgrade.example'
  const legacy = 'github.com/example/repo/feature/deep'
  const credentialsPath = join(dir, 'credentials.json')
  writeFileSync(credentialsPath, JSON.stringify({ [server]: { session: 's'.repeat(64), login: 'Ada', at: Date.now() } }))
  vi.stubEnv('ROOM_CREDENTIALS', credentialsPath)
  if (source === 'ROOM_ROOM') vi.stubEnv('ROOM_ROOM', legacy)
  if (source === 'ROOM_URL') vi.stubEnv('ROOM_URL', `${server}/${legacy}`)
  if (source === 'remembered') {
    execFileSync('git', ['-C', dir, 'remote', 'remove', 'origin'])
    writeFileSync(join(dir, '.git', 'room.json'), JSON.stringify({ room: `${server}/${encodeURIComponent(legacy)}`, name: 'Ada', dir }))
  }
  const rooms: string[] = [], notices: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const endpoint = new URL(url).pathname
    if (endpoint === '/auth/config') return Response.json({ github: 'device' })
    if (endpoint === '/view-token') {
      rooms.push((JSON.parse(String(init?.body)) as { room: string }).room)
      return new Response('preflight refused for test', { status: 400 })
    }
    throw new Error(`unexpected request ${endpoint}`)
  }))
  const remembered = source === 'remembered' ? await startupJoinOptions(dir, server) : undefined
  await expect(joinSession({ dir, where: source === 'ROOM_URL' ? undefined : server,
    ...(source === 'argument' ? { room: legacy } : {}), ...remembered, log: text => notices.push(text) })).rejects.toThrow(/preflight refused for test/)
  expect(rooms).toEqual(['github.com/example/repo'])
  expect(notices).toEqual(source === 'remembered' ? [] : [expect.stringContaining('branch part ignored')])
})

it.each(['room_join', 'room_create'] as const)('%s normalizes legacy GitHub rooms before tool preflight', async tool => {
  const server = 'ws://upgrade.example', seen: string[] = []
  const credentialsPath = join(dir, 'credentials.json')
  writeFileSync(credentialsPath, JSON.stringify({ [server]: { session: 's'.repeat(64), login: 'Ada', at: Date.now() } }))
  vi.stubEnv('ROOM_CREDENTIALS', credentialsPath)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname === '/auth/config') return Response.json({ github: 'device' })
    const room = (JSON.parse(String(init?.body)) as { room: string }).room
    seen.push(room)
    return room === 'github.com/example/repo' ? Response.json({ hub: 1 }) : new Response('legacy room refused', { status: 400 })
  }))
  const t = branchTools(session('local/current', { local: true }))
  const reply = await t.tools.call(tool, { where: server, room: 'github.com/example/repo/main', ...(tool === 'room_create' ? { confirm: true } : {}) })
  expect(reply).toContain('joined github.com/example/repo')
  expect(seen).toEqual(['github.com/example/repo'])
  expect(t.joiner).toHaveBeenCalledWith(expect.objectContaining({ room: 'github.com/example/repo' }))
})

it('accepts a nested non-GitHub repository name through explicit join and rejoin', async () => {
  const server = 'ws://nested.example', room = 'git/gitlab.example/group/subgroup/repo'
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => new URL(url).pathname === '/auth/config'
    ? Response.json({}) : (JSON.parse(String(init?.body)) as { room: string }).room === room
      ? Response.json({ hub: 1 }) : new Response('wrong room', { status: 400 })))
  const t = branchTools(session('local/current', { local: true }))
  const reply = await t.tools.call('room_join', { where: server, room })
  expect(reply).toContain(`joined ${room}`)
  expect(t.joiner).toHaveBeenCalledWith(expect.objectContaining({ room }))
  await t.tools.call('room_join', { where: server, room })
  expect(t.active()?.roomName).toBe(room)
})

it('a team worker preflights its inherited nested ROOM_ROOM unchanged', async () => {
  const room = 'git/gitlab.example/group/subgroup/repo', seen: string[] = []
  vi.stubEnv('ROOM_ROOM', room)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname === '/auth/config') return Response.json({})
    seen.push((JSON.parse(String(init?.body)) as { room: string }).room)
    return new Response('room not opened', { status: 404 })
  }))
  await expect(joinSession({ dir, where: 'ws://nested-worker.example' })).rejects.toThrow('room not opened')
  expect(seen).toEqual([room])
})

it.each([400, 404])('shows server text and branch hint for non-GitHub HTTP %i', async status => {
  const server = `ws://nested-${status}.example`, room = 'git/gitlab.example/group/subgroup/repo/main'
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new URL(url).pathname === '/auth/config'
    ? Response.json({}) : new Response('server rejected this room', { status })))
  const t = branchTools(session('local/current', { local: true }))
  const reply = await t.tools.call('room_join', { where: server, room })
  expect(reply).toContain('server rejected this room')
  expect(reply).toContain('if this name ends in a branch, remove it')
})

it('room_login server=team uses the remembered concrete server', async () => {
  const server = 'ws://remembered-login.example'
  await writeChoice(dir, server)
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
  const tools = createTools({ cwd: dir, getSession: () => null, setSession: () => {} })
  dispose.push(() => tools.shutdown())
  expect(await tools.call('room_login', { server: 'team' })).toContain(`${server} has no login provider`)
})

it('S2 exposes takeover=true through room_join and passes it to the join helper', async () => {
  const current = session('local/current', { local: true })
  const t = branchTools(current)
  expect(t.tools.list().find(tool => tool.name === 'room_join')?.inputSchema.properties).toHaveProperty('takeover')
  await t.tools.call('room_join', { where: 'local', room: 'local/other', takeover: true })
  expect(t.joiner).toHaveBeenCalledWith(expect.objectContaining({ takeover: true }))
})

it('M2 rejoins a taken same-room session instead of returning its stale state', async () => {
  const current = session('local/current', { local: true })
  current.lease = { state: 'taken', check() {}, fence: () => undefined, paused: () => 'name taken' } as never
  const t = branchTools(current)
  await t.tools.call('room_join', { where: 'local', room: 'local/current' })
  expect(t.leave).toHaveBeenCalledWith(current)
  expect(t.joiner).toHaveBeenCalledOnce()
})

describe('owed mail survives the trim (ledger test 5)', () => {
  const pat = { name: 'Pat', kind: 'agent' as const }, quinn = { name: 'Quinn', kind: 'agent' as const }
  const inbox = (text: string) => /\[inbox \d+\]\n((?: {2}.*\n)*)/.exec(text)?.[1] ?? ''
  const toolsFor = (s: Session) => {
    const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir })
    dispose.push(() => tools.shutdown())
    return tools
  }

  it('an answer trimmed to mail while P was offline is delivered once when P returns', async () => {
    const s = memorySession(pat, dir)
    const q = hubAppend<QuestionMsg>(s.room, pat, { type: 'question', to: quinn.name, text: 'which token?' })
    const a = hubAppend<AnswerMsg>(s.room, quinn, { type: 'answer', to: pat.name, inReplyTo: q.id, text: 'the access token' })
    for (let i = 0; i < 5; i++) hubAppend<NoteMsg>(s.room, quinn, { type: 'note', text: `later ${i}` })
    trim(s.room, Date.now(), { busKeep: 2 })
    expect(s.room.messages().some(m => m.id === a.id)).toBe(false)
    expect(s.room.mail.has(a.id)).toBe(true)
    const tools = toolsFor(s)
    expect(inbox(await tools.call('room_state', {}))).toContain('the access token')
    expect(s.room.seen(pat.name).get(a.id)).toMatchObject({ via: 'reply' })
    expect(inbox(await tools.call('room_state', {}))).not.toContain('the access token')
  })

  it('a question P was shown and has not answered moves to mail, and room_send inReplyTo still resolves (SF2)', async () => {
    const s = memorySession(pat, dir)
    s.room.colors.set(quinn.name, 0)
    const tools = toolsFor(s)
    const q = hubAppend<QuestionMsg>(s.room, quinn, { type: 'question', to: pat.name, text: 'still valid?' })
    expect(inbox(await tools.call('room_state', {}))).toContain('still valid?')
    for (let i = 0; i < 5; i++) hubAppend<NoteMsg>(s.room, quinn, { type: 'note', text: `later ${i}` })
    trim(s.room, Date.now(), { busKeep: 2 })
    expect(s.room.messages().some(m => m.id === q.id)).toBe(false)
    expect(s.room.mail.get(q.id)).toMatchObject({ text: 'still valid?' })
    const sent = await tools.call('room_send', { type: 'answer', inReplyTo: q.id, text: 'yes' })
    expect(sent).toMatch(/^sent \[/)
    expect(s.room.messages().find(m => m.type === 'answer')).toMatchObject({ inReplyTo: q.id, to: quinn.name })
  })
})
