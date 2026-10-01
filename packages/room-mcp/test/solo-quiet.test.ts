/**
 * Server-instructions rule 1: a room is silent while alone. A session with no company is never woken
 * (Claude inbox socket, channel, Codex queue) and its hooks deliver nothing; what it is owed stays in
 * room_state. A session's own workers are company only for their own notices.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, type BaseMsg, type ConflictMsg, type DoneMsg, type NoteMsg, type QuestionMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { createTools } from '../src/tools.js'
import { startArbitration } from '../src/arbitration.js'
import { sessionDirectory, type Session } from '../src/session.js'
import type { SessionBinding } from '../src/binding.js'
import type { SendWake } from '../src/wake-path.js'
import { hubSeam } from './fixtures/hub.js'
import { visiblePeer } from './fixtures/visible.js'
import { testPolicyStore } from './policy-fixture.js'
import { seedRegistryWorker } from './registry-fixture.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'

const SID = 'solo-session'
const room = { name: 'room', kind: 'bot' as const }
const kieran = { name: 'Kieran', kind: 'agent' as const }
let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'room-solo-')); execFileSync('git', ['-C', dir, 'init', '-q']) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  rmSync(join(dir, '.git/room'), { recursive: true, force: true })
  for (const name of ['ROOM_HOST', 'ROOM_WORKER_ID', 'ROOM_WAKE', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_SESSION_ID']) vi.stubEnv(name, undefined)
})
afterEach(async () => { vi.unstubAllEnvs(); await closeRegistryForDir(dir) })

async function mcp() {
  const texts: string[] = []
  const send: SendWake = async (_target, text) => { texts.push(text); return 'queue' }
  const doc = new RoomDoc()
  const s = { room: doc, awareness: new Awareness(doc.doc), me: { name: 'Rohan', kind: 'agent' }, dir, roomUrl: 'ws://127.0.0.1:9/r', roomName: 'r', browserUrl: '',
    shareMax: 'full', shareRequested: 'full', ...hubSeam(doc), policyStore: testPolicyStore(), provider: { synced: true }, daemon: { touch() {}, async stop() {} } } as unknown as Session
  s.awareness.setLocalState({ user: { name: 'Rohan', kind: 'agent', color: '#000' }, status: 'idle', lastActive: Date.now() })
  const binding: SessionBinding = { bound: () => ({ id: SID, host: 'codex' }), id: () => SID, dir: () => sessionDirectory(join(dir, '.git'), SID), commonDir: () => join(dir, '.git') }
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, binding, wake: send })
  tools.attachHooks(s)
  const arbitration = await startArbitration({ binding, ledger: tools.ledger, select: () => tools.hookSelect() })
  const peers: Awareness[] = []
  return {
    s, tools, texts,
    /** Another participant arrives (fresh awareness and the participant record a join publishes). */
    arrive(who: { name: string; kind: 'agent' | 'human' }) {
      visiblePeer(doc, who.name, who.kind)
      const peer = new Awareness(new Y.Doc())
      peer.setLocalState({ user: { ...who, color: '#111' }, status: 'idle', lastActive: Date.now() })
      applyAwarenessUpdate(s.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
      peers.push(peer)
    },
    hookLines: () => { const { batch, items } = tools.hookSelect(); tools.ledger.release(batch); return items.map(i => i.line) },
    async close() { for (const p of peers) { p.destroy(); p.doc.destroy() } await arbitration.close(); await tools.shutdown(); s.awareness.destroy() },
  }
}
const quiet = () => new Promise(r => setTimeout(r, 500))

it('a solo participant: base, Room and conflict notices do not wake or reach the hook, but room_state shows them', async () => {
  const m = await mcp()
  try {
    visiblePeer(m.s.room, 'Kieran') // known to the room (offline), not here now
    hubAppend<BaseMsg>(m.s.room, kieran, { type: 'base', base: 'f'.repeat(40), prev: 'e'.repeat(40), commits: 1, paths: ['app.py'], summary: 'main moved on' })
    hubAppend<NoteMsg>(m.s.room, room, { type: 'note', to: 'Rohan', priority: 'notify', text: 'released your claim on app.py:1-2: that code changed in abcdef0123' })
    hubAppend<NoteMsg>(m.s.room, room, { type: 'note', to: 'Rohan', priority: 'notify', text: 'you switched to redesign; the room is for main; commits here are not the room\'s base until they are pushed to main' })
    hubAppend<ConflictMsg>(m.s.room, { name: 'room', kind: 'agent' }, { type: 'conflict', claimId: 'c1', otherClaimId: '', path: 'app.py', to: 'Rohan', priority: 'notify', text: "you edited app.py inside Kieran's claim" })
    await quiet()
    expect(m.texts).toEqual([])
    expect(m.hookLines()).toEqual([])
    const state = await m.tools.call('room_state', {})
    expect(state).toContain('main moved on')
    expect(state).toContain('released your claim on app.py:1-2')
    expect(state).toContain("you edited app.py inside Kieran's claim")
    await quiet()
    expect(m.texts).toEqual([])
  } finally { await m.close() }
})

it('company wakes for what arrives with it, never for the notices posted while alone', async () => {
  const m = await mcp()
  try {
    hubAppend<NoteMsg>(m.s.room, room, { type: 'note', to: 'Rohan', priority: 'notify', text: 'released your claim on app.py:1-2: that code changed in abcdef0123' })
    await quiet()
    expect(m.texts).toEqual([])
    m.arrive(kieran)
    await quiet()
    expect(m.texts).toEqual([])
    expect(m.hookLines()).toEqual([])
    hubAppend<QuestionMsg>(m.s.room, kieran, { type: 'question', to: 'Rohan', text: 'is app.py yours?' })
    await vi.waitFor(() => expect(m.texts).toHaveLength(1))
    expect(m.texts[0]).toContain('1 thing may need you: Kieran asked a question')
    expect(m.hookLines().join('\n')).toContain('is app.py yours?')
    expect(m.hookLines().join('\n')).not.toContain('released your claim')
  } finally { await m.close() }
})

it('own workers are company for their own notices only', async () => {
  const m = await mcp()
  try {
    mkdirSync(join(dir, '.git/room/registry'), { recursive: true })
    writeFileSync(join(dir, '.git/room/registry/migration.json'), JSON.stringify({ v: 1, sources: {}, done: true }))
    const registry = await registryForDir(dir)
    await seedRegistryWorker(dir, 'money', { name: 'Rohan+money', room: 'r', lead: { participant: 'Rohan', room: 'r', instance: registry.instance } })
    m.arrive({ name: 'Rohan+money', kind: 'agent' })
    hubAppend<NoteMsg>(m.s.room, room, { type: 'note', to: 'Rohan', priority: 'notify', text: 'released your claim on db.py:1-2: that code changed in abcdef0123' })
    await quiet()
    expect(m.texts).toEqual([])
    hubAppend<DoneMsg>(m.s.room, { name: 'Rohan+money', kind: 'agent' }, { type: 'done', tag: 'money', summary: 'fixed it', changed: ['app.py'], to: 'Rohan', priority: 'notify' })
    await vi.waitFor(() => expect(m.texts).toHaveLength(1))
    expect(m.texts[0]).toContain('Rohan+money finished')
    expect(m.texts[0]).not.toContain('sent a note')
  } finally { await m.close() }
})
