import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, type AnswerMsg, type Identity, type NoteMsg, type QuestionMsg } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { testPolicyStore } from './policy-fixture.js'
import { waitConsumesMessage } from '../src/tools/messaging.js'
import { hubAppend } from '@room/shared/testing'
import { hubSeam } from './fixtures/hub.js'
import { memorySession } from './fixtures/session.js'

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
    policyStore: testPolicyStore(),
    room, awareness, me: asker, dir, roomUrl: 'ws://x/r', roomName: 'r', browserUrl: 'http://x',
    ...hubSeam(room), provider: { synced: true, awareness } as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: asker.name, roomDoc: room, provider: null as never, branch: 'main', base: 'base' },
  }
  const tools = createTools({ getSession: () => session, setSession: () => {}, cwd: dir })
  const question = hubAppend(room, asker, { type: 'question', to: answerer.name, text: 'Ready?' })
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

    const answer = hubAppend<AnswerMsg>(room, answerer, { type: 'answer', to: asker.name, inReplyTo: question.id, text: 'Yes' })
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

describe('one response, one owner (ledger test 7)', () => {
  const lead = { name: 'Lead', kind: 'agent' as const }
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'room-wait-batch-'))
    roots.push(dir)
    const s = memorySession(lead, dir)
    s.room.colors.set(answerer.name, 0)
    return { s, tools: createTools({ getSession: () => s, setSession: () => {}, cwd: dir }) }
  }
  const count = (text: string, needle: string) => text.split(needle).length - 1
  /** The reply's inbox prefix; room_state's own feed lists history too. */
  const inbox = (text: string) => /\[inbox \d+\]\n((?: {2}.*\n)*)/.exec(text)?.[1] ?? ''

  it('room_wait and the inbox prefix of the same reply show M once, with one receipt', async () => {
    const { s, tools } = setup()
    const m = hubAppend<QuestionMsg>(s.room, answerer, { type: 'question', to: lead.name, text: 'shown once?' })
    hubAppend<NoteMsg>(s.room, answerer, { type: 'note', to: lead.name, text: 'the other one' })
    const text = await tools.call('room_wait', { timeoutMs: 10 })
    expect(count(text, 'shown once?')).toBe(1)
    expect(count(inbox(text), 'the other one')).toBe(1)
    expect(s.room.seen(lead.name).get(m.id)).toMatchObject({ via: 'wait' })
    expect(inbox(await tools.call('room_state', {}))).toBe('')
  })

  it('two concurrent calls: M goes to exactly one of them', async () => {
    const { s, tools } = setup()
    hubAppend<NoteMsg>(s.room, answerer, { type: 'note', to: lead.name, text: 'only once' })
    const replies = await Promise.all([tools.call('room_state', {}), tools.call('room_state', {})])
    expect(replies.filter(r => inbox(r).includes('only once'))).toHaveLength(1)
  })

  it('a cancelled wait writes no receipt, and M is delivered later', async () => {
    const { s, tools } = setup()
    const controller = new AbortController()
    const waiting = tools.call('room_wait', { timeoutMs: 5_000 }, controller.signal)
    await new Promise(r => setTimeout(r, 20))
    const m = hubAppend<QuestionMsg>(s.room, answerer, { type: 'question', to: lead.name, text: 'arrived while waiting' })
    controller.abort()
    await waiting
    expect(s.room.seen(lead.name).has(m.id)).toBe(false)
    expect(inbox(await tools.call('room_state', {}))).toContain('arrived while waiting')
    expect(s.room.seen(lead.name).get(m.id)).toMatchObject({ via: 'reply' })
  })
})
