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
import { consumeHookDisclosure, consumeHookNotice, syncHookSeen, writePendingHookContext } from './hooks-bridge.js'
import { resolveConfig } from './config.js'
import { pushChannelNotification } from './channel.js'
import { markTeamSharingDisclosureDelivered, pendingTeamSharingDisclosure, prepareTeamSharingDisclosure } from './tools/join.js'

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
let LOG_FILE: string | undefined = process.env.ROOM_LOG_FILE
const log = (s: string) => {
  try { fs.writeSync(2, `room-mcp: ${s}\n`) } catch { /* stderr may already be closed */ }
  if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${s}\n`) } catch { /* best effort */ } }
}

/** Where the user is working: the runner passes ROOM_DIR; the Codex plugin passes PWD through. */
function cwd(): string {
  const e = (k: string) => (process.env[k] && process.env[k]!.trim()) || undefined
  return e('ROOM_DIR') ?? e('PWD') ?? e('INIT_CWD') ?? process.cwd()
}

async function main() {
  let session: Session | null = null
  let startupNotice = ''
  const dir = cwd()
  const startup = await resolveConfig({ dir, env: process.env })
  LOG_FILE = startup.logFile
  // attachChannel is also handed to the tools so the workers room (opened by room_spawn next to a team session) pushes its wake-ups too.
  const tools = createTools({ getSession: () => session, setSession: s => { session = s; if (s) attachChannel(s) }, cwd: dir, config: startup, attachChannel: s => attachChannel(s) })
  const adopt = async (s: Session) => {
    await prepareTeamSharingDisclosure(s)
    const disclosure = pendingTeamSharingDisclosure(s)
    if (disclosure) writePendingHookContext(s.dir, 'pendingDisclosure', disclosure, s.roomName)
    session = s
    attachChannel(s)
    tools.attachHooks(s)
    const n = tools.clearStale(s)
    if (n) log(`cleared ${n} stale claim(s) from an earlier session`)
  }

  let autoJoin: Promise<void> = Promise.resolve()

  const mcp = new Server(
    { name: 'room', version: '0.2.0' },
    { capabilities: { tools: {}, experimental: { 'claude/channel': {} } }, instructions: AGENT_INSTRUCTIONS() },
  )
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() }))
  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    await autoJoin
    let disclosure = ''
    if (session) {
      const sentence = pendingTeamSharingDisclosure(session)
      if (sentence) {
        const delivery = consumeHookDisclosure(session, sentence)
        if (delivery) {
          markTeamSharingDisclosureDelivered(session)
          if (delivery === 'tool') disclosure = sentence
        }
      }
    }
    const body = await tools.call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
    const delivery = startupNotice ? consumeHookNotice(dir, startupNotice) : undefined
    const notice = session || delivery === 'hook' ? '' : startupNotice
    startupNotice = ''
    return { content: [{ type: 'text', text: (notice ? notice + '\n\n' : '') + (disclosure ? disclosure + '\n\n' : '') + body }] }
  })

  // Claude Code channel: push interrupts and addressed notifies as they arrive.
  const attachChannel = (s: Session) => {
    const myClaims = () => s.room.openClaims().filter(c => c.by === s.me.name && isAgentic(c.byKind))
    s.room.bus.observe(ev => {
      for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) {
        // My own posts never wake me; a message this process wrote as someone else (a worker's synthetic done) does.
        syncHookSeen(s)
        if (m.from === s.me.name || s.room.seen(s.me.name).has(m.id)) continue
        void pushChannelNotification(s, shouldWake(s.me, { kind: 'msg', msg: m }, myClaims(), s.room.changedPaths(s.me.name).length > 0), notification => mcp.notification(notification), startup.claudeChannel)
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
  autoJoin = (async () => {
    try {
      // The clone's origin + current branch always decides the room. ROOM_URL (runner) or a
      // prior .room.json only fill in when the clone has no origin.
      const derived = await deriveRoomName(dir).catch(() => ({ roomName: undefined }))
      const chosen = startup.server
      log(`room: ${startup.where.replace(/\?.*$/, '')} (${startup.whereRule === 'env' ? (startup as typeof startup & { whereEnv?: string }).whereEnv ?? 'ROOM_SERVER' : startup.whereRule === 'remembered' ? 'remembered in this clone' : 'default: nothing configured'})`)
      if (chosen === LOCAL) {
        // No server configured: a local room on this machine (workers get the lead's room via ROOM_ROOM).
        await adopt(await joinSession({ dir, room: startup.room, server: LOCAL, log }))
      } else if (startup.room) {
        await adopt(await joinSession({ dir, room: startup.room, server: chosen, log }))
      } else if (derived.roomName) {
        await adopt(await joinSession({ dir, server: chosen, log }))
      } else if (prior) {
        const u = new URL(prior.room)
        await adopt(await joinSession({ dir: prior.dir ?? dir, name: prior.name, room: decodeRoom(u.pathname.replace(/^\/+/, '')), server: chosen, log }))
      } else { log(`ready; ${dir} has no git origin — call room_join with a room name`); return }
      log('ready')
    } catch (e) {
      if (e instanceof NoRoom && startup.server === LOCAL && !startup.room) log(`ready; ${e.message}`)
      else {
        const expected = startup.server !== LOCAL || !!startup.room
        const line = e instanceof NotLoggedIn
          ? 'Room is not connected: not logged in; use room_login.'
          : `Room could not join: ${e instanceof Error ? e.message : String(e)}; use room_join.`
        if (expected) {
          startupNotice = line
          writePendingHookContext(dir, 'pendingNotice', line)
        }
        log(line)
      }
    }
  })()
  tools.setPendingJoin(autoJoin)

  let closing = false
  const bye = async (reason: string) => {
    if (closing) return
    closing = true
    log(`stopping: ${reason}`)
    // A close/signal can race startup. Do not let a late auto-join create presence after shutdown.
    try { await autoJoin } catch { /* startup already reported the error */ }
    try { await tools.shutdown() } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGINT', () => { void bye('SIGINT') }); process.on('SIGTERM', () => { void bye('SIGTERM') })
  mcp.onclose = () => { void bye('stdin/transport closed') }
  process.stdin.on('end', () => { void bye('stdin closed') })
}

const isEntry = !!process.argv[1] && /room-mcp([\/\\]src[\/\\]index\.ts|\.mjs)?$/.test(process.argv[1])
/** Install only for the executable, never when consumers import the package. */
export function installFailureHandlers(report: (message: string) => void, target: Pick<NodeJS.Process, 'on' | 'exit'> = process): (reason: string, error: unknown) => never {
  const fatal = (reason: string, error: unknown): never => {
    report(`stopping: ${reason}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    return target.exit(1)
  }
  target.on('uncaughtException', error => fatal('uncaughtException', error))
  target.on('unhandledRejection', error => fatal('unhandledRejection', error))
  return fatal
}

if (isEntry) {
  const fatal = installFailureHandlers(log)
  main().catch(error => fatal('startup failed', error))
}
