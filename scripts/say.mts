import * as Y from 'yjs'
import { WebSocket } from 'ws'
import { WebsocketProvider } from 'y-websocket'
import { RoomDoc, formatMsg } from '@room/shared'
const [name, text, waitSec = '150'] = process.argv.slice(2)
const doc = new Y.Doc(); const room = new RoomDoc(doc)
const p = new WebsocketProvider('ws://localhost:1244', 'demo', doc, { WebSocketPolyfill: WebSocket })
await new Promise(r => p.once('sync', r))
if (text) room.say(name, { role: 'human', text })
const seen = new Set()
const dump = () => { for (const it of room.chat(name).toArray()) if (!seen.has(it.id)) { seen.add(it.id); console.log(`[chat/${name}] ${it.role}: ${it.text.replace(/\n/g, '\n    ')}`) } }
const busSeen = new Set()
const dumpBus = () => { for (const m of room.messages()) if (!busSeen.has(m.id)) { busSeen.add(m.id); console.log(`[bus] ${formatMsg(m)}`) } }
room.chat(name).observe(dump); room.bus.observe(dumpBus); dump(); dumpBus()
setTimeout(() => { p.destroy(); process.exit(0) }, Number(waitSec) * 1000)
