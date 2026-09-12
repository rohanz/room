#!/usr/bin/env tsx
import { resolve } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { displayName } from '@room/shared'
import type { Msg } from '@room/shared'
import { createTools } from './tools.js'
import { shouldWake } from './wake.js'
import { AGENT_INSTRUCTIONS } from './prompt.js'
import { decodeRoom, deriveRoomName, findRoomFile, joinSession, leaveSession, type Session } from './session.js'

export { AGENT_INSTRUCTIONS } from './prompt.js'
export { shouldWake } from './wake.js'
export type { WakeEvent, RoomEvent } from './wake.js'
export { createTools, DEFS } from './tools.js'
export type { ToolCtx, ToolDef, Tools } from './tools.js'
export { joinSession, leaveSession, deriveRoomName, findRoomFile, encodeRoom, decodeRoom, parseServer } from './session.js'
export type { Session, JoinOptions } from './session.js'

const log = (s: string) => process.stderr.write(`room-mcp: ${s}\n`)

/** Where the user is working: the runner passes ROOM_DIR; the Codex plugin passes PWD through. */
function cwd(): string {
  const e = (k: string) => (process.env[k] && process.env[k]!.trim()) || undefined
  return resolve(e('ROOM_DIR') ?? e('PWD') ?? e('INIT_CWD') ?? process.cwd())
}

async function main() {
  let session: Session | null = null
  const dir = cwd()
  const tools = createTools({ getSession: () => session, setSession: s => { session = s; if (s) attachChannel(s) }, cwd: dir })
  const adopt = (s: Session) => { session = s; attachChannel(s); tools.attachHooks(s); const n = tools.clearStale(s); if (n) log(`cleared ${n} stale claim(s) from an earlier session`) }

  const mcp = new Server(
    { name: 'room', version: '0.2.0' },
    { capabilities: { tools: {}, experimental: { 'claude/channel': {} } }, instructions: AGENT_INSTRUCTIONS() },
  )
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() }))
  mcp.setRequestHandler(CallToolRequestSchema, async req => ({
    content: [{ type: 'text', text: await tools.call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>) }],
  }))

  // Claude Code channel: push interrupts and addressed notifies as they arrive.
  const attachChannel = (s: Session) => {
    const push = (w: { content: string; meta: Record<string, string> } | null) => {
      if (!w) return
      mcp.notification({ method: 'notifications/claude/channel', params: { content: w.content, meta: w.meta } }).catch(() => { /* no channel attached */ })
    }
    const myClaims = () => s.room.openClaims().filter(c => c.by === s.me.name && c.byKind === 'agent')
    s.room.bus.observe(ev => {
      if (ev.transaction.local) return
      for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) push(shouldWake(s.me, { kind: 'msg', msg: m }, myClaims()))
    })
    log(`${displayName(s.me)} joined ${decodeRoom(s.roomName)} (clone ${s.dir})`)
  }

  // Connect first so Codex starts promptly; join in the background. Tool calls wait for it.
  const transport = new StdioServerTransport()
  await mcp.connect(transport)

  // Auto-join: the runner's ROOM_URL, a prior .room.json, or simply a clone with a git origin.
  const env = (k: string) => (process.env[k] && process.env[k]!.trim()) || undefined
  const prior = findRoomFile(dir)
  const autoJoin = (async () => {
    try {
      if (env('ROOM_URL') || prior) {
        const url = env('ROOM_URL') ?? prior!.room
        const u = new URL(url)
        const roomName = decodeRoom(u.pathname.replace(/^\/+/, ''))
        adopt(await joinSession({ dir: env('ROOM_DIR') ?? prior?.dir ?? dir, name: env('ROOM_NAME') ?? prior?.name, room: roomName, server: `${u.protocol}//${u.host}`, log }))
      } else {
        const { roomName } = await deriveRoomName(dir).catch(() => ({ roomName: undefined }))
        if (!roomName) { log(`ready; ${dir} has no git origin — call room_join with a room name`); return }
        adopt(await joinSession({ dir, log }))
      }
      log('ready')
    } catch (e) {
      log(`auto-join failed (${e instanceof Error ? e.message : String(e)}); call room_join`)
    }
  })()
  tools.setPendingJoin(autoJoin)

  let closing = false
  const bye = async () => {
    if (closing) return
    closing = true
    try { await tools.shutdown() } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGINT', bye); process.on('SIGTERM', bye)
  mcp.onclose = bye
  process.stdin.on('end', bye)
}

const isEntry = !!process.argv[1] && /room-mcp([\/\\]src[\/\\]index\.ts|\.mjs)?$/.test(process.argv[1])
if (isEntry) main().catch(e => { process.stderr.write(`room-mcp: ${e?.stack ?? e}\n`); process.exit(1) })
