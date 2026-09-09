#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { RoomDoc, colorFor, displayName } from '@room/shared'
import type { Claim, Identity, Msg, Presence } from '@room/shared'
import { createTools } from './tools.js'
import { shouldWake } from './wake.js'
import { AGENT_INSTRUCTIONS } from './prompt.js'

export { AGENT_INSTRUCTIONS } from './prompt.js'
export { shouldWake } from './wake.js'
export type { WakeEvent, RoomEvent } from './wake.js'
export { createTools } from './tools.js'
export type { ToolCtx, ToolDef, Tools } from './tools.js'


interface Config { room: string; name: string; dir: string }

function loadConfig(): Config {
  let file: Partial<Config> = {}
  try { file = JSON.parse(readFileSync(resolve(process.cwd(), '.room.json'), 'utf8')) } catch { /* optional */ }
  const room = process.env.ROOM_URL ?? file.room
  const name = process.env.ROOM_NAME ?? file.name
  const dir = process.env.ROOM_DIR ?? file.dir ?? process.cwd()
  if (!room || !name) {
    process.stderr.write('room-mcp: need ROOM_URL and ROOM_NAME (or .room.json {room,name,dir} in cwd)\n')
    process.exit(2)
  }
  return { room, name, dir: resolve(dir) }
}

/** "ws://host:1234/myroom" -> { serverUrl: "ws://host:1234", roomName: "myroom" } */
export function splitRoomUrl(url: string): { serverUrl: string; roomName: string } {
  const u = new URL(url)
  const parts = u.pathname.split('/').filter(Boolean)
  const roomName = parts.pop() ?? 'room'
  u.pathname = parts.length ? '/' + parts.join('/') : ''
  return { serverUrl: u.toString().replace(/\/$/, ''), roomName }
}

async function main() {
  const cfg = loadConfig()
  const me: Identity = { name: cfg.name, kind: 'agent' }
  const doc = new Y.Doc()
  const room = new RoomDoc(doc)
  const { serverUrl, roomName } = splitRoomUrl(cfg.room)
  const provider = new WebsocketProvider(serverUrl, roomName, doc, { WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket })
  const awareness = provider.awareness
  awareness.setLocalState({ user: { name: me.name, kind: 'agent', color: colorFor(me.name) }, status: 'idle' } satisfies Presence)

  const tools = createTools({ room, me, dir: cfg.dir, awareness })

  const mcp = new Server(
    { name: 'room', version: '0.1.0' },
    { capabilities: { tools: {}, experimental: { 'claude/channel': {} } }, instructions: AGENT_INSTRUCTIONS(me.name) },
  )
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() }))
  mcp.setRequestHandler(CallToolRequestSchema, async req => ({
    content: [{ type: 'text', text: await tools.call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>) }],
  }))

  const push = (w: { content: string; meta: Record<string, string> } | null) => {
    if (!w) return
    mcp.notification({ method: 'notifications/claude/channel', params: { content: w.content, meta: w.meta } }).catch(() => { /* channel not attached */ })
  }
  const myClaims = () => room.openClaims().filter(c => c.by === me.name && c.byKind === 'agent')

  // bus: new items only
  room.bus.observe(ev => {
    if (ev.transaction.local) return
    for (const d of ev.changes.delta) {
      if (!d.insert) continue
      for (const m of d.insert as Msg[]) push(shouldWake(me, { kind: 'msg', msg: m }, myClaims()))
    }
  })
  // claims: new keys only
  room.claims.observe(ev => {
    if (ev.transaction.local) return
    for (const [k, ch] of ev.changes.keys) {
      if (ch.action !== 'add') continue
      const c = room.claims.get(k) as Claim | undefined
      if (c) push(shouldWake(me, { kind: 'claim', claim: c }, myClaims()))
    }
  })
  // human cursor entering my claim, once per claim per 3s
  const lastCursorWake = new Map<string, number>()
  awareness.on('change', () => {
    const mine = myClaims()
    if (!mine.length) return
    for (const [clientId, s] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue
      const p = s as Presence | undefined
      if (!p?.user || p.user.kind !== 'human' || !p.cursor) continue
      const w = shouldWake(me, { kind: 'cursor', who: { name: p.user.name, kind: 'human' }, cursor: p.cursor }, mine)
      if (!w) continue
      const key = `${w.meta.msg_id}:${p.user.name}`
      const now = Date.now()
      if ((lastCursorWake.get(key) ?? 0) + 3000 > now) continue
      lastCursorWake.set(key, now)
      push(w)
    }
  })

  const transport = new StdioServerTransport()
  await mcp.connect(transport)
  process.stderr.write(`room-mcp: ${displayName(me)} joined ${cfg.room} (dir ${cfg.dir})\n`)

  const bye = () => { try { awareness.setLocalState(null); provider.destroy() } catch { /* ignore */ } process.exit(0) }
  process.on('SIGINT', bye); process.on('SIGTERM', bye)
  mcp.onclose = bye
  process.stdin.on('end', bye)
}

const isEntry = process.argv[1] && /room-mcp[\/\\]src[\/\\]index\.ts$|room-mcp$/.test(process.argv[1])
if (isEntry) main().catch(e => { process.stderr.write(`room-mcp: ${e?.stack ?? e}\n`); process.exit(1) })
