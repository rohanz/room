/**
 * The browser view's own code (packages/web: ticket proof with WebCrypto, the encrypted websocket class) against
 * a real relay over sockets. Node provides the same `WebSocket`, `fetch` and `crypto.subtle` globals a browser does.
 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { localViewKey, startRelay } from '../src/index.js'
import { authorizedWebSocket } from '../../roomd/src/ws-auth.js'
import { mintTicket, parseRoomUrl } from '../../web/src/conn.js'
import { secureWebSocket } from '../../web/src/secure-websocket.js'

const key = 'interop-key', room = 'local/interop'

describe('browser view against a real relay', () => {
  it('mints a ticket with the view key, reads the room over the encrypted session, and cannot write', async () => {
    const relay = await startRelay(0, { key })
    const server = `ws://127.0.0.1:${relay.port}`
    const writerDoc = new Y.Doc(), viewerDoc = new Y.Doc()
    const writer = new WebsocketProvider(server, encodeURIComponent(room), writerDoc, { WebSocketPolyfill: authorizedWebSocket({ key }) as never, params: { schema: '2' }, disableBc: true })
    let viewer: WebsocketProvider | undefined
    const synced = (p: WebsocketProvider) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('provider did not sync')), 5000)
      const check = () => { if (p.synced) { clearTimeout(timer); resolve() } }
      p.on('sync', check); check()
    })
    try {
      await synced(writer)
      writerDoc.getText('shared').insert(0, 'text the viewer should see')
      const view = localViewKey(key, room)
      const loc = parseRoomUrl(`${server}/${encodeURIComponent(room)}`)
      const ticket = await mintTicket(loc, { view, key: '', token: '', relay: true })
      viewer = new WebsocketProvider(loc.serverUrl, loc.encodedRoomName, viewerDoc, { WebSocketPolyfill: secureWebSocket(view), params: { schema: '2', ticket }, disableBc: true })
      await synced(viewer)
      expect(viewerDoc.getText('shared').toString()).toBe('text the viewer should see')
      // Live updates keep arriving, in order, through the asynchronous decrypt chain.
      for (let i = 0; i < 50; i++) writerDoc.getText('shared').insert(0, `${i};`)
      await expect.poll(() => viewerDoc.getText('shared').toString(), { timeout: 5000 }).toBe(writerDoc.getText('shared').toString())
      viewerDoc.getText('shared').insert(0, 'a viewer write')
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(writerDoc.getText('shared').toString()).not.toContain('a viewer write')
      // The wrong view key cannot mint a ticket.
      await expect(mintTicket(loc, { view: localViewKey(key, 'local/another-room'), key: '', token: '', relay: true })).rejects.toThrow()
    } finally { viewer?.destroy(); writer.destroy(); writerDoc.destroy(); viewerDoc.destroy(); await relay.close() }
  })
})
