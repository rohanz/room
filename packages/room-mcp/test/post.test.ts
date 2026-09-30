import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import { OWED_PER_RECIPIENT, RoomDoc, type NoteMsg, type QuestionMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { ensureLocalRelay } from '@room/relay'
import { HubClient, HubError, hubTransport, type HubTransport } from '../src/hub-client.js'
import { createPost, NOT_SENT } from '../src/post.js'
import { memoryTransport, testLease } from './fixtures/hub.js'

const ada = { name: 'ada', kind: 'agent' as const }
const cleanups: (() => unknown)[] = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

function seam(room = new RoomDoc()) {
  const transport = memoryTransport(room)
  const hub = new HubClient({ transport, client: 'test', sessionId: 's1' })
  cleanups.push(() => hub.close())
  return { room, transport, hub, post: createPost(room, hub, testLease(hub)) }
}

describe('Session.post through the hub (hub §11)', () => {
  it('knows the id before the hub answers; the hub appends it once with a seq', async () => {
    const { room, post } = seam()
    const posting = post<NoteMsg>(ada, { type: 'note', text: 'hello' })
    expect(posting.id).toMatch(/^m_/)
    expect(room.message(posting.id)).toBeUndefined()
    const result = await posting
    expect(result).toMatchObject({ ok: true, msg: { id: posting.id, from: 'ada', text: 'hello', seq: expect.any(Number) } })
    expect(room.messages().map(m => m.id)).toEqual([posting.id])
    const again = await post<NoteMsg>(ada, { type: 'note', text: 'retry' }, { id: posting.id })
    expect(again).toMatchObject({ ok: true, duplicate: true, seq: result.ok ? result.seq : -1, msg: { text: 'hello' } })
    expect(room.messages()).toHaveLength(1)
  })

  it('answers "not sent: hub unreachable" and appends nothing while the hub is down', async () => {
    const { room, transport, post } = seam()
    transport.down()
    const result = await post<NoteMsg>(ada, { type: 'note', text: 'lost?' })
    expect(result).toMatchObject({ ok: false, reason: 'unreachable', text: NOT_SENT })
    expect(room.messages()).toEqual([])
    transport.up()
    expect(await post<NoteMsg>(ada, { type: 'note', text: 'back' })).toMatchObject({ ok: true })
  })

  it('reports the held name instead of a hub outage when another session owns it', async () => {
    const { room, hub } = seam()
    await hub.hello()
    const paused = () => '[room] another session now holds ada; rejoin to take a new name. Coordination is paused; your files are unaffected.'
    const post = createPost(room, hub, () => undefined, paused)
    const result = await post<NoteMsg>(ada, { type: 'note', text: 'late' })
    expect(result).toMatchObject({ ok: false, reason: 'stale', text: expect.stringContaining('another session now holds ada') })
    expect(result.text).not.toContain('hub unreachable')
    expect(room.messages()).toEqual([])
  })

  it('refuses an addressed post over the recipient cap with the hub text; an automatic post is never refused', async () => {
    const { room, post } = seam()
    for (let i = 0; i < OWED_PER_RECIPIENT; i++) hubAppend<QuestionMsg>(room, { name: 'bob', kind: 'agent' }, { type: 'question', to: 'cy', text: `q${i}` })
    const refused = await post<NoteMsg>(ada, { type: 'note', to: 'cy', text: 'one more' })
    expect(refused).toMatchObject({ ok: false, reason: 'over-cap', text: expect.stringContaining('cy has 200 undelivered messages') })
    expect(await post<NoteMsg>(ada, { type: 'note', to: 'cy', text: 'conflict' }, { auto: true })).toMatchObject({ ok: true })
  })

  it('surfaces exhausted storage and rate-limit replies with the hub text', async () => {
    const { hub, post } = seam()
    expect(await post<NoteMsg>(ada, { type: 'note', text: 'prime' })).toMatchObject({ ok: true })
    const spy = vi.spyOn(hub, 'post')
    for (const reason of ['unavailable', 'rate-limited'] as const) {
      spy.mockRejectedValueOnce(new HubError(reason, `${reason}: retry later`))
      expect(await post<NoteMsg>(ada, { type: 'note', text: 'again' })).toMatchObject({ ok: false, reason, text: `${reason}: retry later` })
    }
  })

  it('a hub that never answers is reported as unreachable, not as sent', async () => {
    const silent: HubTransport = { connected: () => true, send() {}, onFrame: () => () => {}, onReconnect: () => () => {} }
    const room = new RoomDoc()
    const hub = new HubClient({ transport: silent, client: 'test', sessionId: 's1' })
    cleanups.push(() => hub.close())
    const result = await createPost(room, hub, testLease(hub))<NoteMsg>(ada, { type: 'note', text: 'x' })
    expect(result).toMatchObject({ ok: false, reason: 'unreachable', text: NOT_SENT })
  }, 20_000)

  it('posts over a real relay socket; a second replica sees the hub-sequenced message', async () => {
    const common = fs.mkdtempSync(path.join(os.tmpdir(), 'room-post-relay-'))
    cleanups.push(() => fs.rmSync(common, { recursive: true, force: true }))
    const relay = await ensureLocalRelay(common, 'local/post/main', { watchMs: 100 })
    cleanups.push(() => relay.stop())
    const open = () => {
      const doc = new Y.Doc()
      const provider = new WebsocketProvider(relay.url, encodeURIComponent('local/post/main'), doc, { WebSocketPolyfill: WebSocket as never, params: { schema: '2', key: relay.key } })
      cleanups.push(() => { provider.destroy(); doc.destroy() })
      return { room: new RoomDoc(doc), provider }
    }
    const a = open(), b = open()
    await Promise.all([a, b].map(x => new Promise<void>(r => x.provider.once('sync', () => r()))))
    const hub = new HubClient({ transport: hubTransport(a.provider), client: 'test', sessionId: 's1' })
    cleanups.push(() => hub.close())
    const result = await createPost(a.room, hub, testLease(hub))<NoteMsg>(ada, { type: 'note', text: 'over the wire' })
    expect(result).toMatchObject({ ok: true, seq: expect.any(Number) })
    await expect.poll(() => b.room.message(result.msg.id)).toMatchObject({ text: 'over the wire', seq: result.ok ? result.seq : -1 })
  }, 20_000)
})
