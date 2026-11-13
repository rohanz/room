import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { trim, type Msg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { createTools } from '../src/tools.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { memorySession } from './fixtures/session.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture(name = 'asker') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-answer-endpoints-'))
  execFileSync('git', ['init', '-q', dir])
  const s = memorySession({ name, kind: 'agent' }, dir)
  for (const peer of ['asker', 'lead', 'third']) s.room.colors.set(peer, 0)
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, log: () => {} })
  cleanups.push(async () => {
    await tools.shutdown(); await closeRegistryForDir(dir)
    s.awareness.destroy(); s.room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true })
  })
  const ask = () => hubAppend(s.room, { name: 'asker', kind: 'agent' }, { type: 'question', to: 'lead', text: 'Which field?' })
  return { s, tools, ask }
}

it('wait returns the validated body after a mismatched reply and after the question mail body is gone', async () => {
  const { s, tools, ask } = fixture(), q = ask()
  s.room.markSeen('lead', [q.id], { s: 'lead-session', via: 'reply' })
  trim(s.room, Date.now(), { busKeep: 0 })
  expect(s.room.mail.has(q.id)).toBe(true)
  expect(await s.post({ name: 'third', kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: q.id, text: 'wrong body' })).toMatchObject({ ok: true })
  expect(await s.post({ name: 'lead', kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: q.id, text: 'validated body' })).toMatchObject({ ok: true })
  expect(s.room.message(q.id)).toBeUndefined()
  const waited = await tools.call('room_wait', { questionId: q.id, timeoutMs: 10 })
  expect(waited).toContain('answered: [notify] lead')
  expect(waited).toContain('validated body')
  expect(waited).not.toContain('answered: [notify] third')
})

it('heals a valid saved answer before candidate selection without waiting for trim', async () => {
  const { s, tools, ask } = fixture('lead'), q = ask()
  const answer = hubAppend(s.room, s.me, { type: 'answer', to: 'asker', inReplyTo: q.id, text: 'saved answer' })
  s.room.outcomes.delete(q.id)
  const candidates = await tools.call('room_send', { type: 'answer', inReplyTo: 'typo', text: 'invalid' })
  expect(candidates).not.toContain(`${q.id}:`)
  expect(s.room.outcomes.get(q.id)?.outcome).toBe('answered')
  expect(s.room.message(answer.id)).toBeDefined()
})

it('accepts any respondent to a broadcast wait without globally closing the question', async () => {
  const { s, tools } = fixture()
  const q = { id: 'broadcast', type: 'question', from: 'asker', fromKind: 'agent', text: 'Anyone?', at: Date.now(), seq: 1 } as Msg
  s.room.bus.push([q])
  for (const respondent of ['lead', 'third']) {
    const answer = hubAppend(s.room, { name: respondent, kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: q.id, text: `${respondent} answer` })
    expect(await tools.call('room_wait', { questionId: q.id, timeoutMs: 10 })).toContain('answered:')
    expect(s.room.outcomes.has(q.id)).toBe(false)
    // Leave only the next respondent's body for the next wait; each is independently eligible.
    s.room.bus.delete(s.room.messages().findIndex(m => m.id === answer.id), 1)
  }
})

it('a valid legacy reply arriving in another room ends a blocked wait with its body', async () => {
  const { s, tools, ask } = fixture(), q = ask()
  const workers = memorySession(s.me, s.dir, undefined, 'workers')
  workers.room.colors.set('lead', 0)
  tools.attachWorkersRoom(workers)
  cleanups.unshift(async () => { workers.awareness.destroy(); workers.room.doc.destroy() })
  const waiting = tools.call('room_wait', { questionId: q.id, timeoutMs: 1000 })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(await workers.post({ name: 'lead', kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: q.id, text: 'cross-room validated body' })).toMatchObject({ ok: true })
  expect(await waiting).toContain('answered: [notify] lead')
  expect(s.room.outcomes.get(q.id)?.outcome).toBe('answered')
})
