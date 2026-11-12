import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { deliveryIndex, OUTCOMES_MAX, RoomDoc, trim, type Msg, type RetiredWorker } from '@room/shared'
import { memorySession } from './fixtures/session.js'
import { createTools } from '../src/tools.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { watchLegacyIdentity } from '../src/session.js'

it('does not label an already answered question unanswered after retirement and body trimming', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-mail3-'))
  execFileSync('git', ['init', '-q', dir])
  const s = memorySession({ name: 'lead', kind: 'agent' }, dir)
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir })
  try {
    const now = Date.now()
    const question: Msg = { id: 'question', type: 'question', from: 'lead', fromKind: 'agent', to: 'lead+w', text: 'Ready?', at: now, priority: 'notify' }
    const answer: Msg = { id: 'answer', type: 'answer', from: 'lead+w', fromKind: 'agent', to: 'lead', inReplyTo: question.id, text: 'Yes', at: now, priority: 'notify' }
    s.room.bus.push([question, answer])
    expect(await tools.call('room_wait', { questionId: question.id, timeoutMs: 10 })).toContain('answered:')
    const archive: RetiredWorker & { id: string } = { id: 'w_old', name: 'lead+w', tag: 'w', lead: 'lead', host: 'codex', task: '', summary: 'Done', files: [], fileCount: 0, startedAt: now, finishedAt: now, retiredAt: now, outcome: 'clean' }
    s.room.retireWorker(archive.id, archive, () => {})
    // The answer wins while its body exists, even though retirement marks every addressed message.
    expect(await tools.call('room_wait', { questionId: question.id, timeoutMs: 10 })).toContain('answered:')
    trim(s.room, now, { busKeep: 0 })
    expect(s.room.message(question.id)).toBeUndefined()
    expect(s.room.message(answer.id)).toBeUndefined()
    expect(s.room.outcomes.get(question.id)?.outcome).toBe('recipient-retired')
    expect(await tools.call('room_wait', { questionId: question.id, timeoutMs: 10 })).not.toContain('will not answer')
  } finally {
    await tools.shutdown(); await closeRegistryForDir(dir)
    s.awareness.destroy(); s.room.doc.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
