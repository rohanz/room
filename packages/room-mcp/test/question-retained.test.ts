import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { RoomDoc, messageEndsWait, type Msg, type Outcome } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { createTools } from '../src/tools.js'
import { renderPrNote } from '../src/prs.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { memorySession } from './fixtures/session.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-retained-question-'))
  execFileSync('git', ['init', '-q', dir])
  const s = memorySession({ name: 'asker', kind: 'agent' }, dir)
  const room = s.room
  for (const name of ['asker', 'lead', 'third']) room.colors.set(name, 0)
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, log: () => {} })
  cleanups.push(async () => {
    await tools.shutdown(); await closeRegistryForDir(dir)
    s.awareness.destroy(); room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true })
  })
  return { room, tools }
}

it.each([undefined, 'expired', 'over-cap', 'recipient-retired', 'asker-retired', 'answered'] as const)(
  'uses the missing-question fallback only without an outcome (%s)', async outcome => {
    const { room, tools } = fixture()
    hubAppend(room, { name: 'third', kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: 'gone', text: 'unknown sender body' })
    if (outcome) room.outcomes.set('gone', { to: 'lead', from: 'asker', outcome, at: Date.now() })
    const result = await tools.call('room_wait', { questionId: 'gone', timeoutMs: 10 })
    if (outcome) expect(result).not.toContain('answered:')
    else expect(result).toContain('answered: [notify] third')
    expect(room.outcomes.get('gone')?.outcome).toBe(outcome)
  })

it('does not use the missing-question fallback for a reply to someone else', async () => {
  const { room, tools } = fixture()
  hubAppend(room, { name: 'lead', kind: 'agent' }, { type: 'answer', to: 'third', inReplyTo: 'gone', text: 'not mine' })
  expect(await tools.call('room_wait', { questionId: 'gone', timeoutMs: 10 })).toContain('timeout after')
})

it('requires exact recipients for questions and validated answers to end waits', () => {
  const question = { id: 'q', type: 'question', from: 'lead', fromKind: 'agent', to: 'asker', at: 1, text: '?' } as const
  expect(messageEndsWait(question, { me: 'asker' })).toBe(true)
  const answer = { ...question, id: 'a', type: 'answer', inReplyTo: 'q' } as const
  expect(messageEndsWait(answer, { me: 'asker', questionId: 'q', answerId: 'a' })).toBe(true)
  expect(messageEndsWait(answer, { me: 'third', questionId: 'q', answerId: 'a' })).toBe(false)
})

it.each(['answered', 'recipient-retired', 'asker-retired'] as const)('PR ledger respects a recorded %s outcome after reply removal', outcome => {
  const room = new RoomDoc()
  try {
    const q = hubAppend(room, { name: 'asker', kind: 'agent' }, { type: 'question', to: 'lead', text: '?' })
    room.outcomes.set(q.id, { to: 'lead', from: 'asker', outcome, at: Date.now() })
    const rendered = renderPrNote(room, { roomName: 'r' })
    expect(rendered.includes('(unanswered)')).toBe(outcome !== 'answered')
    expect(rendered.includes('(answered; answer text no longer retained)')).toBe(outcome === 'answered')
  } finally { room.doc.destroy() }
})

it.each([undefined, 'answered', 'asker-retired'] as const)('PR ledger validates both exact endpoints with outcome %s', outcome => {
  const room = new RoomDoc()
  try {
    const q = hubAppend(room, { name: 'asker', kind: 'agent' }, { type: 'question', to: 'lead', text: '?' })
    const a = hubAppend(room, { name: 'lead', kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: q.id, text: 'valid body' })
    hubAppend(room, { name: 'third', kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: q.id, text: 'wrong sender' })
    hubAppend(room, { name: 'lead', kind: 'agent' }, { type: 'answer', to: 'third', inReplyTo: q.id, text: 'wrong destination' })
    if (outcome) room.outcomes.set(q.id, { to: q.to!, from: q.from, outcome, at: a.at } satisfies Outcome)
    else room.outcomes.delete(q.id) // Saved pre-outcome state: validate against the retained question.
    const rendered = renderPrNote(room, { roomName: 'r' })
    expect(rendered.includes('answered: valid body')).toBe(outcome !== 'asker-retired')
    expect(rendered).not.toContain('wrong sender')
    expect(rendered).not.toContain('wrong destination')
  } finally { room.doc.destroy() }
})

it('PR ledger accepts a valid broadcast reply without creating a global outcome', () => {
  const room = new RoomDoc()
  try {
    room.bus.push([{ id: 'broadcast', type: 'question', from: 'asker', fromKind: 'agent', text: '?', at: Date.now() } as Msg])
    hubAppend(room, { name: 'third', kind: 'agent' }, { type: 'answer', to: 'asker', inReplyTo: 'broadcast', text: 'broadcast body' })
    expect(renderPrNote(room, { roomName: 'r' })).toContain('answered: broadcast body')
    expect(room.outcomes.has('broadcast')).toBe(false)
  } finally { room.doc.destroy() }
})
