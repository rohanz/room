/**
 * roomd — push-only publisher from one git clone to one person's room overlay.
 *
 * Other participants' overlays are coordination context only. They never write
 * into this clone.
 */
import { readRoomFile, roomFilePath } from './room-file.js'
export { validRepoPath, isInsideRoot, containedRepoPath, MATERIALIZED_PATH, DISK_READ_PATH, LINK_INPUT_PATH, RECORDED_PATH, CARRIED_PATH, type RepoPathSyntax, type RepoLeafPolicy, type RepoContainmentOptions } from './repo-path.js'
export { readRoomFile, roomFilePath, type RoomFile } from './room-file.js'
import { commonGitDirFromDotGit } from './git-dirs.js'
import { RetainedDeclaredPaths } from './retained-declared.js'
export { worktreeGitDirFromDotGit, worktreeGitDirSync, commonGitDirFromDotGit, gitCommonDir, realGitCommonDir, carryRecord, carryRecordSync } from './git-dirs.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DiskBatch } from './disk-batch.js'
import { WebSocket } from 'ws'
import { WebsocketProvider } from 'y-websocket'
import { claimDigest, reanchorClaims } from './reanchor.js'
import type { Claim, ReleaseMsg } from '@room/shared'
import type * as Y from 'yjs'
import chokidar, { type FSWatcher } from 'chokidar'
import { BASE_CATCH_UP, RoomDoc, colorFor, isRegenerableBuildPath, roomNameParts, scopeCovers, type BaseMsg, type Kind, type Msg, type NoteMsg, type Presence } from '@room/shared'

import { parseRoomIgnore, type RoomIgnore } from './roomignore.js'
import { baselineText, carriesWork, workerBaseline, type Baseline } from './baseline.js'
import { git, gitBlobInfoMany, gitBranch, gitChanged, gitCountBetween, gitHead, gitIgnored, gitOrigin, gitPathsBetween, gitPushedRoomHead, gitRelation, gitRoomRemoteBranchExists, gitShow, gitShowMany, gitSubject, gitTracked, type GitBlobInfo } from './git.js'

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
export type ShareLevel = 'intent' | 'declared' | 'full'
export const SHARE_LEVELS: readonly ShareLevel[] = ['intent', 'declared', 'full']
const SHARE_RANK: Record<ShareLevel, number> = { intent: 0, declared: 1, full: 2 }
/** A level from user input (env, tool argument); undefined when it is not one. */
export function parseShare(v: unknown): ShareLevel | undefined {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return (SHARE_LEVELS as readonly string[]).includes(s) ? s as ShareLevel : undefined
}
/** The level actually allowed: never above the server ceiling. */
export function clampShare(level: ShareLevel, max: ShareLevel): ShareLevel {
  return SHARE_RANK[level] > SHARE_RANK[max] ? max : level
}
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
  /** Local relay key (room-local.json): sent as ?key= so only sessions that can read the clone's git dir connect. */
  localKey?: string
  log?: (line: string) => void
  /** Test hook: awaited inside the publish path after the base text is read, before the room is written. */
  beforePublishWrite?: (relpath: string) => Promise<void>
  /** Test hook: called after a watched disk change has finished processing, including skipped files. */
  onScanned?: (relpath: string) => void
  /** Max time to wait for the initial sync; default 15s. */
  connectTimeoutMs?: number
  /** Max time for the whole startup (git reads, sync, seed, watcher); default 60s. */
  startupTimeoutMs?: number
  /** Overrides for tests. */
  debounceMs?: number
  trackedRefreshMs?: number
  /** How often to check whether local HEAD moved (commit/pull); default 3s. */
  basePollMs?: number
  /** Per-file cap in bytes; larger files are skipped. Default 512 KB. */
  sizeCap?: number
  /** Total text this person shares across all files; files that would exceed it are skipped. Default 8 MB. */
  totalBudget?: number
  /** Sharing level; default 'full'. */
  share?: ShareLevel
  /** Current server ceiling, checked again before each overlay write during startup. */
  shareCeiling?: () => ShareLevel
  /** Paths whose files are published under 'declared'. Default: the person's scope in the room doc, kept in sync as it changes. */
  scopePaths?: string[]
  /** In-memory transport override for tests that cannot open loopback sockets. */
  providerFactory?: (serverUrl: string, roomName: string, doc: Y.Doc) => WebsocketProvider
  /** Rolling bus size and maintenance interval. Defaults: ROOM_BUS_KEEP/2000 and 60s. */
  busKeep?: number
  busTrimMs?: number
  /** After startup, skipped files are logged as one count per this window; default 10s. */
  skipLogMs?: number
}

export interface Skipped { size: string[]; budget: string[]; ignore: string[]; share: string[] }

export interface Roomd {
  stop(reason?: string): Promise<void>
  /** Test barrier for already-observed watcher events: drains debounces and in-flight disk publishes. */
  settle(): Promise<void>
  touch(): void
  readonly dir: string
  readonly name: string
  readonly roomDoc: RoomDoc
  readonly provider: WebsocketProvider
  readonly branch: string
  readonly base: string
  /** Current sharing level. */
  readonly share: ShareLevel
  /** Change the sharing level (and, under 'declared', the paths it covers). Dropping the level withdraws
   *  overlays the new level no longer allows; raising it republishes what the disk holds. Resolves once
   *  every tracked file has been re-evaluated. */
  setShare(level: ShareLevel, scopePaths?: string[]): Promise<void>
  /** Files not shared and why: over the per-file cap, over the total budget, matched by .roomignore, or withheld by the sharing level. */
  skipped(): Skipped
}

export class RoomdError extends Error {
  constructor(message: string, public readonly code: number) {
    super(message)
    this.name = 'RoomdError'
  }
}

export const DEFAULT_IGNORED_DIRS = new Set(['node_modules', '.venv', 'dist', 'build', '.git', '.room', 'target', '.next', 'coverage'])
export function defaultIgnoredPath(relpath: string): boolean {
  return relpath.split('/').some(segment => DEFAULT_IGNORED_DIRS.has(segment) || segment === '.DS_Store' || /\.(npy|npz|parquet|pkl|pt|bin|sqlite|zip|gz|tmp)$/i.test(segment) || segment.endsWith('~') || /^(?:\.#.*|\.tmp(?:[.-].*)?|\..+\.(?:tmp(?:[.-].*)?|sw[opx]|part|atomic))$/i.test(segment))
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
  readonly roomDoc = new RoomDoc()
  readonly provider: WebsocketProvider
  branch = ''
  base = ''
  /**
   * The commit this person's overlays are published against (baseOf): HEAD, except for a carried worker
   * in a team room. Its HEAD is a commit of the lead's uncommitted work that exists only on the lead's
   * machine, so it publishes against the lead's HEAD it was carried from, which teammates can fetch.
   */
  shared = ''
  private readonly localRoom: boolean
  private readonly namedRoomBranch: string
  private readonly roomName: string
  private notifiedSwitch?: string

  readonly dir: string
  readonly name: string
  private readonly kind: Kind
  private readonly owner: string
  private readonly label?: string
  private readonly log: (line: string) => void
  private readonly debounceMs: number
  private readonly trackedRefreshMs: number
  private readonly basePollMs: number
  private readonly sizeCap: number
  private readonly totalBudget: number
  private readonly connectTimeoutMs: number
  private readonly busKeep: number
  private readonly busTrimMs: number
  private roomIgnore: RoomIgnore = parseRoomIgnore('')
  private readonly skips = { size: new Set<string>(), budget: new Set<string>(), ignore: new Set<string>(), share: new Set<string>() }
  private readonly roomUrl: string
  share: ShareLevel
  private readonly shareCeiling?: () => ShareLevel
  /** Explicit scope paths (option / setShare); when unset, the person's scope in the room doc decides. */
  private explicitScopePaths?: string[]
  /** Exact paths already published while declared; task scope may end before teammates collect them. */
  private retainedDeclaredPaths: Set<string> = new Set<string>()
  private beforePublishWrite?: (relpath: string) => Promise<void>

  private onScanned?: (relpath: string) => void

  private tracked = new Set<string>()
  private watcher: FSWatcher | null = null
  private timers = new Set<NodeJS.Timeout>()
  private readonly batch: DiskBatch
  private workQueue: Promise<void> = Promise.resolve()
  private readonly watchedDirectory: string
  private publishUnder?: string
  private publisherChosen = false
  private symlinks = new Set<string>()
  private loggedSkips = new Set<string>()
  /** Skips not yet logged: reason -> count, with one example path; logged as one line per window. */
  private pendingSkips = new Map<string, number>()
  private pendingSkipExample = ''
  private skipLogTimer?: NodeJS.Timeout
  private readonly skipLogMs: number
  private started = false
  private oversizedCache = new Map<string, { size: number; mtimeMs: number; base: string; changed: boolean; hash?: string }>()
  private diskWork = new Set<Promise<void>>()
  private stopped = false
  private lastActive = Date.now()
  /** The startup step in progress, named in a startup failure. */
  phase = 'git'
  onSeedProgress?: () => void

  constructor(options: RoomdOptions) {
    this.dir = path.resolve(options.dir)
    this.name = options.name
    this.kind = options.kind ?? 'human'
    this.owner = options.owner ?? options.name
    this.label = options.label
    this.roomUrl = options.room
    this.localRoom = !!options.localKey
    this.log = options.log ?? (line => process.stderr.write(`[roomd] ${line}\n`))
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
    }, this.debounceMs)
    this.trackedRefreshMs = options.trackedRefreshMs ?? 10_000
    this.basePollMs = options.basePollMs ?? 3_000
    this.sizeCap = options.sizeCap ?? 512 * 1024
    this.totalBudget = options.totalBudget ?? 8 * 1024 * 1024
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000
    const envKeep = Number.parseInt(process.env.ROOM_BUS_KEEP ?? '', 10)
    this.busKeep = Math.max(0, options.busKeep ?? (Number.isFinite(envKeep) ? envKeep : 2000))
    this.busTrimMs = options.busTrimMs ?? 60_000
    this.skipLogMs = options.skipLogMs ?? 10_000
    this.shareCeiling = options.shareCeiling
    this.share = clampShare(options.share ?? 'full', this.shareCeiling?.() ?? 'full')
    this.explicitScopePaths = options.scopePaths
    this.onScanned = options.onScanned
    this.beforePublishWrite = options.beforePublishWrite
    const { serverUrl, roomName } = splitRoomUrl(options.room)
    let decodedRoomName = roomName
    try { decodedRoomName = decodeURIComponent(roomName) } catch { /* use the literal name */ }
    this.roomName = decodedRoomName
    this.namedRoomBranch = roomNameParts(decodedRoomName).branch
    this.provider = options.providerFactory
      ? options.providerFactory(serverUrl, roomName, this.roomDoc.doc)
      : new WebsocketProvider(serverUrl, roomName, this.roomDoc.doc, {
          WebSocketPolyfill: WebSocket as any,
          params: { ...tokenParams(options.token ?? process.env.ROOM_TOKEN), ...(options.localKey ? { key: options.localKey } : {}), ...(options.session ? { session: options.session } : {}) },
        })
    this.setStatus('syncing', { host: options.host, model: options.model, effort: options.effort })
  }

  async start(): Promise<void> {
    if (!fs.existsSync(path.join(this.dir, '.git'))) {
      throw new RoomdError(`${this.dir} is not a git repository`, 1)
    }

    const [branch, base, repo, tracked] = await this.step('git', () => Promise.all([
      gitBranch(this.dir),
      gitHead(this.dir),
      gitOrigin(this.dir),
      gitTracked(this.dir),
    ]))
    this.branch = branch
    this.base = base
    this.tracked = tracked
    this.retainedDeclaredPaths = new RetainedDeclaredPaths(this.dir, this.roomName, this.name, splitRoomUrl(this.roomUrl).serverUrl)

    await this.step('sync', () => this.waitForSync())
    // The daemon owns base receipts. Observe before the initial sweep so a notice
    // cannot arrive between the sweep and subscription.
    const onBaseNotice = (event: Y.YArrayEvent<Msg>) => {
      const notices = event.changes.delta.flatMap(change => (change.insert ?? []) as Msg[])
      this.markIntegratedBaseNotices(notices)
    }
    this.roomDoc.bus.observe(onBaseNotice)
    this.unobserveBus = () => this.roomDoc.bus.unobserve(onBaseNotice)
    this.markIntegratedBaseNotices(this.roomDoc.messages())
    this.phase = 'base'
    this.choosePublisher()
    this.roomDoc.assignColor(this.name, this)
    this.setStatus(this.currentStatus())
    await this.refreshShared()
    this.roomDoc.setBaseOf(this.name, this.shared, this)
    const roomBase = this.roomDoc.meta.base
    if (roomBase && roomBase !== this.base) {
      const rel = await gitRelation(this.dir, this.base, roomBase)
      if (rel === 'ahead') await this.maybeAdvance(roomBase, this.base)
      else if (rel === 'behind') this.log(`behind room base ${roomBase.slice(0, 10)} (local HEAD ${this.base.slice(0, 10)})${this.isWorkerWorktree() ? '' : `; ${BASE_CATCH_UP}`}`)
      else {
        const message = rel === 'unknown'
          ? `room base ${roomBase} is not in this clone (local HEAD ${this.base}) — ${BASE_CATCH_UP} Then $room-join`
          : `local HEAD ${this.base} has diverged from room base ${roomBase} — stop and tell your human; never merge another branch into this one`
        this.setStatus(`error: ${message}`)
        throw new RoomdError(message, 2)
      }
    }
    if (!roomBase) {
      this.roomDoc.setMeta({
        ...(repo ? { repo } : {}),
        branch: this.roomBranch(),
        base: this.base,
        createdAt: Date.now(),
        seededBy: this.name,
      }, this)
    }

    this.loadRoomIgnore()
    await this.step('seed', () => this.seedLocalOverlay())
    if (!this.publishUnder) this.writeRoomFile()
    this.excludeRoomFile()
    await this.step('watch', () => this.startWatcher())
    this.trimBusIfLeader()
    if (this.busTrimMs > 0) this.every(this.busTrimMs, () => this.trimBusIfLeader())
    this.every(this.trackedRefreshMs, () => this.refreshTracked())
    this.every(this.basePollMs, () => this.enqueue(() => this.pollHead()))
    this.roomDoc.metaMap.observe(() => observeCallback(() => this.refreshBaseStatus(), error => this.log(`warn: ${errMsg(error)}`)))
    // Under 'declared' the published set follows the person's scope; re-evaluate when it changes.
    this.roomDoc.scopes.observe(ev => { if (ev.keysChanged.has(this.name) && this.share === 'declared' && !this.explicitScopePaths) observeCallback(() => this.resharePaths(), error => this.log(`warn: ${errMsg(error)}`)) })
    await this.refreshBaseStatus()
    this.pendingSkips.clear() // the startup scan's skips are counted in the synced line
    this.started = true
    this.log(`synced ${this.roomDoc.changedPaths(this.name).length} changed paths as ${this.name} (${this.branch}@${this.base.slice(0, 7)}, sharing ${this.share})${this.skipSummary()}`)
  }

  private step<T>(phase: string, work: () => Promise<T>): Promise<T> {
    this.phase = phase
    if (phase === 'seed') this.onSeedProgress?.()
    return inPhase(phase, work)
  }

  skipped(): Skipped {
    return { size: Array.from(this.skips.size), budget: Array.from(this.skips.budget), ignore: Array.from(this.skips.ignore), share: Array.from(this.skips.share).sort() }
  }

  private skipSummary(): string {
    const n = this.skips.size.size + this.skips.budget.size + this.skips.ignore.size + this.skips.share.size
    if (!n) return ''
    const parts = [['size', this.skips.size.size], ['budget', this.skips.budget.size], ['ignore', this.skips.ignore.size], ['withheld', this.skips.share.size]].filter(([, c]) => c).map(([k, c]) => `${c} ${k}`)
    return `; skipped ${n} file(s) (${parts.join(', ')})`
  }

  // ---- sharing level ----------------------------------------------------

  async setShare(level: ShareLevel, scopePaths?: string[]): Promise<void> {
    level = clampShare(level, this.shareCeiling?.() ?? 'full')
    const before = this.share
    // Paths passed here are a one-off override; `undefined` keeps following the declared scope.
    this.explicitScopePaths = scopePaths
    this.setEffectiveShare(level)
    if (before !== level) this.log(`sharing ${before} -> ${level}`)
    await this.resharePaths()
  }

  /** Apply every effective boundary in one place, withdrawing existing text before any async reconcile. */
  private setEffectiveShare(level: ShareLevel): void {
    if (level !== this.share) this.retainedDeclaredPaths.clear()
    this.share = level
    this.setStatus(this.currentStatus())
    const changed = new Set(this.roomDoc.changedPaths(this.name))
    const base = this.roomDoc.baseOf(this.name)
    const paths = new Set(changed)
    if (base) for (const key of this.roomDoc.baseTexts.keys()) {
      if (key.startsWith(`${base}:`)) paths.add(key.slice(base.length + 1))
    }
    for (const relpath of paths) {
      if (!this.sharedAtCurrentLevel(relpath)) this.withhold(relpath, changed.has(relpath))
    }
  }

  /** Paths that decide what 'declared' publishes: explicit ones, else the scope in the room doc. */
  private scopePaths(): string[] {
    return this.explicitScopePaths ?? this.roomDoc.scope(this.name)?.paths ?? []
  }

  /** Published state (possibly left over from an earlier daemon session), recorded skips, plus the given paths. */
  private pathsToReconcile(extra: Iterable<string> = []): Set<string> {
    return new Set([
      ...this.roomDoc.changedPaths(this.name),
      ...this.skips.size, ...this.skips.budget, ...this.skips.share,
      ...this.roomDoc.deletedFor(this.name).keys(),
      ...this.retainedDeclaredPaths,
      ...extra,
    ])
  }

  /** May this file's text (or its deletion) be published at the current level? */
  private isShared(relpath: string): boolean {
    const allowed = clampShare(this.share, this.shareCeiling?.() ?? 'full')
    if (allowed !== this.share) this.setEffectiveShare(allowed)
    return this.sharedAtCurrentLevel(relpath)
  }

  private sharedAtCurrentLevel(relpath: string): boolean {
    if (this.share === 'full') return true
    if (this.share === 'intent') return false
    return this.retainedDeclaredPaths.has(relpath) || scopeCovers({ paths: this.scopePaths() }, relpath)
  }

  /** Re-evaluate every changed file against the current level: withdraw what is no longer allowed, publish what now is. */
  private async resharePaths(): Promise<void> {
    if (this.stopped) return
    await this.reconcile(await gitChanged(this.dir))
  }

  /** Withdraw a file from the room without touching disk; remembers it as withheld when it differs from base. */
  private withhold(relpath: string, changed: boolean): void {
    const had = this.roomDoc.overlayText(this.name, relpath) !== undefined || (this.roomDoc.deleted.get(this.name)?.has(relpath) ?? false)
    this.roomDoc.doc.transact(() => {
      if (had) {
        this.roomDoc.clearOverlay(this.name, relpath, this)
        this.roomDoc.unmarkDeleted(this.name, relpath, this)
      }
      const base = this.roomDoc.baseOf(this.name)
      if (base && ![...new Set([...this.roomDoc.overlays.keys(), ...this.roomDoc.deleted.keys()])]
        .some(person => person !== this.name && this.roomDoc.baseOf(person) === base && this.roomDoc.changedPaths(person).includes(relpath))) {
        this.roomDoc.baseTexts.delete(`${base}:${relpath}`)
      }
    }, this)
    if (had) this.log(`withdrew ${relpath} overlay (sharing ${this.share})`)
    this.retainedDeclaredPaths.delete(relpath)
    if (changed) this.skips.share.add(relpath)
    else this.skips.share.delete(relpath)
  }

  /** Stop publishing a path that an ignore rule now excludes, including deletion-only overlays. */
  private withdrawIgnored(relpath: string, reason: string): void {
    const had = this.roomDoc.overlayText(this.name, relpath) !== undefined || (this.roomDoc.deleted.get(this.name)?.has(relpath) ?? false)
    if (had) {
      this.roomDoc.doc.transact(() => { this.roomDoc.clearOverlay(this.name, relpath, this); this.roomDoc.unmarkDeleted(this.name, relpath, this) }, this)
      this.log(`withdrew ${relpath} (${reason})`)
    }
    this.retainedDeclaredPaths.delete(relpath)
    this.skips.share.delete(relpath)
    this.skipIgnored(relpath, reason)
  }

  private loadRoomIgnore(): void {
    let text = ''
    try { if (this.isSafeRoomPath(ROOMIGNORE)) text = fs.readFileSync(this.abs(ROOMIGNORE), 'utf8') } catch { /* none */ }
    this.roomIgnore = parseRoomIgnore(text)
    if (this.roomIgnore.patterns) this.log(`${ROOMIGNORE}: ${this.roomIgnore.patterns} pattern(s)`)
  }

  /** Bytes of overlay text this person currently shares, excluding one path (about to be replaced). */
  private sharedBytes(except: string): number {
    let total = 0
    for (const [relpath, text] of this.roomDoc.overlay(this.name)) if (relpath !== except) total += text.length
    return total
  }

  async stop(reason = 'requested'): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.unobserveBus?.()
    this.flushSkipLog()
    this.log(`stopped: ${reason.replace(/\s+/g, ' ')}`)
    for (const timer of this.timers) clearInterval(timer)
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

  private every(ms: number, fn: () => unknown): void {
    const timer = setInterval(() => {
      observeCallback(fn, error => this.log(`warn: ${errMsg(error)}`))
    }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }

  private setStatus(status: string, runtime: Pick<Presence, 'host' | 'model' | 'effort'> = {}): void {
    const current = (this.provider.awareness.getLocalState() ?? {}) as Partial<SharePresence>
    const state: SharePresence = {
      ...current,
      ...runtime,
      user: { name: this.name, kind: this.kind, owner: this.owner, ...(this.label ? { label: this.label } : {}), color: colorFor(this.name, this.roomDoc) },
      status,
      share: this.share,
      watchedDirectory: this.watchedDirectory,
      publishUnder: this.publishUnder,
      lastActive: this.lastActive,
    }
    this.provider.awareness.setLocalState(state)
  }

  private choosePublisher(): void {
    const states = this.provider.awareness.getStates?.()
    if (!states) return
    const peers = Array.from(states.values()) as Partial<Presence>[]
    const colocated = peers.filter(p => p.watchedDirectory === this.watchedDirectory && p.user?.name !== this.name && p.user?.name)
    // A newly joining daemon follows the existing publisher. If two starters see each
    // other before either has settled, name ordering breaks the resulting cycle.
    const incumbent = colocated.find(p => p.user!.name === this.publishUnder)
    let publisher: string | undefined
    if (incumbent && !incumbent.publishUnder) publisher = incumbent.user!.name
    else if (incumbent?.publishUnder === this.name) publisher = [this.name, incumbent.user!.name].sort()[0]
    else {
      const active = colocated.filter(p => !p.publishUnder && (!this.publisherChosen || p.status !== 'syncing')).map(p => p.user!.name).sort()
      publisher = this.publisherChosen && !this.publishUnder ? [this.name, ...active].sort()[0] : active[0]
    }
    this.publisherChosen = true
    const next = publisher === this.name ? undefined : publisher
    if (next === this.publishUnder) return
    this.publishUnder = next
    this.setStatus(this.currentStatus())
    if (next) {
      this.roomDoc.doc.transact(() => {
        for (const p of this.roomDoc.changedPaths(this.name)) {
          this.roomDoc.clearOverlay(this.name, p, this); this.roomDoc.unmarkDeleted(this.name, p, this)
        }
      }, this)
      this.log(`publishing under ${next} (same watched directory)`)
    } else this.log('publishing watched directory')
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.workQueue = this.workQueue.then(() => this.stopped ? undefined : work()).catch(error => this.log(`warn: ${errMsg(error)}`))
    return this.workQueue
  }

  private currentStatus(): string {
    return (this.provider.awareness.getLocalState() as Presence | null)?.status ?? 'synced'
  }

  /** Mark this party active now (tool calls count as activity). */
  touch(): void { this.bumpLastActive() }

  private bumpLastActive(): void {
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
      readRoomFile(this.dir) // Migrate legacy metadata before replacing it.
      fs.writeFileSync(
        roomFilePath(this.dir),
        JSON.stringify({ room: this.roomUrl, name: this.name, dir: this.dir }, null, 2) + '\n',
      )
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

  private unobserveBus?: () => void

  /** Record receipts before any synchronous delivery observer sees a new bus entry. */
  private markIntegratedBaseNotices(notices: readonly Msg[]): void {
    if (this.stopped) return
    const seen = this.roomDoc.seen(this.name)
    const ids: string[] = []
    for (const notice of notices) {
      if (notice.type !== 'base' || seen.has(notice.id)) continue
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', notice.base, 'HEAD'], {
          cwd: this.dir, stdio: 'ignore', timeout: 2000,
        })
        ids.push(notice.id)
      } catch { /* A missing commit or Git error leaves the notice deliverable. */ }
    }
    this.roomDoc.markSeen(this.name, ids, this)
  }

  /** Local HEAD moved (commit, pull, checkout): re-seed the overlay and maybe advance the room base. */
  private async pollHead(): Promise<void> {
    if (this.stopped) return
    const wasSecondary = !!this.publishUnder
    this.choosePublisher()
    if (wasSecondary && !this.publishUnder) await this.seedLocalOverlay()
    const [head, branch] = await Promise.all([gitHead(this.dir), gitBranch(this.dir)])
    if (head === this.base && branch === this.branch) {
      // HEAD unchanged, but a commit we are ahead with may have been pushed since last check.
      const roomBase = this.roomDoc.meta.base
      if (roomBase && roomBase !== head) await this.refreshBaseStatus()
      return
    }
    const prev = this.base
    const claimSnapshot = prev !== head ? await this.snapshotOwnClaims(prev) : []
    this.base = head
    this.branch = branch
    if (prev !== head) this.markIntegratedBaseNotices(this.roomDoc.messages())
    this.tracked = await gitTracked(this.dir)
    await this.refreshShared()
    this.roomDoc.setBaseOf(this.name, this.shared, this)
    if (prev !== head) this.log(`HEAD moved ${prev.slice(0, 10)} -> ${head.slice(0, 10)}`)
    const roomBase = this.roomDoc.meta.base
    if (roomBase && roomBase !== head && await gitRelation(this.dir, head, roomBase) === 'ahead') await this.maybeAdvance(roomBase, head)
    await this.seedLocalOverlay()
    if (prev !== head) await this.reanchorOwnClaims(head, claimSnapshot)
    await this.refreshBaseStatus()
  }

  private readonly unpushedPairs = new Set<string>()

  private roomBranch(): string { return this.namedRoomBranch || this.roomDoc.meta.branch || this.branch }

  /** Address the branch warning to this agent; a self-authored message is filtered from its inbox. */
  private warnBranchSwitch(): boolean {
    const roomBranch = this.roomBranch()
    if (this.branch === 'HEAD') {
      this.notifiedSwitch = undefined
      this.setStatus(`detached HEAD; room base waits until you return to ${roomBranch}`)
      return true
    }
    if (this.branch === roomBranch) { this.notifiedSwitch = undefined; return false }
    const text = `you switched to ${this.branch}; the room is for ${roomBranch}; commits here are not the room's base until they are pushed to ${roomBranch}`
    this.setStatus(text)
    if (this.notifiedSwitch !== this.branch) {
      this.notifiedSwitch = this.branch
      this.roomDoc.post<NoteMsg>({ name: 'room', kind: 'bot' }, { type: 'note', to: this.name, priority: 'notify', text }, this)
      this.log(text)
    }
    return true
  }

  private isWorkerWorktree(): boolean { return !!this.label && this.branch === `room/${this.label}` }

  /** The lead's work carried into this worker, while HEAD is still the worker's recorded base (baseline.ts). */
  private carried(): Baseline | undefined {
    if (!this.isWorkerWorktree()) return undefined
    const baseline = workerBaseline(this.roomDoc.workerOf(this.name))
    return baseline?.sha === this.base && carriesWork(baseline) ? baseline : undefined
  }

  private async refreshShared(): Promise<void> {
    this.shared = !this.localRoom && this.carried()?.carriedCommit ? (await git(this.dir, ['rev-parse', `${this.base}^`])).trim() : this.base
  }

  private localCommittedHead?: string

  /** A remote branch requires push; without one, local participants share the object store. */
  private async maybeAdvance(from: string, to: string): Promise<void> {
    if (this.isWorkerWorktree()) { this.setStatus('worker worktree ahead of room base'); return }
    if (this.warnBranchSwitch()) return
    if (!await gitRoomRemoteBranchExists(this.dir, this.roomBranch())) {
      if (this.localRoom) await this.advanceBase(from, to)
      this.localCommittedHead = to
      this.setStatus('committed locally')
      return
    }
    const pushed = await gitPushedRoomHead(this.dir, to, this.roomBranch())
    if (pushed && pushed !== from && await gitRelation(this.dir, pushed, from) === 'ahead') {
      await this.advanceBase(from, pushed)
    } else {
      this.setStatus('ahead of base (unpushed): git push')
      const pair = `${to}:${from}`
      if (!this.unpushedPairs.has(pair)) {
        this.unpushedPairs.add(pair)
        this.log(`HEAD ${to.slice(0, 10)} is ahead of the room base but not pushed; base stays at ${from.slice(0, 10)}`)
      }
    }
  }

  private async advanceBase(from: string, to: string): Promise<void> {
    const [commits, paths, summary] = await Promise.all([
      gitCountBetween(this.dir, from, to), gitPathsBetween(this.dir, from, to), gitSubject(this.dir, to),
    ])
    this.roomDoc.doc.transact(() => {
      this.roomDoc.setMeta({ base: to, branch: this.roomBranch() }, this)
      this.roomDoc.post<BaseMsg>({ name: this.name, kind: this.kind, owner: this.owner, ...(this.label ? { label: this.label } : {}) }, { type: 'base', base: to, prev: from, commits, paths, summary }, this)
    }, this)
    this.log(`advanced room base to ${to.slice(0, 10)} (+${commits})`)
  }

  /** Presence status reflects where this clone stands relative to the room base. */
  private async refreshBaseStatus(): Promise<void> {
    if (this.stopped) return
    if (!this.isWorkerWorktree() && this.warnBranchSwitch()) return
    const roomBase = this.roomDoc.meta.base
    if (!roomBase || roomBase === this.base) {
      this.setStatus(this.localCommittedHead === this.base && !await gitRoomRemoteBranchExists(this.dir, this.roomBranch()) ? 'committed locally' : 'synced')
      return
    }
    const rel = await gitRelation(this.dir, this.base, roomBase)
    if (rel === 'behind') {
      const n = await gitCountBetween(this.dir, this.base, roomBase).catch(() => 0)
      this.setStatus(`${this.isWorkerWorktree() ? 'worker worktree behind room base' : 'behind base'} by ${n || '?'} commit${n === 1 ? '' : 's'}${this.isWorkerWorktree() ? '' : `: ${BASE_CATCH_UP}`}`)
    } else if (rel === 'ahead') { await this.maybeAdvance(roomBase, this.base) }
    else this.setStatus(`${rel === 'unknown' ? 'behind base (fetch)' : 'diverged from base'}${this.isWorkerWorktree() ? '' : `: ${BASE_CATCH_UP}`}`)
  }

  /** Capture the claimed code before a commit can clear its overlay. */
  private async snapshotOwnClaims(prev: string): Promise<Claim[]> {
    const owned = [...this.roomDoc.claims.values()].filter(c => c.by === this.name && !c.mirrorOf && !c.path.endsWith('/'))
    const oldPaths = [...new Set(owned.filter(c => !this.roomDoc.overlayText(this.name, c.path) && !c.claimedHash).map(c => c.path))]
    const oldTexts = oldPaths.length ? await gitShowMany(this.dir, prev, oldPaths) : new Map<string, string | undefined>()
    return owned.map(c => {
      const overlay = this.roomDoc.text(c.path, this.name)
      if (c.claimedHash) return c
      if (overlay !== undefined) {
        const range = this.roomDoc.claimRange(c)
        return { ...c, ...range, claimedHash: claimDigest(overlay, range.from, range.to) }
      }
      const oldText = oldTexts.get(c.path)
      return { ...c, claimedHash: oldText === undefined ? undefined : claimDigest(oldText, c.from, c.to) }
    })
  }

  /** Validate only this daemon's claims against the new HEAD or current overlay. */
  private async reanchorOwnClaims(head: string, snapshot: readonly Claim[]): Promise<void> {
    if (!snapshot.length || this.stopped || await gitHead(this.dir) !== head) return
    const paths = [...new Set(snapshot.map(c => c.path))]
    const headTexts = await gitShowMany(this.dir, head, paths)
    if (this.stopped || await gitHead(this.dir) !== head) return
    const currentTexts = new Map(paths.map(p => [p, this.roomDoc.text(p, this.name) ?? headTexts.get(p)]))
    const { moves, releases } = reanchorClaims(this.name, snapshot, currentTexts)
    const hashById = new Map(snapshot.map(c => [c.id, c.claimedHash]))
    this.roomDoc.doc.transact(() => {
      for (const move of moves) {
        const current = this.roomDoc.claims.get(move.id)
        if (current?.by === this.name && !current.mirrorOf) this.roomDoc.moveClaim(move.id, move.from, move.to, this, hashById.get(move.id))
      }
      for (const release of releases) {
        const current = this.roomDoc.claims.get(release.id)
        if (current?.by !== this.name || current.mirrorOf) continue
        this.roomDoc.removeClaim(release.id, this)
        const text = `released your claim on ${release.path}:${release.from}-${release.to}: that code changed in ${head.slice(0, 10)}`
        this.roomDoc.post<ReleaseMsg>({ name: this.name, kind: this.kind }, { type: 'release', claimId: release.id, path: release.path, summary: text }, this)
        this.roomDoc.post<NoteMsg>({ name: 'room', kind: 'bot' }, { type: 'note', to: this.name, priority: 'notify', text }, this)
        this.log(text)
      }
    }, this)
  }

  /** Publish what differs from HEAD: git's changed paths plus what this person already published, never every tracked file. */
  private async seedLocalOverlay(): Promise<void> {
    await this.reconcile(await gitChanged(this.dir))
  }

  /** Publish the disk state of these paths and the published ones, reading every base text in one git process. */
  private async reconcile(extra: Iterable<string>): Promise<void> {
    if (this.stopped) return
    const paths = Array.from(this.pathsToReconcile(extra))
    const base = this.base, shared = this.shared
    const oversized = paths.filter(p => {
      try { const stat = fs.lstatSync(this.abs(p)); return stat.isFile() && stat.size > this.sizeCap } catch { return false }
    })
    const oversizedSet = new Set(oversized)
    const ordinary = paths.filter(p => !oversizedSet.has(p))
    const [texts, sharedTexts, blobs] = await Promise.all([
      gitShowMany(this.dir, base, ordinary),
      shared === base ? undefined : gitShowMany(this.dir, shared, ordinary),
      gitBlobInfoMany(this.dir, base, oversized),
    ])
    // One HEAD check per batch: a move since the read is left to pollHead, which reseeds against the new HEAD.
    if (this.stopped || await gitHead(this.dir) !== base) return
    for (const relpath of paths) {
      if (this.stopped) return
      await this.publishDiskState(relpath, { base, texts, shared, sharedTexts, blobs })
      if (this.phase === 'seed') this.onSeedProgress?.()
    }
  }

  private abs(relpath: string): string {
    return path.join(this.dir, ...relpath.split('/'))
  }

  /** Read UTF-8 text; undefined for missing, binary, or over-cap files. */
  private readText(relpath: string, quiet = false): string | undefined {
    try {
      const stat = fs.lstatSync(this.abs(relpath))
      if (!this.isSafeRoomPath(relpath) || stat.isSymbolicLink()) return undefined
      if (!stat.isFile()) return undefined
      if (stat.size > this.sizeCap) {
        if (!this.skips.size.has(relpath) && !quiet) this.noteSkip(relpath, 'over size cap')
        this.skips.size.add(relpath)
        return undefined
      }
      this.skips.size.delete(relpath)
      const bytes = fs.readFileSync(this.abs(relpath))
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        if (!quiet) this.skipIgnored(relpath, 'not UTF-8')
        return undefined
      }
    } catch {
      return undefined
    }
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

  private skipIgnored(relpath: string, reason: string): void {
    this.skips.ignore.add(relpath)
    if (!this.loggedSkips.has(relpath)) { this.loggedSkips.add(relpath); this.noteSkip(relpath, reason) }
  }

  /** Count a skip for the next summary line: a test run can write thousands of ignored files. */
  private noteSkip(relpath: string, reason: string): void {
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

  private isSafeRoomPath(relpath: string, applyIgnore = true): boolean {
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

  /** `read`: base texts already read at `read.base` (and `read.shared`) with HEAD checked once for the batch (reconcile). */
  private async publishDiskState(relpath: string, read?: { base: string; texts: Map<string, string | undefined>; shared: string; sharedTexts?: Map<string, string | undefined>; blobs?: Map<string, GitBlobInfo | undefined> }): Promise<void> {
    if (this.stopped) return
    this.choosePublisher()
    if (this.publishUnder) return
    this.skips.size.delete(relpath)
    this.skips.budget.delete(relpath)
    if (!this.isSafeRoomPath(relpath)) {
      this.roomDoc.clearOverlay(this.name, relpath, this)
      this.roomDoc.unmarkDeleted(this.name, relpath, this)
      this.retainedDeclaredPaths.delete(relpath)
      return
    }
    if (this.batch.deferHot(relpath)) return
    const publishingBase = this.base, sharedBase = this.shared
    const batched = read?.base === publishingBase && read.shared === sharedBase && read.texts.has(relpath)
    const headText = () => batched ? Promise.resolve(read!.texts.get(relpath)) : gitShow(this.dir, publishingBase, relpath)
    const carried = this.carried()
    const carriedFile = carried?.untracked.has(relpath) === true
    /** What the disk is compared with: HEAD's text, or a carried untracked file's carried text (the lead's, not a worker change). */
    const baseText = () => carriedFile ? baselineText(carried!, relpath, async () => undefined) : headText()
    /** The base text published under baseOf: the compared text, unless baseOf is another commit or holds no carried text of its own. */
    const publishedText = async (compared: string | undefined) => {
      if (sharedBase !== publishingBase) return batched && read!.sharedTexts ? read!.sharedTexts.get(relpath) : gitShow(this.dir, sharedBase, relpath)
      return carriedFile && !carried!.carriedCommit ? headText() : compared
    }
    const moved = () => publishingBase !== this.base || sharedBase !== this.shared
    const headMoved = async () => !batched && await gitHead(this.dir) !== publishingBase
    const oversizedChanged = async () => {
      const stat = fs.statSync(this.abs(relpath))
      const cached = this.oversizedCache.get(relpath)
      const sameFile = cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs
      if (sameFile && cached.base === publishingBase) {
        if (!cached.changed) this.skips.size.delete(relpath)
        return cached.changed
      }
      const blob = read?.base === publishingBase && read.blobs?.has(relpath)
        ? read.blobs.get(relpath) : (await gitBlobInfoMany(this.dir, publishingBase, [relpath])).get(relpath)
      let hash = sameFile ? cached.hash : undefined
      if (blob?.size === stat.size && !hash) hash = (await git(this.dir, ['hash-object', '--no-filters', '--', relpath])).trim()
      const changed = !blob || blob.size !== stat.size || hash !== blob.hash
      this.oversizedCache.set(relpath, { size: stat.size, mtimeMs: stat.mtimeMs, base: publishingBase, changed, ...(hash ? { hash } : {}) })
      if (!changed) this.skips.size.delete(relpath)
      return changed
    }
    const exists = fs.existsSync(this.abs(relpath))
    const beforeText = this.roomDoc.text(relpath, this.name)
    const beforeDeleted = this.roomDoc.deleted.get(this.name)?.has(relpath) ?? false
    let droppedStale = false

    if (!exists) {
      const base = await baseText()
      const published = base === undefined ? undefined : await publishedText(base)
      if (this.stopped || moved() || await headMoved()) { this.scheduleDisk(relpath, true); return }
      if (published === undefined) {
        this.roomDoc.doc.transact(() => {
          this.roomDoc.clearOverlay(this.name, relpath, this)
          this.roomDoc.unmarkDeleted(this.name, relpath, this)
        }, this)
        this.retainedDeclaredPaths.delete(relpath)
        droppedStale = beforeText !== undefined || beforeDeleted
      } else if (!this.isShared(relpath)) {
        this.withhold(relpath, true)
        return
      } else {
        this.skips.share.delete(relpath)
        this.roomDoc.doc.transact(() => {
          this.roomDoc.markDeleted(this.name, relpath, this)
          this.roomDoc.clearOverlay(this.name, relpath, this)
        }, this)
      }
    } else if (!this.isShared(relpath)) {
      // Withheld by the sharing level: publish nothing, but remember whether it differs from base.
      const disk = this.readText(relpath, true)
      const changed = disk === undefined && this.skips.size.has(relpath)
        ? await oversizedChanged() : disk !== undefined && disk !== await baseText()
      this.withhold(relpath, changed)
      return
    } else {
      this.skips.share.delete(relpath)

      const disk = this.readText(relpath)
      if (disk === undefined) {
        if (this.skips.size.has(relpath)) await oversizedChanged()
        this.roomDoc.clearOverlay(this.name, relpath, this)
        this.roomDoc.unmarkDeleted(this.name, relpath, this)
        this.retainedDeclaredPaths.delete(relpath)
        return
      }
      const base = await baseText()
      const published = disk === base ? undefined : await publishedText(base)
      await this.beforePublishWrite?.(relpath)
      if (this.stopped || this.publishUnder || !this.isSafeRoomPath(relpath) || moved() || await headMoved()) { this.scheduleDisk(relpath, true); return }
      // The level or scope may have changed while we waited on git: never write text the current level withholds.
      if (!this.isShared(relpath)) { this.withhold(relpath, disk !== base); return }
      if (disk !== base && this.sharedBytes(relpath) + disk.length > this.totalBudget) {
        if (!this.skips.budget.has(relpath)) { this.skips.budget.add(relpath); this.noteSkip(relpath, `over the ${Math.round(this.totalBudget / 1024)} KB total budget`) }
        this.roomDoc.clearOverlay(this.name, relpath, this)
        this.roomDoc.unmarkDeleted(this.name, relpath, this)
        this.retainedDeclaredPaths.delete(relpath)
        return
      }
      this.skips.budget.delete(relpath)
      this.roomDoc.doc.transact(() => {
        this.roomDoc.unmarkDeleted(this.name, relpath, this)
        if (disk === base) this.roomDoc.clearOverlay(this.name, relpath, this)
        else {
          this.roomDoc.setOverlay(this.name, relpath, disk, this)
          if (disk.length <= this.sizeCap) this.roomDoc.setBaseText(sharedBase, relpath, published ?? '', this)
        }
      }, this)
    }

    const afterText = this.roomDoc.text(relpath, this.name)
    const afterDeleted = this.roomDoc.deleted.get(this.name)?.has(relpath) ?? false
    if (this.share === 'declared' && (afterText !== undefined || afterDeleted)) this.retainedDeclaredPaths.add(relpath)
    else if (afterText === undefined && !afterDeleted) this.retainedDeclaredPaths.delete(relpath)
    if (beforeText !== afterText || beforeDeleted !== afterDeleted) {
      this.batch.published(relpath)
      this.bumpLastActive()
      this.log(droppedStale ? `dropped stale overlay ${relpath}` : afterDeleted ? `marked ${relpath} deleted` : afterText === undefined ? `cleared ${relpath} overlay` : `published ${relpath} overlay`)
    }
  }

  // ---- watcher -----------------------------------------------------------

  private trimBusIfLeader(): void {
    const states = typeof this.provider.awareness.getStates === 'function'
      ? Array.from(this.provider.awareness.getStates().values())
      : [{ user: { name: this.name } }]
    const present = states
      .map(state => (state as Partial<Presence>)?.user?.name)
      .filter((name): name is string => !!name && !name.startsWith('pr#'))
    const workers = new Set(Array.from(this.roomDoc.workers.values()).map(w => w.name))
    const leads = present.filter(name => !workers.has(name)).sort()
    const leader = leads[0] ?? present.sort()[0] ?? this.name
    if (leader !== this.name) return
    const removed = this.roomDoc.trimBus(this.busKeep, this)
    if (removed) this.log(`folded ${removed} old bus messages into the compact ledger (keeping ${this.busKeep})`)
  }

  private async startWatcher(): Promise<void> {
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
      if (path.basename(relpath) === '.gitignore') this.refreshTracked().catch(() => {})
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
    const before = new Set(this.skips.ignore)
    this.skips.ignore.clear()
    this.loadRoomIgnore()
    for (const relpath of this.pathsToReconcile(before)) {
      const nowIgnored = this.isIgnoredPath(relpath)
      if (nowIgnored) this.withdrawIgnored(relpath, ROOMIGNORE)
      else if (before.has(relpath)) this.scheduleDisk(relpath, false)
    }
  }

  /** Does not synthesize events: callers must first observe the change they are waiting for. */
  async settle(): Promise<void> {
    while (this.batch.size || this.diskWork.size) {
      await Promise.all([...this.diskWork, new Promise<void>(resolve => setTimeout(resolve, this.debounceMs))])
    }
  }

  private scheduleDisk(relpath: string, isNew: boolean): void {
    this.batch.add(relpath, isNew)
  }

  private async onDiskChange(relpath: string, isNew: boolean): Promise<void> {
    if (this.stopped) return
    if (await gitIgnored(this.dir, relpath)) {
      this.tracked.delete(relpath)
      this.withdrawIgnored(relpath, '.gitignore')
      return
    }
    if (!this.tracked.has(relpath) && !this.roomDoc.changedPaths(this.name).includes(relpath)) {
      if (!isNew || !fs.existsSync(this.abs(relpath))) return
      this.tracked.add(relpath)
    }
    await this.publishDiskState(relpath)
  }

  /** Does git track (or offer as untracked) any file under this directory? */
  private holdsTracked(dir: string): boolean {
    const prefix = `${dir}/`
    for (const relpath of this.tracked) if (relpath.startsWith(prefix)) return true
    return false
  }

  private async refreshTracked(): Promise<void> {
    if (this.stopped) return
    try {
      const next = await gitTracked(this.dir)
      const added = Array.from(next).filter(relpath => !this.tracked.has(relpath))
      const removed = Array.from(new Set([...this.tracked, ...this.roomDoc.changedPaths(this.name)])).filter(relpath => !next.has(relpath))
      this.tracked = next
      for (const relpath of added) {
        if (!this.isIgnoredPath(relpath) && fs.existsSync(this.abs(relpath))) {
          this.scheduleDisk(relpath, true)
          if (isRegenerableBuildPath(relpath)) this.watcher?.add(this.abs(relpath))
        }
      }
      // Untracked files disappear from ls-files when deleted, so polling must
      // publish their deletion even if the platform watcher misses the unlink.
      for (const relpath of removed) {
        if (fs.existsSync(this.abs(relpath)) && await gitIgnored(this.dir, relpath)) {
          this.withdrawIgnored(relpath, '.gitignore')
        } else if (this.roomDoc.overlayText(this.name, relpath) && !fs.existsSync(this.abs(relpath))) {
          this.scheduleDisk(relpath, false)
        }
      }
    } catch (error) {
      this.log(`warn: git ls-files: ${errMsg(error)}`)
    }
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
