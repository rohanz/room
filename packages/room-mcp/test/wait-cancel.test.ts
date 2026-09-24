import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, type AnswerMsg, type Identity } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { waitConsumesMessage } from '../src/tools/messaging.js'

const asker: Identity = { name: 'Asker', kind: 'agent' }
const answerer: Identity = { name: 'Answerer', kind: 'agent' }
const roots: string[] = []

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('aborting room_wait removes its listeners and leaves a later answer unread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-wait-cancel-'))
  roots.push(dir)
  const room = new RoomDoc(new Y.Doc())
  room.colors.set(answerer.name, '#000')
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...asker, color: '#000' }, status: 'idle' })
  const session: Session = {
    room, awareness, me: asker, dir, roomUrl: 'ws://x/r', roomName: 'r', browserUrl: 'http://x',
    provider: { synced: true, awareness } as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: asker.name, roomDoc: room, provider: null as never, branch: 'main', base: 'base' },
  }
  const tools = createTools({ getSession: () => session, setSession: () => {}, cwd: dir })
  const question = room.post(asker, { type: 'question', to: answerer.name, text: 'Ready?' })
  const answerShape = { type: 'answer', from: answerer.name, to: asker.name, inReplyTo: question.id, id: 'later' } as AnswerMsg
  const unobserveBus = vi.spyOn(room.bus, 'unobserve')
  const unobserveClaims = vi.spyOn(room.claims, 'unobserve')
  const offDoc = vi.spyOn(room.doc, 'off')
  const clearTimer = vi.spyOn(globalThis, 'clearTimeout')
  const controller = new AbortController()
  try {
    const waiting = tools.call('room_wait', { questionId: question.id, timeoutMs: 500 }, controller.signal)
    await vi.waitFor(() => expect(waitConsumesMessage(session, answerShape)).toBe(true))
    const clearedBeforeAbort = clearTimer.mock.calls.length
    controller.abort()
    expect(waitConsumesMessage(session, answerShape)).toBe(false)
    await expect(waiting).resolves.toContain('cancelled')
    expect(unobserveBus).toHaveBeenCalledOnce()
    expect(unobserveClaims).toHaveBeenCalledOnce()
    expect(offDoc).toHaveBeenCalledWith('update', expect.any(Function))
    expect(clearTimer.mock.calls.length).toBeGreaterThan(clearedBeforeAbort)

    const answer = room.post<AnswerMsg>(answerer, { type: 'answer', to: asker.name, inReplyTo: question.id, text: 'Yes' })
    expect(room.seen(asker.name).has(answer.id)).toBe(false)
    expect(await tools.call('room_wait', { questionId: question.id })).toContain('Yes')
  } finally {
    controller.abort()
    await tools.shutdown()
    awareness.destroy()
    room.doc.destroy()
    unobserveBus.mockRestore(); unobserveClaims.mockRestore(); offDoc.mockRestore(); clearTimer.mockRestore()
  }
})
