#!/usr/bin/env tsx
import { readRoomFile } from '@room/roomd'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { RoomDoc, colorFor } from '@room/shared'
import { deriveRoomName, encodeRoom, parseServer } from '@room/room-mcp'
import { CodexBackend } from './backend.js'
import { Runner } from './runner.js'

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v && !v.startsWith('--')) { out[k] = v; i++ } else out[k] = 'true' }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('usage: roomagent [--dir <clone>] [--name <Name>] [--room ws://host:1234/<room>] [--server ws://host:1234] [--model <model>] [--turn-timeout-ms <ms>]\n(room defaults to <server>/<origin>/<branch> of the clone, or private Git room metadata; name defaults to git config user.name)')
  console.log('team runner destination: --room/--server > ROOM_SERVER > ROOM_URL > saved metadata; no default server or local mode')
  process.exit(0)
}
const dir = resolve(args.dir ?? process.cwd())
const cfg = readRoomFile(dir) ?? {}
const workDir = resolve(cfg.dir ?? dir)
const gitName = () => { try { return execFileSync('git', ['-C', workDir, 'config', 'user.name'], { encoding: 'utf8' }).trim() || undefined } catch { return undefined } }
const name = args.name ?? cfg.name ?? gitName()
const serverChoice = args.room ? undefined : args.server ?? process.env.ROOM_SERVER
let roomUrl = args.room ?? (serverChoice ? undefined : process.env.ROOM_URL ?? cfg.room)
if (serverChoice) {
  const server = parseServer(serverChoice).server
  if (!/^wss?:\/\//.test(server)) { console.error('roomagent: team runner needs a ws:// or wss:// server; local mode is not supported'); process.exit(2) }
  const d = await deriveRoomName(workDir)
  if (d.roomName) roomUrl = `${server}/${encodeRoom(d.roomName)}`
}
if (!name || !roomUrl) { console.error('roomagent: pass --room and --name, or choose --server/ROOM_SERVER/ROOM_URL in a clone with an origin'); process.exit(2) }

// ws://host:1234/<room> → server + room name
const u = new URL(roomUrl)
const roomName = u.pathname.replace(/^\/+/, '') || 'room'
const serverUrl = `${u.protocol}//${u.host}`

const here = dirname(fileURLToPath(import.meta.url))
const mcpEntry = resolve(here, '../../room-mcp/src/index.ts')

const doc = new Y.Doc()
const room = new RoomDoc(doc)
const token = (args.token ?? process.env.ROOM_TOKEN ?? parseServer(args.server ?? process.env.ROOM_SERVER ?? '').token ?? '').trim()
const provider = new WebsocketProvider(serverUrl, roomName, doc, { WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket, params: token ? { token } : {} })
provider.awareness.setLocalState({ user: { name, kind: 'agent', color: colorFor(name) }, status: 'idle' })

const backend = new CodexBackend({
  workingDirectory: workDir,
  model: args.model,
  turnTimeoutMs: args['turn-timeout-ms'] ? Number(args['turn-timeout-ms']) : undefined,
  mcp: { command: 'npx', args: ['tsx', mcpEntry], env: { ROOM_URL: roomUrl, ROOM_NAME: name, ROOM_DIR: workDir, ...(token ? { ROOM_TOKEN: token } : {}) } },
})
const runner = new Runner({ name, room, awareness: provider.awareness, backend, log: l => console.error(`[roomagent] ${l}`) })

// Mirror the transcript to the terminal so the browser view is optional.
room.chat(name).observe(ev => {
  for (const d of ev.changes.delta) for (const it of d.insert ?? []) if (it.role !== 'human') console.log(`[${it.role}] ${it.text}`)
})
provider.once('sync', () => {
  runner.start()
  console.error(`[roomagent] ${name}'s agent online in ${roomName} @ ${serverUrl}, cwd ${workDir}`)
})
provider.on('status', (e: { status: string }) => console.error(`[roomagent] ws ${e.status}`))

function shutdown() {
  console.error('[roomagent] shutting down')
  runner.stop()
  provider.awareness.setLocalState(null)
  provider.destroy()
  setTimeout(() => process.exit(0), 200)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
