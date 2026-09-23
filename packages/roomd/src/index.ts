/**
 * roomd — push-only publisher from one git clone to one person's room overlay.
 *
 * Other participants' overlays are coordination context only. They never write
 * into this clone.
 */
import { readRoomFile, roomFilePath } from './room-file.js'
export { readRoomFile, roomFilePath, type RoomFile } from './room-file.js'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DiskBatch } from './disk-batch.js'
import { WebSocket } from 'ws'
import { WebsocketProvider } from 'y-websocket'
import type * as Y from 'yjs'
import chokidar, { type FSWatcher } from 'chokidar'
import { RoomDoc, colorFor, scopeCovers, type BaseMsg, type Kind, type Presence } from '@room/shared'
import { parseRoomIgnore, type RoomIgnore } from './roomignore.js'
import { git, gitBranch, gitCountBetween, gitHead, gitIgnored, gitIsOnRemote, gitOrigin, gitPathsBetween, gitRelation, gitShow, gitSubject, gitTracked } from './git.js'

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
  /** Paths whose files are published under 'declared'. Default: the person's scope in the room doc, kept in sync as it changes. */
  scopePaths?: string[]
  /** In-memory transport override for tests that cannot open loopback sockets. */
  providerFactory?: (serverUrl: string, roomName: string, doc: Y.Doc) => WebsocketProvider
  /** Rolling bus size and maintenance interval. Defaults: ROOM_BUS_KEEP/2000 and 60s. */
  busKeep?: number
  busTrimMs?: number
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

export async function startRoomd(options: RoomdOptions): Promise<Roomd> {
  const daemon = new Daemon(options)
  try {
    await daemon.start()
  } catch (error) {
    await daemon.stop(`startup failed: ${errMsg(error)}`).catch(() => {})
    throw error
  }
  return daemon
}

class Daemon implements Roomd {
  readonly roomDoc = new RoomDoc()
  readonly provider: WebsocketProvider
  branch = ''
  base = ''

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
  /** Explicit scope paths (option / setShare); when unset, the person's scope in the room doc decides. */
  private explicitScopePaths?: string[]
  /** Exact paths already published while declared; task scope may end before teammates collect them. */
  private readonly retainedDeclaredPaths = new Set<string>()
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
  private diskWork = new Set<Promise<void>>()
  private stopped = false
  private lastActive = Date.now()

  constructor(options: RoomdOptions) {
    this.dir = path.resolve(options.dir)
    this.name = options.name
    this.kind = options.kind ?? 'human'
    this.owner = options.owner ?? options.name
    this.label = options.label
    this.roomUrl = options.room
    this.log = options.log ?? (line => process.stderr.write(`[roomd] ${line}\n`))
    this.debounceMs = options.debounceMs ?? 300
    this.watchedDirectory = createHash('sha256').update(fs.realpathSync(this.dir)).digest('hex')
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
    this.share = options.share ?? 'full'
    this.explicitScopePaths = options.scopePaths
    this.onScanned = options.onScanned
    this.beforePublishWrite = options.beforePublishWrite
    const { serverUrl, roomName } = splitRoomUrl(options.room)
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

    const [branch, base, repo, tracked] = await Promise.all([
      gitBranch(this.dir),
      gitHead(this.dir),
      gitOrigin(this.dir),
      gitTracked(this.dir),
    ])
    this.branch = branch
    this.base = base
    this.tracked = tracked

    await this.waitForSync()
    this.choosePublisher()
    this.roomDoc.assignColor(this.name, this)
    this.setStatus(this.currentStatus())
    this.roomDoc.setBaseOf(this.name, this.base, this)
    const roomBase = this.roomDoc.meta.base
    if (roomBase && roomBase !== this.base) {
      const rel = await gitRelation(this.dir, this.base, roomBase)
      if (rel === 'ahead') await this.maybeAdvance(roomBase, this.base)
      else if (rel === 'behind') this.log(`behind room base ${roomBase.slice(0, 10)} (local HEAD ${this.base.slice(0, 10)})${this.isWorkerWorktree() ? '' : '; git pull to catch up'}`)
      else {
        const message = rel === 'unknown'
          ? `room base ${roomBase} is not in this clone (local HEAD ${this.base}) — git pull, then $room-join`
          : `local HEAD ${this.base} has diverged from room base ${roomBase} — rebase or merge onto the room base, then $room-join`
        this.setStatus(`error: ${message}`)
        throw new RoomdError(message, 2)
      }
    }
    if (!roomBase) {
      this.roomDoc.setMeta({
        ...(repo ? { repo } : {}),
        branch: this.branch,
        base: this.base,
        createdAt: Date.now(),
        seededBy: this.name,
      }, this)
    }

    this.loadRoomIgnore()
    await this.seedLocalOverlay()
    if (!this.publishUnder) this.writeRoomFile()
    this.excludeRoomFile()
    await this.startWatcher()
    this.trimBusIfLeader()
    if (this.busTrimMs > 0) this.every(this.busTrimMs, () => this.trimBusIfLeader())
    this.every(this.trackedRefreshMs, () => this.refreshTracked())
    this.every(this.basePollMs, () => this.enqueue(() => this.pollHead()))
    this.roomDoc.metaMap.observe(() => { void this.refreshBaseStatus() })
    // Under 'declared' the published set follows the person's scope; re-evaluate when it changes.
    this.roomDoc.scopes.observe(ev => { if (ev.keysChanged.has(this.name) && this.share === 'declared' && !this.explicitScopePaths) void this.resharePaths() })
    await this.refreshBaseStatus()
    this.log(`synced ${this.roomDoc.changedPaths(this.name).length} changed paths as ${this.name} (${this.branch}@${this.base.slice(0, 7)}, sharing ${this.share})${this.skipSummary()}`)
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
    const before = this.share
    if (before !== level) this.retainedDeclaredPaths.clear()
    this.share = level
    // Paths passed here are a one-off override; `undefined` keeps following the declared scope.
    this.explicitScopePaths = scopePaths
    this.setStatus(this.currentStatus())
    if (before !== level) this.log(`sharing ${before} -> ${level}`)
    await this.resharePaths()
  }

  /** Paths that decide what 'declared' publishes: explicit ones, else the scope in the room doc. */
  private scopePaths(): string[] {
    return this.explicitScopePaths ?? this.roomDoc.scope(this.name)?.paths ?? []
  }

  /** Disk paths plus persisted state that may be left over from an earlier daemon session. */
  private pathsToReconcile(extra: Iterable<string> = []): Set<string> {
    return new Set([
      ...this.tracked,
      ...this.roomDoc.changedPaths(this.name),
      ...this.roomDoc.deletedFor(this.name).keys(),
      ...extra,
    ])
  }

  /** May this file's text (or its deletion) be published at the current level? */
  private isShared(relpath: string): boolean {
    if (this.share === 'full') return true
    if (this.share === 'intent') return false
    return this.retainedDeclaredPaths.has(relpath) || scopeCovers({ paths: this.scopePaths() }, relpath)
  }

  /** Re-evaluate every tracked file against the current level: withdraw what is no longer allowed, publish what now is. */
  private async resharePaths(): Promise<void> {
    if (this.stopped) return
    for (const relpath of this.pathsToReconcile(this.skips.share)) {
      if (this.stopped) return
      if (this.isIgnoredPath(relpath)) continue
      await this.publishDiskState(relpath)
    }
  }

  /** Withdraw a file from the room without touching disk; remembers it as withheld when it differs from base. */
  private withhold(relpath: string, changed: boolean): void {
    const had = this.roomDoc.overlayText(this.name, relpath) !== undefined || (this.roomDoc.deleted.get(this.name)?.has(relpath) ?? false)
    if (had) {
      this.roomDoc.doc.transact(() => { this.roomDoc.clearOverlay(this.name, relpath, this); this.roomDoc.unmarkDeleted(this.name, relpath, this) }, this)
      this.log(`withdrew ${relpath} overlay (sharing ${this.share})`)
    }
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
      Promise.resolve(fn()).catch(error => this.log(`warn: ${errMsg(error)}`))
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
    let gitDir = path.join(this.dir, '.git')
    try {
      if (fs.statSync(gitDir).isFile()) {
        const m = fs.readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/)
        if (m) {
          gitDir = path.resolve(this.dir, m[1].trim())
          const common = path.join(gitDir, 'commondir')
          if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, 'utf8').trim())
        }
      }
    } catch { /* fall through to the plain path */ }
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

  /** Local HEAD moved (commit, pull, checkout): re-seed the overlay and maybe advance the room base. */
  private async pollHead(): Promise<void> {
    if (this.stopped) return
    const wasSecondary = !!this.publishUnder
    this.choosePublisher()
    if (wasSecondary && !this.publishUnder) await this.seedLocalOverlay()
    const head = await gitHead(this.dir)
    if (head === this.base) {
      // HEAD unchanged, but a commit we are ahead with may have been pushed since last check.
      const roomBase = this.roomDoc.meta.base
      if (roomBase && roomBase !== head) await this.refreshBaseStatus()
      return
    }
    const prev = this.base
    this.base = head
    this.branch = await gitBranch(this.dir)
    this.tracked = await gitTracked(this.dir)
    this.roomDoc.setBaseOf(this.name, head, this)
    this.log(`HEAD moved ${prev.slice(0, 10)} -> ${head.slice(0, 10)}`)
    const roomBase = this.roomDoc.meta.base
    if (roomBase && roomBase !== head && await gitRelation(this.dir, head, roomBase) === 'ahead') await this.maybeAdvance(roomBase, head)
    await this.seedLocalOverlay()
    await this.refreshBaseStatus()
  }

  private readonly unpushedPairs = new Set<string>()

  private isWorkerWorktree(): boolean { return !!this.label && this.branch === `room/${this.label}` }

  /** Advance the shared base only once the commit is on the remote; teammates cannot pull an unpushed commit. */
  private async maybeAdvance(from: string, to: string): Promise<void> {
    if (this.isWorkerWorktree()) { this.setStatus('worker worktree ahead of room base'); return }
    if (await gitIsOnRemote(this.dir, to)) await this.advanceBase(from, to)
    else {
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
      this.roomDoc.setMeta({ base: to, branch: this.branch }, this)
      this.roomDoc.post<BaseMsg>({ name: this.name, kind: this.kind, owner: this.owner, ...(this.label ? { label: this.label } : {}) }, { type: 'base', base: to, prev: from, commits, paths, summary }, this)
    }, this)
    this.log(`advanced room base to ${to.slice(0, 10)} (+${commits})`)
  }

  /** Presence status reflects where this clone stands relative to the room base. */
  private async refreshBaseStatus(): Promise<void> {
    if (this.stopped) return
    const roomBase = this.roomDoc.meta.base
    if (!roomBase || roomBase === this.base) { this.setStatus('synced'); return }
    const rel = await gitRelation(this.dir, this.base, roomBase)
    if (rel === 'behind') {
      const n = await gitCountBetween(this.dir, this.base, roomBase).catch(() => 0)
      this.setStatus(`${this.isWorkerWorktree() ? 'worker worktree behind room base' : 'behind base'} by ${n || '?'} commit${n === 1 ? '' : 's'}${this.isWorkerWorktree() ? '' : ': git pull'}`)
    } else if (rel === 'ahead') { await this.maybeAdvance(roomBase, this.base) }
    else this.setStatus(`${rel === 'unknown' ? 'behind base (fetch)' : 'diverged from base'}${this.isWorkerWorktree() ? '' : ': git pull'}`)
  }

  private async seedLocalOverlay(): Promise<void> {
    for (const relpath of this.pathsToReconcile()) {
      if (this.stopped) return
      await this.publishDiskState(relpath)
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
        if (!this.skips.size.has(relpath) && !quiet) this.log(`skip ${relpath}: ${stat.size} bytes > cap`)
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
    if (!this.loggedSkips.has(relpath)) { this.loggedSkips.add(relpath); this.log(`skip ${relpath}: ${reason}`) }
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

  private async publishDiskState(relpath: string): Promise<void> {
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
    const publishingBase = this.base
    const oversizedChanged = async () => {
      // Hash without loading an oversized file into this process.
      const [diskHash, baseHash] = await Promise.all([
        git(this.dir, ['hash-object', '--no-filters', '--', relpath]),
        git(this.dir, ['rev-parse', `${publishingBase}:${relpath}`]).catch(() => ''),
      ])
      const changed = diskHash.trim() !== baseHash.trim()
      if (!changed) this.skips.size.delete(relpath)
      return changed
    }
    const exists = fs.existsSync(this.abs(relpath))
    const beforeText = this.roomDoc.text(relpath, this.name)
    const beforeDeleted = this.roomDoc.deleted.get(this.name)?.has(relpath) ?? false
    let droppedStale = false

    if (!exists) {
      const base = await gitShow(this.dir, publishingBase, relpath)
      if (this.stopped || await gitHead(this.dir) !== publishingBase) { this.scheduleDisk(relpath, true); return }
      if (base === undefined) {
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
        ? await oversizedChanged() : disk !== undefined && disk !== await gitShow(this.dir, this.base, relpath)
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
      const base = await gitShow(this.dir, this.base, relpath)
      await this.beforePublishWrite?.(relpath)
      if (this.stopped || this.publishUnder || !this.isSafeRoomPath(relpath) || publishingBase !== this.base || await gitHead(this.dir) !== publishingBase) { this.scheduleDisk(relpath, true); return }
      // The level or scope may have changed while we waited on git: never write text the current level withholds.
      if (!this.isShared(relpath)) { this.withhold(relpath, disk !== base); return }
      if (disk !== base && this.sharedBytes(relpath) + disk.length > this.totalBudget) {
        if (!this.skips.budget.has(relpath)) { this.skips.budget.add(relpath); this.log(`skip ${relpath}: sharing it would exceed the ${Math.round(this.totalBudget / 1024)} KB total budget`) }
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
          if (disk.length <= this.sizeCap) this.roomDoc.setBaseText(this.base, relpath, base ?? '', this)
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
    await new Promise<void>(resolve => watcher.on('ready', () => resolve()))
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

  private async refreshTracked(): Promise<void> {
    if (this.stopped) return
    try {
      const next = await gitTracked(this.dir)
      const added = Array.from(next).filter(relpath => !this.tracked.has(relpath))
      const removed = Array.from(new Set([...this.tracked, ...this.roomDoc.changedPaths(this.name)])).filter(relpath => !next.has(relpath))
      this.tracked = next
      for (const relpath of added) {
        if (!this.isIgnoredPath(relpath) && fs.existsSync(this.abs(relpath))) this.scheduleDisk(relpath, true)
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
