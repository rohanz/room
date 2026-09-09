import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { Identity } from '@room/shared'
import { createTools } from '../src/tools.js'

const COMMITTED = 'def a():\n    return 1\n\ndef b():\n    return 2\n'
const LIVE = 'def a():\n    return 1\n\ndef b():\n    return 22\n'
const me: Identity = { name: 'Rohan', kind: 'agent' }
let dir: string

function setup() {
  const doc = new Y.Doc()
  const room = new RoomDoc(doc)
  room.setFile('app.py', LIVE)
  room.setMeta({ repo: 'demo', branch: 'main', base: 'abc123' })
  const awareness = new Awareness(doc)
  awareness.setLocalState({ user: { name: 'Rohan', kind: 'agent', color: '#000' }, status: 'idle' })
  const tools = createTools({ room, me, dir, awareness, sleep: async () => {} })
  return { room, awareness, tools }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-mcp-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(dir, 'app.py'), COMMITTED)
  git('add', '.'); git('commit', '-qm', 'init')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('tools', () => {
  it('lists the nine tools', () => {
    const { tools } = setup()
    expect(tools.list().map(t => t.name)).toEqual(['room_state', 'room_read_live', 'room_read_committed', 'room_diff', 'room_who', 'room_claim', 'room_release', 'room_send', 'room_wait'])
  })

  it('read_committed and diff use the git repo', async () => {
    const { tools } = setup()
    expect(await tools.call('room_read_committed', { path: 'app.py' })).toContain('5|     return 2')
    const d = await tools.call('room_diff', { path: 'app.py' })
    expect(d).toContain('-    return 2\n')
    expect(d).toContain('+    return 22')
    expect(await tools.call('room_diff', {})).toContain('app.py')
    expect(await tools.call('room_read_committed', { path: 'nope.py' })).toMatch(/^error:/)
  })

  it('read_live has line numbers and unknown path errors', async () => {
    const { tools } = setup()
    expect(await tools.call('room_read_live', { path: 'app.py' })).toContain('4| def b():')
    expect(await tools.call('room_read_live', { path: 'x' })).toMatch(/^error:/)
  })

  it('claim clamps, posts claim msg, sets awareness; overlap emits conflict', async () => {
    const { room, tools, awareness } = setup()
    room.addClaim({ path: 'app.py', from: 4, to: 5, by: 'Kieran', byKind: 'agent', intent: 'notify' })
    const r = await tools.call('room_claim', { path: 'app.py', from: 4, to: 99, intent: 'refactor b' })
    expect(r).toContain('claimed c_')
    expect(r).toContain('CONFLICT')
    const types = room.messages().map(m => m.type)
    expect(types).toEqual(['claim', 'conflict'])
    const mine = room.openClaims().find(c => c.by === 'Rohan')!
    expect(mine.to).toBe(5) // trailing newline does not add a line
    expect((awareness.getLocalState() as any).cursor).toEqual({ path: 'app.py', from: 4, to: 5 })
    // release
    const rel = await tools.call('room_release', { claimId: mine.id, summary: 'done' })
    expect(rel).toContain('released')
    expect(room.openClaims().map(c => c.by)).toEqual(['Kieran'])
    expect(room.messages().at(-1)!.type).toBe('release')
    expect((awareness.getLocalState() as any).status).toBe('idle')
    expect(await tools.call('room_release', { claimId: 'nope' })).toMatch(/^error:/)
  })

  it('no conflict when nobody overlaps', async () => {
    const { room, tools } = setup()
    const r = await tools.call('room_claim', { path: 'app.py', from: 1, to: 2, intent: 'x' })
    expect(r).not.toContain('CONFLICT')
    expect(room.messages().map(m => m.type)).toEqual(['claim'])
  })

  it('room_who reports a cursor and a claim in range', async () => {
    const { room, tools, awareness } = setup()
    const doc2 = new Y.Doc()
    void doc2
    // simulate a remote human via awareness state of another client id
    const states = awareness.getStates()
    states.set(999, { user: { name: 'Kieran', kind: 'human', color: '#111' }, cursor: { path: 'app.py', from: 4, to: 4 } })
    room.addClaim({ path: 'app.py', from: 5, to: 5, by: 'Kieran', byKind: 'agent', intent: 'notify' })
    const r = await tools.call('room_who', { path: 'app.py', from: 4, to: 5 })
    expect(r).toContain('cursor: Kieran at app.py:4-4')
    expect(r).toContain("Kieran's agent · app.py:5-5")
    expect(await tools.call('room_who', { path: 'app.py', from: 1, to: 2 })).toContain('nobody active')
  })

  it('room_send maps types and validates', async () => {
    const { room, tools } = setup()
    expect(await tools.call('room_send', { type: 'changed', text: 'renamed' })).toMatch(/^error/)
    await tools.call('room_send', { type: 'changed', text: 'renamed b', paths: ['app.py'] })
    const q = room.post(( { name: 'Kieran', kind: 'agent' }), { type: 'question', to: 'Rohan', text: 'why?' } as any)
    const a = await tools.call('room_send', { type: 'answer', inReplyTo: q.id, text: 'because' })
    expect(a).toContain('answers: because')
    const last = room.messages().at(-1) as any
    expect(last).toMatchObject({ type: 'answer', to: 'Kieran', inReplyTo: q.id, from: 'Rohan', fromKind: 'agent' })
    expect(await tools.call('room_send', { type: 'note', text: 'x' })).toMatch(/^error/)
  })

  it('room_state shows everything and counts unread', async () => {
    const { room, tools } = setup()
    const s1 = await tools.call('room_state', {})
    expect(s1).toContain('meta: repo=demo branch=main')
    expect(s1).toContain("Rohan's agent (you)")
    expect(s1).toContain('unread since your last room_state: 0')
    room.post({ name: 'Kieran', kind: 'human' }, { type: 'note', text: 'hi' } as any)
    room.addClaim({ path: 'app.py', from: 1, to: 1, by: 'Kieran', byKind: 'human', intent: 'fix' })
    const s2 = await tools.call('room_state', {})
    expect(s2).toContain('unread since your last room_state: 1')
    expect(s2).toContain('Kieran · app.py:1-1 · fix')
    expect(s2).toContain('Kieran: hi')
  })

  it('room_wait caps at 30s and never throws', async () => {
    const { tools } = setup()
    expect(await tools.call('room_wait', { seconds: 500 })).toContain('waited 30s')
    expect(await tools.call('nope', {})).toMatch(/^error/)
  })
})

describe('claims on new files and self-messages', () => {
  it('allows claiming a path that is not in the room yet', async () => {
    const room = new RoomDoc()
    const tools = createTools({ room, me: { name: 'Kieran', kind: 'agent' }, dir: process.cwd(), awareness: new Awareness(room.doc) })
    const out = await tools.call('room_claim', { path: 'api/notify.py', from: 1, to: 5, intent: 'create stub' })
    expect(out).toMatch(/^claimed /)
    expect(out).toContain('new file')
    expect(room.openClaims()[0]).toMatchObject({ path: 'api/notify.py', from: 1, to: 1 })
  })
  it('refuses room_send to yourself', async () => {
    const room = new RoomDoc()
    const tools = createTools({ room, me: { name: 'Kieran', kind: 'agent' }, dir: process.cwd(), awareness: new Awareness(room.doc) })
    const out = await tools.call('room_send', { type: 'question', to: 'Kieran', text: 'may I?' })
    expect(out).toMatch(/^error: you cannot message yourself/)
    expect(room.messages()).toHaveLength(0)
  })
})
