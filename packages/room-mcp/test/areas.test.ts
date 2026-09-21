import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { Identity } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'

/** Two repos: one with CODEOWNERS (api/ owned by kieran, web/ by rohan), one without. */
let owned: { dir: string; base: string }
let plain: { dir: string; base: string }

function repo(files: Record<string, string>): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'room-areas-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), text) }
  git('add', '.'); git('commit', '-qm', 'init')
  return { dir, base: git('rev-parse', 'HEAD').trim() }
}

beforeAll(() => {
  owned = repo({
    '.github/CODEOWNERS': 'api/ @kieran\nweb/ @rohan\ndocs/ @rohan @kieran\n',
    'api/a.py': 'def a():\n    return 1\n',
    'web/b.py': 'def b():\n    return 2\n',
    'README.md': 'hi\n',
  })
  plain = repo({ 'api/a.py': 'x = 1\n', 'web/b.py': 'y = 2\n', 'README.md': 'hi\n' })
})
afterAll(() => { rmSync(owned.dir, { recursive: true, force: true }); rmSync(plain.dir, { recursive: true, force: true }) })

function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}

function agent(room: RoomDoc, me: Identity, r: { dir: string; base: string }) {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle', lastActive: Date.now() })
  const s: Session = {
    room, awareness, me, dir: r.dir, roomUrl: 'ws://x/r', roomName: 'r', browserUrl: 'http://x',
    provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir: r.dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base: r.base } as never,
  }
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: r.dir, log: () => {} })
  return { s, tools, awareness }
}

/** Rohan and Kieran in the same room, awareness exchanged as a server would. */
function two(r: { dir: string; base: string }) {
  const { a, b } = pair()
  a.setMeta({ repo: 'demo', branch: 'main', base: r.base })
  const rohan = agent(a, { name: 'Rohan', kind: 'agent' }, r)
  const kieran = agent(b, { name: 'Kieran', kind: 'agent' }, r)
  const sync = () => {
    applyAwarenessUpdate(rohan.awareness, encodeAwarenessUpdate(kieran.awareness, [b.doc.clientID]), 'test')
    applyAwarenessUpdate(kieran.awareness, encodeAwarenessUpdate(rohan.awareness, [a.doc.clientID]), 'test')
  }
  sync()
  const inboxOf = (out: string) => out.startsWith('[inbox') ? out.slice(0, out.indexOf('\n\n')) : ''
  return { a, b, rohan, kieran, sync, inboxOf }
}

describe('areas from CODEOWNERS', () => {
  it('room_scope stores areas on the scope, reports them, who else is there, and the owners of areas I do not own', async () => {
    const t = two(owned)
    const k = await t.kieran.tools.call('room_scope', { area: 'api', summary: 'handlers', paths: ['api/a.py'] })
    expect(k).toContain('areas: api/ (from CODEOWNERS)')
    expect(k).toContain('nobody else is in your areas')
    expect(k).not.toContain('owners of api/') // Kieran owns api/
    expect(t.b.scope('Kieran')?.areas).toEqual(['api/'])
    t.sync()
    const r = await t.rohan.tools.call('room_scope', { area: 'api', summary: 'also handlers', paths: ['api/', 'docs/x.md'] })
    expect(r).toContain('areas: api/, docs/ (from CODEOWNERS)')
    expect(r).toContain('also in your areas: Kieran (api/)')
    expect(r).toContain('owners of api/: @kieran')
    expect(r).not.toContain('owners of docs/') // Rohan co-owns docs/
    expect(t.a.scope('Rohan')?.areas).toEqual(['api/', 'docs/'])
    expect((t.rohan.awareness.getLocalState() as { areas: string[] }).areas).toEqual(['api/', 'docs/'])
  })

  it('a changed file puts you in its area even without a scope; room_claim hints the owners', async () => {
    const t = two(owned)
    t.a.setOverlay('Rohan', 'api/a.py', 'def a():\n    return 11\n')
    const claim = await t.rohan.tools.call('room_claim', { path: 'api/a.py', from: 1, to: 1, intent: 'x' })
    expect(claim).toContain('owners of api/: @kieran')
    const st = await t.rohan.tools.call('room_state', {})
    expect(st).toContain('your areas: api/')
  })

  it('room_state shows only my areas, one summary line for the rest, and everything with all=true', async () => {
    const t = two(owned)
    await t.rohan.tools.call('room_scope', { area: 'web', summary: 'ui', paths: ['web/'] })
    await t.kieran.tools.call('room_scope', { area: 'api', summary: 'handlers', paths: ['api/'] })
    await t.kieran.tools.call('room_claim', { path: 'api/a.py', from: 1, to: 2, intent: 'tune a' })
    t.b.setOverlay('Kieran', 'api/a.py', 'def a():\n    return 12\n')
    t.sync()
    const mine = await t.rohan.tools.call('room_state', {})
    expect(mine).toContain('your areas: web/')
    expect(mine).toContain('participants overlapping your work (1 active):')
    expect(mine).toContain('Rohan · agent (you)')
    expect(mine).not.toContain('Kieran · agent')
    expect(mine).toContain('1 others: Kieran (all:true for detail)')
    expect(mine).toContain('open claims (1):')
    expect(mine).toContain('Kieran: 1 claim(s) · api/')
    expect(mine).not.toContain('tune a')
    expect(mine).toContain('uncommitted changes in your areas (1 file elsewhere):')
    expect(mine).not.toContain('Kieran: api/a.py')
    expect(mine).not.toContain('Kieran · agent · areas api/')
    const all = await t.rohan.tools.call('room_state', { all: true })
    expect(all).toContain('participants (2 active):')
    expect(all).toMatch(/Kieran · agent: working on api: handlers \(api\/\).* · areas api\//)
    expect(all).toContain('tune a')
    expect(all).toContain('Kieran: api/a.py')
    // Someone in my area is listed without all=true.
    await t.kieran.tools.call('room_scope', { area: 'web', summary: 'moved to ui', paths: ['web/b.py'] })
    t.sync()
    const now = await t.rohan.tools.call('room_state', {})
    expect(now).toContain('participants overlapping your work (2 active):')
    expect(now).not.toContain('others:')
  })

  it('inbox: broadcast notify from another area is dropped; from my area, addressed, and interrupts arrive', async () => {
    const t = two(owned)
    await t.rohan.tools.call('room_scope', { area: 'web', summary: 'ui', paths: ['web/'] })
    await t.rohan.tools.call('room_state', {}) // drain
    // Kieran declares a scope in api/ (broadcast notify with paths): not for Rohan.
    await t.kieran.tools.call('room_scope', { area: 'api', summary: 'handlers', paths: ['api/'] })
    t.sync()
    expect(t.inboxOf(await t.rohan.tools.call('room_state', {}))).toBe('')
    // An unaddressed routine change is feed-only, even when it touches my area.
    t.b.post({ name: 'Kieran', kind: 'agent' }, { type: 'changed', paths: ['web/b.py'], summary: 'routine edit', symbols: ['b'] } as never)
    expect(t.inboxOf(await t.rohan.tools.call('room_state', {}))).toBe('')
    // The routine broadcast stays feed-only, but symbol users get an addressed copy.
    await t.kieran.tools.call('room_send', { type: 'changed', text: 'renamed b', paths: ['web/b.py'], symbols: ['b'] })
    expect(t.inboxOf(await t.rohan.tools.call('room_state', {}))).toContain('renamed b')
    // A changed-with-symbols in api/: not for Rohan.
    await t.kieran.tools.call('room_send', { type: 'changed', text: 'renamed a', paths: ['api/a.py'], symbols: ['a'] })
    expect(t.inboxOf(await t.rohan.tools.call('room_state', {}))).toBe('')
    // Addressed and interrupt still arrive whatever the area.
    await t.kieran.tools.call('room_send', { type: 'question', text: 'seen a?', to: 'Rohan' })
    await t.kieran.tools.call('room_send', { type: 'note', text: 'stop everything', priority: 'interrupt' })
    const box = t.inboxOf(await t.rohan.tools.call('room_state', {}))
    expect(box).toContain('seen a?')
    expect(box).toContain('stop everything')
    // Kieran's inbox saw nothing from Rohan's web/ scope beyond his own messages.
    expect(t.inboxOf(await t.kieran.tools.call('room_state', {}))).not.toContain('ui')
  })
})

describe('areas without CODEOWNERS', () => {
  it('top-level directories are the areas and "/" holds root files', async () => {
    const t = two(plain)
    const r = await t.rohan.tools.call('room_scope', { area: 'api', summary: 'x', paths: ['api/a.py', 'README.md'] })
    expect(r).toContain('areas: /, api/ (top-level dirs; no CODEOWNERS)')
    expect(r).not.toContain('owners of')
    expect(t.a.scope('Rohan')?.areas).toEqual(['/', 'api/'])
    await t.kieran.tools.call('room_scope', { area: 'web', summary: 'y', paths: ['web/'] })
    t.sync()
    const st = await t.rohan.tools.call('room_state', {})
    expect(st).toContain('your areas: /, api/')
    expect(st).toContain('1 others: Kieran (all:true for detail)')
  })

  it('with no scope and no changes you see everything', async () => {
    const t = two(plain)
    await t.kieran.tools.call('room_scope', { area: 'web', summary: 'y', paths: ['web/'] })
    t.sync()
    const st = await t.rohan.tools.call('room_state', {})
    expect(st).toContain('areas: none yet (showing all)')
    expect(st).toContain('participants (2 active):')
  })
})
