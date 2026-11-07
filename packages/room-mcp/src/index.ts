#!/usr/bin/env tsx
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { RoomMcpServer } from './mcp-server.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { displayName } from '@room/shared'
import { createTools, DEFS } from './tools.js'
import { AGENT_INSTRUCTIONS } from './prompt.js'
import { LOCAL, createLocalReplica, disposeLocalReplica, decodeRoom, detachCheckout, joinSession, leaveSession, startupJoinOptions, type Session } from './session.js'
import { StaleReplacement, rejoinWhenStale } from './compacted.js'
import { joinableRoot, sameFolder } from './repository.js'
import { AutoJoin } from './auto-join.js'
import { gitCommonDir } from '@room/roomd'
import { primePrivateState } from '@room/relay'
import { resolveConfig } from './config.js'
import { createMidTurnSender, createWakeSender } from './wake-path.js'
import { CodexTurnProbe } from './codex-turn.js'
import { adoptLocalReplica, explicitLocalReplica, offerTeamSharingDisclosure, rejoinOptions } from './tools/join.js'
import type { Settle } from './tools/index.js'
import type { WorkerStopCause } from './worker-status.js'
import { FlushedStdioTransport } from './transport.js'
import { admitCodexThread } from './session.js'
import { CODEX_WORKER_BIND_WAIT_MS, createSessionBinding, isCodexExecWorker } from './binding.js'
import { startArbitration } from './arbitration.js'
import { codexWorkspace, createWorkspaceBinding, deferForSharedCodex, fallbackWorkspace } from './workspace.js'
import { PresenceEnd, attachingParentReader, hostKind, hostSessionAlive, idleLeaseTickMs, joinedPresenceHolds, joinedPresenceWorkers, nextIdleEpisode, releaseIdleHeld, resolveIdleLeaseMs } from './presence-end.js'
import pluginManifest from '../../../plugins/room/.claude-plugin/plugin.json' with { type: 'json' }
import { runDoctor } from './doctor.js'
import { admitWorkerEnvironment, admittedWorker } from './worker-registry.js'
import { ToolTimingTracker, currentToolTiming, registerPrepareGitTiming, startEventLoopWatchdog } from './timing.js'
import { CpuWatchdog, setLatestCpuProfile } from './cpu-watchdog.js'
import { codexPreBinding as callMetadata } from './hosts/codex-binding.js'
import { channelCapabilities } from './hosts/claude-binding.js'
import { resolveDaemonCutover } from './daemon-cutover.js'

/** Plugin release, also advertised in the MCP handshake. Package versions are private. */
export const RELEASE_VERSION = pluginManifest.version

export { AGENT_INSTRUCTIONS } from './prompt.js'
export { createTools, DEFS } from './tools.js'
export type { ToolCtx, ToolDef, Tools } from './tools.js'
export { joinSession, leaveSession, createRoom, closeRoom, NoRoom, NotLoggedIn, deriveRoomName, findRoomFile, encodeRoom, decodeRoom, parseServer, serverAuthMode, serverShareMax, requestedShare, resolveAuth, startLogin, pollLogin, logout } from './session.js'
export { credentialsPath, getCredential, setCredential, removeCredential } from './credentials.js'
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
// The clone's git common dir, read through the session binding so a repository created after startup is found.
let roomLogDir: () => string | undefined = () => undefined
const log = (s: string) => {
  try { fs.writeSync(2, `room-mcp: ${s}\n`) } catch { /* stderr may already be closed */ }
  const at = new Date().toISOString()
  if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, `${at} ${s}\n`) } catch { /* best effort */ } }
  const common = roomLogDir()
  if (common) appendRoomLog(path.join(common, ROOM_LOG), `${at} pid ${process.pid}${process.env.ROOM_TAG ? ` ${process.env.ROOM_TAG}` : ''}: ${s}`)
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
  const cpu = new CpuWatchdog({ busy: () => timing.busy, activity: () => timing.activity, log, profileDir: () => { const common = roomLogDir(); return common ? path.join(common, 'room', 'profiles') : undefined } })
  const watchdog = startEventLoopWatchdog(timing, { log, onTick: () => { void cpu.sample() } })
  setLatestCpuProfile(() => cpu.latest)
  const bundleUpdateNotice = createBundleUpdateNotice(process.argv[1] ?? '')
  const mcp = new RoomMcpServer(
    { name: 'room', version: RELEASE_VERSION },
    { capabilities: { tools: {}, experimental: channelCapabilities }, instructions: AGENT_INSTRUCTIONS() },
  )
  let initialized: { dir: string; call: (req: { params: { name: string; arguments?: Record<string, unknown> } }, signal?: AbortSignal, handoff?: (settle: Settle) => void) => Promise<string> } | undefined
  const binding = createWorkspaceBinding({
    deferred: deferForSharedCodex(process.env), fallbackDir: () => fallbackWorkspace(process.env, process.cwd()),
    logFallback: () => log('call has no workspace metadata; using ROOM_DIR/PWD/INIT_CWD/process.cwd() fallback'),
    logFailure: error => log(`workspace initialization failed: ${error instanceof Error ? error.message : String(error)}`),
    initialize: async (dir: string, signal: AbortSignal) => {
      let session: Session | null = null
      // The startup choice only: environment is fixed for the process, and room_join/room_close/joinSession re-resolve it.
      // Resolve and prime while config reads are already awaiting Git; a deferred workspace stays unbound until a call.
      const privacy = gitCommonDir(dir).catch(() => undefined).then(common => common ? primePrivateState(common) : undefined)
      const [startup] = await Promise.all([resolveConfig({ dir, env: process.env }), privacy])
      if (signal.aborted) throw new Error('Room is shutting down')
      LOG_FILE = startup.logFile
      const sessionBinding = createSessionBinding(dir)
      roomLogDir = () => sessionBinding.commonDir()
      let rebinding: Promise<void> | undefined
      let rebindHost: (sessionId: string) => Promise<void> = async () => {}
      // Content-free wakes: Codex active-turn output or idle queue; Claude inbox or channel.
      const wake = createWakeSender({ channel: startup.claudeChannel, notify: notification => mcp.notification(notification) })
      let presence: PresenceEnd | undefined
      const midTurn = createMidTurnSender({ log, clientVersion: RELEASE_VERSION })
      const wakeProbe = new CodexTurnProbe({ contactAgeMs: () => presence?.idleMs(), clientVersion: RELEASE_VERSION })
      let startupReplica = startup.server === LOCAL ? createLocalReplica() : undefined
      const tools = createTools({ join: async opts => {
        if (!session && opts.server === LOCAL) {
          startupReplica = await explicitLocalReplica(opts, startupReplica)
          return joinSession({ ...opts, localReplica: startupReplica })
        }
        return joinSession(opts)
      }, completionReady: async () => {
        const bound = sessionBinding.bound()
        if (bound && session?.lease && bound.id !== session.lease.sessionId) await rebindHost(bound.id)
        else if (rebinding) await rebinding
      }, getSession: () => session, setSession: s => { session = s; if (s) { replacement.forget(); joined(s) } }, cwd: dir, config: startup, wake, midTurn, wakeProbe, binding: sessionBinding, log })
      // A replica the server refused after a compacting restart is replaced inside the auto-join (compacted.ts).
      const replacement = new StaleReplacement({ joinedSessions: () => tools.joinedSessions(), drop: (s, why) => tools.drop(s, why),
        attachWorkersRoom: (s, lead) => tools.attachWorkersRoom(s, lead), credentialsPath: startup.credentialsPath, log })
      // The hooks take message content only from this endpoint, never from a file.
      const arbitration = await startArbitration({ binding: sessionBinding, ledger: tools.ledger, select: () => tools.hookSelect(),
        canSelect: () => !rebinding && !!session?.lease?.fence() && session.lease.sessionId === sessionBinding.bound()?.id,
        onContact: () => presence?.activity(), log, worker: admittedWorker })
      const adopt = async (s: Session, clearStale = true) => {
        // Offered before any tool call, so the first hook or reply can hand it off.
        await offerTeamSharingDisclosure(s, tools.ledger)
        await tools.prepareNotices(s)
        session = s
        joined(s)
        tools.attachHooks(s)
        if (clearStale) {
          const n = tools.clearStale(s)
          if (n) log(`cleared ${n} stale claim(s) from an earlier session`)
        }
      }

      // Presence ends once the host session has finished (registry §18): its process gone, or the idle lease.
      // Host kind, parent and lease come from this process's parent and environment, which never change while it lives.
      const presenceHostKind = hostKind()
      const attachingParent = attachingParentReader()
      const idleLeaseMs = resolveIdleLeaseMs(process.env.ROOM_IDLE_LEASE_MS)
      presence = new PresenceEnd({
        hostKind: presenceHostKind,
        idleLeaseMs,
        tickMs: idleLeaseTickMs(idleLeaseMs),
        ...(presenceHostKind === 'shared-app-server' ? { episodeId: await nextIdleEpisode(await gitCommonDir(dir)) } : {}),
        hostAlive: () => hostSessionAlive(dir, attachingParent()),
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
          const reuse = new Map(joined.map(old => [old, detachCheckout(old)]))
          try {
            for (const old of [...joined].reverse()) await tools.drop(old, 'host session rebound')
            const fresh = await joinSession({ ...rejoinOptions(primary, startup.credentialsPath), reuse: reuse.get(primary), sessionId: nextId, log })
            await adopt(fresh, false)
            for (const old of joined.slice(1)) {
              const secondary = await joinSession({ ...rejoinOptions(old, startup.credentialsPath), reuse: reuse.get(old), sessionId: nextId, log })
              tools.attachWorkersRoom(secondary, fresh)
            }
          } finally { await Promise.all([...reuse.values()].map(value => value.watcher?.dispose())) }
        })().finally(() => { rebinding = undefined })
        return rebinding
      }
      const call = async (req: { params: { name: string; arguments?: Record<string, unknown> } }, signal?: AbortSignal, handoff?: (settle: Settle) => void) => {
        // Completion bypasses lease rebinding, but must retain a thread discovered since admission.
        if (req.params.name === 'room_done' && process.env.ROOM_WORKER_ID) {
          await admitWorkerEnvironment(dir, process.env, createSessionBinding(dir).bound())
        }
        if (req.params.name === 'room_done' || req.params.name === 'room_state' && req.params.arguments?.check === true) {
          if (req.params.name === 'room_done') presence!.activity()
          return tools.call(req.params.name, req.params.arguments ?? {}, signal, handoff)
        }
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

      const joined = (s: Session) => {
        startupReplica = adoptLocalReplica(startupReplica, s.localReplica)
        autoJoin.remember(s)
        s.onHookActivity?.(() => presence?.activity()); s.onRebind?.(id => { void rebindHost(id).catch(error => log(`host rebind failed: ${String(error)}`)) })
        rejoinWhenStale(s, () => session, autoJoin)
        log(`${displayName(s.me)} joined ${decodeRoom(s.roomName)} (clone ${s.dir})`)
      }

      // Auto-join when the repo already has a room: the runner's ROOM_URL, a prior .room.json, or
      // simply a clone with a git origin. A repo nobody has opened waits for room_create.
      const chosen = startup.server
      log(`room: ${startup.where.replace(/\?.*$/, '')} (${startup.whereRule === 'env' ? (startup as typeof startup & { whereEnv?: string }).whereEnv ?? 'ROOM_SERVER' : startup.whereRule === 'remembered' ? 'remembered in this clone' : 'default: nothing configured'})`)
      const autoJoin = new AutoJoin({
        local: chosen === LOCAL,
        log,
        // Joining before the thread id is known would rebind (leave and rejoin) as soon as it arrives.
        ...(isCodexExecWorker() ? { bindWait: { bound: () => !!sessionBinding.bound(), ms: CODEX_WORKER_BIND_WAIT_MS } } : {}),
        async attempt(target) {
          const root = await joinableRoot(dir)
          if (await replacement.begin(session)) return replacement.join()
          if (session?.local) {
            await session.recoverLocal?.()
            if (!session.provider.wsconnected || !session.provider.synced) throw new Error('local daemon is reconnecting; keeping this session and its replica')
            return session
          }
          // Reconnect with the latest accepted session, including its current sharing choice.
          if (target) {
            const reuse = session ? undefined : detachCheckout(target)
            const s = await joinSession({ ...rejoinOptions(target, startup.credentialsPath), localReplica: target.localReplica, reuse, log })
            return s
          }
          // The clone's origin decides the repository room. ROOM_URL (runner) or a
          // prior .room.json only fill in when the clone has no origin.
          const options = await startupJoinOptions(root, chosen, startup.room)
          if (options) return joinSession({ ...options, localReplica: startupReplica, log })
          log(`ready; ${dir} has no git origin — call room_join with a room name`)
          return undefined
        },
        async adopt(s) { if (s === session) return; if (replacement.active) await replacement.finish(s, adopt); else await adopt(s); log('ready') },
        onCancel: target => { if (!session) disposeLocalReplica(target?.localReplica ?? startupReplica) },
        discard: async (s, reason) => { if (s === session && reason !== 'leave') return; const unsaved = await leaveSession(s, { preserveReplica: reason !== 'leave' }); if (unsaved) log(`WARN: ${unsaved}`) },
        joined: () => !!session && !session.stale && (!session.local || !!session.closed || session.provider.wsconnected && session.provider.synced),
        report(line) {
          tools.startupNotice(line)
          log(line)
        },
      })
      tools.setAutoJoin(autoJoin)
      if (!signal.aborted) void autoJoin.ensure()

      const runtime = { call, shutdown: async (reason?: WorkerStopCause, progress: (phase: string) => void = () => {}) => {
        presence.stop(); autoJoin.cancel({ explicitLeave: false })
        if (reason !== 'SIGTERM' && reason !== 'SIGINT') { progress('settling auto-join'); await autoJoin.settle() }
        await tools.shutdown(reason, progress)
        progress('closing arbitration')
        await arbitration.close()
      } }
      initialized = { dir, call }
      return runtime
    },
  })

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: DEFS }))
  // The reply's ledger batch commits when its bytes reach the host's pipe (FlushedStdioTransport).
  const transport = new FlushedStdioTransport()
  mcp.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const threadId = callMetadata.decodeCall(req.params._meta).toolSessionId
    if (threadId) admitCodexThread(threadId)
    extra.signal.addEventListener('abort', () => transport.forget(extra.requestId), { once: true })
    const result = await timing.run(req.params.name, async () => {
      if (req.params.name === 'room_state' && req.params.arguments?.check === true) {
        const dir = codexWorkspace(req.params) ?? fallbackWorkspace(process.env, process.cwd())
        const active = initialized
        if (active) {
          const [requestedRoot, activeRoot] = await Promise.all([joinableRoot(dir).catch(() => dir), joinableRoot(active.dir).catch(() => active.dir)])
          if (sameFolder(requestedRoot, activeRoot)) return { value: await active.call(req, extra.signal, settle => transport.expect(extra.requestId, settle)), error: undefined }
        }
        return { value: await runDoctor(dir), error: undefined }
      }
      return binding.run(req.params, runtime => runtime.call(req, extra.signal, settle => transport.expect(extra.requestId, settle)))
    })
    return { content: [{ type: 'text' as const, text: result.error ?? result.value! }], ...(result.error ? { isError: true } : {}) }
  })

  const shutdownInterrupt = new AbortController()
  const bye = async (reason: string) => {
    if (closing) {
      if (reason === 'SIGINT' || reason === 'SIGTERM') shutdownInterrupt.abort(reason)
      return
    }
    closing = true
    watchdog.stop()
    const cause = reason === 'stdin closed' || reason === 'stdin/transport closed' || reason === 'SIGTERM' || reason === 'SIGINT' ? reason : undefined
    await finishSignalShutdown(reason, async progress => {
      progress('closing runtime binding')
      await (await binding.close())?.shutdown(cause, progress)
    }, log, () => process.exit(0), shutdownInterrupt.signal)
  }
  process.on('SIGINT', () => { void bye('SIGINT') }); process.on('SIGTERM', () => { void bye('SIGTERM') })
  mcp.onclose = () => { void bye(process.stdin.readableEnded ? 'stdin closed' : 'stdin/transport closed') }
  process.stdin.on('end', () => { void bye('stdin closed') })

  // The definitions are static; a shared Codex daemon needs no directory-bound state until a call.
  await mcp.connect(transport)
  try { await binding.start() } catch (error) {
    // A failed eager startup must leave the MCP alive so room_state({check:true}) can diagnose it.
    if (!closing) log(`startup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Give signal cleanup a bounded chance to end leases and clear awareness before process exit. */
export async function finishSignalShutdown(reason: string, leave: (progress: (phase: string) => void) => Promise<void>, report: (line: string) => void, exit: () => void, force?: AbortSignal): Promise<void> {
  report(`stopping: ${reason}`)
  let pending = 'session cleanup', timer: ReturnType<typeof setTimeout> | undefined
  let interrupt!: () => void
  const interrupted = new Promise<'forced'>(resolve => { interrupt = () => resolve('forced') })
  force?.addEventListener('abort', interrupt, { once: true })
  if (force?.aborted) interrupt()
  try {
    // The deadline bounds the entire exit path, including registry I/O and binding startup.
    // Do not manufacture completion facts: durable stop intent remains recovery evidence.
    const result = await Promise.race([
      Promise.resolve().then(() => leave(phase => { pending = phase })).then(() => 'complete' as const, error => ({ error })),
      new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), 4000) }),
      interrupted,
    ])
    if (result === 'complete') report(`stopped: ${reason}`)
    else if (result === 'timeout' || result === 'forced') {
      const cause = result === 'timeout' ? 'timed out after 4000ms' : `forced by ${String(force?.reason)}`
      report(`shutdown ${cause}: ${reason}; pending: ${pending}; stop records retained for recovery`)
    } else report(`shutdown error: ${result.error instanceof Error ? result.error.message : String(result.error)}; pending: ${pending}`)
  } finally {
    if (timer) clearTimeout(timer)
    force?.removeEventListener('abort', interrupt)
  }
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
  } else if (process.argv[2] === 'cutover-resolve') {
    const run = async () => {
      const { values } = parseArgs({ args: process.argv.slice(3), options: {
        dir: { type: 'string' }, record: { type: 'string' }, 'confirm-not-running': { type: 'boolean' }, note: { type: 'string' },
      } })
      await resolveDaemonCutover(await gitCommonDir(values.dir ?? process.cwd()), values.record ?? '', values['confirm-not-running'] === true, values.note)
      process.stdout.write('Cutover record resolved by operator. Changed evidence will be judged again.\n')
    }
    run().catch(error => fatal('cutover-resolve failed', error))
  } else main().catch(error => fatal('startup failed', error))
}
