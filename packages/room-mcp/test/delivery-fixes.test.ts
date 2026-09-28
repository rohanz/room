// Wave-2 review fixes on the reply path: M5 (an error reply never receipts content it does not carry),
// M6 (the sharing disclosure is consumed only by a confirmed handoff) and F-M2 (a bounded inbox).
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import * as Y from 'yjs'
import { RoomDoc, type NoteMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { createTools, type Settle } from '../src/tools/index.js'
import { FlushedStdioTransport } from '../src/transport.js'
import { PolicyStore } from '../src/policy-store.js'
import { offerTeamSharingDisclosure } from '../src/tools/join.js'
import type { SessionBinding } from '../src/binding.js'
import type { Session } from '../src/session.js'
import { memorySession } from './fixtures/session.js'

const me = { name: 'Pat', kind: 'agent' as const }
const quinn = { name: 'Quinn', kind: 'agent' as const }
const ROOM = 'git/example/repo/main'
const dirs: string[] = []
beforeEach(() => { for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) vi.stubEnv(key, undefined) })
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d }

/** stdout whose write callback reports success a moment later. */
const pipe = () => new Writable({ highWaterMark: 1 << 20, write(_chunk, _enc, callback) { setTimeout(() => callback(null), 5) } })
const flush = () => new Promise(r => setTimeout(r, 20))

it('M5: a reply that fails after selecting its inbox is an error that receipts nothing; the message is shown again', async () => {
  const dir = tmp('room-m5-')
  const s = memorySession(me, dir)
  const m = hubAppend<NoteMsg>(s.room, quinn, { type: 'note', to: me.name, text: 'owed to Pat' })
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir })
  // The reviewer's probe: a reply-building step after the inbox selection throws.
  let fail = true
  const paused = s.hub.paused.bind(s.hub)
  s.hub.paused = () => { if (fail) throw new Error('probe disk full'); return paused() }
  let settle!: Settle
  const text = await tools.call('room_state', {}, undefined, x => { settle = x })
  expect(text).toBe('error: probe disk full')
  const transport = new FlushedStdioTransport(new PassThrough(), pipe())
  transport.expect(1, settle)
  await transport.send({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], isError: true } })
  expect(s.room.seen(me.name).has(m.id)).toBe(false)
  fail = false
  expect(await tools.call('room_state', {})).toContain('owed to Pat')
})

it('M5: the transport commits only a reply that carries the tool\'s text; a replaced reply receipts nothing', async () => {
  const dir = tmp('room-m5-')
  const s = memorySession(me, dir)
  const m = hubAppend<NoteMsg>(s.room, quinn, { type: 'note', to: me.name, text: 'owed to Pat' })
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir })
  let settle!: Settle
  const text = await tools.call('room_state', {}, undefined, x => { settle = x })
  expect(text).toContain('owed to Pat')
  const transport = new FlushedStdioTransport(new PassThrough(), pipe())
  transport.expect(1, settle)
  // A wrapper after the tool call failed, so the host gets an error in place of the selected content.
  await transport.send({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'error: wrapper failed' }], isError: true } })
  expect(s.room.seen(me.name).has(m.id)).toBe(false)
  expect(await tools.call('room_state', {})).toContain('owed to Pat')
})

async function teamSession(dir: string): Promise<Session> {
  const s = memorySession(me, dir, new RoomDoc(new Y.Doc()), ROOM)
  s.roomUrl = `ws://team/${encodeURIComponent(ROOM)}`
  s.policyStore = await PolicyStore.open({ dir, room: ROOM, participant: me.name, server: 'ws://team', requested: 'full' })
  return s
}
const reopen = (dir: string) => PolicyStore.open({ dir, room: ROOM, participant: me.name, server: 'ws://team', requested: 'full' })
const binding = (dir: string, id = 'host-session'): SessionBinding => ({ bound: () => ({ id, host: 'claude' }), id: () => id, dir: () => join(dir, '.git', 'room', 'sessions', id), commonDir: () => join(dir, '.git') })
function gitDir(prefix: string): string {
  const dir = tmp(prefix)
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  return dir
}

it('M6: an unconfirmed tool reply leaves the disclosure owed; reopening offers it again; a confirmed one marks it', async () => {
  const dir = gitDir('room-m6-')
  const a = await teamSession(dir)
  const first = createTools({ getSession: () => a, setSession: () => {}, cwd: dir })
  let settle!: Settle
  expect(await first.call('room_state', {}, undefined, x => { settle = x })).toContain('note for your human')
  expect(settle).toBeDefined()
  // The MCP dies before stdout confirms the reply.
  expect((await reopen(dir)).disclosed.version).toBe(0)
  const b = await teamSession(dir)
  const second = createTools({ getSession: () => b, setSession: () => {}, cwd: dir })
  expect(await second.call('room_state', {})).toContain('note for your human')
  await flush()
  expect((await reopen(dir)).disclosed).toEqual({ level: 'full', version: 1 })
  expect(await second.call('room_state', {})).not.toContain('note for your human')
  await first.shutdown(); await second.shutdown()
})

it('M6: an unconfirmed hook selection leaves the disclosure owed; reopening offers it again', async () => {
  const dir = gitDir('room-m6-')
  const a = await teamSession(dir)
  const first = createTools({ getSession: () => a, setSession: () => {}, cwd: dir })
  await offerTeamSharingDisclosure(a, first.ledger)
  const selected = first.hookSelect()
  expect(selected.notices.join('\n')).toContain('note for your human')
  // The hook printed nothing it could confirm: the batch is never committed.
  expect((await reopen(dir)).disclosed.version).toBe(0)
  const b = await teamSession(dir)
  const second = createTools({ getSession: () => b, setSession: () => {}, cwd: dir })
  expect(await second.call('room_state', {})).toContain('note for your human')
  await first.shutdown(); await second.shutdown()
})

it('M6: a notice receipt without the marker (a crash between them) is recovered, not shown again', async () => {
  const dir = gitDir('room-m6-')
  const a = await teamSession(dir)
  a.policyStore.markDisclosed = async () => { throw new Error('killed before the marker') }
  const first = createTools({ getSession: () => a, setSession: () => {}, cwd: dir, binding: binding(dir) })
  expect(await first.call('room_state', {})).toContain('note for your human')
  await flush()
  expect((await reopen(dir)).disclosed.version).toBe(0)
  const b = await teamSession(dir)
  const second = createTools({ getSession: () => b, setSession: () => {}, cwd: dir, binding: binding(dir) })
  expect(await second.call('room_state', {})).not.toContain('note for your human')
  await flush()
  expect((await reopen(dir)).disclosed).toEqual({ level: 'full', version: 1 })
  await first.shutdown(); await second.shutdown()
})

it('F-M2: 40 owed messages of 500 characters: the hook and the reply each take a bounded share, the rest stays owed', async () => {
  const dir = tmp('room-budget-')
  const s = memorySession(me, dir)
  for (let i = 0; i < 40; i++) hubAppend<NoteMsg>(s.room, quinn, { type: 'note', to: me.name, text: `${String(i).padStart(2, '0')} ${'x'.repeat(496)}` })
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir })
  const hook = tools.hookSelect()
  const size = hook.items.reduce((n, item) => n + item.line.length, 0) + hook.notices.reduce((n, line) => n + line.length, 0)
  expect(hook.items.length).toBeGreaterThan(0)
  expect(size).toBeLessThanOrEqual(6_000)
  expect(hook.more).toBe(40 - hook.items.length)
  tools.ledger.commit(hook.batch)
  expect(tools.ledger.candidates(s)).toHaveLength(40 - hook.items.length)

  const reply = await tools.call('room_state', {})
  const block = reply.slice(reply.indexOf('[inbox'), reply.indexOf('more: call room_state'))
  const shown = (block.match(/ x{496}/g) ?? []).length
  expect(shown).toBeGreaterThan(0)
  expect(block.length).toBeLessThan(6_100)
  expect(reply).toContain(`${40 - hook.items.length - shown} more: call room_state`)
  expect(tools.ledger.candidates(s)).toHaveLength(40 - hook.items.length - shown)
})
