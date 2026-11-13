import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deliveryIndex, memorySnapshot, OUTCOMES_MAX, OUTCOMES_TTL_MS, owed, trim, type RetiredWorker } from '@room/shared'
import * as Y from 'yjs'
import { hubAppend } from '@room/shared/testing'
import { createTools } from '../src/tools.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { memorySession } from './fixtures/session.js'
import { seedRegistryWorker } from './registry-fixture.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture(worker: boolean, workersRoom = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-question-bookkeeping-'))
  execFileSync('git', ['init', '-q', dir])
  const primary = memorySession({ name: 'lead', kind: 'agent' }, dir)
  const s = workersRoom ? memorySession(primary.me, dir, undefined, 'workers') : primary
  const name = worker ? 'lead+w' : 'peer'
  s.room.colors.set(name, 0)
  if (worker) s.room.workerViews.set('w_old', { id: 'w_old', name, tag: 'w', lead: 'lead', mode: 'local', host: 'codex',
    task: '', branch: 'room/w', status: 'running', run: 1, startedAt: Date.now(), fence: 'test' })
  const tools = createTools({ getSession: () => primary, setSession: () => {}, cwd: dir, log: () => {} })
  if (workersRoom) tools.attachWorkersRoom(s)
  const retire = (disposition: 'collected' | 'discarded' = 'collected') => {
    const now = Date.now()
    const archive: RetiredWorker = { id: 'w_old', name, tag: 'w', lead: 'lead', host: 'codex', task: '', summary: 'done',
      files: [], fileCount: 0, startedAt: now, finishedAt: now, retiredAt: now, outcome: 'clean', disposition }
    s.room.retireWorker('w_old', archive, () => {})
  }
  const ask = () => hubAppend(s.room, { name, kind: 'agent' }, { type: 'question', to: 'lead', text: 'Which field?' })
  const candidates = () => tools.call('room_send', { type: 'answer', inReplyTo: 'does-not-exist', text: 'invalid' })
  cleanups.push(async () => {
    await tools.shutdown(); await closeRegistryForDir(dir)
    for (const session of new Set([s, primary])) { session.awareness.destroy(); session.room.doc.destroy() }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { s, name, tools, ask, retire, candidates }
}

it.each([[false, false], [true, false], [true, true]])('an explicit answer stays answered with and without to (worker=%s, workers room=%s)', async (worker, workersRoom) => {
  for (const addressed of [false, true]) {
    const f = fixture(worker, workersRoom), q = f.ask()
    expect(await f.tools.call('room_state', {})).toContain('QUESTION FOR YOU:')
    expect(f.s.room.seen('lead').has(q.id)).toBe(true)
    const sent = await f.tools.call('room_send', { type: 'answer', inReplyTo: q.id, ...(addressed ? { to: f.name } : {}), text: 'price_cents' })
    expect(sent).toContain('sent [')
    expect(sent).toContain('answers: price_cents')
    expect(await f.candidates()).not.toContain(`${q.id}:`)
    expect(await f.tools.call('room_wait', { questionId: q.id, timeoutMs: 5 })).toContain('was answered')
    const answer = f.s.room.messages().find(m => m.type === 'answer')!
    f.s.room.markSeen(f.name, [answer.id], { s: 'asker-session', via: 'reply' })
    if (worker) f.retire()
    trim(f.s.room, Date.now(), { busKeep: 0 })
    expect(await f.candidates()).not.toContain(`${q.id}:`)
  }
})

it.each([false, true])('a successful room_send answer ends a question outside the inbox budget (worker=%s)', async worker => {
  const f = fixture(worker)
  hubAppend(f.s.room, { name: f.name, kind: 'agent' }, { type: 'question', to: 'lead', text: 'earlier '.repeat(900) })
  const q = f.ask()
  const sent = await f.tools.call('room_send', { type: 'answer', to: f.name, inReplyTo: q.id, text: 'price_cents' })
  expect(sent).toContain('answers: price_cents')
  // The earlier oversized question uses the reply's inbox budget, leaving this one unreceipted.
  expect(f.s.room.seen('lead').has(q.id)).toBe(false)
  expect(deliveryIndex(f.s.room).pending.has(q.id)).toBe(false)
  const answer = f.s.room.messages().find(m => m.type === 'answer')!
  f.s.room.markSeen(f.name, [answer.id], { s: 'asker-session', via: 'reply' })
  if (worker) f.retire()
  trim(f.s.room, Date.now(), { busKeep: 0 })
  expect(f.s.room.message(answer.id)).toBeUndefined()
  expect(await f.candidates()).not.toContain(`${q.id}:`)
})

it.each(['collected', 'discarded'] as const)('ends questions asked by a %s worker, including unseen bus and mail copies', async disposition => {
  const f = fixture(true), q = f.ask(), mailed = f.ask()
  f.s.room.mail.set(mailed.id, mailed)
  f.s.room.bus.delete(f.s.room.messages().findIndex(m => m.id === mailed.id), 1)
  deliveryIndex(f.s.room)
  f.retire(disposition)
  expect(owed(f.s.room, { name: 'lead' }, { frontier: 0, routed: new Set() }, {})).toEqual([])
  expect(deliveryIndex(f.s.room).pending.has(q.id)).toBe(false)
  expect(deliveryIndex(f.s.room).pending.has(mailed.id)).toBe(false)
  expect(f.s.room.mail.has(mailed.id)).toBe(false)
  expect(f.tools.ledger.candidates(f.s)).toEqual([])
  expect(await f.tools.call('room_wait', { questionId: q.id, timeoutMs: 5 })).toContain('this question no longer accepts an answer')
  expect(await f.candidates()).not.toContain(`${q.id}:`)
  expect(await f.candidates()).not.toContain(`${mailed.id}:`)
  expect(await f.tools.call('room_state', {})).not.toContain('QUESTION FOR YOU:')
  expect(await f.tools.call('room_wait', { timeoutMs: 5 })).not.toContain('question for you')
})

it('pins terminal questions through snapshot reload and outcome count/age pruning, then releases the pins with their bodies', async () => {
  const f = fixture(true), answered = f.ask(), retired = f.ask()
  expect(await f.tools.call('room_send', { type: 'answer', inReplyTo: answered.id, text: 'price_cents' })).toContain('answers:')
  f.retire()
  const saved = memorySnapshot(f.s.room.doc)
  const reloaded = fixture(false)
  Y.applyUpdate(reloaded.s.room.doc, saved)
  const now = Date.now() + OUTCOMES_TTL_MS + 1
  for (let i = 0; i < OUTCOMES_MAX; i++) reloaded.s.room.outcomes.set(`noise-${i}`, { to: 'other', from: 'someone', outcome: 'expired', at: now })
  trim(reloaded.s.room, now)
  expect(reloaded.s.room.outcomes.get(answered.id)?.outcome).toBe('answered')
  expect(reloaded.s.room.outcomes.get(retired.id)?.outcome).toBe('asker-retired')
  expect(await reloaded.candidates()).not.toContain(`${answered.id}:`)
  expect(await reloaded.candidates()).not.toContain(`${retired.id}:`)
  expect(deliveryIndex(reloaded.s.room).verify()).toBeUndefined()
  trim(reloaded.s.room, now, { busKeep: 0 })
  trim(reloaded.s.room, now + OUTCOMES_TTL_MS + 1)
  expect(reloaded.s.room.outcomes.has(answered.id)).toBe(false)
  expect(reloaded.s.room.outcomes.has(retired.id)).toBe(false)
})

it('preserves ordinary notes and questions from a successor under a reused worker name', async () => {
  const f = fixture(true)
  const note = hubAppend(f.s.room, { name: f.name, kind: 'agent' }, { type: 'note', to: 'lead', text: 'useful completed findings' })
  f.retire()
  expect(deliveryIndex(f.s.room).pending.has(note.id)).toBe(true)
  f.s.room.workerViews.set('w_new', { id: 'w_new', name: f.name, tag: 'w', lead: 'lead', mode: 'local', host: 'codex', task: '',
    branch: 'room/w', status: 'running', run: 1, startedAt: Date.now(), fence: 'new' })
  const q = f.ask()
  f.retire()
  expect(f.s.room.outcomes.has(q.id)).toBe(false)
  expect(deliveryIndex(f.s.room).pending.has(q.id)).toBe(true)
  expect(await f.candidates()).toContain(`${q.id}:`)
})

it('does not forget an answer when the question is still owed as the answer is trimmed', async () => {
  const f = fixture(false), q = f.ask()
  // A peer can answer using a question ID learned outside its Room inbox (or after failed handoff).
  const answer = hubAppend(f.s.room, { name: 'lead', kind: 'agent' }, { type: 'answer', to: f.name, inReplyTo: q.id, text: 'price_cents' })
  // Simulate the saved state written by the previous build, before answer outcomes existed.
  f.s.room.outcomes.delete(q.id)
  f.s.room.markSeen(f.name, [answer.id], { s: 'asker-session', via: 'reply' })
  trim(f.s.room, Date.now(), { busKeep: 0 })
  expect(f.s.room.message(answer.id)).toBeUndefined()
  expect(await f.candidates()).not.toContain(`${q.id}:`)
  expect(await f.tools.call('room_state', {})).not.toContain('QUESTION FOR YOU:')
  expect(await f.tools.call('room_wait', { timeoutMs: 5 })).not.toContain('question for you')
})

it('records an answer to an aliased asker and ignores a reply addressed to someone else', async () => {
  const f = fixture(false)
  f.s.room.doc.getMap<string>('aliases').set('old-peer', f.name)
  const q = hubAppend(f.s.room, { name: 'old-peer', kind: 'agent' }, { type: 'question', to: 'lead', text: 'Which field?' })
  const wrong = await f.s.post(f.s.me, { type: 'answer', to: 'someone-else', inReplyTo: q.id, text: 'unrelated' })
  expect(wrong.ok).toBe(true)
  expect(f.s.room.outcomes.has(q.id)).toBe(false)
  const valid = hubAppend(f.s.room, { name: 'old-peer', kind: 'agent' }, { type: 'question', to: 'lead', text: 'Another field?' })
  expect(await f.tools.call('room_send', { type: 'answer', to: f.name, inReplyTo: valid.id, text: 'price_cents' })).toContain('answers: price_cents')
  expect(f.s.room.outcomes.get(valid.id)?.outcome).toBe('answered')
})

it('keeps a question open when the answer post is refused by the full recipient mailbox', async () => {
  const f = fixture(false), q = f.ask()
  for (let i = 0; i < 200; i++) hubAppend(f.s.room, f.s.me, { type: 'note', to: f.name, text: `pending ${i}` })
  const sent = await f.tools.call('room_send', { type: 'answer', to: f.name, inReplyTo: q.id, text: 'price_cents' })
  expect(sent).toContain('200 undelivered messages')
  expect(sent).not.toContain('sent [')
  expect(f.s.room.outcomes.has(q.id)).toBe(false)
  expect(await f.candidates()).toContain(`${q.id}:`)
})

it('heals old and late outgoing questions in the existing registry retirement pass', async () => {
  const f = fixture(true), q = f.ask()
  const { registry, record } = await seedRegistryWorker(f.s.dir, 'w', { id: 'w_old', room: f.s.roomName })
  const archive = await registry.archiveOf(record, { summary: 'done' })
  await registry.beginRetirement(record.id, archive)
  await registry.finishCleanup(record.id, record.room)
  f.s.room.workerViews.delete(record.id)
  f.s.room.doc.getArray('retiredWorkers').push([archive])
  await registry.pruneRetired(0)
  expect(await registry.read(record.id)).toBeUndefined()
  await registry.retireWorkerMail(f.s.room, 'lead', f.s.roomName)
  expect(f.s.room.outcomes.get(q.id)?.outcome).toBe('asker-retired')
  const late = f.ask()
  expect(deliveryIndex(f.s.room).pending.has(late.id)).toBe(true)
  await registry.retireWorkerMail(f.s.room, 'lead', f.s.roomName)
  expect(f.s.room.outcomes.get(late.id)?.outcome).toBe('asker-retired')
  expect(f.tools.ledger.candidates(f.s)).toEqual([])
})
