import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, deliveryIndex, recordAnswer, trim, type Msg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { createTools } from '../src/tools.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { memorySession } from './fixtures/session.js'
import { renderPrNote } from '../src/prs.js'
import { ServerHubs } from '../../server/src/hub.js'
import { SETTLE_MS } from '@room/hub-core'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture(name = 'asker', room = new RoomDoc()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-rev4-'))
  execFileSync('git', ['init', '-q', dir])
  const s = memorySession({ name, kind: 'agent' }, dir, room)
  for (const peer of ['asker', 'lead', 'third', name]) room.colors.set(peer, 0)
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, log: () => {} })
  cleanups.push(async () => {
    await tools.shutdown(); await closeRegistryForDir(dir)
    s.awareness.destroy(); room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true })
  })
  const ask = (from = 'asker', to = 'lead') => hubAppend(room, { name: from, kind: 'agent' }, { type: 'question', to, text: 'Which field?' })
  return { s, tools, ask, room }
}

it('returns a retained pre-outcome answer after the old trimmer removed the receipted question', async () => {
  const { tools, ask, room } = fixture(), q = ask()
  room.markSeen('lead', [q.id], { s: 'lead-session', via: 'reply' })
  const a = hubAppend(room, { name: 'lead', kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: q.id, text: 'legacy retained body' })
  // The parent trimmer archives an answered, receipted question, retains its owed answer,
  // and has no answered outcome type. Recreate precisely those persisted roots.
  room.outcomes.delete(q.id)
  room.archive.set(q.id, ['question', q.from, q.at, []])
  room.mail.set(a.id, a)
  room.bus.delete(0, room.bus.length)
  expect(room.message(q.id)).toBeUndefined()
  const result = await tools.call('room_wait', { questionId: q.id, timeoutMs: 10 })
  expect(result).toContain('answered:')
  expect(result).toContain('legacy retained body')
})

it('allows the canonical recipient to answer a question addressed to its saved alias', async () => {
  const { tools, ask, room } = fixture('lead')
  room.doc.getMap<string>('aliases').set('old-lead', 'lead')
  const q = ask('asker', 'old-lead')
  const sent = await tools.call('room_send', { type: 'answer', inReplyTo: q.id, text: 'alias recipient body' })
  expect(sent).toContain('sent [')
  expect(room.outcomes.get(q.id)?.outcome).toBe('answered')
})

it('returns the valid saved answer text when its destination is an alias of the current asker', async () => {
  const { tools, ask, room } = fixture('asker')
  room.doc.getMap<string>('aliases').set('old-asker', 'asker')
  const q = ask('old-asker')
  hubAppend(room, { name: 'lead', kind: 'agent' }, { type: 'answer', to: 'old-asker', inReplyTo: q.id, text: 'alias asker body' })
  expect(room.outcomes.get(q.id)?.outcome).toBe('answered')
  expect(await tools.call('room_wait', { questionId: q.id, timeoutMs: 10 })).toContain('alias asker body')
})

it.each(['sender', 'destination', 'reference'] as const)('does not close a blocked wait for an invalid %s; a later valid answer returns text', async mismatch => {
  const { s, tools, ask, room } = fixture(), q = ask()
  let finished = false
  const pending = tools.call('room_wait', { questionId: q.id, timeoutMs: 1000 }).then(x => { finished = true; return x })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect((await s.post({ name: mismatch === 'sender' ? 'third' : 'lead', kind: 'agent' }, {
    type: 'answer', to: mismatch === 'destination' ? 'third' : 'asker',
    inReplyTo: mismatch === 'reference' ? 'other-question' : q.id, text: 'invalid body',
  })).ok).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(finished).toBe(false)
  expect(room.outcomes.has(q.id)).toBe(false)
  expect(deliveryIndex(room).pending.has(q.id)).toBe(true)
  expect((await s.post({ name: 'lead', kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: q.id, text: 'valid body' })).ok).toBe(true)
  expect(await pending).toContain('answers: valid body')
  expect(deliveryIndex(room).pending.has(q.id)).toBe(false)
})

it('both asker sessions return an answer even after one receipts it', async () => {
  const first = fixture(), q = first.ask()
  const second = fixture('asker', first.room)
  const pending = second.tools.call('room_wait', { questionId: q.id, timeoutMs: 1000 })
  await new Promise(resolve => setTimeout(resolve, 20))
  await first.s.post({ name: 'lead', kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: q.id, text: 'two sessions body' })
  expect(await first.tools.call('room_wait', { questionId: q.id, timeoutMs: 10 })).toContain('two sessions body')
  expect(await pending).toContain('two sessions body')
})

it('a replicated atomic hub update returns the answer body to the blocked client', async () => {
  const client = fixture(), q = client.ask()
  const hub = fixture('lead')
  Y.applyUpdate(hub.room.doc, Y.encodeStateAsUpdate(client.room.doc))
  const pending = client.tools.call('room_wait', { questionId: q.id, timeoutMs: 1000 })
  await new Promise(resolve => setTimeout(resolve, 20))
  await hub.s.post({ name: 'lead', kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: q.id, text: 'replicated hub body' })
  Y.applyUpdate(client.room.doc, Y.encodeStateAsUpdate(hub.room.doc))
  expect(await pending).toContain('answers: replicated hub body')
})

it('two disconnected healing readers converge and repeated reads add no Yjs structs', async () => {
  const first = fixture('lead')
  for (let i = 0; i < 100; i++) {
    const q = first.ask()
    hubAppend(first.room, { name: 'lead', kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: q.id, text: `answer ${i}` })
    first.room.outcomes.delete(q.id)
  }
  const second = fixture('lead')
  Y.applyUpdate(second.room.doc, Y.encodeStateAsUpdate(first.room.doc))
  const candidates = (f: ReturnType<typeof fixture>) => f.tools.call('room_send', { type: 'answer', inReplyTo: 'typo', text: 'probe' })
  await Promise.all([candidates(first), candidates(second)])
  expect(first.room.outcomes.size).toBe(100)
  expect(second.room.outcomes.size).toBe(100)
  Y.applyUpdate(first.room.doc, Y.encodeStateAsUpdate(second.room.doc))
  Y.applyUpdate(second.room.doc, Y.encodeStateAsUpdate(first.room.doc))
  const before = [first, second].map(f => Buffer.from(Y.encodeStateAsUpdate(f.room.doc)))
  for (let i = 0; i < 10; i++) await Promise.all([candidates(first), candidates(second)])
  for (const [i, f] of [first, second].entries()) expect(Buffer.from(Y.encodeStateAsUpdate(f.room.doc))).toEqual(before[i])
  expect([...first.room.outcomes]).toEqual([...second.room.outcomes])
})

it('accepts alias respondent identity at the shared relation and keeps note replies from closing questions', () => {
  const { ask, room } = fixture()
  room.doc.getMap<string>('aliases').set('old-lead', 'lead')
  const q = ask('asker', 'old-lead')
  const note = hubAppend(room, { name: 'lead', kind: 'agent' }, { type: 'note', to: 'asker', inReplyTo: q.id, text: 'not an answer' })
  room.markSeen('old-lead', [q.id], { s: 's', via: 'reply' })
  trim(room, Date.now(), { busKeep: 0 })
  expect(room.message(q.id)).toBeDefined()
  expect(room.outcomes.has(q.id)).toBe(false)
  const answer = { ...note, id: 'valid-answer', type: 'answer' } as Msg
  recordAnswer(room, answer)
  expect(room.outcomes.get(q.id)?.outcome).toBe('answered')
})

it('does not label an invalid third-party reply as an answer in the PR ledger', () => {
  const { ask, room } = fixture(), q = ask()
  hubAppend(room, { name: 'third', kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: q.id, text: 'unrelated third-party reply' })
  expect(room.outcomes.has(q.id)).toBe(false)
  expect(renderPrNote(room, { roomName: 'r' })).toContain('(unanswered)')
})

it('separately addressed questions close only for the named respondent who answered', () => {
  const { ask, room } = fixture(), first = ask('asker', 'lead'), second = ask('asker', 'third')
  hubAppend(room, { name: 'lead', kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: first.id, text: 'first recipient' })
  expect(room.outcomes.get(first.id)?.outcome).toBe('answered')
  expect(room.outcomes.has(second.id)).toBe(false)
  expect(deliveryIndex(room).pending.has(second.id)).toBe(true)
})

it('the hosted ServerHubs path replicates a valid answer to a blocked asker', async () => {
  const client = fixture(), q = client.ask(), serverDoc = new Y.Doc()
  Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(client.room.doc))
  let mono = 0
  const hubs = new ServerHubs({ store: { advance: async floor => floor + 1 }, log: () => {}, full: () => false, mono: () => mono })
  hubs.ensure('r', serverDoc)
  for (let i = 0; !hubs.current('r') && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1))
  const hub = hubs.current('r')!
  expect(hub).toBeDefined()
  try {
    mono += SETTLE_MS + 1
    hub.tick()
    const conn = {}, principal = { login: 'lead', id: 'test:lead', readOnly: false }
    expect(hub.handle(conn, { v: 1, id: 'hello', op: 'hello', proto: 1, schema: 2, client: 'review', sessionId: 'session' }, principal).ok).toBe(true)
    const acquired = hub.handle(conn, { v: 1, id: 'acquire', op: 'acquire', name: 'lead', holder: { sessionId: 'session', pid: process.pid, startTime: '', executable: '' } }, principal)
    expect(acquired.ok).toBe(true)
    const waiting = client.tools.call('room_wait', { questionId: q.id, timeoutMs: 1000 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(hub.handle(conn, { v: 1, id: 'post', op: 'post', lease: { name: 'lead', epoch: (acquired as { epoch: number }).epoch },
      msg: { id: 'hosted-answer', from: 'lead', fromKind: 'agent', type: 'answer', to: 'asker', inReplyTo: q.id, text: 'hosted body' } }, principal).ok).toBe(true)
    Y.applyUpdate(client.room.doc, Y.encodeStateAsUpdate(serverDoc))
    expect(await waiting).toContain('answers: hosted body')
  } finally { hub.stop(); hubs.stop('r'); serverDoc.destroy() }
})
