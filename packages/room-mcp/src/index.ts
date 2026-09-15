#!/usr/bin/env tsx
import fs from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { displayName, isAgentic } from '@room/shared'
import type { Msg } from '@room/shared'
import { createTools } from './tools.js'
import { shouldWake } from './wake.js'
import { AGENT_INSTRUCTIONS } from './prompt.js'
import { LOCAL, NoRoom, NotLoggedIn, decodeRoom, deriveRoomName, findRoomFile, joinSession, leaveSession, type Session } from './session.js'
import { resolveConfig } from './config.js'

export { AGENT_INSTRUCTIONS } from './prompt.js'
export { shouldWake } from './wake.js'
export type { WakeEvent, RoomEvent } from './wake.js'
export { createTools, DEFS } from './tools.js'
export type { ToolCtx, ToolDef, Tools } from './tools.js'
export { joinSession, leaveSession, createRoom, closeRoom, NoRoom, NotLoggedIn, deriveRoomName, findRoomFile, encodeRoom, decodeRoom, parseServer, serverAuthMode, serverShareMax, requestedShare, resolveAuth, startLogin, pollLogin, logout } from './session.js'
export { credentialsPath, configureCredentials, getCredential, setCredential, removeCredential } from './credentials.js'
export type { Session, JoinOptions } from './session.js'
export { resolveConfig } from './config.js'
export type { ResolvedConfig, ConfigArgs, ConfigRule } from './config.js'

// ROOM_LOG_FILE: also append every log line to a file (workers spawned by room_spawn get one per tag).
let LOG_FILE: string | undefined
const log = (s: string) => {
  process.stderr.write(`room-mcp: ${s}\n`)
  if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${s}\n`) } catch { /* best effort */ } }
}

/** Where the user is working: the runner passes ROOM_DIR; the Codex plugin passes PWD through. */
function cwd(): string {
  const e = (k: string) => (process.env[k] && process.env[k]!.trim()) || undefined
  return e('ROOM_DIR') ?? e('PWD') ?? e('INIT_CWD') ?? process.cwd()
}

async function main() {
  let session: Session | null = null
  const dir = cwd()
  const startup = await resolveConfig({ dir, env: process.env })
  LOG_FILE = startup.logFile
  // attachChannel is also handed to the tools so the workers room (opened by room_spawn next to a team session) pushes its wake-ups too.
  const tools = createTools({ getSession: () => session, setSession: s => { session = s; if (s) attachChannel(s) }, cwd: dir, config: startup, attachChannel: s => attachChannel(s) })
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
    const myClaims = () => s.room.openClaims().filter(c => c.by === s.me.name && isAgentic(c.byKind))
    s.room.bus.observe(ev => {
      for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) {
        // My own posts never wake me; a message this process wrote as someone else (a worker's synthetic done) does.
        if (ev.transaction.local && m.from === s.me.name) continue
        push(shouldWake(s.me, { kind: 'msg', msg: m }, myClaims()))
      }
    })
    log(`${displayName(s.me)} joined ${decodeRoom(s.roomName)} (clone ${s.dir})`)
  }

  // Connect first so Codex starts promptly; join in the background. Tool calls wait for it.
  const transport = new StdioServerTransport()
  await mcp.connect(transport)

  // Auto-join when the repo already has a room: the runner's ROOM_URL, a prior .room.json, or
  // simply a clone with a git origin. A repo nobody has opened waits for room_create.
  const prior = findRoomFile(dir)
  const autoJoin = (async () => {
    try {
      // The clone's origin + current branch always decides the room. ROOM_URL (runner) or a
      // prior .room.json only fill in when the clone has no origin.
      const derived = await deriveRoomName(dir).catch(() => ({ roomName: undefined }))
      const chosen = startup.server
      log(`room: ${startup.where.replace(/\?.*$/, '')} (${startup.whereRule === 'env' ? 'ROOM_SERVER' : startup.whereRule === 'remembered' ? 'remembered in this clone' : 'default: nothing configured'})`)
      const roomUrl = process.env.ROOM_URL?.trim()
      if (roomUrl) {
        const u = new URL(roomUrl)
        adopt(await joinSession({ dir: startup.dir, name: startup.name, room: decodeRoom(u.pathname.replace(/^\/+/, '')), server: `${u.protocol}//${u.host}`, log }))
      } else if (chosen === LOCAL) {
        // No server configured: a local room on this machine (workers get the lead's room via ROOM_ROOM).
        adopt(await joinSession({ dir, room: startup.room, server: LOCAL, log }))
      } else if (startup.room) {
        adopt(await joinSession({ dir, room: startup.room, server: chosen, log }))
      } else if (derived.roomName) {
        adopt(await joinSession({ dir, server: chosen, log }))
      } else if (prior) {
        const u = new URL(prior.room)
        adopt(await joinSession({ dir: prior.dir ?? dir, name: prior.name, room: decodeRoom(u.pathname.replace(/^\/+/, '')), server: `${u.protocol}//${u.host}`, log }))
      } else { log(`ready; ${dir} has no git origin — call room_join with a room name`); return }
      log('ready')
    } catch (e) {
      if (e instanceof NoRoom) log(`ready; ${e.message}`)
      else if (e instanceof NotLoggedIn) log(`ready; not logged in: room_login`)
      else log(`auto-join failed (${e instanceof Error ? e.message : String(e)}); call room_join`)
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
