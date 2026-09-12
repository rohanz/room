#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { RoomDoc, colorFor } from '@room/shared'
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
  console.log('usage: roomagent --name <Name> --dir <clone> --room ws://host:1234/<room> [--model <model>] [--turn-timeout-ms <ms>]\n(defaults read from <dir>/.room.json {room,name,dir})')
  process.exit(0)
}
const dir = resolve(args.dir ?? process.cwd())
let cfg: { room?: string; name?: string; dir?: string } = {}
try { cfg = JSON.parse(readFileSync(resolve(dir, '.room.json'), 'utf8')) } catch { /* optional */ }
const name = args.name ?? cfg.name
const roomUrl = args.room ?? cfg.room
const workDir = resolve(cfg.dir ?? dir)
if (!name || !roomUrl) { console.error('roomagent: need --name and --room (or <dir>/.room.json)'); process.exit(2) }

// ws://host:1234/<room> → server + room name
const u = new URL(roomUrl)
const roomName = u.pathname.replace(/^\/+/, '') || 'room'
const serverUrl = `${u.protocol}//${u.host}`

const here = dirname(fileURLToPath(import.meta.url))
const mcpEntry = resolve(here, '../../room-mcp/src/index.ts')

const doc = new Y.Doc()
const room = new RoomDoc(doc)
const provider = new WebsocketProvider(serverUrl, roomName, doc, { WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket })
provider.awareness.setLocalState({ user: { name, kind: 'agent', color: colorFor(name) }, status: 'idle' })

const backend = new CodexBackend({
  workingDirectory: workDir,
  model: args.model,
  turnTimeoutMs: args['turn-timeout-ms'] ? Number(args['turn-timeout-ms']) : undefined,
  mcp: { command: 'npx', args: ['tsx', mcpEntry], env: { ROOM_URL: roomUrl, ROOM_NAME: name, ROOM_DIR: workDir } },
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
