import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { DOC_SIZE_CAP_CODE, sizeCapReason } from '@room/hub-core'
import { startRelay, type RelayOptions } from '../src/index.js'
import { authorizedWebSocket } from '../../roomd/src/ws-auth.js'

const key = 'cap-key', room = 'local/cap', cap = 1048576
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A relay with a 1 MiB cap that re-measures on every write, so no test needs a 200-write or 8 MB run-up. */
async function cappedRelay(opts: RelayOptions = {}) {
  const relay = await startRelay(0, { key, docCap: { maxBytes: cap, meter: { maxWrites: 1 } }, ...opts })
  const providers: WebsocketProvider[] = []
  const connect = () => {
    const p = new WebsocketProvider(`ws://127.0.0.1:${relay.port}`, encodeURIComponent(room), new Y.Doc(), { WebSocketPolyfill: authorizedWebSocket({ key }) as never, params: { schema: '2' }, disableBc: true })
    providers.push(p)
    const closes: { code?: number; reason?: string }[] = []
    p.on('connection-close', (e: { code?: number; reason?: string } | null) => { if (e) closes.push({ code: e.code, reason: e.reason }) })
    return { p, doc: p.doc, closes }
  }
  const close = async () => { for (const p of providers) { p.destroy(); p.doc.destroy() } await relay.close() }
  return { connect, close }
}

it('refuses writes into a local room over the size cap as the server does, and the room stays readable', async () => {
  const logs: string[] = []
  const relay = await cappedRelay({ log: line => logs.push(line) })
  try {
    const writer = relay.connect(), reader = relay.connect()
    await expect.poll(() => writer.p.synced && reader.p.synced).toBe(true)
    // One write may cross the cap: the room was under it when the write arrived (as a whole-document sync can be).
    const big = 'x'.repeat(cap + 1024)
    writer.doc.getMap('meta').set('big', big)
    await expect.poll(() => reader.doc.getMap('meta').get('big')).toBe(big)
    // The next write is refused: the writer is closed with the server's code and reason, and nobody sees it.
    writer.doc.getMap('meta').set('refused', 1)
    await expect.poll(() => writer.closes[0]).toEqual({ code: DOC_SIZE_CAP_CODE, reason: sizeCapReason(cap) })
    writer.p.disconnect()
    await wait(200)
    expect(reader.doc.getMap('meta').has('refused')).toBe(false)
    expect(reader.closes).toEqual([]) // reads keep flowing
    expect(logs.join('\n')).toContain(`local room ${room}: refusing writes`)
    // The relay keeps serving: a newcomer loads the whole room, without the refused write.
    const late = relay.connect()
    await expect.poll(() => late.doc.getMap('meta').get('big')).toBe(big)
    expect(late.doc.getMap('meta').has('refused')).toBe(false)
  } finally { await relay.close() }
})

it('a local room exactly at the cap still takes writes, including the deletion that shrinks it', async () => {
  const relay = await cappedRelay()
  try {
    const a = relay.connect(), b = relay.connect()
    await expect.poll(() => a.p.synced && b.p.synced).toBe(true)
    a.doc.getMap('meta').set('a', 'x'.repeat(cap / 2))
    await expect.poll(() => b.doc.getMap('meta').has('a')).toBe(true)
    // Find the pad that takes this exact state to the cap: a scratch copy with the same client id writes it.
    let pad = 0
    for (let i = 0; i < 5; i++) {
      const scratch = new Y.Doc()
      Y.applyUpdate(scratch, Y.encodeStateAsUpdate(a.doc))
      scratch.clientID = a.doc.clientID // after the apply: Yjs moves a doc off a client id it sees arrive
      scratch.getMap('meta').set('pad', 'y'.repeat(pad))
      const size = Y.encodeStateAsUpdate(scratch).byteLength
      scratch.destroy()
      if (size === cap) break
      pad += cap - size
    }
    a.doc.getMap('meta').set('pad', 'y'.repeat(pad))
    expect(Y.encodeStateAsUpdate(a.doc).byteLength).toBe(cap)
    await expect.poll(() => (b.doc.getMap('meta').get('pad') as string | undefined)?.length).toBe(pad)
    // The relay's copy is now the same state, exactly at the cap: a deletion goes through.
    a.doc.getMap('meta').delete('a')
    await expect.poll(() => b.doc.getMap('meta').has('a')).toBe(false)
    expect([...a.closes, ...b.closes]).toEqual([])
  } finally { await relay.close() }
})
