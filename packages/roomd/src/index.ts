/**
 * roomd — push-only publisher from one git clone to one person's room overlay.
 *
 * Other participants' overlays are coordination context only. They never write
 * into this clone.
 */
import { readRoomFile, roomFilePath } from './room-file.js'
export { validRepoPath, isInsideRoot, containedRepoPath, MATERIALIZED_PATH, DISK_READ_PATH, LINK_INPUT_PATH, RECORDED_PATH, CARRIED_PATH, type RepoPathSyntax, type RepoLeafPolicy, type RepoContainmentOptions } from './repo-path.js'
export { readRoomFile, roomFilePath, type RoomFile } from './room-file.js'
import { commonGitDirFromDotGit, worktreeGitDirFromDotGit } from './git-dirs.js'
export { worktreeGitDirFromDotGit, worktreeGitDirSync, commonGitDirFromDotGit, gitCommonDir, realGitCommonDir } from './git-dirs.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DiskBatch } from './disk-batch.js'
import { CoalescedPoll } from './poll.js'
import { Publisher, type PreparedPublication } from './publisher.js'
import { StalePublication } from './disk-scan.js'
import { markManifestIncomplete } from './manifest-publish.js'
import { authorizesText, rulesFromText, defaultIgnoredPath, DEFAULT_IGNORED_DIRS, type SharingPolicy, type PublicationInputs, type PlannedEntry } from './policy.js'
import type { ShareLevel } from './share-level.js'
export { SHARE_LEVELS, parseShare, clampShare, type ShareLevel } from './share-level.js'
export { policyFromLevel, authorizesText, rulesFromText, plan, defaultIgnoredPath, DEFAULT_IGNORED_DIRS, type SharingPolicy, type PublicationInputs, type ExclusionRules } from './policy.js'
import { WebSocket } from 'ws'
import { WebsocketProvider } from 'y-websocket'
import { claimDigest, reanchorClaims, type ClaimMove, type ClaimRelease, type ClaimSearchProgress } from './reanchor.js'
import type { Claim, ParticipantGit, PushedMsg, ReleaseMsg } from '@room/shared'
import * as Y from 'yjs'
import chokidar, { type FSWatcher } from 'chokidar'
import { RoomDoc, assertValidParticipantName, claimReleaseText, colorFor, holderFence, isRegenerableBuildPath, manifestKey, manifestPaths, newId, participantRecord, type Identity, type Kind, type Msg, type NoteMsg, type PostBody, type Presence } from '@room/shared'

import { parseRoomIgnore, type RoomIgnore } from './roomignore.js'
import { carriesWork, workerBaseline, type Baseline, type BaselineSource } from './baseline.js'
import { git, gitBlobInfoMany, gitBranch, gitChanged, gitHead, gitIgnored, gitPathsBetween, gitShowMany, gitTracked } from './git.js'
import { pushedFacts, pushedRange, readBaseRefs, refsKey, resolveBase, roomRemote, type BaseInputs, type ResolvedBase } from './base.js'
export { comparePair, ensureCommit, readBaseRefs, resolveBase, roomRemote, type BaseInputs, type BaseRefs, type ResolvedBase } from './base.js'

/** Keep event emitters and timers from leaking both sync throws and rejected promises. */
export function observeCallback(fn: () => unknown, report: (error: unknown) => void): void {
  void Promise.resolve().then(fn).catch(report)
}

/**
 * How much of this clone the daemon publishes.
 *  - intent: presence, scope, claims, plans and bus only; no file text at all.
 *  - declared: overlays only for paths under the person's declared scope paths; the rest is withheld.
 *  - full: every changed file (the original behaviour).
 */
/** Presence as this daemon publishes it: the shared Presence plus the sharing level. */
export type SharePresence = Presence & { share?: ShareLevel }
export { claimDigest } from './reanchor.js'

const machineHostname = os.hostname()
const machineIdentities = new Map<string, string>()
let machineIdentityWarningLogged = false

/** Stable per-machine salt; an override keeps tests away from the user's config dir. */
function machineIdentity(log: (line: string) => void): string {
  if (process.env.ROOM_MACHINE_ID) return process.env.ROOM_MACHINE_ID
  const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'room', 'machine-id')
  const cached = machineIdentities.get(file)
  if (cached) return cached
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    // Publish the fully written file atomically so racing daemons never read a blank id.
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}`
    try {
      fs.writeFileSync(temporary, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 })
      try { fs.linkSync(temporary, file) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    } finally {
      try { fs.rmSync(temporary, { force: true }) } catch { /* best effort */ }
    }
    const id = fs.readFileSync(file, 'utf8').trim()
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid machine-id file')
    machineIdentities.set(file, id)
    return id
  } catch (error) {
    machineIdentities.set(file, machineHostname)
    if (!machineIdentityWarningLogged) {
      machineIdentityWarningLogged = true
      try { log(`machine id unavailable (${error instanceof Error ? error.message : String(error)}); using hostname for checkout identity`) } catch { /* logging must not break join */ }
    }
    return machineHostname
  }
}

export interface RoomdOptions {
  /** Full room URL, e.g. ws://host:1234/my-room */
  room: string
  /** Path to the git clone. */
  dir: string
  /** Person whose overlay this daemon publishes. */
  name: string
  /** Presence kind to publish; 'agent' when embedded in the MCP server. Default 'human'. */
  kind?: Kind
  /** Verified login responsible for this participant (see Identity.owner). Default: name. */
  owner?: string
  /** Display hint, e.g. the tag of a second agent. */
  label?: string
  host?: string
  model?: string
  effort?: string
  /** Shared room token, sent as ?token= on the websocket. Default: ROOM_TOKEN env. */
  token?: string
  /** Room session id from GitHub device login, sent as ?session= (servers with GITHUB_CLIENT_ID). */
  session?: string
  /** The bound host session (registry §17): published in presence, where it makes the holder fresh. */
  sessionId?: string
  /**
   * The name lease (registry §15, hub §4.1): the fence this daemon's records carry, its hub epoch, while
   * the lease is good; undefined while paused (hub §7), when no fenced write goes out. A new value is a
   * new incarnation: the next transition republishes everything under it. Without it (the standalone
   * CLI, tests) the daemon fences on its session id, or an id of its own.
   */
  lease?: () => string | undefined
  /** A worker daemon's carried baseline from its lead's registry record. */
  carried?: BaselineSource
  /** Local relay key (room/relay.json): sent as ?key= so only sessions that can read the clone's git dir connect. */
  localKey?: string
  log?: (line: string) => void
  /** Test hook: awaited inside the publish path after the base text is read, before the room is written. */
  beforePublishWrite?: (relpath: string) => Promise<void>
  /** Test hook: await before using a path's base text. */
  beforeBaseRead?: (relpath: string) => Promise<void>
  /** Test hook: called after a watched disk change has finished processing, including skipped files. */
  onScanned?: (relpath: string) => void
  /** Max time to wait for the initial sync; default 15s. */
  connectTimeoutMs?: number
  /** Max time for the whole startup (git reads, sync, seed, watcher); default 60s. */
  startupTimeoutMs?: number
  /** Overrides for tests. */
  debounceMs?: number
  /** Test override for hot-file throttling. */
  hotThrottleMs?: number
  trackedRefreshMs?: number
  /** How often to check whether local HEAD moved (commit/pull); default 3s. */
  basePollMs?: number
  /** Per-file cap in bytes; larger files are skipped. Default 512 KB. */
  sizeCap?: number
  /** Total text this person shares across all files; files that would exceed it are skipped. Default 8 MB. */
  totalBudget?: number
  /** Immutable requested/effective policy supplied by the local PolicyStore. */
  policy: SharingPolicy
  /**
   * Posts through the room's hub, the sole appender of its bus (room-mcp post.ts). This daemon's posts are
   * automatic (released claims, `pushed`). Without one (the standalone CLI has no hub client) they are only logged.
   * The result, awaited for `pushed`, is the hub's answer: `{ ok: false }` or undefined means it was not taken.
   */
  post?: (from: Identity, body: PostBody<Msg>, opts: { id?: string; auto: true }) => unknown
  /** Settles durable departing grants after a successful full scan. */
  onFullScan?: (policy: SharingPolicy, entries: ReadonlyMap<string, PlannedEntry>, unsettled: readonly string[]) => Promise<void>
  /** In-memory transport override for tests that cannot open loopback sockets. */
  providerFactory?: (serverUrl: string, roomName: string, doc: Y.Doc) => WebsocketProvider
  /** Test scheduler for remote repair; callback is awaited by the test without a wall clock. */
  remoteRepairSchedule?: (run: () => Promise<void>) => () => void
  /** Test hook after the seed scan, before the watcher is established. */
  beforeWatcherReady?: () => void
  /** Slow Git-state reconciliation interval; default 60s. */
  reconcileIntervalMs?: number
  /** Test scheduler for the periodic reconciliation. */
  periodicReconcileSchedule?: (run: () => void, intervalMs: number) => () => void
  /** After startup, skipped files are logged as one count per this window; default 10s. */
  skipLogMs?: number
}

export interface Skipped { size: string[]; budget: string[]; ignore: string[] }

export interface Roomd {
  stop(reason?: string): Promise<void>
  /** Pause all fenced publication after a server size-cap rejection. */
  setPublicationRejected(rejected: boolean): void
  reconcileGitChanges(): Promise<void>
  /** Recheck branch-room claims reclaimed after this daemon's initial HEAD transition. */
  validateMigratedClaims(): Promise<void>
  /** Test barrier for already-observed watcher events: drains debounces and in-flight disk publishes. */
  settle(): Promise<void>
  touch(): void
  readonly dir: string
  readonly name: string
  readonly roomDoc: RoomDoc
  readonly provider: WebsocketProvider
  readonly branch: string
  readonly base: string
  /** This participant's base (reporooms §B3): what its `git` record announces and teammates compare with. */
  readonly anchor: { base: string; anchored: boolean }
  readonly share: ShareLevel
  readonly inputs: PublicationInputs
  readonly fence: string | undefined
  /** Atomically narrow old publication under a new input snapshot, then queue a full scan. */
  applyInputs(next: PublicationInputs): void
  rememberClaimDigest(id: string, digest: string): void
  /** Files excluded by size, budget or ignore rules. */
  skipped(): Skipped
}

export class RoomdError extends Error {
  constructor(message: string, public readonly code: number) {
    super(message)
    this.name = 'RoomdError'
  }
}

const ROOM_FILE = '.room.json'
const ROOMIGNORE = '.roomignore'

export function tokenParams(token?: string): Record<string, string> {
  const t = token?.trim()
  return t ? { token: t } : {}
}

export function splitRoomUrl(room: string): { serverUrl: string; roomName: string } {
  const url = new URL(room)
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length === 0) throw new RoomdError(`room URL must end with /<room>: ${room}`, 1)
  const roomName = parts.pop()!
  url.pathname = parts.length ? '/' + parts.join('/') : ''
  return { serverUrl: url.toString().replace(/\/$/, ''), roomName }
}

/** Tag an error with the join step that threw it (relay, sync, git, seed, watch); the join failure line names it. */
export async function inPhase<T>(phase: string, work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) {
    if (error instanceof Error && !('phase' in error)) Object.assign(error, { phase })
    throw error
  }
}

export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000

export async function startRoomd(options: RoomdOptions): Promise<Roomd> {
  const daemon = new Daemon(options)
  const limit = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(() => reject(Object.assign(new RoomdError(`startup did not finish within ${Math.round(limit / 1000)}s`, 1), { phase: daemon.phase })), limit)
    }
    daemon.onSeedProgress = reset
    reset()
  })
  try {
    await Promise.race([daemon.start(), deadline])
  } catch (error) {
    await daemon.stop(`startup failed: ${errMsg(error)}`).catch(() => {})
    throw error
  } finally { clearTimeout(timer); daemon.onSeedProgress = undefined }
  return daemon
}

class Daemon implements Roomd {
  private readonly claimDigests = new Map<string, string>()
  rememberClaimDigest(id: string, digest: string): void { this.claimDigests.set(id, digest) }
  private publicationRejected = false
  setPublicationRejected(rejected: boolean): void { this.publicationRejected = rejected }
  readonly roomDoc = new RoomDoc()
  readonly provider: WebsocketProvider
  branch = ''
  base = ''
  anchor = { base: '', anchored: false }
  private appliedHead = ''
  /** refsKey of the last completed transition; unset until the start transition has run. */
  private appliedRefs?: string
  /** Whether the last completed transition wrote base facts; a change of role forces the next one (promotion, demotion). */
  private appliedAsPublisher?: boolean
  /** Set when a transition marks the manifest incomplete; no publication completes it until the transition commits. */
  private transitionPending = false
  /** Claims whose original anchors still need validation against the committed HEAD. */
  private pendingClaimValidation?: { head: string; fence: string; claims: Map<string, ClaimSnapshot> }
  private readonly claimSearchProgress = new Map<string, ClaimSearchProgress>()
  /** Whether this daemon uses a local worker-room anchor rather than a room-remote anchor. */
  private readonly localRoom: boolean
  private readonly roomName: string
  /** The remote whose URL names the room (§B3); read at start. */
  private remote?: string
  private readonly sessionId?: string
  private readonly lease?: () => string | undefined
  private readonly ownFence: string
  /** The incarnation the last completed transition wrote under; a new one forces the next. */
  private appliedFence?: string

  readonly dir: string
  readonly name: string
  private readonly kind: Kind
  private readonly owner: string
  private readonly label?: string
  private readonly carriedFrom?: BaselineSource
  readonly log: (line: string) => void
  private readonly debounceMs: number
  private readonly trackedRefreshMs: number
  private readonly basePollMs: number
  private readonly reconcileIntervalMs: number
  private readonly periodicReconcileSchedule: (run: () => void, intervalMs: number) => () => void
  private cancelPeriodicReconcile?: () => void
  private reconcileQueued = false
  private reconcilePass = 0
  private reconcileDirty = false
  private reconcileCompletion: Promise<void> = Promise.resolve()
  private nextReconcile?: { promise: Promise<void>; resolve: () => void }
  private trackedPoll?: CoalescedPoll
  private headPoll?: CoalescedPoll
  private readonly beforeWatcherReady?: () => void
  readonly onFullScan?: RoomdOptions['onFullScan']
  private readonly poster?: RoomdOptions['post']
  private pushedInFlight = false
  readonly sizeCap: number
  readonly totalBudget: number
  private readonly connectTimeoutMs: number
  private roomIgnore: RoomIgnore = parseRoomIgnore('')
  private roomIgnoreText = ''
  readonly skips = { size: new Set<string>(), budget: new Set<string>(), ignore: new Set<string>() }
  private readonly roomUrl: string
  inputs: PublicationInputs
  get share(): ShareLevel { return this.inputs.policy.level }
  private remoteRepairTimer?: () => void
  private readonly remoteRepairSchedule: (run: () => Promise<void>) => () => void
  private unobserveOwnedData?: () => void
  beforePublishWrite?: (relpath: string) => Promise<void>
  beforeBaseRead?: (relpath: string) => Promise<void>

  private onScanned?: (relpath: string) => void

  private tracked = new Set<string>()
  private indexed = new Set<string>()
  private watcher: FSWatcher | null = null
  readonly batch: DiskBatch
  private readonly publisher: Publisher
  private workQueue: Promise<void> = Promise.resolve()
  private readonly watchedDirectory: string
  private symlinks = new Set<string>()
  private loggedSkips = new Set<string>()
  /** Skips not yet logged: reason -> count, with one example path; logged as one line per window. */
  private pendingSkips = new Map<string, number>()
  private pendingSkipExample = ''
  private skipLogTimer?: NodeJS.Timeout
  private readonly skipLogMs: number
  private started = false
  private diskWork = new Set<Promise<void>>()
  stopped = false
  private lastActive = Date.now()
  /** The startup step in progress, named in a startup failure. */
  phase = 'git'
  onSeedProgress?: () => void

  constructor(options: RoomdOptions) {
    assertValidParticipantName(options.name)
    if (options.owner) assertValidParticipantName(options.owner)
    if (options.label) assertValidParticipantName(options.label)
    this.dir = path.resolve(options.dir)
    this.name = options.name
    this.kind = options.kind ?? 'human'
    this.owner = options.owner ?? options.name
    this.label = options.label
    this.carriedFrom = options.carried
    this.roomUrl = options.room
    this.localRoom = !!options.localKey
    this.sessionId = options.sessionId
    this.lease = options.lease
    this.ownFence = options.sessionId ?? newId('daemon_')
    this.log = options.log ?? (line => process.stderr.write(`[roomd] ${line}\n`))
    this.remoteRepairSchedule = options.remoteRepairSchedule ?? (run => {
      const timer = setTimeout(() => { void run() }, 40)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
    this.debounceMs = options.debounceMs ?? 300
    this.watchedDirectory = createHash('sha256').update(machineHostname).update('\0').update(machineIdentity(this.log)).update('\0').update(fs.realpathSync(this.dir)).digest('hex')
    this.batch = new DiskBatch(paths => {
      const work = this.enqueue(async () => {
        await this.pollHead()
        for (const [p, fresh] of paths) {
          try { await this.onDiskChange(p, fresh) }
          finally { this.onScanned?.(p) }
        }
      })
      this.diskWork.add(work)
      void work.finally(() => this.diskWork.delete(work))
      return work
    }, this.debounceMs, Date.now, options.hotThrottleMs, error => this.publisher.reconcileFailed(error))
    this.trackedRefreshMs = options.trackedRefreshMs ?? 10_000
    this.basePollMs = options.basePollMs ?? 3_000
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 60_000
    this.periodicReconcileSchedule = options.periodicReconcileSchedule ?? ((run, intervalMs) => {
      const timer = setInterval(run, intervalMs)
      timer.unref?.()
      return () => clearInterval(timer)
    })
    this.beforeWatcherReady = options.beforeWatcherReady
    this.onFullScan = options.onFullScan
    this.poster = options.post
    this.sizeCap = options.sizeCap ?? 512 * 1024
    this.totalBudget = options.totalBudget ?? 8 * 1024 * 1024
    this.inputs = { policy: options.policy, rules: rulesFromText('', this.sizeCap, this.totalBudget), head: '' }
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000
    this.skipLogMs = options.skipLogMs ?? 10_000
    this.onScanned = options.onScanned
    this.beforePublishWrite = options.beforePublishWrite
    this.beforeBaseRead = options.beforeBaseRead
    const { serverUrl, roomName } = splitRoomUrl(options.room)
    let decodedRoomName = roomName
    try { decodedRoomName = decodeURIComponent(roomName) } catch { /* use the literal name */ }
    this.roomName = decodedRoomName
    this.provider = options.providerFactory
      ? options.providerFactory(serverUrl, roomName, this.roomDoc.doc)
      : new WebsocketProvider(serverUrl, roomName, this.roomDoc.doc, {
          WebSocketPolyfill: WebSocket as any,
          params: { schema: '2', ...tokenParams(options.token ?? process.env.ROOM_TOKEN), ...(options.localKey ? { key: options.localKey } : {}), ...(options.session ? { session: options.session } : {}) },
        })
    this.publisher = new Publisher(this)
    this.setStatus('syncing', { host: options.host, model: options.model, effort: options.effort })
  }

  async start(): Promise<void> {
    if (!fs.existsSync(path.join(this.dir, '.git'))) {
      throw new RoomdError(`${this.dir} is not a git repository`, 1)
    }

    const [branch, base, tracked, remote] = await this.step('git', () => Promise.all([
      gitBranch(this.dir),
      gitHead(this.dir),
      gitTracked(this.dir),
      this.localRoom ? undefined : roomRemote(this.dir, this.roomName),
    ]))
    this.branch = branchName(branch)
    this.base = base
    this.inputs = { ...this.inputs, head: base }
    this.remote = remote
    this.tracked = tracked.paths
    this.indexed = tracked.indexed

    await this.step('sync', () => this.waitForSync())
    this.observeOwnedData()
    this.phase = 'base'
    this.roomDoc.assignColor(this.name, this)
    this.setStatus(this.currentStatus())
    // The start transition resumes from the recorded head, so claims re-anchor over what changed while down (§B2).
    this.appliedHead = participantRecord(this.roomDoc, this.name)?.git?.head || base
    // Publication during the seed already needs the anchor; the start transition records it.
    const { base: anchorBase, anchored } = await resolveBase(this.dir, { head: base, branch: this.branch, refs: await readBaseRefs(this.dir, this.remote, this.branch) }, this.localRoom ? { local: true, carried: this.localCarriedBase() } : {})
    this.anchor = { base: anchorBase, anchored }
    this.inputs = { ...this.inputs, head: anchorBase }
    this.roomDoc.reconcileBaseTexts(this.name, this, anchorBase)
    this.loadRoomIgnore()
    this.inputs = { ...this.inputs, rules: rulesFromText(this.roomIgnoreText, this.sizeCap, this.totalBudget) }
    await this.step('seed', () => this.seedLocalOverlay())
    if (this.inputs.policy.publisher) this.writeRoomFile()
    this.excludeRoomFile()
    await this.step('watch', () => this.startWatcher())
    // Events can be missed between the seed scan and watch readiness.
    await this.reconcileGitChanges()
    if (this.reconcileIntervalMs > 0) this.cancelPeriodicReconcile = this.periodicReconcileSchedule(() => { void this.reconcileGitChanges() }, this.reconcileIntervalMs)
    this.trackedPoll = new CoalescedPoll('tracked refresh', this.trackedRefreshMs, () => this.refreshTracked(), this.log)
    if (this.basePollMs > 0) this.headPoll = new CoalescedPoll('HEAD poll', this.basePollMs, () => this.queuedHeadPoll(), this.log)
    this.pendingSkips.clear() // the startup scan's skips are counted in the synced line
    this.started = true
    this.log(`synced ${manifestPaths(this.roomDoc, this.name).length} changed paths as ${this.name} (${this.branch}@${this.base.slice(0, 7)}, sharing ${this.share})${this.skipSummary()}`)
  }

  private step<T>(phase: string, work: () => Promise<T>): Promise<T> {
    this.phase = phase
    if (phase === 'seed') this.onSeedProgress?.()
    return inPhase(phase, work)
  }

  skipped(): Skipped {
    return { size: Array.from(this.skips.size), budget: Array.from(this.skips.budget), ignore: Array.from(this.skips.ignore) }
  }

  private skipSummary(): string {
    const n = this.skips.size.size + this.skips.budget.size + this.skips.ignore.size
    if (!n) return ''
    const parts = [['size', this.skips.size.size], ['budget', this.skips.budget.size], ['ignore', this.skips.ignore.size]].filter(([, c]) => c).map(([k, c]) => `${c} ${k}`)
    return `; skipped ${n} file(s) (${parts.join(', ')})`
  }

  // ---- sharing policy --------------------------------------------------

  applyInputs(next: PublicationInputs): void {
    if (this.stopped || this.inputs === next) return
    this.roomDoc.doc.transact(() => {
      for (const [id, claim] of this.roomDoc.claims) {
        if (claim.by !== this.name || !claim.claimedHash || authorizesText(next.policy, claim.path)) continue
        this.claimDigests.set(id, claim.claimedHash)
        const { claimedHash: _private, ...publicClaim } = claim
        this.roomDoc.claims.set(id, publicClaim)
      }
    }, this)
    this.publisher.applyInputs(next)
    this.inputs = next
    this.claimSearchProgress.clear()
    this.setStatus(this.currentStatus())
    void this.enqueue(async () => { await this.publisher.reconcile('all', this.publicationComplete()) })
  }


  private loadRoomIgnore(): void {
    let text = ''
    try { if (this.isSafeRoomPath(ROOMIGNORE, false)) text = fs.readFileSync(this.abs(ROOMIGNORE), 'utf8') } catch { /* none */ }
    this.roomIgnoreText = text
    this.roomIgnore = parseRoomIgnore(text)
    if (this.roomIgnore.patterns) this.log(`${ROOMIGNORE}: ${this.roomIgnore.patterns} pattern(s)`)
  }

  async stop(reason = 'requested'): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.unobserveOwnedData?.()
    this.remoteRepairTimer?.()
    this.publisher.stop()
    this.trackedPoll?.stop()
    this.headPoll?.stop()
    this.cancelPeriodicReconcile?.()
    this.flushSkipLog()
    this.log(`stopped: ${reason.replace(/\s+/g, ' ')}`)
    this.batch.stop()
    await this.watcher?.close().catch(() => {})
    try { this.provider.awareness.setLocalState(null) } catch { /* already disconnected */ }
    // y-websocket sends awareness updates immediately, but the OS socket may still have bytes queued.
    // Give the offline update a bounded chance to leave before a signal handler exits the process.
    const socket = this.provider.ws
    if (socket) {
      const deadline = Date.now() + 1000
      while (socket.bufferedAmount > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    }
    this.provider.destroy()
    this.roomDoc.doc.destroy()
  }

  private setStatus(status: string, runtime: Pick<Presence, 'host' | 'model' | 'effort'> = {}): void {
    const current = (this.provider.awareness.getLocalState() ?? {}) as Partial<SharePresence>
    const state: SharePresence = {
      ...current,
      ...runtime,
      user: { name: this.name, kind: this.kind, owner: this.owner, ...(this.label ? { label: this.label } : {}), color: colorFor(this.name, this.roomDoc) },
      status,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      share: this.share,
      watchedDirectory: this.watchedDirectory,
      lastActive: this.lastActive,
    }
    this.provider.awareness.setLocalState(state)
  }

  /**
   * The fence of every record this daemon writes, or undefined while it may write none: its name lease is
   * paused, or the hub-written holder already names another incarnation (a successor, hub §4.3).
   */
  get fence(): string | undefined {
    if (this.publicationRejected) return undefined
    const fence = this.lease ? this.lease() : this.ownFence
    const holder = participantRecord(this.roomDoc, this.name)?.holder
    return fence !== undefined && (!holder || holderFence(holder) === fence) ? fence : undefined
  }

  enqueue(work: () => Promise<void>): Promise<void> {
    this.workQueue = this.workQueue.then(() => this.stopped ? undefined : work()).catch(error => this.publisher.reconcileFailed(error))
    return this.workQueue
  }

  /** HEAD failures use the publisher retry, so this timer never backs off. */
  private queuedHeadPoll(): Promise<void> { return this.enqueue(() => this.pollHead()) }

  /** Level-triggered check, shared by startup, the slow timer and failed-publish retry. */
  reconcileGitChanges(): Promise<void> {
    if (this.stopped) return this.workQueue
    if (this.reconcileQueued) {
      this.reconcileDirty = true
      if (this.reconcilePass === 2) {
        if (!this.nextReconcile) {
          let resolve!: () => void
          const promise = new Promise<void>(done => { resolve = done })
          this.nextReconcile = { promise, resolve }
        }
        return this.nextReconcile.promise
      }
      return this.reconcileCompletion
    }
    this.reconcileQueued = true
    this.reconcileCompletion = this.enqueue(async () => {
      try {
        for (let pass = 1; pass <= 2; pass++) {
          this.reconcilePass = pass
          this.reconcileDirty = false
          await this.pollHead()
          await this.publisher.reconcile('all', this.publicationComplete())
          if (!this.reconcileDirty || this.stopped) break
        }
      } finally {
        this.reconcilePass = 0
        this.reconcileQueued = false
        const next = this.nextReconcile
        this.nextReconcile = undefined
        if (this.reconcileDirty && !this.stopped) void this.reconcileGitChanges().then(() => next?.resolve())
        else next?.resolve()
      }
    })
    return this.reconcileCompletion
  }


  private currentStatus(): string {
    return (this.provider.awareness.getLocalState() as Presence | null)?.status ?? 'synced'
  }

  private publicationComplete(): boolean {
    return this.anchor.anchored && !this.transitionPending && !this.pendingClaimValidation?.claims.size
  }

  /** Mark this party active now (tool calls count as activity). */
  touch(): void { this.bumpLastActive() }

  bumpLastActive(): void {
    this.lastActive = Date.now()
    this.setStatus(this.currentStatus())
  }

  private waitForSync(): Promise<void> {
    if (this.provider.synced) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.provider.off('sync', onSync)
        reject(new RoomdError(`could not sync with ${this.roomUrl} within ${this.connectTimeoutMs}ms`, 1))
      }, this.connectTimeoutMs)
      const onSync = (synced: boolean) => {
        if (!synced) return
        clearTimeout(timer)
        this.provider.off('sync', onSync)
        resolve()
      }
      this.provider.on('sync', onSync)
    })
  }

  private writeRoomFile(): void {
    try {
      const previous = readRoomFile(this.dir) // Keep the old identity for ambiguous-claim recovery.
      const legacy = previous?.legacy ?? (previous?.room && previous.room !== this.roomUrl && previous.name
        ? { room: previous.room, name: previous.name } : undefined)
      const file = roomFilePath(this.dir), temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try {
        fs.writeFileSync(temp, JSON.stringify({ room: this.roomUrl, name: this.name, dir: this.dir, ...(legacy ? { legacy } : {}) }, null, 2) + '\n', { mode: 0o600 })
        fs.renameSync(temp, file)
      } finally { fs.rmSync(temp, { force: true }) }
    } catch (error) {
      this.log(`warn: could not write ${ROOM_FILE}: ${errMsg(error)}`)
    }
  }

  private excludeRoomFile(): void {
    // Worktrees have a .git file pointing at <common>/.git/worktrees/<name>; excludes live in the common dir.
    const gitDir = commonGitDirFromDotGit(this.dir)
    const exclude = path.join(gitDir, 'info', 'exclude')
    try {
      fs.mkdirSync(path.dirname(exclude), { recursive: true })
      const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
      const missing = [ROOM_FILE, '.room/'].filter(p => !current.split(/\r?\n/).includes(p))
      if (!missing.length) return
      const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
      fs.appendFileSync(exclude, `${separator}${missing.join('\n')}\n`)
    } catch (error) {
      this.log(`warn: could not add ${ROOM_FILE} to .git/info/exclude: ${errMsg(error)}`)
    }
  }

  // ---- startup and disk -> overlay --------------------------------------

  // ---- base commit tracking ---------------------------------------------


  /** A live owner can restore a peer's mistaken deletion of its current incarnation. */
  private observeOwnedData(): void {
    const removedOwnEntry = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
      if (transaction.origin === this || this.stopped) return
      const fence = this.fence
      if (!fence) return
      const incarnation = manifestKey(this.name, fence)
      if (events.some(event => event instanceof Y.YMapEvent && (
        event.target === this.roomDoc.overlays || event.target === this.roomDoc.manifest
          ? event.changes.keys.get(incarnation)?.action === 'delete'
          : event.path[0] === incarnation && [...event.changes.keys.values()].some(change => change.action === 'delete')
      ))) this.scheduleRemoteRepair()
    }
    const changedBaseText = (event: Y.YMapEvent<string>, transaction: Y.Transaction) => {
      if (transaction.origin === this || this.stopped) return
      if ([...event.changes.keys].some(([key, change]) => {
        const split = key.indexOf('\u0000')
        if (split < 0 || key.slice(split + 1).includes('\u0000')) return false
        const owner = key.slice(0, split)
        return owner === this.name || (change.action === 'add' && manifestPaths(this.roomDoc, owner).length === 0)
      })) this.scheduleRemoteRepair()
    }
    this.roomDoc.overlays.observeDeep(removedOwnEntry)
    this.roomDoc.manifest.observeDeep(removedOwnEntry)
    this.roomDoc.ownedBaseTexts.observe(changedBaseText)
    this.unobserveOwnedData = () => {
      this.roomDoc.overlays.unobserveDeep(removedOwnEntry)
      this.roomDoc.manifest.unobserveDeep(removedOwnEntry)
      this.roomDoc.ownedBaseTexts.unobserve(changedBaseText)
    }
  }

  private scheduleRemoteRepair(): void {
    if (this.remoteRepairTimer) return
    this.remoteRepairTimer = this.remoteRepairSchedule(async () => {
      this.remoteRepairTimer = undefined
      this.roomDoc.reconcileBaseTexts(this.name, this, this.inputs.head)
      await this.enqueue(async () => { await this.publisher.reconcile('all', this.publicationComplete()) })
    })
  }

  /** The holder of the worktree's publisher lease alone writes base facts and posts `pushed` (invariant 11, registry §16). */
  private publishesBaseFacts(): boolean { return this.inputs.policy.publisher }

  /** Wait until Git's temporary pull state is gone and claimed paths have stopped changing. */
  private async waitForGitOperation(head: string): Promise<void> {
    const gitDir = worktreeGitDirFromDotGit(this.dir)
    const markers = ['index.lock', 'MERGE_AUTOSTASH', 'MERGE_HEAD', 'REBASE_HEAD', 'rebase-apply', 'rebase-merge']
    const busy = () => markers.some(marker => fs.existsSync(path.join(gitDir, marker)))
    const claimedPaths = [...new Set([...this.roomDoc.claims.values()]
      .filter(c => c.by === this.name && !c.mirrorOf && !c.path.endsWith('/') && this.isSafeRoomPath(c.path, false))
      .map(c => c.path))].sort()
    const fingerprint = () => claimedPaths.map(rel => {
      try {
        const stat = fs.lstatSync(this.abs(rel))
        return `${rel}:${stat.size}:${stat.mtimeMs}`
      } catch { return `${rel}:missing` }
    }).join('\n')
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (!busy()) {
        const before = fingerprint()
        await new Promise(resolve => setTimeout(resolve, 75))
        if (!busy() && before === fingerprint() && await gitHead(this.dir) === head) return
      } else await new Promise(resolve => setTimeout(resolve, 75))
    }
    if (busy()) throw new Error('Git operation or worktree is still changing; retry HEAD reconciliation')
    if (await gitHead(this.dir) !== head) throw new Error('HEAD moved during Git operation')
    // A busy editor alone must not hold the transition indefinitely.
  }

  /**
   * One HEAD transition (§B2): a commit, pull, reset, branch switch, or a fetch or force-push that moved
   * the room remote's refs. The applied state advances only when the whole transition has committed.
   */
  private async pollHead(): Promise<void> {
    const fence = this.fence
    // Paused (hub §7): nothing fenced goes out, and nothing is applied, so the resumed transition redoes it all.
    if (this.stopped || fence === undefined) return
    await this.postPushedPending()
    const [head, rawBranch] = await Promise.all([gitHead(this.dir), gitBranch(this.dir)])
    const branch = branchName(rawBranch)
    const headMoved = head !== this.appliedHead || branch !== this.branch
    const publishing = this.publishesBaseFacts()
    const invalidate = () => {
      this.inputs = { ...this.inputs }
      if (publishing) {
        this.transitionPending = true
        markManifestIncomplete(this.roomDoc, this.name, fence)
      }
    }
    if (headMoved) invalidate()
    const inputs: BaseInputs = { head, branch, refs: await readBaseRefs(this.dir, this.remote, branch) }
    if (!headMoved && refsKey(inputs) === this.appliedRefs && publishing === this.appliedAsPublisher && fence === this.appliedFence) {
      await this.retryPendingClaims(head, fence)
      return
    }
    // §B2 step 1: invalidate prior scans and coverage before waiting for Git's transient state.
    if (!headMoved) invalidate()
    if (headMoved) await this.waitForGitOperation(head)
    // A promoted session's own record predates the other publisher's tenure: it yields no pushed (§B4).
    const promoted = publishing && this.appliedAsPublisher === false
    const prev = this.appliedHead
    const firstTransition = this.appliedRefs === undefined
    const claimSnapshot = prev !== head || firstTransition ? await this.snapshotOwnClaims(prev) : []
    // A newer transition supersedes the old target, but unresolved original anchors survive it.
    const pending = this.pendingClaimValidation
    const pendingIds = new Set<string>()
    if (pending?.fence === fence) {
      const byId = new Map(claimSnapshot.map(c => [c.id, c]))
      for (const [id, original] of pending.claims) {
        if (JSON.stringify(this.roomDoc.claims.get(id)) === original.claimState) {
          byId.set(id, original)
          pendingIds.add(id)
        } else this.claimSearchProgress.delete(id)
      }
      claimSnapshot.splice(0, claimSnapshot.length, ...byId.values())
    }
    if (headMoved) {
      this.base = head
      this.branch = branch
      this.tracked = (await gitTracked(this.dir)).paths
      if (this.fence !== fence) throw new Error('the name lease changed during the HEAD transition')
    }
    const resolved = await resolveBase(this.dir, inputs, this.localRoom ? { local: true, carried: this.localCarriedBase() } : {})
    const claims = await this.reanchorOwnClaims(head, claimSnapshot, true, pendingIds)
    const facts = await this.transitionFacts(inputs, resolved, promoted, fence)
    // A disk scan or policy change during preparation invalidates it; prepare again rather than fail the move.
    for (let attempt = 1; ; attempt++) {
      let publication: PreparedPublication | undefined
      try { publication = await this.publisher.prepare(this.inputs = { ...this.inputs, head: resolved.base }) }
      catch (error) { if (!(error instanceof StalePublication)) throw error }
      if (await gitHead(this.dir) !== head) throw new Error('HEAD moved during reconciliation')
      if (this.fence !== fence) throw new Error('the name lease changed during the HEAD transition')
      if (publication && await this.publisher.validatePrepared(publication) && this.claimFilesValid(claims) && this.commitTransition(inputs, claims, facts, publication, resolved.anchored && !claims.uncertain.length)) break
      if (attempt === TRANSITION_ATTEMPTS) throw new Error(`publication changed during HEAD transition ${attempt} times`)
    }
    this.anchor = { base: resolved.base, anchored: resolved.anchored }
    this.transitionPending = false
    this.setStatus(resolved.status)
    this.appliedHead = head
    this.appliedRefs = refsKey(inputs)
    this.appliedAsPublisher = publishing
    this.appliedFence = fence
    this.pendingClaimValidation = claims.uncertain.length ? { head, fence, claims: new Map(claimSnapshot.filter(c => claims.uncertain.includes(c.id)).map(c => [c.id, c])) } : undefined
    if (prev !== head) this.log(`HEAD moved ${prev.slice(0, 10)} -> ${head.slice(0, 10)}`)
    // §B2 step 6, after the transaction.
    await this.postPushedPending()
  }

  /** The awaited half of §B2 step 5: the next `git` record, under the transition's fence, and whether it yields `pushed` (§B4). */
  private async transitionFacts({ head, branch }: BaseInputs, resolved: ResolvedBase, promoted: boolean, fence: string): Promise<TransitionFacts> {
    if (!this.publishesBaseFacts()) return {}
    const prev = participantRecord(this.roomDoc, this.name)?.git
    const fields = {
      branch, head, base: resolved.base, anchored: resolved.anchored,
      ...(resolved.remote ? { remote: resolved.remote } : {}), ...(resolved.upstream ? { upstream: resolved.upstream } : {}),
      ...(resolved.ahead !== undefined ? { ahead: resolved.ahead, behind: resolved.behind } : {}), fence,
    }
    const { rev: _rev, pushedPending: _owed, ...recorded } = prev ?? { rev: 0 }
    if (JSON.stringify(recorded) === JSON.stringify(fields)) return {}
    const next: ParticipantGit = { ...fields, rev: (prev?.rev ?? 0) + 1 }
    // Only a surviving record yields a notice: current refs cannot recover a lost fromSha (§B4). Without a
    // poster (the CLI) nothing could ever post it, so nothing is owed.
    if (!this.poster || !prev || promoted || !resolved.upstream || !await pushedRange(this.dir, prev, next)) return { next }
    return { next, pushed: { fromSha: prev.base, toSha: next.base, branch, upstream: resolved.upstream } }
  }

  /**
   * The record's owed `pushed` after this transition: the new range, joined to an older unposted one it
   * continues. An older one it does not continue is replaced (delivery is at most once, §B4); an older one
   * with no new range is kept.
   */
  private owedPushed(pushed: PushedPending | undefined): PushedPending | undefined {
    const owed = participantRecord(this.roomDoc, this.name)?.git?.pushedPending
    if (!pushed) return owed
    if (!owed) return pushed
    if (owed.toSha === pushed.fromSha && owed.branch === pushed.branch && owed.upstream === pushed.upstream) return { ...pushed, fromSha: owed.fromSha }
    this.log(`replacing an unposted pushed ${owed.fromSha.slice(0, 10)}..${owed.toSha.slice(0, 10)}: the upstream moved since`)
    return pushed
  }

  /**
   * §B2 step 6: post the record's `pushedPending` by its deterministic id (the hub dedupes a repeat). It
   * clears only once the hub accepted it, and then only the part the post covered: a transition committed
   * meanwhile keeps its newer range. One post at a time; a refusal waits for the next poll. Resolves once
   * the post is sent; the hub's answer is handled when it comes.
   */
  private async postPushedPending(): Promise<void> {
    const owed = this.publishesBaseFacts() ? participantRecord(this.roomDoc, this.name)?.git?.pushedPending : undefined
    const fence = this.fence
    if (!owed || !this.poster || this.pushedInFlight || this.stopped || !fence) return
    this.pushedInFlight = true
    const from: Identity = { name: this.name, kind: this.kind, owner: this.owner, ...(this.label ? { label: this.label } : {}) }
    let answer: unknown
    let commits = 0
    try {
      const facts = await pushedFacts(this.dir, owed.fromSha, owed.toSha)
      commits = facts.commits
      answer = this.poster(from, { type: 'pushed', ...owed, ...facts } as PostBody<PushedMsg>, { id: `pushed:${this.name}:${owed.fromSha}:${owed.toSha}`, auto: true })
    } catch (error) { this.pushedInFlight = false; this.log(`pushed not posted yet: ${errMsg(error)}`); return }
    void Promise.resolve(answer).then(result => {
      if (!hubAccepted(result) || this.stopped || this.fence !== fence) return
      this.log(`${owed.upstream} now has ${owed.fromSha.slice(0, 10)}..${owed.toSha.slice(0, 10)} (+${commits})`)
      const record = participantRecord(this.roomDoc, this.name)?.git
      const current = record?.pushedPending
      if (!record || current?.fromSha !== owed.fromSha) return
      const { pushedPending: _done, ...rest } = record
      const next: ParticipantGit = current.toSha === owed.toSha ? rest : { ...rest, pushedPending: { ...current, fromSha: owed.toSha } }
      this.roomDoc.doc.transact(() => this.roomDoc.participants.set(`${this.name}\u0000git`, next), this)
    }).catch(error => this.log(`pushed not posted yet: ${errMsg(error)}`)).finally(() => { this.pushedInFlight = false })
  }

  /**
   * §B2 step 5, one synchronous transaction: the publication, the `git` record (rev + 1) with `pushedPending`
   * when §B4 applies, and this participant's claim moves and releases. A session publishing under another
   * writes only its claim part. False, with nothing written, when the publication went stale.
   */
  private commitTransition({ head }: BaseInputs, claims: ClaimChanges, { next, pushed }: TransitionFacts, publication: PreparedPublication, anchored: boolean): boolean {
    if (!this.publisher.valid(publication)) return false
    for (const [id, state] of claims.claimState) if (JSON.stringify(this.roomDoc.claims.get(id)) !== state) return false
    if (!this.publisher.identityValid(publication)) return false
    // Notices are posted after the transaction commits: the hub appends them (hub §8), by id where retried.
    const notices: { from: Identity; body: PostBody<Msg>; id?: string }[] = []
    this.roomDoc.doc.transact(() => {
      this.publisher.apply(publication, anchored)
      if (next) {
        // Read inside the transaction: a post accepted while this transition was prepared already cleared its part.
        const owed = this.owedPushed(pushed)
        this.roomDoc.participants.set(`${this.name}\u0000git`, owed ? { ...next, pushedPending: owed } : next)
      }
      for (const move of claims.moves) {
        const current = this.roomDoc.claims.get(move.id)
        if (current?.by === this.name && !current.mirrorOf) this.roomDoc.moveClaim(move.id, move.from, move.to, this,
          authorizesText(this.inputs.policy, current.path) ? claims.hashById.get(move.id) : undefined)
      }
      for (const release of claims.releases) {
        const current = this.roomDoc.claims.get(release.id)
        if (current?.by !== this.name || current.mirrorOf) continue
        this.roomDoc.removeClaim(release.id, this)
        const text = claimReleaseText(release.path, release.from, release.to, head.slice(0, 10))
        notices.push({ from: { name: this.name, kind: this.kind }, body: { type: 'release', claimId: release.id, path: release.path, summary: text } as PostBody<ReleaseMsg> })
        notices.push({ from: { name: 'room', kind: 'bot' }, body: { type: 'note', to: this.name, priority: 'notify', text } as PostBody<NoteMsg> })
        this.log(text)
      }
    }, this)
    for (const n of notices) this.post(n.from, n.body, n.id)
    return true
  }

  /** An automatic post through the hub; without a poster (the CLI) the notice is only logged. */
  private post(from: Identity, body: PostBody<Msg>, id?: string): void {
    if (this.poster) this.poster(from, body, { ...(id ? { id } : {}), auto: true })
    else this.log(`not posted (no hub client): ${body.type}`)
  }

  /** The lead's work carried into this worker for the worktree's lifetime. */
  carried(): Baseline | undefined {
    const baseline = workerBaseline(this.carriedFrom)
    return carriesWork(baseline) ? baseline : undefined
  }

  /** A local-room worker's base is the commit its lead carried it from (registry pins it). */
  private localCarriedBase(): string | undefined {
    return workerBaseline(this.carriedFrom)?.sha
  }

  /** Capture the claimed code before a commit can clear its overlay. */
  private async snapshotOwnClaims(prev: string): Promise<ClaimSnapshot[]> {
    const owned = [...this.roomDoc.claims.values()].filter(c => c.by === this.name && !c.mirrorOf && !c.path.endsWith('/'))
    const fence = this.fence
    if (!fence) return []
    const incarnation = manifestKey(this.name, fence)
    const oldPaths = [...new Set(owned.filter(c => this.roomDoc.text(c.path, incarnation) === undefined).map(c => c.path))]
    const oldTexts = new Map<string, string | undefined>()
    const oldInfo = oldPaths.length ? await gitBlobInfoMany(this.dir, prev, oldPaths) : new Map()
    for (const rel of oldPaths) {
      await new Promise<void>(resolve => setImmediate(resolve))
      const info = oldInfo.get(rel)
      if (info && info.size <= this.sizeCap) oldTexts.set(rel, (await gitShowMany(this.dir, prev, [rel])).get(rel))
    }
    const snapshots: ClaimSnapshot[] = []
    for (const c of owned) {
      await new Promise<void>(resolve => setImmediate(resolve))
      const overlay = this.roomDoc.text(c.path, incarnation)
      const oldText = oldTexts.get(c.path)
      const range = overlay !== undefined && !c.claimedHash ? this.roomDoc.claimRange(c) : { from: c.from, to: c.to }
      const source = overlay === undefined ? oldText : overlay
      const hash = c.claimedHash ?? this.claimDigests.get(c.id) ?? (source === undefined || Buffer.byteLength(source) > this.sizeCap ? undefined : claimDigest(source, range.from, range.to))
      const block = (text: string | undefined): string | undefined => {
        if (text === undefined || Buffer.byteLength(text) > this.sizeCap || claimDigest(text, range.from, range.to) !== hash) return undefined
        return text.split('\n').slice(range.from - 1, range.to).join('\n')
      }
      snapshots.push({ ...c, ...range, claimedHash: hash, anchorText: block(overlay) ?? block(oldText), oldText, claimState: JSON.stringify(c) })
    }
    return snapshots
  }

  /** §B2 step 4: where this daemon's claims moved, over the current texts; applied in commitTransition. */
  private async reanchorOwnClaims(head: string, snapshot: readonly Claim[], onlyChanged = false, pendingIds: ReadonlySet<string> = new Set()): Promise<ClaimChanges> {
    if (!snapshot.length) return NO_CLAIM_CHANGES
    const fence = this.fence
    if (!fence) return NO_CLAIM_CHANGES
    const changedPaths = onlyChanged && this.appliedHead
      ? new Set(await gitPathsBetween(this.dir, this.appliedHead, head, true))
      : undefined
    const relevant = changedPaths ? snapshot.filter(c => changedPaths.has(c.path) || pendingIds.has(c.id)) : snapshot
    if (!relevant.length) return NO_CLAIM_CHANGES
    const claimState = new Map(relevant.map(c => [c.id, (c as ClaimSnapshot).claimState ?? JSON.stringify(this.roomDoc.claims.get(c.id))]))
    const paths = [...new Set(relevant.map(c => c.path))]
    const currentTexts = new Map<string, string | undefined>()
    const fileState = new Map<string, string>()
    const unreadable = new Set<string>()
    const inputs = this.inputs
    for (const rel of paths) {
      await new Promise<void>(resolve => setImmediate(resolve))
      fileState.set(rel, this.claimFileIdentity(rel))
      if (!this.isSafeRoomPath(rel, false)) { currentTexts.set(rel, undefined); continue }
      try {
        const before = await fs.promises.lstat(this.abs(rel))
        if (!before.isFile()) { currentTexts.set(rel, undefined); continue }
        if (before.size > this.sizeCap) { unreadable.add(rel); continue }
        const handle = await fs.promises.open(this.abs(rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
        try {
          const opened = await handle.stat()
          if (!opened.isFile() || opened.size > this.sizeCap || opened.ino !== before.ino || opened.mtimeMs !== before.mtimeMs) { unreadable.add(rel); continue }
          const bytes = Buffer.allocUnsafe(opened.size + 1)
          let count = 0
          while (count < bytes.length) {
            const read = await handle.read(bytes, count, bytes.length - count, count)
            if (!read.bytesRead) break
            count += read.bytesRead
          }
          const after = await handle.stat()
          const pathAfter = await fs.promises.lstat(this.abs(rel))
          if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || pathAfter.ino !== opened.ino || !this.isSafeRoomPath(rel, false)) { unreadable.add(rel); continue }
          currentTexts.set(rel, bytes.subarray(0, count).toString('utf8'))
        } finally { await handle.close() }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') currentTexts.set(rel, undefined)
        else unreadable.add(rel)
      }
    }
    const originals = new Map(relevant.flatMap(c => {
      const anchor = (c as ClaimSnapshot).anchorText
      return anchor === undefined ? [] : [[c.id, anchor] as const]
    }))
    const previousTexts = new Map(relevant.flatMap(c => {
      const oldText = (c as ClaimSnapshot).oldText
      return oldText === undefined ? [] : [[c.id, oldText] as const]
    }))
    const changes = await reanchorClaims(this.name, relevant, currentTexts, { originals, unreadable,
      previousTexts, progress: this.claimSearchProgress,
      searchKey: c => `${head}:${fence}:${claimState.get(c.id)}:${fileState.get(c.path)}`,
      valid: () => this.fence === fence && this.inputs === inputs && !this.stopped })
    const dirty = changes.releases.length || changes.uncertain.length ? new Set(await gitChanged(this.dir)) : new Set<string>()
    for (const c of relevant) if (changes.uncertain.includes(c.id) && unreadable.has(c.path) && !dirty.has(c.path)) {
      changes.releases.push({ id: c.id, path: c.path, from: c.from, to: c.to })
    }
    const uncertain = changes.uncertain.filter(id => !changes.releases.some(release => release.id === id))
    const releases = changes.releases.filter(release => {
      if (!dirty.has(release.path)) return true
      this.log(`kept claim on ${release.path}:${release.from}-${release.to} after ${head.slice(0, 10)}: the file has your uncommitted edits`)
      uncertain.push(release.id)
      return false
    })
    if (uncertain.length) {
      this.log(`claim reanchor uncertain for ${uncertain.length} claim(s); keeping them and retrying`)
      this.publisher.markDirty()
    }
    return { moves: changes.moves, releases, uncertain, fileState, hashById: new Map(relevant.map(c => [c.id, c.claimedHash])),
      claimState }
  }

  private claimFileIdentity(rel: string): string {
    if (!this.isSafeRoomPath(rel, false)) return 'unsafe'
    try {
      const stat = fs.lstatSync(this.abs(rel))
      return `${stat.isFile()}:${stat.size}:${stat.mtimeMs}:${stat.ino}`
    } catch (error) { return `error:${(error as NodeJS.ErrnoException).code ?? 'unknown'}` }
  }

  private claimFilesValid(changes: ClaimChanges): boolean {
    for (const [rel, identity] of changes.fileState) if (this.claimFileIdentity(rel) !== identity) return false
    return true
  }

  /** One bounded claim-validation slice per publisher tick, independent of later HEAD movement. */
  private async retryPendingClaims(head: string, fence: string): Promise<void> {
    const pending = this.pendingClaimValidation
    if (!pending || pending.head !== head || pending.fence !== fence || !pending.claims.size) return
    const [id, original] = pending.claims.entries().next().value as [string, ClaimSnapshot]
    if (JSON.stringify(this.roomDoc.claims.get(id)) !== original.claimState) {
      pending.claims.delete(id)
      this.claimSearchProgress.delete(id)
      if (!pending.claims.size) this.pendingClaimValidation = undefined
      return
    }
    const inputs = this.inputs
    const changes = await this.reanchorOwnClaims(head, [original])
    const finalHead = await gitHead(this.dir)
    if (this.stopped || this.fence !== fence || this.inputs !== inputs || this.pendingClaimValidation !== pending ||
      pending.head !== head || pending.fence !== fence || pending.claims.get(id) !== original || finalHead !== head ||
      !this.claimFilesValid(changes)) return
    if (JSON.stringify(this.roomDoc.claims.get(id)) !== original.claimState) {
      pending.claims.delete(id)
      this.claimSearchProgress.delete(id)
      if (!pending.claims.size) this.pendingClaimValidation = undefined
      return
    }
    if (changes.uncertain.includes(id)) {
      // Rotation prevents an unreadable or individually expensive claim starving later claims.
      pending.claims.delete(id)
      pending.claims.set(id, original)
      return
    }
    const notices: { from: Identity; body: PostBody<Msg> }[] = []
    this.roomDoc.doc.transact(() => {
      for (const move of changes.moves) {
        const current = this.roomDoc.claims.get(move.id)
        if (current?.by === this.name && !current.mirrorOf) this.roomDoc.moveClaim(move.id, move.from, move.to, this,
          authorizesText(this.inputs.policy, current.path) ? changes.hashById.get(move.id) : undefined)
      }
      for (const release of changes.releases) {
        const current = this.roomDoc.claims.get(release.id)
        if (current?.by !== this.name || current.mirrorOf) continue
        this.roomDoc.removeClaim(release.id, this)
        const text = claimReleaseText(release.path, release.from, release.to, head.slice(0, 10))
        notices.push({ from: { name: this.name, kind: this.kind }, body: { type: 'release', claimId: release.id, path: release.path, summary: text } as PostBody<ReleaseMsg> })
        notices.push({ from: { name: 'room', kind: 'bot' }, body: { type: 'note', to: this.name, priority: 'notify', text } as PostBody<NoteMsg> })
        this.log(text)
      }
    }, this)
    pending.claims.delete(id)
    this.claimSearchProgress.delete(id)
    if (!pending.claims.size) this.pendingClaimValidation = undefined
    for (const notice of notices) this.post(notice.from, notice.body)
  }

  /** Validate claims recovered from a branch-room archive after the first repo-room join. */
  async validateMigratedClaims(): Promise<void> {
    const fence = this.fence
    if (!fence) return
    const migrated = [...this.roomDoc.claims.values()].filter(claim => claim.by === this.name && typeof (claim as Claim & { origin?: string }).origin === 'string')
    if (!migrated.length) return
    const changes = await this.reanchorOwnClaims(this.base, migrated)
    if (this.fence !== fence) return
    const snapshot = new Map(migrated.map(claim => [claim.id, JSON.stringify(claim)]))
    const stillMine = (id: string) => this.fence === fence && JSON.stringify(this.roomDoc.claims.get(id)) === snapshot.get(id)
    const notices: { from: Identity; body: PostBody<Msg> }[] = []
    this.roomDoc.doc.transact(() => {
      for (const move of changes.moves) {
        if (stillMine(move.id)) this.roomDoc.moveClaim(move.id, move.from, move.to, this,
          authorizesText(this.inputs.policy, this.roomDoc.claims.get(move.id)?.path ?? '') ? changes.hashById.get(move.id) : undefined)
      }
      for (const release of changes.releases) {
        if (!stillMine(release.id)) continue
        this.roomDoc.removeClaim(release.id, this)
        const summary = `released your migrated claim on ${release.path}:${release.from}-${release.to}: its claimed lines are no longer in this checkout`
        notices.push({ from: { name: this.name, kind: this.kind }, body: { type: 'release', claimId: release.id, path: release.path, summary } as PostBody<ReleaseMsg> })
        notices.push({ from: { name: 'room', kind: 'bot' }, body: { type: 'note', to: this.name, priority: 'notify', text: summary } as PostBody<NoteMsg> })
        this.log(summary)
      }
    }, this)
    for (const notice of notices) this.post(notice.from, notice.body)
  }

  /** Publish what differs from HEAD: git's changed paths plus what this person already published, never every tracked file. */
  private async seedLocalOverlay(): Promise<void> {
    await this.publisher.reconcile('all', this.publicationComplete())
  }

  abs(relpath: string): string {
    return path.join(this.dir, ...relpath.split('/'))
  }

  private isIgnoredPath(relpath: string): boolean {
    if (!relpath || relpath === ROOM_FILE) return true
    if (defaultIgnoredPath(relpath)) {
      if (!relpath.split('/').some(part => DEFAULT_IGNORED_DIRS.has(part))) this.skipIgnored(relpath, 'default ignore')
      return true
    }
    if (this.roomIgnore.ignores(relpath)) {
      this.skipIgnored(relpath, ROOMIGNORE)
      return true
    }
    return false
  }

  skipIgnored(relpath: string, reason: string): void {
    this.skips.ignore.add(relpath)
    if (!this.loggedSkips.has(relpath)) { this.loggedSkips.add(relpath); this.noteSkip(relpath, reason) }
  }

  /** Count a skip for the next summary line: a test run can write thousands of ignored files. */
  noteSkip(relpath: string, reason: string): void {
    if (!this.pendingSkips.size) this.pendingSkipExample = relpath
    this.pendingSkips.set(reason, (this.pendingSkips.get(reason) ?? 0) + 1)
    if (this.skipLogTimer || !this.started) return
    this.skipLogTimer = setTimeout(() => this.flushSkipLog(), this.skipLogMs)
    this.skipLogTimer.unref?.()
  }

  private flushSkipLog(): void {
    clearTimeout(this.skipLogTimer)
    this.skipLogTimer = undefined
    if (!this.pendingSkips.size) return
    const n = Array.from(this.pendingSkips.values()).reduce((a, b) => a + b, 0)
    this.log(`skipped ${n} file(s) (${Array.from(this.pendingSkips, ([reason, count]) => `${count} ${reason}`).join(', ')}), e.g. ${this.pendingSkipExample}`)
    this.pendingSkips.clear()
  }

  isSafeRoomPath(relpath: string, applyIgnore = true): boolean {
    if (applyIgnore && this.isIgnoredPath(relpath)) return false
    const target = path.resolve(this.dir, ...relpath.split('/'))
    const inside = path.relative(this.dir, target)
    if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return false
    let current = this.dir
    for (const segment of inside.split(path.sep)) {
      current = path.join(current, segment)
      try {
        const relative = path.relative(this.dir, current)
        if (fs.lstatSync(current).isSymbolicLink()) this.symlinks.add(relative)
        else this.symlinks.delete(relative)
        if (this.symlinks.has(path.relative(this.dir, current))) { this.skipIgnored(relpath, 'symlink'); return false }
        const real = path.relative(fs.realpathSync(this.dir), fs.realpathSync(current))
        if (real === '..' || real.startsWith(`..${path.sep}`) || path.isAbsolute(real)) return false
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false }
      if (this.symlinks.has(path.relative(this.dir, current))) return false
    }
    return true
  }

  // ---- watcher -----------------------------------------------------------

  private async startWatcher(): Promise<void> {
    this.beforeWatcherReady?.()
    // Chokidar can emit neither `ready` nor `error` when the watched root becomes
    // unreadable before its initial scan. Check the root ourselves before waiting.
    try { fs.readdirSync(this.dir) }
    catch (error) { throw new RoomdError(`cannot watch ${this.dir}: ${errMsg(error)}`, 1) }
    const watchedFiles = new Set<string>()
    let warnedLarge = false
    const countFile = (absolute: string, add: boolean) => {
      const relpath = path.relative(this.dir, absolute).split(path.sep).join('/')
      if (!relpath || defaultIgnoredPath(relpath)) return
      if (add) watchedFiles.add(relpath); else watchedFiles.delete(relpath)
      if (!warnedLarge && watchedFiles.size > 20_000) {
        warnedLarge = true
        this.log(`warn: watching ${watchedFiles.size} files; add generated or bulky paths to ${ROOMIGNORE}`)
      }
    }
    const watcher = chokidar.watch(this.dir, {
      ignoreInitial: true,
      followSymlinks: false,
      persistent: true,
      ignored: (absolute: string) => {
        const relpath = path.relative(this.dir, absolute).split(path.sep).join('/')
        if (relpath === '') return false
        // Build and test output (test-results/, .astro/, ...) can hold thousands of files per run; watch it only when git tracks or offers something in it.
        if (isRegenerableBuildPath(relpath.slice(relpath.lastIndexOf('/') + 1)) && !this.holdsTracked(relpath)) return true
        if (defaultIgnoredPath(relpath)) return this.isIgnoredPath(relpath)
        return !this.isSafeRoomPath(relpath, false)
      },
    })
    this.watcher = watcher
    watcher.on('all', (event, absolute) => {
      if (this.stopped) return
      if (event === 'add') countFile(absolute, true)
      else if (event === 'unlink') countFile(absolute, false)
      const relpath = path.relative(this.dir, absolute).split(path.sep).join('/')
      if (!this.isSafeRoomPath(relpath)) { this.onScanned?.(relpath); return }
      if (event === 'addDir' || event === 'unlinkDir') return
      if (path.basename(relpath) === '.gitignore') {
        if (this.trackedPoll) this.trackedPoll.trigger()
        else observeCallback(() => this.refreshTracked(), error => this.log(`warn: ${errMsg(error)}`))
      }
      if (relpath === ROOMIGNORE) { this.reloadRoomIgnore(); return }
      this.scheduleDisk(relpath, event === 'add')
    })
    watcher.on('error', error => this.log(`watcher error: ${errMsg(error)}`))
    // Before ready, an error on the clone itself or running out of watches means nothing would be seen: fail the start.
    // An unreadable subdirectory is only logged; the rest of the clone is still watched.
    await new Promise<void>((resolve, reject) => {
      const fatal = (error: unknown) => {
        const e = error as NodeJS.ErrnoException
        if (e?.path === this.dir || e?.code === 'EMFILE' || e?.code === 'ENOSPC') { watcher.off('ready', ready); reject(new RoomdError(`cannot watch ${this.dir}: ${errMsg(error)}`, 1)) }
      }
      const ready = () => { watcher.off('error', fatal); resolve() }
      watcher.on('error', fatal)
      watcher.once('ready', ready)
    })
    for (const [dir, names] of Object.entries(watcher.getWatched())) for (const name of names) {
      const absolute = path.join(dir, name)
      try { if (fs.statSync(absolute).isFile()) countFile(absolute, true) } catch { /* raced with unlink */ }
    }
    this.log(`watching ${watchedFiles.size} files`)
  }

  /** .roomignore changed: newly ignored files leave the room, newly allowed ones are published. */
  private reloadRoomIgnore(): void {
    this.loadRoomIgnore()
    this.applyInputs({ ...this.inputs, rules: rulesFromText(this.roomIgnoreText, this.sizeCap, this.totalBudget) })
  }

  /** Does not synthesize events: callers must first observe the change they are waiting for. */
  async settle(): Promise<void> {
    while (this.batch.size || this.diskWork.size) {
      await Promise.all([...this.diskWork, new Promise<void>(resolve => setTimeout(resolve, this.debounceMs))])
    }
  }

  scheduleDisk(relpath: string, isNew: boolean): void {
    this.batch.add(relpath, isNew)
  }

  private async onDiskChange(relpath: string, isNew: boolean): Promise<void> {
    if (this.stopped) return
    if (await gitIgnored(this.dir, relpath)) { this.tracked.delete(relpath); await this.publisher.reconcile('all', this.publicationComplete()); return }
    if (!this.tracked.has(relpath) && !manifestPaths(this.roomDoc, this.name).includes(relpath)) {
      if (!isNew || !fs.existsSync(this.abs(relpath))) return
      this.tracked.add(relpath)
    }
    await this.publisher.reconcile('all', this.publicationComplete())
  }

  /** Does git track (or offer as untracked) any file under this directory? */
  private holdsTracked(dir: string): boolean {
    const prefix = `${dir}/`
    for (const relpath of this.tracked) if (relpath.startsWith(prefix)) return true
    return false
  }

  private async refreshTracked(): Promise<void> {
    if (this.stopped) return
    const next = await gitTracked(this.dir)
    const added = Array.from(next.paths).filter(relpath => !this.tracked.has(relpath))
    const promoted = Array.from(next.indexed).filter(relpath => !this.indexed.has(relpath))
    const demoted = Array.from(this.indexed).filter(relpath => !next.indexed.has(relpath) && next.paths.has(relpath))
    const removed = Array.from(new Set([...this.tracked, ...manifestPaths(this.roomDoc, this.name)])).filter(relpath => !next.paths.has(relpath))
    this.tracked = next.paths
    this.indexed = next.indexed
    for (const relpath of new Set([...added, ...promoted, ...demoted])) {
      if (!this.isIgnoredPath(relpath) && fs.existsSync(this.abs(relpath))) {
        this.scheduleDisk(relpath, true)
        if (isRegenerableBuildPath(relpath)) this.watcher?.add(this.abs(relpath))
      }
    }
    // Untracked files disappear from ls-files when deleted, so polling must
    // publish their deletion even if the platform watcher misses the unlink.
    for (const relpath of removed) {
      if (fs.existsSync(this.abs(relpath)) && await gitIgnored(this.dir, relpath)) {
        this.scheduleDisk(relpath, false)
      } else if (this.fence && this.roomDoc.overlayText(manifestKey(this.name, this.fence), relpath) && !fs.existsSync(this.abs(relpath))) {
        this.scheduleDisk(relpath, false)
      }
    }
  }
}

type ClaimSnapshot = Claim & { anchorText?: string; oldText?: string; claimState?: string }
interface ClaimChanges { moves: ClaimMove[]; releases: ClaimRelease[]; uncertain: string[]; fileState: Map<string, string>; hashById: Map<string, string | undefined>; claimState: Map<string, string | undefined> }
type PushedPending = NonNullable<ParticipantGit['pushedPending']>
interface TransitionFacts { next?: ParticipantGit; pushed?: PushedPending }
/** A post the hub took: a refusal resolves `{ ok: false }`, and no hub connection yet resolves undefined. */
const hubAccepted = (result: unknown) => result != null && !(typeof result === 'object' && 'ok' in result && result.ok === false)
/** Preparations a HEAD transition tries before it gives up until the next poll. */
const TRANSITION_ATTEMPTS = 5
const NO_CLAIM_CHANGES: ClaimChanges = { moves: [], releases: [], uncertain: [], fileState: new Map(), hashById: new Map(), claimState: new Map() }

/** Detached HEAD has no branch: `''` in the record (reporooms §Participant record). */
const branchName = (abbrev: string) => abbrev === 'HEAD' ? '' : abbrev

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
