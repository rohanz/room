import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { owed, OUTCOMES_MAX, RoomDoc, trim, type Msg, type RetiredWorker } from '@room/shared'
import { memorySession } from './fixtures/session.js'
import { createTools } from '../src/tools.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { startAutoTaggedRoomd } from '../src/session.js'
import { hubRoom } from './fixtures/hub-provider.js'

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
    // The answer wins while its body exists, and retirement preserves the question's answered outcome.
    expect(await tools.call('room_wait', { questionId: question.id, timeoutMs: 10 })).toContain('answered:')
    trim(s.room, now, { busKeep: 0 })
    expect(s.room.message(question.id)).toBeUndefined()
    expect(s.room.message(answer.id)).toBeUndefined()
    expect(s.room.outcomes.get(question.id)?.outcome).toBe('answered')
    expect(await tools.call('room_wait', { questionId: question.id, timeoutMs: 10 })).toContain('question was answered')
  } finally {
    await tools.shutdown(); await closeRegistryForDir(dir)
    s.awareness.destroy(); s.room.doc.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('a stale session with a 0.16 identity hint cannot re-owe retired mail after its marker is pruned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-identity-mail-'))
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'base'])
  const hub = hubRoom(), stale = new RoomDoc(new Y.Doc())
  const now = Date.now(), oldRoom = 'local/repo/main', placeholder = '?0123456789abcdef', name = 'lead+w'
  const message: Msg = { id: 'ended', type: 'answer', from: placeholder, fromKind: 'agent', to: name, inReplyTo: 'q', text: 'Done', at: now }
  hub.doc.mail.set(message.id, message)
  // The former reclaim watcher captured this private hint at startup.
  fs.writeFileSync(path.join(dir, '.git', 'room.json'), JSON.stringify({ legacy: { room: 'ws://test/' + encodeURIComponent(oldRoom), name: 'ben' } }))
  let joined: Awaited<ReturnType<typeof startAutoTaggedRoomd>> | undefined
  try {
    joined = await startAutoTaggedRoomd({ dir, room: 'ws://test/room', name: 'ben', owner: 'ben', requested: 'intent', sessionId: 'stale-session', replica: stale.doc,
      providerFactory: (_server, _room, doc) => hub.provider(doc), log: () => {} })
    expect(joined.lease.fence()).toBeTruthy()
    // Disconnect the session replica before retirement, keeping its pre-retirement mail copy.
    joined.daemon.provider.destroy()
    expect(stale.mail.has(message.id)).toBe(true)
    hub.doc.retireWorker('w_old', { id: 'w_old', name, tag: 'w', lead: 'lead', host: 'codex', task: '', summary: 'Done', files: [], fileCount: 0, startedAt: now, finishedAt: now, retiredAt: now, outcome: 'clean' }, () => {})
    expect(hub.doc.mail.has(message.id)).toBe(false)
    for (let n = 0; n < OUTCOMES_MAX; n++) hub.doc.outcomes.set('later-' + n, { from: 'lead', to: name, outcome: 'recipient-retired', at: now + 1 })
    trim(hub.doc, now + 2, { busKeep: 0 })
    expect(hub.doc.outcomes.has(message.id)).toBe(false)
    // Late unresolved facts used to rewrite mail on this stale replica before reconnecting.
    joined.daemon.roomDoc.doc.getMap('unresolved').set(oldRoom + '\0ben', { placeholder, claims: [] })
    Y.applyUpdate(hub.doc.doc, Y.encodeStateAsUpdate(stale.doc))
    expect(hub.doc.mail.has(message.id)).toBe(false)
    expect(owed(hub.doc, { name }, { frontier: 0, routed: new Set() }, {})).toEqual([])
    expect(joined.daemon.roomDoc.doc.getMap('aliases').has(placeholder)).toBe(false)
    expect(joined.daemon.roomDoc.doc.getMap('unresolved').has(oldRoom + '\0ben')).toBe(true)
  } finally {
    await joined?.daemon.stop()
    await closeRegistryForDir(dir)
    stale.doc.destroy(); hub.doc.doc.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
