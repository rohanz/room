// Usage: ROOM_URL=ws://host:port/room npx tsx scripts/say.mts <Name> ["message"] [seconds-to-watch]
// Posts a human message into <Name>'s agent chat and prints chat + bus activity.
import * as Y from 'yjs'
import { WebSocket } from 'ws'
import { WebsocketProvider } from 'y-websocket'
import { RoomDoc, formatMsg } from '@room/shared'
import { roomConnectionParams, waitForRoomSync } from '../packages/agent/src/connection.js'
const [name, text, waitSec = '150'] = process.argv.slice(2)
const ROOM_URL = process.env.ROOM_URL?.trim()
if (!ROOM_URL) throw new Error('Set ROOM_URL=ws://host:port/room before connecting')
if (!name) throw new Error('Usage: scripts/say.mts <Name> ["message"] [seconds-to-watch]')
const u = new URL(ROOM_URL); const serverUrl = `${u.protocol}//${u.host}`; const roomName = u.pathname.replace(/^\//, '')
const doc = new Y.Doc(); const room = new RoomDoc(doc)
const params = roomConnectionParams(u, { token: process.env.ROOM_TOKEN, session: process.env.ROOM_SESSION, key: process.env.ROOM_LOCAL_KEY })
const p = new WebsocketProvider(serverUrl, roomName, doc, { WebSocketPolyfill: WebSocket, params })
try { await waitForRoomSync(p, Number(process.env.ROOM_CONNECT_TIMEOUT_MS ?? 15_000), `${serverUrl}/${roomName}`) }
catch (error) { p.destroy(); throw error }
if (text) room.say(name, { role: 'human', text })
const seen = new Set()
const dump = () => { for (const it of room.chat(name).toArray()) if (!seen.has(it.id)) { seen.add(it.id); console.log(`[chat/${name}] ${it.role}: ${it.text.replace(/\n/g, '\n    ')}`) } }
const busSeen = new Set()
const dumpBus = () => { for (const m of room.messages()) if (!busSeen.has(m.id)) { busSeen.add(m.id); console.log(`[bus] ${formatMsg(m)}`) } }
room.chat(name).observe(dump); room.bus.observe(dumpBus); dump(); dumpBus()
setTimeout(() => { p.destroy(); process.exit(0) }, Number(waitSec) * 1000)
