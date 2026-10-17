import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedRegistryWorker, workerByTag } from './registry-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { GraphIndex } from '../src/graph-index.js'
import { setParticipantBase } from '@room/shared/testing'
import { clearFixture, publishFixture, setFixtureLocalRoot } from './fixtures/manifest.js'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, formatMsg, manifestPaths, participantRecord, shouldWakeOnMsg } from '@room/shared'
import type { Identity } from '@room/shared'
import { createTools, type Tools } from '../src/tools.js'
import { changedRanges, ConflictSet } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'
import { epochPublication, hubAppend } from '@room/shared/testing'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

const COMMITTED = 'def validate(x):\n    return x\n\ndef b():\n    return 2\n'
const me: Identity = { name: 'Rohan', kind: 'agent' }
let dir: string, base: string
const activeTools = new Set<Tools>()

function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}
function fakeSession(room: RoomDoc, extra: Partial<Session> = {}): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { name: 'Rohan', kind: 'agent', color: '#000' }, status: 'idle' })
  return {
    policyStore: testPolicyStore(),
    room, awareness, me, dir, roomUrl: 'ws://127.0.0.1:9/github.com%2Fo%2Fr', roomName: 'github.com/o/r', browserUrl: 'http://x',
    ...hubSeam(room), provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: 'Rohan', roomDoc: room, provider: null as never, branch: 'main', base },
    ...extra,
  }
}
function addPresence(target: Awareness, name: string): Awareness {
  const doc = new Y.Doc(), peer = new Awareness(doc)
  peer.setLocalState({ user: { name, kind: 'agent', color: '#000' }, status: 'idle' })
  applyAwarenessUpdate(target, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
  return peer
}
function setup(opts: { now?: () => number; joined?: boolean; session?: Partial<Session> } = {}) {
  const { a, b } = pair()
  a.setMeta({ repo: 'github.com/o/r' })
  setFixtureLocalRoot(a, 'Rohan', dir)
  let session: Session | null = opts.joined === false ? null : fakeSession(a, opts.session)
  const closed: string[] = []
  const tools = createTools({
    getSession: () => session, setSession: s => { session = s }, cwd: dir, now: opts.now, conflictDebounceMs: 5,
    join: async () => fakeSession(a), leave: async () => {}, close: async s => { closed.push(s.roomName); return ['github.com/o/r'] },
    log: () => {},
  })
  activeTools.add(tools)
  if (session) tools.attachHooks(session)
  return { room: a, other: b, tools, closed, get session() { return session } }
}
const kieran: Identity = { name: 'Kieran', kind: 'agent' }

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-conf-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(dir, 'app.py'), COMMITTED)
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})
afterAll(async () => {
  for (const tools of activeTools) await tools.shutdown()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => { writeFileSync(join(dir, 'app.py'), COMMITTED) })

describe('changedRanges', () => {
  it('reports live line ranges that differ from the base', () => {
    expect(changedRanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual([{ from: 2, to: 2 }])
    expect(changedRanges('a\nb\nc\n', 'a\nb\nc\nd\ne\n')).toEqual([{ from: 4, to: 5 }])
    expect(changedRanges('a\nb\n', 'a\nb\n')).toEqual([])
  })
  it('conservatively covers an unrelated 800-line rewrite', () => {
    const before = Array.from({ length: 800 }, (_, i) => `old-${i}\n`).join('')
    const after = Array.from({ length: 800 }, (_, i) => `new-${i}\n`).join('')
    expect(changedRanges(before, after)).toEqual([{ from: 1, to: 800 }])
  })
})

describe('temporary peer-copy notifications', () => {
  it.each([true, false])('new copies (identical=%s) notify both participants only on divergence', async identical => {
    const room = new RoomDoc(), path = 'copied.lua'
    const ours = '-- shared header\nreturn ours\n'
    const theirs = identical ? ours : '-- shared header\nreturn theirs\n'
    for (const name of ['Rohan', 'Kieran']) epochPublication(room, name, base)
    publishFixture(room, 'Rohan', path, ours, { base })
    publishFixture(room, 'Kieran', path, theirs, { base })
    const sessions = ['Rohan', 'Kieran'].map(name => fakeSession(room, {
      me: { name, kind: 'agent' },
      lease: { fence: () => '1' } as Session['lease'],
    }))
    const states = new Map(['Rohan', 'Kieran'].map((name, i) => [i + 1, {
      user: { name, kind: 'agent' }, sessionId: participantRecord(room, name)!.holder!.sessionId,
    }]))
    for (const session of sessions) vi.spyOn(session.awareness, 'getStates').mockReturnValue(states)
    const sets = sessions.map(session => new ConflictSet(session, session.me.name, session, () => {}))
    try {
      for (const set of sets) await set.reconcile('new peer copies')
      const notices = room.messages().filter(m => m.type === 'merge-conflict')
      if (identical) expect(notices).toEqual([])
      else {
        expect(notices).toHaveLength(2)
        expect(notices.map(m => m.to).sort()).toEqual(['Kieran', 'Rohan'])
        for (const notice of notices) {
          expect(formatMsg(notice)).toContain('CONFLICT on copied.lua')
          expect(notice.text).toContain('at lines 2')
          expect(notice.priority).toBe('notify')
        }
      }
      clearFixture(room, 'Rohan', path)
      for (const set of sets) await set.reconcile('temporary copy removed')
      for (const set of sets) await set.reconcile('still removed')
      const cleared = room.messages().filter(m => m.type === 'merge-conflict' && m.clearedFrom)
      expect(cleared).toHaveLength(identical ? 0 : 2)
      for (const notice of cleared) {
        expect(formatMsg(notice)).toContain('CONFLICT cleared on copied.lua')
        expect(notice.priority).toBe('fyi')
      }
    } finally {
      for (const set of sets) set.stop()
      for (const session of sessions) { session.awareness.destroy(); session.hub.close() }
      room.doc.destroy()
    }
  })
})

describe('room lifecycle', () => {
  it('shows another session in this checkout once without attributing its file changes to a peer', async () => {
    const room = new RoomDoc()
    room.setMeta({ repo: 'r', branch: 'main', base })
    const joined = fakeSession(room)
    room.manifestHead.set('Rohan', { base, fence: 'f', coverage: { kind: 'none', reason: 'not-publisher' }, publisher: 'Kieran', level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true })
    joined.awareness.setLocalStateField('watchedDirectory', dir)
    const peer = addPresence(joined.awareness, 'Kieran')
    peer.setLocalStateField('watchedDirectory', dir)
    applyAwarenessUpdate(joined.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
    let current: Session | null = null
    const tools = createTools({ getSession: () => current, setSession: s => { current = s }, cwd: dir, join: async () => joined, log: () => {} })
    activeTools.add(tools)
    const reply = await tools.call('room_join', {})
    expect(reply.match(/another session in this checkout/g)).toHaveLength(1)
    expect(reply).not.toContain('Your file changes are published under')
    peer.destroy()
  })

  it('shows a live same-checkout session’s explicit declarations on join even without company', async () => {
    const room = new RoomDoc()
    room.setMeta({ repo: 'r', branch: 'main', base })
    const joined = fakeSession(room)
    joined.awareness.setLocalStateField('watchedDirectory', dir)
    const peer = addPresence(joined.awareness, 'Kieran')
    peer.setLocalStateField('watchedDirectory', dir)
    applyAwarenessUpdate(joined.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
    room.setScope({ by: 'Kieran', byKind: 'agent', area: 'api', summary: 'editing app', paths: ['app.py'] })
    room.addClaim({ by: 'Kieran', byKind: 'agent', path: 'app.py', from: 1, to: 1, intent: 'change parser' })
    let current: Session | null = null
    const tools = createTools({ getSession: () => current, setSession: s => { current = s }, cwd: dir, join: async () => joined, log: () => {} })
    activeTools.add(tools)
    const reply = await tools.call('room_join', {})
    expect(reply).toContain('alone here')
    expect(reply).toContain("scope: Kieran's agent")
    expect(reply).toContain('claim')
    expect(reply).toContain('change parser')
    peer.destroy()
  })

  it('room_close needs confirm=true, then closes for everyone and leaves', async () => {
    const clock = Date.UTC(2026, 8, 15, 8, 30)
    const t = setup({ now: () => clock })
    hubAppend(t.other, kieran, { type: 'note', text: 'done (api): shipped', priority: 'fyi' })
    expect(await t.tools.call('room_close', {})).toContain('confirm=true')
    expect(t.closed).toEqual([])
    const out = await t.tools.call('room_close', { confirm: true })
    expect(t.closed).toEqual(['github.com/o/r'])
    expect(out).toContain('closed github.com/o/r for everyone: removed github.com/o/r')
    const ledger = join(dir, '.room', 'ledger', 'github.com_o_r_detached-2026-09-15T08-30-00-000Z.md')
    expect(out).toContain(ledger)
    expect(existsSync(ledger)).toBe(true)
    expect(readFileSync(ledger, 'utf8')).toContain('done (api): shipped')
    expect(t.session).toBeNull()
    expect(t.room.messages().some(m => m.type === 'note' && m.priority === 'interrupt' && m.text.includes('closing github.com/o/r for everyone'))).toBe(true)
  })

  it('room_export writes the current ledger to a requested path and reports its line count', async () => {
    const t = setup({ now: () => Date.UTC(2026, 8, 15, 9) })
    hubAppend(t.other, kieran, { type: 'note', text: 'done (tests): 12 pass', priority: 'fyi' })
    const out = await t.tools.call('room_export', { path: '.room/custom-story.md' })
    const ledger = join(dir, '.room', 'custom-story.md')
    expect(out).toContain(`exported room ledger to ${ledger} (4 lines)`)
    expect(readFileSync(ledger, 'utf8')).toContain('done (tests): 12 pass')
    expect(t.session).not.toBeNull()
  })

  it('a session whose room the server closed refuses tools until leave + create', async () => {
    let clock = 1000
    const t = setup({ session: { provider: { synced: true, wsconnected: true } as Session['provider'] }, now: () => clock })
    t.session!.closed = { reason: 'room closed' }
    await t.tools.call('room_state', {})
    clock += 2001
    const state = await t.tools.call('room_state', {})
    expect(state).toContain('OFFLINE: not connected to ')
    expect(state).toContain('showing the last known state')
    expect(await t.tools.call('room_leave', {})).toContain('left')
  })

  it('join preserves stale manifests so absent participants remain visible', async () => {
    const DAY = 86_400_000
    let clock = 1_000_000_000_000
    const t = setup({ joined: false, now: () => clock })
    publishFixture(t.other, 'Kieran', 'app.py', 'old\n')
    publishFixture(t.other, 'Hrishi', 'app.py', 'recent\n')
    for (const [person, age] of [['Kieran', 9], ['Hrishi', 2]] as const) {
      const head = t.other.manifestHead.get(person)!
      t.other.manifestHead.set(person, { ...head, scannedAt: clock - age * DAY })
    }
    await t.tools.call('room_join', {})
    expect(manifestPaths(t.room, 'Kieran')).toEqual(['app.py'])
    expect(manifestPaths(t.room, 'Hrishi')).toEqual(['app.py'])
    const note = t.room.messages().find(m => m.type === 'note' && m.text.includes('evicted'))
    expect(note).toBeUndefined()
  })
})


describe('worker preview pair baselines', () => {
  const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
  const SHARED = Array.from({ length: 10 }, (_, i) => `line${i + 1}`)
  const lines = (...edits: [number, string][]) => { const l = [...SHARED]; for (const [n, t] of edits) l[n - 1] = t; return l.join('\n') + '\n' }

  let root: string, repo: string, head: string
  const cleanups: (() => Promise<void>)[] = []
  let roomEnv: Record<string, string | undefined>
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  const put = (dir: string, p: string, text: string, mode?: number) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text)
    if (mode !== undefined) fs.chmodSync(path.join(dir, p), mode)
  }

  beforeEach(() => {
    roomEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('ROOM_')))
    for (const key of Object.keys(roomEnv)) delete process.env[key]
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-pairs-')))
    // Port reservations are machine-global in production; isolate this fixture's
    // spawned workers so concurrent test processes cannot contend for or inherit them.
    vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'config'))
    repo = path.join(root, 'lead'); fs.mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'rohanz'); git(repo, 'config', 'user.email', 'rohanz@example.test')
    put(repo, 'shared.txt', lines())
    put(repo, '.gitignore', 'secret.env\nbuild/\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base'); head = git(repo, 'rev-parse', 'HEAD')
    // roomd adds Room's directory to the private exclude file when a session joins.
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.room/\n')
  })
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c().catch(() => {})
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) delete process.env[key]
    Object.assign(process.env, roomEnv)
  })


  function pair() {
    const a = new Y.Doc(), b = new Y.Doc()
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
    b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
    return { a: new RoomDoc(a), b: new RoomDoc(b) }
  }
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
    const { a, b } = pair()
    a.setMeta({ repo: 'x' })
    setParticipantBase(a, 'rohanz', head)
    let ls: Session | null = fakeSession(a, lead, repo)
    const exits = new Map<string, (code: number | null) => void>()
    let pid = 4_000_000 // above any real pid: nothing is ever alive or signalled
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: repo, probe: () => undefined, listCwdProcesses: () => [],
      spawner: spec => {
        return { pid: pid++, started: Promise.resolve(), onExit: cb => { exits.set(spec.env.ROOM_TAG, cb) }, kill: () => true }
      },
    })
    cleanups.push(() => leadTools.shutdown())
    const call = (tool: string, args: Record<string, unknown>) => leadTools.call(tool, args) as Promise<string>
    async function spawn(tag: string) {
      const reply = await call('room_spawn', { tag, task: `task ${tag}` })
      const w = workerByTag(repo, tag)
      expect(w, reply).toBeTruthy()
      return { reply, w: w!, dir: w!.dir }
    }
    /** The worker reports with room_done through its own session, then its process exits cleanly. */
    async function finish(tag: string) {
      const w = workerByTag(repo, tag)!
      let ws: Session | null = fakeSession(b, { name: `rohanz+${tag}`, kind: 'agent', owner: 'rohanz', label: tag }, w.dir)
      const tools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: w.dir })
      const registry = await registryForDir(repo)
      const record = registry.list().find(record => record.tag === tag)!
      const run = record.runs.at(-1)!
      await registry.admit({ id: record.id, run: run.n, nonce: run.nonce, dir: record.dir, chain: [] })
      process.env.ROOM_WORKER_ID = record.id
      try { expect(await tools.call('room_done', { summary: `${tag} finished` })).toContain('marked done') }
      finally { delete process.env.ROOM_WORKER_ID }
      await tools.shutdown(); ws?.graph?.stop()
      exits.get(tag)!(0)
      await vi.waitFor(() => expect(workerByTag(repo, tag)).toMatchObject({ status: 'done', exitCode: 0 }), { timeout: 15_000 })
    }
    async function workerPreview(tag: string, run: string) {
      const w = workerByTag(repo, tag)!
      const ws = fakeSession(b, { name: `rohanz+${tag}`, kind: 'agent', owner: 'rohanz', label: tag }, w.dir)
      const tools = createTools({ getSession: () => ws, setSession: () => {}, cwd: w.dir })
      try { return await tools.call('room_preview_merge', { person: 'rohanz', run }) as string }
      finally { await tools.shutdown(); ws.graph?.stop() }
    }
    return { a, b, call, spawn, finish, workerPreview }
  }

  describe('grand-worker preview of its worker-lead after a private checkpoint', () => {
    it.each([false, true])('worker previews its lead whose committed edit it already has (lead is itself a Room worker: %s)', async leadIsWorker => {
      const t = world()
      if (leadIsWorker) {
        // The lead session is itself a worker of a human session, with its recorded base at the original HEAD.
        await seedRegistryWorker(repo, 'self', { name: 'rohanz', lead: { participant: 'human', room: 'local/x', instance: (await registryForDir(repo)).instance },
          room: 'local/x', base: head, dir: repo, outside: true, branch: 'main' })
      }
      // Private checkpoint: the lead commits; its overlay still lists the file against its recorded base.
      put(repo, 'shared.txt', lines([2, 'lead committed']))
      git(repo, 'add', 'shared.txt'); git(repo, 'commit', '-qm', 'private checkpoint')
      publishFixture(t.a, 'rohanz', 'shared.txt', lines([2, 'lead committed']))
      // A worker-lead keeps its comparison base but publishes its actual HEAD.
      t.a.participants.set('rohanz\0git', { ...t.a.participants.get('rohanz\0git')!, head: git(repo, 'rev-parse', 'HEAD') })
      const { dir } = await t.spawn('fork')
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'))
      put(dir, 'shared.txt', lines([2, 'lead committed and worker fixed']))
      const preview = await t.workerPreview('fork', `test "$(sed -n '2p' shared.txt)" = 'lead committed and worker fixed' && echo '1 passed'`)
      expect(preview, preview).not.toContain('CONFLICTS:')
        expect(preview).toContain('tests: PASSED (exit 0)')
    })
  })

  describe('sibling preview of a carried sibling', () => {
    it.each(['w', 'x'])('carried sibling preview from %s is clean when only w edits the carried line', async owner => {
      put(repo, 'shared.txt', lines([2, 'lead carried']))
      const t = world()
      const w = await t.spawn('w'), x = await t.spawn('x')
      expect(w.w.carriedBase).toBeTruthy(); expect(x.w.carriedBase).toBeTruthy()
      // Identical spawn commits can share a SHA within one second. Force two snapshots
      // with the same blob and different history so the per-path ancestor rule is exercised.
      const xBase = git(x.dir, 'commit-tree', git(x.dir, 'rev-parse', `${x.w.base}^{tree}`), '-p', head, '-m', 'second carried snapshot')
      git(x.dir, 'reset', '-q', '--hard', xBase)
      const registry = await registryForDir(repo)
      await registry.update(x.w.id, old => ({ ...old, base: xBase, carriedBase: xBase, seq: old.seq + 1 }))
      expect(xBase).not.toBe(w.w.base)
      put(w.dir, 'shared.txt', lines([2, 'lead carried fixed']))
      publishFixture(t.a, 'rohanz+w', 'shared.txt', lines([2, 'lead carried fixed']), { base: w.w.carriedBase })
      const xs = fakeSession(t.b, { name: `rohanz+${owner}`, kind: 'agent', owner: 'rohanz', label: owner }, owner === 'w' ? w.dir : x.dir)
      const tools = createTools({ getSession: () => xs, setSession: () => {}, cwd: xs.dir })
      try {
        const preview = await tools.call('room_preview_merge', { person: owner === 'w' ? 'rohanz+x' : 'rohanz+w', run: `test "$(sed -n '2p' shared.txt)" = 'lead carried fixed' && echo '1 passed'` }) as string
        expect(preview, preview).not.toContain('CONFLICTS:')
        expect(preview).toContain('tests: PASSED (exit 0)')
      } finally { await tools.shutdown(); xs.graph?.stop() }
    })
  })

  describe('sibling preview of a kept sibling', () => {
    it('worker x previews kept sibling w, which edits a delivered line after keep; x never touched the file', async () => {
      const t = world()
      const w = await t.spawn('w'), x = await t.spawn('x')
      put(w.dir, 'shared.txt', lines([2, 'DELIVERED']))
      await t.finish('w')
      expect(await t.call('room_collect', { tag: 'w', keep: true })).toContain('kept w')
      const s1 = workerByTag(repo, 'w')!.base!
      put(w.dir, 'shared.txt', lines([2, 'DELIVERED fixed']))
      publishFixture(t.a, 'rohanz+w', 'shared.txt', lines([2, 'DELIVERED fixed']), { base: s1 })
      const xs = fakeSession(t.b, { name: 'rohanz+x', kind: 'agent', owner: 'rohanz', label: 'x' }, x.dir)
      const tools = createTools({ getSession: () => xs, setSession: () => {}, cwd: x.dir })
      try {
        const preview = await tools.call('room_preview_merge', { person: 'rohanz+w', run: `test "$(sed -n '2p' shared.txt)" = 'DELIVERED fixed' && echo '1 passed'` }) as string
        expect(preview, preview).not.toContain('CONFLICTS:')
        expect(preview).toContain('tests: PASSED (exit 0)')
      } finally { await tools.shutdown(); xs.graph?.stop() }
    })
  })

})
