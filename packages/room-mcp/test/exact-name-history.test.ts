import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { recordAnswer } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { createTools } from '../src/tools.js'
import { knownNames } from '../src/tools/names.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { memorySession } from './fixtures/session.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-exact-names-'))
  execFileSync('git', ['init', '-q', dir])
  const s = memorySession({ name: 'lead', kind: 'agent' }, dir), room = s.room
  for (const name of ['asker', 'lead']) room.colors.set(name, 0)
  // A saved document can contain these roots, but they no longer define identities.
  room.doc.getMap('aliases').set('old-lead', 'lead')
  room.doc.getMap('aliases').set('old-asker', 'asker')
  room.doc.getMap('aliases').set('unseen-old', 'unseen-current')
  room.doc.getMap('unresolved').set(`${s.roomName}/main\0old`, { placeholder: '?old', claims: [{}] })
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, log: () => {} })
  cleanups.push(async () => {
    await tools.shutdown(); await closeRegistryForDir(dir)
    s.awareness.destroy(); room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true })
  })
  return { s, room, tools }
}

it('validates saved reply endpoints by exact name even with saved aliases', () => {
  const { room } = fixture()
  const q = hubAppend(room, { name: 'old-asker', kind: 'agent' }, { type: 'question', to: 'old-lead', text: '?' })
  const reply = { id: 'saved', type: 'answer' as const, from: 'lead', fromKind: 'agent' as const, to: 'asker', inReplyTo: q.id, text: 'saved', at: Date.now() }
  recordAnswer(room, reply)
  expect(room.outcomes.has(q.id)).toBe(false)
  recordAnswer(room, { ...reply, from: 'old-lead', to: 'old-asker' })
  expect(room.outcomes.get(q.id)?.outcome).toBe('answered')
})

it('does not offer a question addressed to an old name to the current participant', async () => {
  const { room, tools } = fixture()
  const q = hubAppend(room, { name: 'asker', kind: 'agent' }, { type: 'question', to: 'old-lead', text: '?' })
  expect(await tools.call('room_send', { type: 'answer', inReplyTo: q.id, text: 'reply' })).toContain('error: invalid inReplyTo')
  expect(room.outcomes.has(q.id)).toBe(false)
})

it('does not resolve an old recipient in the missing-question wait fallback', async () => {
  const { room, tools } = fixture()
  hubAppend(room, { name: 'asker', kind: 'agent' }, { type: 'answer', to: 'old-lead', inReplyTo: 'gone', text: 'old destination' })
  expect(await tools.call('room_wait', { questionId: 'gone', timeoutMs: 5 })).toContain('timeout after')
})

it('does not add identities or state lines from inert saved maps', async () => {
  const { s, tools } = fixture()
  const names = knownNames(s, () => [])
  expect(names.has('unseen-current')).toBe(false)
  expect(names.has('?old')).toBe(false)
  expect(await tools.call('room_state', {})).not.toContain('for an unresolved name')
})
