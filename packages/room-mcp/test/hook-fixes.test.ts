// Wave-2 review fixes on the hook path (Fable F-M1, F-M2, F-M3), checked against the Claude Code hooks
// reference (2.1.283): additionalContext is capped at 10,000 characters, and `agent_id` is present only when
// the hook fires inside a subagent.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, type NoteMsg, type QuestionMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { sessionDirectory, type Session } from '../src/session.js'
import { createTools, type Tools } from '../src/tools.js'
import { startArbitration, type Arbitration } from '../src/arbitration.js'
import type { SessionBinding } from '../src/binding.js'
import { testPolicyStore } from './policy-fixture.js'
import { hubSeam } from './fixtures/hub.js'

const HOOKS = resolve(__dirname, '../../../plugins/room/hooks')
const SID = 'hook-fixes-session'
const me = { name: 'Rohan', kind: 'agent' as const }
const quinn = { name: 'Quinn', kind: 'agent' as const }
let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-hook-fixes-'))
  execFileSync('git', ['-C', dir, 'init', '-q'])
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  mkdirSync(join(dir, 'api'))
  writeFileSync(join(dir, 'api/tax.py'), 'x = 1\n')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  for (const key of ['ROOM_HOST', 'ROOM_WORKER_HOST', 'ROOM_WORKER_ID', 'CLAUDE_CODE_SESSION_ID', 'ROOM_WAKE', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']) vi.stubEnv(key, undefined)
  rmSync(join(dir, '.git/room'), { recursive: true, force: true })
})
afterEach(() => { vi.unstubAllEnvs() })

const sdir = () => sessionDirectory(join(dir, '.git'), SID)
const readSession = (name: string) => JSON.parse(readFileSync(join(sdir(), name), 'utf8'))
const writeSession = (name: string, value: object) => writeFileSync(join(sdir(), name), JSON.stringify(value))
function runHook(script: string, input: object): Promise<string> {
  return new Promise((res, rej) => {
    const p = execFile('node', [join(HOOKS, script)], { cwd: HOOKS }, (err, out) => err ? rej(err) : res(out))
    p.stdin!.end(JSON.stringify({ session_id: SID, cwd: dir, ...input }))
  })
}
const context = (out: string) => out ? JSON.parse(out).hookSpecificOutput.additionalContext as string : ''
const settle = () => new Promise(r => setTimeout(r, 250))

function addPresence(s: Session, name: string) {
  const peer = new Awareness(new Y.Doc())
  peer.setLocalState({ user: { name, kind: 'agent', color: '#111' }, status: 'idle', lastActive: Date.now() })
  applyAwarenessUpdate(s.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
  return peer
}

/** A bound session with a live Room MCP: tools, ledger and the hooks' arbitration endpoint. */
async function liveMcp() {
  const room = new RoomDoc()
  const awareness = new Awareness(room.doc)
  const s = { room, awareness, me, dir, roomUrl: 'ws://x/r', roomName: 'r', browserUrl: '', shareMax: 'full', shareRequested: 'full', ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true } as never, daemon: { touch() {}, async stop() {} } as never } as Session
  const binding: SessionBinding = { bound: () => ({ id: SID, host: 'claude' }), id: () => SID, dir: () => sdir(), commonDir: () => join(dir, '.git') }
  const tools: Tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, binding })
  tools.attachHooks(s)
  const arbitration: Arbitration = await startArbitration({ binding, ledger: tools.ledger, select: () => tools.hookSelect() })
  const peer = addPresence(s, 'Quinn')
  return { s, tools, async close() { peer.destroy(); await arbitration.close(); await tools.shutdown(); awareness.destroy() } }
}
const editTax = { tool_name: 'Edit', tool_input: { file_path: 'api/tax.py' } }
const editApp = { tool_name: 'Write', tool_input: { file_path: 'app.py' } }

describe('F-M1: a quiet minute does not silence the before-edit hook', () => {
  it('61 s with no doc update: the claim line still appears while the MCP is up', async () => {
    const mcp = await liveMcp()
    try {
      mcp.s.room.addClaim({ path: 'api/tax.py', from: 1, to: 1, by: 'Quinn', byKind: 'agent', intent: 'rework tax' })
      await settle()
      writeSession('state.json', { ...readSession('state.json'), at: Date.now() - 61_000 })
      expect(context(await runHook('before-edit.mjs', editTax))).toContain("Quinn's agent holds api/tax.py:1-1 — rework tax")
    } finally { await mcp.close() }
  })

  it('SessionStart after a quiet minute still names the company while the MCP is up', async () => {
    const mcp = await liveMcp()
    try {
      await settle()
      writeSession('state.json', { ...readSession('state.json'), at: Date.now() - 61_000 })
      expect(context(await runHook('session-start.mjs', { source: 'resume' }))).toContain("Quinn's agent is here")
    } finally { await mcp.close() }
  })

  it('with no MCP a stale state file stays silent (the age gate guards only the content-free fallback)', async () => {
    mkdirSync(sdir(), { recursive: true })
    writeSession('state.json', { at: Date.now() - 61_000, company: true, owedCount: 2, others: ['Quinn'], claims: [] })
    expect(await runHook('before-edit.mjs', editTax)).toBe('')
  })
})

describe('F-M2: hook output stays under the 10,000-character additionalContext cap', () => {
  it('40 owed messages of 500 characters and a long claim list: under the cap, and the rest stays owed', async () => {
    const mcp = await liveMcp()
    try {
      for (let i = 0; i < 40; i++) hubAppend<NoteMsg>(mcp.s.room, quinn, { type: 'note', to: me.name, text: `${String(i).padStart(2, '0')} ${'y'.repeat(496)}` })
      for (let i = 0; i < 40; i++) mcp.s.room.addClaim({ path: 'app.py', from: i + 1, to: i + 1, by: `Peer${i}`, byKind: 'agent', intent: `a long intent ${'z'.repeat(200)}` })
      await settle()
      const out = context(await runHook('before-edit.mjs', editApp))
      expect(out.length).toBeLessThanOrEqual(10_000)
      const shown = (out.match(/ y{496}/g) ?? []).length
      expect(shown).toBeGreaterThan(0)
      expect(out).toContain(`${40 - shown} more: call room_state`)
      expect(out).toContain("Peer0's agent holds app.py:1-1")
      expect(mcp.tools.ledger.candidates(mcp.s)).toHaveLength(40 - shown)
    } finally { await mcp.close() }
  })
})

describe('F-M3: a hook fired inside a subagent does not take the main session\'s inbox', () => {
  it('with agent_id: claims and the content-free pending line, no selection and no receipt', async () => {
    const mcp = await liveMcp()
    try {
      mcp.s.room.addClaim({ path: 'app.py', from: 1, to: 1, by: 'Quinn', byKind: 'agent', intent: 'rename x' })
      const m = hubAppend<QuestionMsg>(mcp.s.room, quinn, { type: 'question', to: me.name, text: 'touching app.py?' })
      await settle()
      const sub = { ...editApp, agent_id: 'agent-1', agent_type: 'Explore' }
      const inSubagent = context(await runHook('before-edit.mjs', sub))
      expect(inSubagent).not.toContain('touching app.py?')
      expect(inSubagent).toContain('1 message pending')
      expect(inSubagent).toContain("Quinn's agent holds app.py:1-1")
      expect(mcp.s.room.seen(me.name).has(m.id)).toBe(false)
      // The subagent being told about the claim does not count as the main conversation being told.
      const main = context(await runHook('before-edit.mjs', editApp))
      expect(main).toContain('touching app.py?')
      expect(main).toContain("Quinn's agent holds app.py:1-1")
      expect(mcp.s.room.seen(me.name).get(m.id)).toMatchObject({ via: 'hook' })
    } finally { await mcp.close() }
  })
})
