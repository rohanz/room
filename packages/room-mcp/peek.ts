import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { RoomDoc } from '@room/shared'
import { execFileSync } from 'node:child_process'
const gh = execFileSync('gh', ['auth', 'token']).toString().trim()
const doc = new Y.Doc(); const room = new RoomDoc(doc)
const p = new WebsocketProvider('wss://room-rohanz.fly.dev', encodeURIComponent('github.com/rohanz/room-playground/drive-test'), doc, { WebSocketPolyfill: WebSocket as any, params: { gh } })
await new Promise<void>(r => p.once('sync', () => r())); await new Promise(r => setTimeout(r, 1500))
console.log('presence:', Array.from(p.awareness.getStates().entries()).filter(([id]) => id !== p.awareness.clientID).map(([, s]: any) => `${s.user?.name} "${s.status}"`))
p.destroy(); process.exit(0)
