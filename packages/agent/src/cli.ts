#!/usr/bin/env tsx
import { readRoomFile } from '@room/roomd'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { RoomDoc, colorFor } from '@room/shared'
import { configureCredentials, deriveRoomName, encodeRoom, getCredential, parseServer } from '@room/room-mcp'
import { CodexBackend } from './backend.js'
import { roomConnectionParams, waitForRoomSync } from './connection.js'
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
  console.log('usage: roomagent [--dir <clone>] [--name <Name>] [--room ws://host:1234/<room>] [--server ws://host:1234] [--session <id>] [--token <token>] [--key <local-key>] [--model <model>] [--connect-timeout-ms <ms>] [--turn-timeout-ms <ms>]\n(room defaults to <server>/<origin>/<branch> of the clone, or private Git room metadata; name defaults to the saved login or git config user.name)')
  console.log('team runner destination: --room/--server > ROOM_SERVER > ROOM_URL > saved metadata; no default server or local mode')
  process.exit(0)
}
const dir = resolve(args.dir ?? process.cwd())
const cfg = readRoomFile(dir) ?? {}
const workDir = resolve(cfg.dir ?? dir)
const gitName = () => { try { return execFileSync('git', ['-C', workDir, 'config', 'user.name'], { encoding: 'utf8' }).trim() || undefined } catch { return undefined } }
const serverChoice = args.room ? undefined : args.server ?? process.env.ROOM_SERVER
let roomUrl = args.room ?? (serverChoice ? undefined : process.env.ROOM_URL ?? cfg.room)
if (serverChoice) {
  const server = parseServer(serverChoice).server
  if (!/^wss?:\/\//.test(server)) { console.error('roomagent: team runner needs a ws:// or wss:// server; local mode is not supported'); process.exit(2) }
  const d = await deriveRoomName(workDir)
  if (d.roomName) roomUrl = `${server}/${encodeRoom(d.roomName)}`
}
if (!roomUrl) { console.error('roomagent: pass --room, or choose --server/ROOM_SERVER/ROOM_URL in a clone with an origin'); process.exit(2) }

// ws://host:1234/<room> → server + room name
const u = new URL(roomUrl)
const roomName = u.pathname.replace(/^\/+/, '') || 'room'
const serverUrl = `${u.protocol}//${u.host}`
configureCredentials(args.credentials ?? process.env.ROOM_CREDENTIALS)
const saved = getCredential(serverUrl)
const name = args.name ?? cfg.name ?? saved?.login ?? gitName()
if (!name) { console.error('roomagent: pass --name or set git config user.name'); process.exit(2) }
const params = roomConnectionParams(u, {
  token: args.token ?? process.env.ROOM_TOKEN ?? parseServer(args.server ?? process.env.ROOM_SERVER ?? '').token,
  session: args.session ?? process.env.ROOM_SESSION ?? saved?.session,
  key: args.key ?? process.env.ROOM_LOCAL_KEY,
})

const here = dirname(fileURLToPath(import.meta.url))
const mcpEntry = resolve(here, '../../room-mcp/src/index.ts')

const doc = new Y.Doc()
const room = new RoomDoc(doc)
const provider = new WebsocketProvider(serverUrl, roomName, doc, { WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket, params })
provider.awareness.setLocalState({ user: { name, kind: 'agent', color: colorFor(name) }, status: 'idle' })

let temporaryCredentialsDir: string | undefined
let credentialsPath = args.credentials ?? process.env.ROOM_CREDENTIALS
const cleanupCredentials = () => {
  if (temporaryCredentialsDir) rmSync(temporaryCredentialsDir, { recursive: true, force: true })
  temporaryCredentialsDir = undefined
}
process.once('exit', cleanupCredentials)
if (params.session) {
  temporaryCredentialsDir = mkdtempSync(resolve(tmpdir(), 'roomagent-'))
  credentialsPath = resolve(temporaryCredentialsDir, 'credentials.json')
  writeFileSync(credentialsPath, JSON.stringify({ [serverUrl]: { session: params.session, login: name, at: Date.now() } }) + '\n', { mode: 0o600 })
}

const backend = new CodexBackend({
  workingDirectory: workDir,
  model: args.model,
  turnTimeoutMs: args['turn-timeout-ms'] ? Number(args['turn-timeout-ms']) : undefined,
  mcp: { command: 'npx', args: ['tsx', mcpEntry], env: {
    ROOM_URL: roomUrl, ROOM_NAME: name, ROOM_DIR: workDir,
    ...(params.token ? { ROOM_TOKEN: params.token } : {}),
    ...(credentialsPath ? { ROOM_CREDENTIALS: credentialsPath } : {}),
  } },
})
const runner = new Runner({ name, room, awareness: provider.awareness, backend, log: l => console.error(`[roomagent] ${l}`) })

// Mirror the transcript to the terminal so the browser view is optional.
room.chat(name).observe(ev => {
  for (const d of ev.changes.delta) for (const it of d.insert ?? []) if (it.role !== 'human') console.log(`[${it.role}] ${it.text}`)
})
provider.on('status', (e: { status: string }) => console.error(`[roomagent] ws ${e.status}`))
try {
  await waitForRoomSync(provider, args['connect-timeout-ms'] ? Number(args['connect-timeout-ms']) : 15_000, `${serverUrl}/${roomName}`)
} catch (error) {
  console.error(`[roomagent] ${error instanceof Error ? error.message : String(error)}`)
  provider.destroy(); cleanupCredentials()
  process.exit(1)
}
runner.start()
console.error(`[roomagent] ${name}'s agent online in ${roomName} @ ${serverUrl}, cwd ${workDir}`)

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.error('[roomagent] shutting down')
  await runner.stop(1000)
  provider.awareness.setLocalState(null)
  provider.destroy()
  cleanupCredentials()
  process.exit(0)
}
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
