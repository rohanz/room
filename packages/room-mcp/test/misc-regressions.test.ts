import { describe, expect, it } from 'vitest'
import { pidIsOurWorker } from '../src/worker-process.js'
import { RoomDoc, messageForMe, workerLine, type WorkerView } from '@room/shared'
import type { LocalWorker } from '../src/worker-status.js'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { hubAppend } from '@room/shared/testing'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

describe('resumed worker process identity', () => {
  it('recognizes a Codex process by its OS start identity after resume', () => {
    const startedAt = Date.now()
    const sessionId = '550e8400-e29b-41d4-a716-446655440000'
    const worker = { startedAt, processStartTime: 'test:resume:1', tag: 'misc', dir: '/tmp/room/misc', hostSessionId: sessionId, name: 'rohanz+misc', lead: 'rohanz', host: 'codex', task: 'continue', branch: 'room/misc', pid: process.pid, status: 'running' } as LocalWorker
    const alive = pidIsOurWorker(process.pid, worker,
      () => ({ startTime: worker.processStartTime, executable: 'codex' }))
    expect(alive).toBe(true)
    const view: WorkerView = { id: 'w_misc', tag: worker.tag, name: worker.name, lead: worker.lead, mode: 'local', host: 'codex',
      task: worker.task, branch: worker.branch, status: 'running', run: 1, startedAt, fence: 'test' }
    expect(workerLine({ worker: view, processGone: !alive, changedCount: 0, now: startedAt })[0]).not.toContain('stopped while no session')
  })
})

describe('worker to worker answers', () => {
  it('returns B\'s answer to A on A\'s next room_wait', async () => {
    const room = new RoomDoc(new Y.Doc())
    const mk = (name: string): Session => {
      const me = { name, kind: 'agent' as const, owner: 'rohanz' }
      const awareness = new Awareness(room.doc)
      awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
      return { me, room, awareness, dir: process.cwd(), roomName: 'local/x/main', roomUrl: 'ws://127.0.0.1:1/local%2Fx%2Fmain', browserUrl: 'http://x', ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true, awareness }, daemon: { touch() {}, async stop() {} }, shareMax: 'full', shareRequested: 'full' } as unknown as Session
    }
    const a = mk('rohanz+a'), b = mk('rohanz+b')
    const ta = createTools({ getSession: () => a, setSession: () => {}, cwd: process.cwd() })
    const tb = createTools({ getSession: () => b, setSession: () => {}, cwd: process.cwd() })
    try {
      // Both participants are the lead's workers as the room shows them (views are display facts; no registry here).
      const view = (tag: string, name: string, task: string): WorkerView => ({ id: `w_${tag}`, tag, name, lead: 'rohanz', mode: 'local',
        host: 'codex', task, branch: `room/${tag}`, status: 'running', run: 1, startedAt: Date.now(), fence: 'test' })
      room.workerViews.set('w_a', view('a', a.me.name, 'ask'))
      room.workerViews.set('w_b', view('b', b.me.name, 'answer'))
      const asked = await ta.call('room_send', { type: 'question', to: b.me.name, text: 'Which field?' }) as string
      const questionId = asked.match(/questionId=(m_\w+)/)?.[1]
      expect(questionId, asked).toBeTruthy()
      const answered = await tb.call('room_send', { type: 'answer', inReplyTo: questionId, text: 'price_cents' }) as string
      expect(answered).toContain('price_cents')
      expect(await ta.call('room_wait', { questionId, timeoutMs: 10 })).toContain('answered:')
    } finally { await ta.shutdown(); await tb.shutdown() }
  })
})

describe('replies to addressed notes', () => {
  it('delivers a threaded note to its author without answering an open question', async () => {
    const room = new RoomDoc(new Y.Doc())
    const mk = (name: string): Session => {
      const me = { name, kind: 'agent' as const, owner: 'rohanz' }
      const awareness = new Awareness(room.doc)
      awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
      return { me, room, awareness, dir: process.cwd(), roomName: 'local/x/main', roomUrl: 'ws://127.0.0.1:1/local%2Fx%2Fmain', browserUrl: 'http://x', ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true, awareness }, daemon: { touch() {}, async stop() {} }, shareMax: 'full', shareRequested: 'full' } as unknown as Session
    }
    const a = mk('rohanz+a'), b = mk('rohanz+b')
    const ta = createTools({ getSession: () => a, setSession: () => {}, cwd: process.cwd() })
    const tb = createTools({ getSession: () => b, setSession: () => {}, cwd: process.cwd() })
    try {
      const note = hubAppend(room, a.me, { type: 'note', to: b.me.name, text: 'Please inspect this.' })
      const question = hubAppend(room, a.me, { type: 'question', to: b.me.name, text: 'Ready?' })
      const sent = await tb.call('room_send', { type: 'answer', inReplyTo: note.id, text: 'I saw it.' }) as string
      expect(sent).toContain('I saw it.')
      const reply = room.messages().find(m => m.type === 'note' && m.inReplyTo === note.id)
      expect(reply).toMatchObject({ type: 'note', to: a.me.name, from: b.me.name, inReplyTo: note.id })
      expect(reply && messageForMe(a.me, reply)).toBe(true)
      expect(room.messages().some(m => m.type === 'answer' && m.inReplyTo === question.id)).toBe(false)
      expect(await tb.call('room_send', { type: 'answer', inReplyTo: question.id, text: 'Yes' })).toContain('Yes')
      expect(await ta.call('room_wait', { questionId: question.id, timeoutMs: 10 })).toContain('answered:')
    } finally { await ta.shutdown(); await tb.shutdown() }
  })
})
