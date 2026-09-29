import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { hasCompany } from '../src/company.js'
import { describeCompany } from '../src/company.js'
import { RoomDoc, type Identity, type NoteMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { sessionDirectory, type Session } from '../src/session.js'
import { createTools } from '../src/tools.js'
import { startArbitration } from '../src/arbitration.js'
import type { SessionBinding } from '../src/binding.js'
import { memorySession } from './fixtures/session.js'
import { visiblePeer } from './fixtures/visible.js'

it('counts a teammate with a different machine checkout id, while deduping the same physical checkout', () => {
  const own = new Y.Doc(), foreign = new Y.Doc(), remote = new Y.Doc()
  const awareness = new Awareness(own), peer = new Awareness(foreign), remotePeer = new Awareness(remote)
  const room = new RoomDoc(own)
  try {
    visiblePeer(room, 'Ada', 'agent', 'ada-session')
    visiblePeer(room, 'Bea', 'agent', 'bea-session')
    awareness.setLocalState({ user: { name: 'Ada', kind: 'agent' }, sessionId: 'ada-session', watchedDirectory: 'machine-a:path' })
    peer.setLocalState({ user: { name: 'Bea', kind: 'agent' }, sessionId: 'bea-session', watchedDirectory: 'machine-b:path' })
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [foreign.clientID]), 'test')
    const session = { room, awareness, me: { name: 'Ada', kind: 'agent' } } as Session
    expect(hasCompany(session)).toEqual({ company: true, others: ['Bea'] })
    peer.setLocalStateField('watchedDirectory', 'machine-a:path')
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [foreign.clientID]), 'test')
    expect(hasCompany(session)).toEqual({ company: false, others: [] })
    remotePeer.setLocalState({ user: { name: 'Bea', kind: 'agent' }, sessionId: 'bea-session', watchedDirectory: 'machine-b:path' })
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remotePeer, [remote.clientID]), 'test')
    expect(hasCompany(session)).toEqual({ company: true, others: ['Bea'] })
  } finally {
    awareness.destroy(); peer.destroy(); remotePeer.destroy(); own.destroy(); foreign.destroy(); remote.destroy()
  }
})

it('announces an untagged agent with its marker and a human by the bare name', () => {
  const own = new RoomDoc(), beaDoc = new Y.Doc(), cyDoc = new Y.Doc()
  const awareness = new Awareness(own.doc), bea = new Awareness(beaDoc), cy = new Awareness(cyDoc)
  try {
    visiblePeer(own, 'Ada', 'agent', 'ada-session')
    visiblePeer(own, 'Bea', 'agent', 'bea-session')
    visiblePeer(own, 'Cy', 'human', 'cy-session')
    awareness.setLocalState({ user: { name: 'Ada', kind: 'agent' }, sessionId: 'ada-session' })
    bea.setLocalState({ user: { name: 'Bea', kind: 'agent' }, sessionId: 'bea-session' })
    cy.setLocalState({ user: { name: 'Cy', kind: 'human' }, sessionId: 'cy-session' })
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(bea, [beaDoc.clientID]), 'test')
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(cy, [cyDoc.clientID]), 'test')
    own.setScope({ by: 'Bea', byKind: 'agent', area: 'api', summary: 'parser', paths: ['src/'] })
    const session = { awareness, me: { name: 'Ada', kind: 'agent' }, room: own } as Session
    expect(describeCompany(session, hasCompany(session))).toBe("[room] Bea's agent is here, on api: src/; Cy is here.")
  } finally {
    awareness.destroy(); bea.destroy(); cy.destroy(); own.doc.destroy(); beaDoc.destroy(); cyDoc.destroy()
  }
})

describe('two sessions in one worktree under two names (ledger test 12)', () => {
  const HOOKS = resolve(import.meta.dirname, '../../../plugins/room/hooks')
  const runHook = (input: object) => new Promise<string>((res, rej) => {
    const p = execFile('node', [join(HOOKS, 'before-edit.mjs')], { cwd: HOOKS }, (err, out) => err ? rej(err) : res(out))
    p.stdin!.end(JSON.stringify(input))
  })
  const context = (out: string) => out ? JSON.parse(out).hookSpecificOutput.additionalContext as string : ''
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'room-same-checkout-')); execFileSync('git', ['-C', dir, 'init', '-q']) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function mcp(id: string, me: Identity, room: RoomDoc) {
    const s = memorySession(me, dir, room)
    const binding: SessionBinding = { bound: () => ({ id, host: 'claude' }), id: () => id, dir: () => sessionDirectory(join(dir, '.git'), id), commonDir: () => join(dir, '.git') }
    const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, binding })
    tools.attachHooks(s)
    const arbitration = await startArbitration({ binding, ledger: tools.ledger, select: () => tools.hookSelect() })
    return { s, tools, close: async () => { await arbitration.close(); await tools.shutdown() } }
  }

  it('each session has its own directory, endpoint and ledger; receipts land on its own participant', async () => {
    const room = new RoomDoc(new Y.Doc())
    const ada = await mcp('session-a', { name: 'Ada', kind: 'agent' }, room)
    const bea = await mcp('session-b', { name: 'Bea', kind: 'agent' }, room)
    try {
      const cy = { name: 'Cy', kind: 'agent' as const }
      const toAda = hubAppend<NoteMsg>(room, cy, { type: 'note', to: 'Ada', text: 'for Ada' })
      const toBea = hubAppend<NoteMsg>(room, cy, { type: 'note', to: 'Bea', text: 'for Bea' })
      await new Promise(r => setTimeout(r, 250))
      const edit = (session_id: string) => runHook({ session_id, cwd: dir, tool_name: 'Read' })
      const a = context(await edit('session-a')), b = context(await edit('session-b'))
      expect(a).toContain('for Ada'); expect(a).not.toContain('for Bea')
      expect(b).toContain('for Bea'); expect(b).not.toContain('for Ada')
      expect(room.seen('Ada').get(toAda.id)).toMatchObject({ s: 'session-a', via: 'hook' })
      expect(room.seen('Bea').get(toBea.id)).toMatchObject({ s: 'session-b', via: 'hook' })
      expect(room.seen('Ada').has(toBea.id)).toBe(false)
      expect(sessionDirectory(join(dir, '.git'), 'session-a')).not.toBe(sessionDirectory(join(dir, '.git'), 'session-b'))
    } finally { await ada.close(); await bea.close() }
  })
})
