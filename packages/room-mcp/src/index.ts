#!/usr/bin/env tsx
import fs from 'node:fs'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { displayName } from '@room/shared'
import { createTools, DEFS } from './tools.js'
import { AGENT_INSTRUCTIONS } from './prompt.js'
import { LOCAL, decodeRoom, joinSession, leaveSession, startupJoinOptions, type Session } from './session.js'
import { joinableRoot } from './repository.js'
import { AutoJoin } from './auto-join.js'
import { gitCommonDir } from '@room/roomd'
import { resolveConfig } from './config.js'
import { createWakeSender } from './wake-path.js'
import { CodexTurnProbe } from './codex-turn.js'
import { offerTeamSharingDisclosure, rejoinOptions } from './tools/join.js'
import type { Settle } from './tools/index.js'
import { FlushedStdioTransport } from './transport.js'
import { createSessionBinding } from './binding.js'
import { startArbitration } from './arbitration.js'
import { createWorkspaceBinding, deferForSharedCodex, fallbackWorkspace } from './workspace.js'
import { PresenceEnd, hostKind, hostSessionAlive, idleLeaseTickMs, joinedPresenceHolds, joinedPresenceWorkers, nextIdleEpisode, releaseIdleHeld, resolveIdleLeaseMs } from './presence-end.js'
import pluginManifest from '../../../plugins/room/.claude-plugin/plugin.json' with { type: 'json' }
import { runDoctor } from './doctor.js'
import { ownWorkerNames } from './worker-registry.js'
import { ToolTimingTracker, currentToolTiming, registerPrepareGitTiming, startEventLoopWatchdog } from './timing.js'

/** Plugin release, also advertised in the MCP handshake. Package versions are private. */
export const RELEASE_VERSION = pluginManifest.version

export { AGENT_INSTRUCTIONS } from './prompt.js'
export { createTools, DEFS } from './tools.js'
export type { ToolCtx, ToolDef, Tools } from './tools.js'
export { joinSession, leaveSession, createRoom, closeRoom, NoRoom, NotLoggedIn, deriveRoomName, findRoomFile, encodeRoom, decodeRoom, parseServer, serverAuthMode, serverShareMax, requestedShare, resolveAuth, startLogin, pollLogin, logout } from './session.js'
export { credentialsPath, configureCredentials, getCredential, setCredential, removeCredential } from './credentials.js'
export type { Session, JoinOptions } from './session.js'
export { resolveConfig } from './config.js'
export { HubClient, hubTransport } from './hub-client.js'
export { createPost, NOT_SENT, type Post, type PostOpts, type PostResult, type Posting } from './post.js'
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
  const timing = new ToolTimingTracker({ log })
  registerPrepareGitTiming()
  const watchdog = startEventLoopWatchdog(timing, { log })
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
      const startup = await resolveConfig({ dir, env: process.env })
      if (signal.aborted) throw new Error('Room is shutting down')
      LOG_FILE = startup.logFile
      ROOM_LOG_FILE = await gitCommonDir(dir).then(common => path.join(common, ROOM_LOG), () => undefined)
      if (signal.aborted) throw new Error('Room is shutting down')
      const sessionBinding = createSessionBinding(dir)
      let rebinding: Promise<void> | undefined
      let rebindHost: (sessionId: string) => Promise<void> = async () => {}
      // Content-free wakes of this host session: the Codex queue, or Claude Code's inbox socket, then the channel.
      const wake = createWakeSender({ channel: startup.claudeChannel, notify: notification => mcp.notification(notification) })
      let presence: PresenceEnd | undefined
      const wakeProbe = new CodexTurnProbe({ contactAgeMs: () => presence?.idleMs() })
      const tools = createTools({ getSession: () => session, setSession: s => { session = s; if (s) joined(s) }, cwd: dir, config: startup, wake, wakeProbe, binding: sessionBinding, log })
      // The hooks take message content only from this endpoint, never from a file.
      const arbitration = await startArbitration({ binding: sessionBinding, ledger: tools.ledger, select: () => tools.hookSelect(),
        canSelect: () => !rebinding && !!session?.lease?.fence() && session.lease.sessionId === sessionBinding.bound()?.id,
        onContact: () => presence?.activity(), log })
      const adopt = async (s: Session, clearStale = true) => {
        // Offered before any tool call, so the first hook or reply can hand it off.
        await offerTeamSharingDisclosure(s, tools.ledger)
        session = s
        joined(s)
        tools.attachHooks(s)
        if (clearStale) {
          const n = tools.clearStale(s)
          if (n) log(`cleared ${n} stale claim(s) from an earlier session`)
        }
      }

      // Presence ends once the host session has finished (registry §18): its process gone, or the idle lease.
      const presenceHostKind = hostKind()
      const idleLeaseMs = resolveIdleLeaseMs(process.env.ROOM_IDLE_LEASE_MS)
      presence = new PresenceEnd({
        hostKind: presenceHostKind,
        idleLeaseMs,
        tickMs: idleLeaseTickMs(idleLeaseMs),
        ...(presenceHostKind === 'shared-app-server' ? { episodeId: await nextIdleEpisode(await gitCommonDir(dir)) } : {}),
        hostAlive: () => hostSessionAlive(dir),
        holds: () => joinedPresenceHolds(tools.joinedSessions()),
        leadsWorkers: () => joinedPresenceWorkers(tools.joinedSessions()),
        waiting: () => tools.waiting(),
        hostEnded: reason => { void bye(reason) },
        leave: async idle => { for (const joined of [...tools.joinedSessions()].reverse()) await tools.drop(joined, `idle ${Math.floor(idle / 60_000)} min with nothing held (idle lease)`) },
        releaseHeld: async (idle, epoch) => { for (const joined of tools.joinedSessions()) await releaseIdleHeld(joined, epoch, idle, presence!.mono) },
        replayPending: async () => { for (const joined of tools.joinedSessions()) await releaseIdleHeld(joined, 'replay', presence!.idleMs(), presence!.mono, true) },
        publishIdle: minutes => { for (const joined of tools.joinedSessions()) try { joined.awareness.setLocalStateField('idleMin', minutes) } catch { /* leaving */ } },
        log,
      })
      rebindHost = async nextId => {
        if (rebinding) return rebinding
        const joined = tools.joinedSessions()
        const primary = joined[0]
        if (!primary || primary.lease?.sessionId === nextId) return
        rebinding = (async () => {
          log(`host session changed from ${primary.lease?.sessionId ?? '?'} to ${nextId}; rebinding room leases`)
          for (const old of [...joined].reverse()) await tools.drop(old, 'host session rebound')
          const fresh = await joinSession({ ...rejoinOptions(primary, startup.credentialsPath), sessionId: nextId, log })
          await adopt(fresh, false)
          for (const old of joined.slice(1)) {
            const secondary = await joinSession({ ...rejoinOptions(old, startup.credentialsPath), sessionId: nextId, log })
            tools.attachWorkersRoom(secondary, fresh)
          }
        })().finally(() => { rebinding = undefined })
        return rebinding
      }
      const call = async (req: { params: { name: string; arguments?: Record<string, unknown> } }, signal?: AbortSignal, handoff?: (settle: Settle) => void) => {
        const bound = sessionBinding.bound()
        if (bound && session?.lease && bound.id !== session.lease.sessionId) await rebindHost(bound.id)
        else if (rebinding) await rebinding
        const away = presence!.hasLeft
        const idle = presence!.activity()
        await (currentToolTiming()?.phase('settle', () => autoJoin.settle()) ?? autoJoin.settle()) // a join in progress decides which session the reply is about
        const body = await tools.call(req.params.name, req.params.arguments ?? {}, signal, handoff)
        const updateNotice = bundleUpdateNotice()
        const rejoined = away && session ? `[room] rejoined ${decodeRoom(session.roomName)} as ${displayName(session.me)} after ${Math.floor(idle / 60_000)} min idle` : ''
        return (rejoined ? rejoined + '\n\n' : '') + (updateNotice ? updateNotice + '\n\n' : '') + body
      }

      const joined = (s: Session) => { s.onHookActivity?.(() => presence?.activity()); s.onRebind?.(id => { void rebindHost(id).catch(error => log(`host rebind failed: ${String(error)}`)) }); log(`${displayName(s.me)} joined ${decodeRoom(s.roomName)} (clone ${s.dir})`) }

      // Auto-join when the repo already has a room: the runner's ROOM_URL, a prior .room.json, or
      // simply a clone with a git origin. A repo nobody has opened waits for room_create.
      const chosen = startup.server
      log(`room: ${startup.where.replace(/\?.*$/, '')} (${startup.whereRule === 'env' ? (startup as typeof startup & { whereEnv?: string }).whereEnv ?? 'ROOM_SERVER' : startup.whereRule === 'remembered' ? 'remembered in this clone' : 'default: nothing configured'})`)
      const autoJoin = new AutoJoin({
        local: chosen === LOCAL,
        log,
        async attempt(target) {
          const root = await joinableRoot(dir)
          // A session whose relay was taken by another clone's relay cannot reconnect on the same URL: leave it and join afresh.
          if (session?.local?.lost) await tools.drop(session, session.local.lost)
          // After room_join/room_create, keep the repository room the human chose.
          if (target) {
            const s = await joinSession({ ...rejoinOptions(target, startup.credentialsPath), log })
            return s
          }
          // The clone's origin decides the repository room. ROOM_URL (runner) or a
          // prior .room.json only fill in when the clone has no origin.
          const options = await startupJoinOptions(root, chosen, startup.room)
          if (options) return joinSession({ ...options, log })
          log(`ready; ${dir} has no git origin — call room_join with a room name`)
          return undefined
        },
        async adopt(s) { await adopt(s); log('ready') },
        discard: s => leaveSession(s),
        joined: () => !!session && !session.local?.lost,
        report(line) {
          tools.startupNotice(line)
          log(line)
        },
      })
      tools.setAutoJoin(autoJoin)
      if (!signal.aborted) void autoJoin.ensure()

      return { call, shutdown: async (signal?: boolean) => {
        presence.stop(); autoJoin.cancel()
        if (!signal) await autoJoin.settle()
        await tools.shutdown()
        await arbitration.close()
      } }
    },
  })

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: DEFS }))
  // The reply's ledger batch commits when its bytes reach the host's pipe (FlushedStdioTransport).
  const transport = new FlushedStdioTransport()
  mcp.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    extra.signal.addEventListener('abort', () => transport.forget(extra.requestId), { once: true })
    const result = await timing.run(req.params.name, () => binding.run(req.params, runtime => runtime.call(req, extra.signal, settle => transport.expect(extra.requestId, settle))))
    return { content: [{ type: 'text' as const, text: result.error ?? result.value! }], ...(result.error ? { isError: true } : {}) }
  })

  const bye = async (reason: string) => {
    if (closing) return
    closing = true
    watchdog.stop()
    await finishSignalShutdown(reason, async () => { await (await binding.close())?.shutdown(reason === 'SIGTERM' || reason === 'SIGINT') }, log, () => process.exit(0))
  }
  process.on('SIGINT', () => { void bye('SIGINT') }); process.on('SIGTERM', () => { void bye('SIGTERM') })
  mcp.onclose = () => { void bye('stdin/transport closed') }
  process.stdin.on('end', () => { void bye('stdin closed') })

  // The definitions are static; a shared Codex daemon needs no directory-bound state until a call.
  try {
    await mcp.connect(transport)
    await binding.start()
  } catch (error) {
    if (!closing) throw error // non-deferred startup keeps its fatal exit policy
  }
}

/** Give signal cleanup a bounded chance to end leases and clear awareness before process exit. */
export async function finishSignalShutdown(reason: string, leave: () => Promise<void>, report: (line: string) => void, exit: () => void, limitMs = 4_000): Promise<void> {
  report(`stopping: ${reason}`)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const completed = await Promise.race([leave().then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), limitMs) })])
    if (!completed) report(`shutdown timed out after ${limitMs}ms: ${reason}`)
  } catch (error) { report(`shutdown error: ${error instanceof Error ? error.message : String(error)}`) }
  finally { if (timer) clearTimeout(timer) }
  report(`stopped: ${reason}`)
  exit()
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
  if (process.argv[2] === 'doctor') {
    const flag = process.argv.indexOf('--dir')
    const dir = flag >= 0 && process.argv[flag + 1] ? process.argv[flag + 1] : process.cwd()
    runDoctor(dir).then(report => { process.stdout.write(report + '\n'); process.exitCode = /^FAIL  /m.test(report) ? 1 : 0 }).catch(error => fatal('doctor failed', error))
  } else main().catch(error => fatal('startup failed', error))
}
