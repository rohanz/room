import { describe, expect, it } from 'vitest'
import { pidIsOurWorker } from '../src/workers.js'
import { RoomDoc, workerLine, type Worker } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'

describe('resumed worker process identity', () => {
  it('recognizes a Codex resume command by its retained host session id', () => {
    const startedAt = Date.now()
    const sessionId = '550e8400-e29b-41d4-a716-446655440000'
    const worker = { startedAt, tag: 'misc', dir: '/tmp/room/misc', hostSessionId: sessionId, name: 'rohanz+misc', lead: 'rohanz', host: 'codex', task: 'continue', branch: 'room/misc', pid: process.pid, status: 'running' } as Worker
    const alive = pidIsOurWorker(process.pid, worker,
      () => ({ start: startedAt, command: `codex exec resume ${sessionId} -c sandbox_mode=workspace-write --json Continue` }))
    expect(alive).toBe(true)
    expect(workerLine({ worker, processGone: !alive, changedCount: 0, now: startedAt })[0]).not.toContain('stopped while no session')
  })
})

describe('worker to worker answers', () => {
  it('returns B\'s answer to A on A\'s next room_wait', async () => {
    const room = new RoomDoc(new Y.Doc())
    const mk = (name: string): Session => {
      const me = { name, kind: 'agent' as const, owner: 'rohanz' }
      const awareness = new Awareness(room.doc)
      awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
      return { me, room, awareness, dir: process.cwd(), roomName: 'local/x/main', roomUrl: 'ws://127.0.0.1:1/local%2Fx%2Fmain', browserUrl: 'http://x', provider: { synced: true, awareness }, daemon: { touch() {}, async stop() {} }, shareMax: 'full', shareRequested: 'full' } as unknown as Session
    }
    const a = mk('rohanz+a'), b = mk('rohanz+b')
    const ta = createTools({ getSession: () => a, setSession: () => {}, cwd: process.cwd() })
    const tb = createTools({ getSession: () => b, setSession: () => {}, cwd: process.cwd() })
    try {
      room.setWorker({ tag: 'a', name: a.me.name, lead: 'rohanz', host: 'codex', task: 'ask', dir: a.dir, branch: 'room/a', pid: process.pid, startedAt: Date.now(), status: 'running' })
      room.setWorker({ tag: 'b', name: b.me.name, lead: 'rohanz', host: 'codex', task: 'answer', dir: b.dir, branch: 'room/b', pid: process.pid, startedAt: Date.now(), status: 'running' })
      const asked = await ta.call('room_send', { type: 'question', to: b.me.name, text: 'Which field?' }) as string
      const questionId = asked.match(/questionId=(m_\w+)/)?.[1]
      expect(questionId, asked).toBeTruthy()
      const answered = await tb.call('room_send', { type: 'answer', inReplyTo: questionId, text: 'price_cents' }) as string
      expect(answered).toContain('price_cents')
      expect(await ta.call('room_wait', { questionId, timeoutMs: 10 })).toContain('answered:')
    } finally { await ta.shutdown(); await tb.shutdown() }
  })
})
