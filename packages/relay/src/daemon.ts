/** Per-clone transport process and its non-owning client launcher. No shell or host identity. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CURRENT_COMPAT, parseAdvertisement, selectContract } from '@room/hub-core'
import { AuthorityLock } from './hub.js'
import { liveness, writeAtomic, type ProcessIdentity } from './leases.js'
import { probeOwnProcess } from './process.js'
import { localProofHeader, relayHealth, relayIdentity } from './proof.js'
import { cloneId, deterministicPort, relayFile, startRelay, type LocalRelay, type LocalRelayInfo, type StartedRelay } from './index.js'
import { verifyPrivatePath, privateStateDirectory } from './private-state.js'

declare const __ROOM_DAEMON_RELEASE__: string
const release = typeof __ROOM_DAEMON_RELEASE__ === 'string' ? __ROOM_DAEMON_RELEASE__ : 'development'

export const LOCAL_DAEMON_IDLE_MS = 5 * 60_000
export interface LocalDaemonOptions {
  entryPath?: string
  /** Source-tree fixture only; installed self-contained bundles require no Node flags. */
  execArgv?: string[]
  log?: (line: string) => void
  startupTimeoutMs?: number
  probeTimeoutMs?: number
}
export interface LocalDaemon extends LocalRelay {
  pid: number; runtime: 'daemon'; idleMs: number
  /** True only when this call's child won authority; adopted instances remain non-owning. */
  launched: boolean
}
export interface StartedLocalDaemon {
  info: LocalRelayInfo
  relay: StartedRelay
  /** Resolves only after durable save, socket teardown and authority release. */
  closed: Promise<void>
  close(): Promise<void>
}

/** Bounded, strict discovery reads: unreadable/invalid is never permission to rotate a key. */
function discovery(commonDir: string): LocalRelayInfo | undefined {
  const file = relayFile(commonDir)
  let raw: string
  try {
    if (fs.statSync(file).size > 8192) throw new Error('discovery exceeds size limit')
    verifyPrivatePath(file)
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
  let v: LocalRelayInfo
  try { v = JSON.parse(raw) as LocalRelayInfo }
  catch { throw new Error('invalid local relay discovery JSON; preserve and repair room/relay.json before restarting Room') }
  if (!v || v.schema !== 2 || !Number.isInteger(v.port) || v.port < 1 || v.port > 65535 || !Number.isInteger(v.pid) || v.pid < 1 || typeof v.key !== 'string' || !v.key || v.key.length > 256 || typeof v.room !== 'string' || !Number.isFinite(v.startedAt) || (v.discovery !== undefined && v.discovery !== 1)) throw new Error('invalid or unsupported local relay discovery; preserve it and repair before restarting Room')
  if (v.nonce !== undefined && (typeof v.nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(v.nonce))) throw new Error('invalid daemon identity nonce in discovery')
  if (v.compat !== undefined) parseAdvertisement(v.compat)
  if (v.runtime !== undefined && v.runtime !== 'daemon' && v.runtime !== 'session-relay') throw new Error('unsupported local runtime in discovery; update Room or repair the record')
  if (v.lead !== undefined && v.lead !== true && (!v.lead || typeof v.lead !== 'object' || !Number.isInteger(v.lead.pid) || v.lead.pid < 1 || typeof v.lead.startTime !== 'string' || !v.lead.startTime || typeof v.lead.executable !== 'string' || !v.lead.executable)) throw new Error('invalid discovery process identity; preserve and repair the record')
  return v
}

/** Zero writers starts the clock; viewers/pending sockets cannot postpone it. */
export class WriterIdleClock {
  private emptySince: number
  private writers = 0
  constructor(private readonly now: () => number, readonly idleMs = LOCAL_DAEMON_IDLE_MS) { this.emptySince = now() }
  changed(count: number): void { if (count === 0 && this.writers !== 0) this.emptySince = this.now(); this.writers = count }
  expired(): boolean { return this.writers === 0 && this.now() - this.emptySince >= this.idleMs }
}

/** Run in the child only. Losing contenders exit without ever publishing shared state. */
export async function startLocalDaemon(opts: {
  commonDir: string; room: string; idleMs?: number; idleCheckMs?: number; now?: () => number
  finalSaveRetryMs?: readonly number[]; retryMs?: number; log?: (line: string) => void
}): Promise<StartedLocalDaemon | undefined> {
  const commonDir = fs.realpathSync.native(opts.commonDir)
  const log = opts.log ?? (() => {})
  privateStateDirectory(path.join(commonDir, 'room'))
  const lock = AuthorityLock.take(commonDir)
  if (!lock) return undefined
  let relay: StartedRelay | undefined
  try {
    const previous = discovery(commonDir)
    const key = previous?.key ?? crypto.randomBytes(32).toString('hex')
    const own = probeOwnProcess()
    if (!own?.startTime || !own.executable) throw new Error('cannot establish daemon process birth identity')
    const identity: ProcessIdentity = { pid: process.pid, startTime: own.startTime, executable: own.executable }
    const clock = new WriterIdleClock(opts.now ?? Date.now, opts.idleMs)
    const startedAt = Date.now()
    const nonce = crypto.randomUUID()
    let ready = false
    let stopRequested = false
    let draining = false, stopping: Promise<void> | undefined, failure: string | undefined
    let nextRetry = 0, retryMs = opts.retryMs ?? 1000
    let resolveClosed!: () => void
    const closed = new Promise<void>(resolve => { resolveClosed = resolve })
    let timer: ReturnType<typeof setInterval> | undefined
    const close = (requested = true, saved?: () => void): Promise<void> => {
      if (requested) stopRequested = true
      // Fence synchronously in the idle callback, before lease flush/final-save awaits.
      if (stopping) return stopping
      draining = true; relay!.setDraining(true)
      stopping = relay!.close(saved).then(() => {
        if (timer) clearInterval(timer)
        resolveClosed()
      }).catch(error => {
        draining = false; relay!.setDraining(false); stopping = undefined
        failure = (error instanceof Error ? error.message : String(error)).slice(0, 256)
        log(`local daemon save blocked: ${failure}`)
        nextRetry = Date.now() + retryMs; retryMs = Math.min(60_000, retryMs * 2)
        throw error
      })
      return stopping
    }
    const health = (authenticated = false) => ({ ready, nonce, release, uptimeMs: Date.now() - startedAt, idleMs: clock.idleMs, draining, ...(failure ? { stopFailure: authenticated ? failure : failure.match(/\b(?:ENOSPC|EACCES|EIO|EPERM)\b/)?.[0] ?? 'save-blocked' } : {}) })
    const open = (port: number) => startRelay(port, { commonDir, key, hub: { lock }, log, finalSaveRetryMs: opts.finalSaveRetryMs,
      daemon: { health, onSignal: () => { void close().catch(() => {}) }, writersChanged: count => clock.changed(count), stop: async (pid, expectedNonce, saved) => {
        if (pid !== process.pid || expectedNonce !== nonce) throw new Error('local daemon identity changed; reread discovery before stopping')
        if (draining) throw new Error('local daemon is already draining; inspect status and retry')
        await close(false, saved)
      } } })
    const port = previous?.port ?? deterministicPort(commonDir)
    try { relay = await open(port) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      const occupant = await relayIdentity(port, key)
      if (occupant?.health.local === true && occupant.health.clone === cloneId(commonDir)) throw new Error(`local Room owner still answers on port ${port}; drain it before starting the daemon`)
      relay = await open(0)
    }
    relay.setDraining(true) // unpublished listeners cannot attach clients
    await relay.initialize(opts.room)
    const info: LocalRelayInfo = { schema: 2, discovery: 1, runtime: 'daemon', nonce, compat: { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, 'room.daemon': [1] } }, port: relay.port, pid: process.pid, room: opts.room, key, startedAt: Date.now(), lead: identity }
    writeAtomic(relayFile(commonDir), info)
    verifyPrivatePath(relayFile(commonDir), true)
    ready = true
    relay.setDraining(false)
    timer = setInterval(() => {
      if (!draining && (stopRequested || clock.expired()) && Date.now() >= nextRetry) void close(false).catch(() => {})
    }, opts.idleCheckMs ?? 1000)
    return { info, relay, closed, close }
  } catch (error) {
    // Before publication no writer can attach. Teardown still uses the save-first path.
    if (relay) {
      await relay.abortUnpublished()
    } else lock.release()
    throw error
  }
}

const flights = new Map<string, Promise<LocalDaemon>>()
/** Caller must already be repository-bound and validate worker clone ownership. No in-process fallback. */
export function ensureLocalDaemon(commonDir: string, room: string, opts: LocalDaemonOptions = {}): Promise<LocalDaemon> {
  const canonical = fs.realpathSync.native(commonDir)
  const running = flights.get(canonical)
  if (running) return running.then(() => ensure(canonical, room, opts))
  const work = ensure(canonical, room, opts).finally(() => { if (flights.get(canonical) === work) flights.delete(canonical) })
  flights.set(canonical, work)
  return work
}
async function ensure(commonDir: string, room: string, opts: LocalDaemonOptions): Promise<LocalDaemon> {
  privateStateDirectory(path.join(commonDir, 'room'))
  const ready = async (): Promise<LocalDaemon | undefined> => {
    const info = discovery(commonDir)
    if (!info) return undefined
    const health = await relayHealth(info.port, info.key, opts.probeTimeoutMs ?? 800)
    if (!health || health.clone !== cloneId(commonDir)) return undefined
    if (typeof health.pid !== 'number' || health.pid !== info.pid) throw new Error('local daemon discovery PID does not match the authenticated listener; retry discovery without taking over')
    if (health.runtime !== 'daemon') throw new Error(`local Room pid ${info.pid} on port ${info.port} uses an in-session runtime; drain all local clients and restart updated Room`)
    const offer = { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, 'room.daemon': [1] } }
    const contract = selectContract(offer, parseAdvertisement(health.compat), { activeSchema: 2, requiredCapabilities: { 'room.daemon': [1] } })
    if (!contract.ok) throw new Error(`local daemon incompatible: ${contract.error.text}; drain clients and restart compatible Room`)
    if (health.ready !== true || health.draining) return undefined
    return {
      url: `ws://127.0.0.1:${info.port}`, httpUrl: `http://127.0.0.1:${info.port}`, port: info.port, key: info.key, pid: health.pid, runtime: 'daemon', idleMs: Number(health.idleMs), owned: false, launched: false,
      async stop() {},
      async forget() {
        const target = `/memory?room=${encodeURIComponent(room)}`
        const response = await fetch(`http://127.0.0.1:${info.port}${target}`, { method: 'DELETE', headers: { Authorization: localProofHeader(info.key, 'DELETE', target, info.port) }, signal: AbortSignal.timeout(2500) })
        if (!response.ok) throw new Error(`could not forget local memory (${response.status})`)
      },
    }
  }
  const existing = await ready()
  if (existing) return existing
  const info = discovery(commonDir)
  if (info?.lead && info.lead !== true && liveness(info.lead) !== 'dead') throw new Error(`local daemon pid ${info.pid} is live or has unknown identity; retry without taking over`)
  const entry = opts.entryPath ?? fileURLToPath(new URL('./room-daemon.mjs', import.meta.url))
  if (!path.isAbsolute(entry) || !fs.statSync(entry).isFile()) throw new Error('local daemon entry must be an absolute installed bundle path')
  // Keep only OS/runtime basics. No ROOM_*, host identities, NODE_OPTIONS or credentials.
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TZ']) if (process.env[name] !== undefined) env[name] = process.env[name]
  const child = spawn(process.execPath, [...(opts.execArgv ?? []), entry, '--common-dir', commonDir, '--room', room], { cwd: commonDir, env, shell: false, detached: true, windowsHide: true, stdio: 'ignore' })
  let launchError: Error | undefined, exited = false
  child.once('error', error => { launchError = error })
  child.once('exit', () => { exited = true })
  child.unref()
  const until = Date.now() + (opts.startupTimeoutMs ?? 10_000)
  do {
    const winner = await ready()
    if (winner) return { ...winner, launched: winner.pid === child.pid }
    if (launchError) throw new Error(`local daemon launch unavailable: ${launchError.message}`)
    // A losing contender can exit before the lock winner publishes; wait for winner readiness.
    if (exited && Date.now() + 250 >= until) break
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < until)
  throw new Error(`local daemon startup unavailable${child.pid ? ` (child pid ${child.pid})` : ''}; inspect the private room/daemon.log and authority owner; retry after repair`)
}

/** Drained maintenance only: authenticate the exact discovery instance, save, then verify its exit. */
export async function stopLocalDaemon(commonDir: string, timeoutMs = 15_000, expectedNonce?: string): Promise<void | 'different daemon instance'> {
  const canonical = fs.realpathSync.native(commonDir)
  const info = discovery(canonical)
  if (expectedNonce !== undefined && info?.nonce !== expectedNonce) return 'different daemon instance'
  if (!info || info.runtime !== 'daemon' || !info.nonce || !info.lead || info.lead === true || info.lead.pid !== info.pid) throw new Error('no verifiable daemon identity in discovery; preserve state and inspect before stopping')
  const health = await relayHealth(info.port, info.key)
  if (!health || health.clone !== cloneId(canonical) || health.runtime !== 'daemon' || health.pid !== info.pid || health.nonce !== info.nonce) throw new Error('local daemon identity could not be authenticated; refusing stop')
  const verifyUntil = Date.now() + Math.min(5000, timeoutMs)
  let alive = liveness(info.lead)
  while (alive === 'unknown' && Date.now() < verifyUntil) {
    await new Promise(resolve => setTimeout(resolve, 100))
    alive = liveness(info.lead)
  }
  if (alive !== 'alive') throw new Error('local daemon birth identity is not verified alive; refusing stop')
  const target = `/daemon/stop?pid=${info.pid}&nonce=${encodeURIComponent(info.nonce)}`
  const response = await fetch(`http://127.0.0.1:${info.port}${target}`, { method: 'POST', headers: { Authorization: localProofHeader(info.key, 'POST', target, info.port) }, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`local daemon stop refused: ${(await response.text()).slice(0, 2048)}`)
  const result = await response.json() as { saved?: boolean }
  if (result.saved !== true) throw new Error('local daemon did not confirm final save')
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (liveness(info.lead) === 'dead') return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('daemon saved but process exit could not be verified; keep old clients stopped and inspect its identity')
}
