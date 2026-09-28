#!/usr/bin/env tsx
import fs from 'node:fs'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { displayName, isAgentic } from '@room/shared'
import type { Msg } from '@room/shared'
import { createTools, DEFS } from './tools.js'
import { shouldWake } from './wake.js'
import { AGENT_INSTRUCTIONS } from './prompt.js'
import { LOCAL, decodeRoom, joinSession, leaveSession, startupJoinOptions, type Session } from './session.js'
import { AutoJoin } from './auto-join.js'
import { joinableRoot } from './repository.js'
import { gitCommonDir } from '@room/roomd'
import { consumeHookDisclosure, consumeHookNotice, syncHookSeen, writePendingHookContext, noteHostTurnMetadata } from './hooks-bridge.js'
import { resolveConfig, resolveSessionHost } from './config.js'
import { SocketWakeRouter } from './wake-path.js'
import { waitConsumesMessage } from './tools/messaging.js'
import { markTeamSharingDisclosureDelivered, pendingTeamSharingDisclosure, prepareTeamSharingDisclosure, rejoinOptions } from './tools/join.js'
import { createWorkspaceBinding, deferForSharedCodex, fallbackWorkspace } from './workspace.js'
import pluginManifest from '../../../plugins/room/.claude-plugin/plugin.json' with { type: 'json' }

/** Plugin release, also advertised in the MCP handshake. Package versions are private. */
export const RELEASE_VERSION = pluginManifest.version

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

/** Room's own log in the clone's git common dir, shared by every session and worker of the clone. */
export const ROOM_LOG = 'room-mcp.log'
export const ROOM_LOG_MAX_BYTES = 1024 * 1024
/** Append one line; past maxBytes the file moves to <file>.1 (replacing the previous one), so it never exceeds twice the cap. */
export function appendRoomLog(file: string, line: string, maxBytes = ROOM_LOG_MAX_BYTES): void {
  try {
    try { if (fs.statSync(file).size >= maxBytes) fs.renameSync(file, `${file}.1`) } catch { /* no log yet */ }
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 })
  } catch { /* best effort: never fail a session over its log */ }
}

// ROOM_LOG_FILE: also append every log line to a file (workers spawned by room_spawn get one per tag).
let LOG_FILE: string | undefined = process.env.ROOM_LOG_FILE
let ROOM_LOG_FILE: string | undefined
const log = (s: string) => {
  try { fs.writeSync(2, `room-mcp: ${s}\n`) } catch { /* stderr may already be closed */ }
  const at = new Date().toISOString()
  if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, `${at} ${s}\n`) } catch { /* best effort */ } }
  if (ROOM_LOG_FILE) appendRoomLog(ROOM_LOG_FILE, `${at} pid ${process.pid}${process.env.ROOM_TAG ? ` ${process.env.ROOM_TAG}` : ''}: ${s}`)
}

/** The entry file is the loaded plugin bundle in an installation. Check it once per tool call. */
export function createBundleUpdateNotice(file: string): () => string {
  let startupMtime: number
  try { startupMtime = fs.statSync(file).mtimeMs } catch { return () => '' }
  let warned = false
  return () => {
    if (warned) return ''
    try {
      if (fs.statSync(file).mtimeMs <= startupMtime) return ''
    } catch { return '' }
    warned = true
    return 'Room was updated on disk; restart this session to pick up fixes'
  }
}

async function main() {
  let closing = false
  const bundleUpdateNotice = createBundleUpdateNotice(process.argv[1] ?? '')
  const mcp = new Server(
    { name: 'room', version: RELEASE_VERSION },
    { capabilities: { tools: {}, experimental: { 'claude/channel': {} } }, instructions: AGENT_INSTRUCTIONS() },
  )
  const binding = createWorkspaceBinding({
    deferred: deferForSharedCodex(process.env), fallbackDir: () => fallbackWorkspace(process.env, process.cwd()),
    logFallback: () => log('call has no workspace metadata; using ROOM_DIR/PWD/INIT_CWD/process.cwd() fallback'),
    logFailure: error => log(`workspace initialization failed: ${error instanceof Error ? error.message : String(error)}`),
    initialize: async (dir: string, signal: AbortSignal) => {
      let session: Session | null = null
      let startupNotice = ''
      const startup = await resolveConfig({ dir, env: process.env })
      if (signal.aborted) throw new Error('Room is shutting down')
      LOG_FILE = startup.logFile
      ROOM_LOG_FILE = await gitCommonDir(dir).then(common => path.join(common, ROOM_LOG), () => undefined)
      if (signal.aborted) throw new Error('Room is shutting down')
      // attachChannel is also handed to the tools so the workers room (opened by room_spawn next to a team session) pushes its wake-ups too.
      const tools = createTools({ getSession: () => session, setSession: s => { session = s; if (s) attachChannel(s) }, cwd: dir, config: startup, attachChannel: s => attachChannel(s) })
      const adopt = async (s: Session) => {
        await prepareTeamSharingDisclosure(s)
        const disclosure = pendingTeamSharingDisclosure(s)
        if (disclosure) writePendingHookContext(s.dir, 'pendingDisclosure', disclosure, s.roomName)
        tools.markHistorySeenOnJoin(s)
        session = s
        attachChannel(s)
        tools.attachHooks(s)
        const n = tools.clearStale(s)
        if (n) log(`cleared ${n} stale claim(s) from an earlier session`)
      }

      const call = async (req: { params: { name: string; arguments?: Record<string, unknown> } }, signal?: AbortSignal) => {
        await autoJoin.settle() // a join in progress decides which session the disclosure below is about
        let disclosure = ''
        if (session) {
          const sentence = pendingTeamSharingDisclosure(session)
          if (sentence) {
            const delivery = consumeHookDisclosure(session, sentence)
            if (delivery === 'hook' || delivery === 'tool') {
              markTeamSharingDisclosureDelivered(session)
              if (delivery === 'tool') disclosure = sentence
            }
          }
        }
        const body = await tools.call(req.params.name, req.params.arguments ?? {}, signal)
        const delivery = startupNotice ? consumeHookNotice(dir, startupNotice) : undefined
        const notice = session || delivery === 'hook' || delivery === 'pending' ? '' : startupNotice
        if (delivery !== 'pending') startupNotice = ''
        const updateNotice = bundleUpdateNotice()
        return (notice ? notice + '\n\n' : '') + (disclosure ? disclosure + '\n\n' : '') + (updateNotice ? updateNotice + '\n\n' : '') + body
      }

      // Claude Code: push interrupts and addressed notifies over the selected wake path.
      const attachedWakeSessions = new WeakSet<Session>()
      const attachChannel = (s: Session) => {
        if (attachedWakeSessions.has(s)) return
        attachedWakeSessions.add(s)
        const router = new SocketWakeRouter({ host: resolveSessionHost(s.dir), channel: startup.claudeChannel, notify: notification => mcp.notification(notification), isUnread: wake => !wake.meta.msg_id || !s.room.seen(s.me.name).has(wake.meta.msg_id), isPendingWait: wake => !!s.room.messages().find(m => m.id === wake.meta.msg_id && waitConsumesMessage(s, m)), log })
        const myClaims = () => s.room.openClaims().filter(c => c.by === s.me.name && isAgentic(c.byKind))
        s.room.bus.observe(ev => {
          for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) {
            // My own posts never wake me; a message this process wrote as someone else (a worker's synthetic done) does.
            syncHookSeen(s)
            if ((m.from === s.me.name && m.fromKind !== 'human') || s.room.seen(s.me.name).has(m.id)) continue
            router.push(shouldWake(s.me, { kind: 'msg', msg: m }, myClaims(), s.room.changedPaths(s.me.name).length > 0,
              new Set(Array.from(s.room.workers.values()).filter(w => w.lead === s.me.name).map(w => w.name))))
          }
        })
        log(`${displayName(s.me)} joined ${decodeRoom(s.roomName)} (clone ${s.dir})`)
      }

      // Auto-join when the repo already has a room: the runner's ROOM_URL, a prior .room.json, or
      // simply a clone with a git origin. A repo nobody has opened waits for room_create.
      const chosen = startup.server
      log(`room: ${startup.where.replace(/\?.*$/, '')} (${startup.whereRule === 'env' ? (startup as typeof startup & { whereEnv?: string }).whereEnv ?? 'ROOM_SERVER' : startup.whereRule === 'remembered' ? 'remembered in this clone' : 'default: nothing configured'})`)
      const autoJoin = new AutoJoin({
        local: chosen === LOCAL,
        log,
        async attempt(target) {
          // A session whose relay was taken by another clone's relay cannot reconnect on the same URL: leave it and join afresh.
          if (session?.local?.lost) await tools.drop(session, session.local.lost)
          // After room_join/room_create, the room the human chose; a room it did not pin still follows the branch.
          if (target) {
            const s = await joinSession({ ...rejoinOptions(target, startup.credentialsPath), log })
            if (!target.pinnedRoom) delete s.pinnedRoom
            return s
          }
          // Checked on every attempt: a folder that is not a repository yet may become one mid-session.
          const options = await startupJoinOptions(await joinableRoot(dir), chosen, startup.room)
          if (options) return joinSession({ ...options, log })
          log(`ready; ${dir} has no git origin — call room_join with a room name`)
          return undefined
        },
        async adopt(s) { await adopt(s); log('ready') },
        discard: s => leaveSession(s),
        joined: () => !!session && !session.local?.lost,
        report(line) {
          startupNotice = line
          writePendingHookContext(dir, 'pendingNotice', line)
          log(line)
        },
      })
      tools.setAutoJoin(autoJoin)
      if (!signal.aborted) void autoJoin.ensure()

      return { call, shutdown: async () => { autoJoin.cancel(); await autoJoin.settle(); await tools.shutdown() } }
    },
  })

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: DEFS }))
  mcp.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    noteHostTurnMetadata(req.params._meta)
    const result = await binding.run(req.params, runtime => runtime.call(req, extra.signal))
    return { content: [{ type: 'text' as const, text: result.error ?? result.value! }], ...(result.error ? { isError: true } : {}) }
  })

  const bye = async (reason: string) => {
    if (closing) return
    closing = true
    log(`stopping: ${reason}`)
    try { await (await binding.close())?.shutdown() } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGINT', () => { void bye('SIGINT') }); process.on('SIGTERM', () => { void bye('SIGTERM') })
  mcp.onclose = () => { void bye('stdin/transport closed') }
  process.stdin.on('end', () => { void bye('stdin closed') })

  // The definitions are static; a shared Codex daemon needs no directory-bound state until a call.
  const transport = new StdioServerTransport()
  try {
    await mcp.connect(transport)
    await binding.start()
  } catch (error) {
    if (!closing) throw error // non-deferred startup keeps its fatal exit policy
  }
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
