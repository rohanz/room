/**
 * roomd — push-only publisher from one git clone to one person's room overlay.
 *
 * Other participants' overlays are coordination context only. They never write
 * into this clone.
 */
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { WebsocketProvider } from 'y-websocket'
import type * as Y from 'yjs'
import chokidar, { type FSWatcher } from 'chokidar'
import { RoomDoc, colorFor, scopeCovers, type BaseMsg, type Kind, type Presence } from '@room/shared'
import { parseRoomIgnore, type RoomIgnore } from './roomignore.js'
import { gitBranch, gitCountBetween, gitHead, gitIgnored, gitIsOnRemote, gitOrigin, gitPathsBetween, gitRelation, gitShow, gitSubject, gitTracked } from './git.js'

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
  /** Shared room token, sent as ?token= on the websocket. Default: ROOM_TOKEN env. */
  token?: string
  /** Room session id from GitHub device login, sent as ?session= (servers with GITHUB_CLIENT_ID). */
  session?: string
  /** Local relay key (room-local.json): sent as ?key= so only sessions that can read the clone's git dir connect. */
  localKey?: string
  log?: (line: string) => void
  /** Test hook: awaited inside the publish path after the base text is read, before the room is written. */
  beforePublishWrite?: (relpath: string) => Promise<void>
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
  stop(): Promise<void>
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
  return relpath.split('/').some(segment => DEFAULT_IGNORED_DIRS.has(segment))
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
    await daemon.stop().catch(() => {})
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
  private beforePublishWrite?: (relpath: string) => Promise<void>

  private tracked = new Set<string>()
  private watcher: FSWatcher | null = null
  private timers = new Set<NodeJS.Timeout>()
  private debounce = new Map<string, NodeJS.Timeout>()
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
    this.debounceMs = options.debounceMs ?? 50
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
    this.beforePublishWrite = options.beforePublishWrite
    const { serverUrl, roomName } = splitRoomUrl(options.room)
    this.provider = options.providerFactory
      ? options.providerFactory(serverUrl, roomName, this.roomDoc.doc)
      : new WebsocketProvider(serverUrl, roomName, this.roomDoc.doc, {
          WebSocketPolyfill: WebSocket as any,
          params: { ...tokenParams(options.token ?? process.env.ROOM_TOKEN), ...(options.localKey ? { key: options.localKey } : {}), ...(options.session ? { session: options.session } : {}) },
        })
    this.setStatus('syncing')
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
    this.roomDoc.setBaseOf(this.name, this.base, this)
    const roomBase = this.roomDoc.meta.base
    if (roomBase && roomBase !== this.base) {
      const rel = await gitRelation(this.dir, this.base, roomBase)
      if (rel === 'ahead') await this.maybeAdvance(roomBase, this.base)
      else if (rel === 'behind') this.log(`behind room base ${roomBase.slice(0, 10)} (local HEAD ${this.base.slice(0, 10)}); git pull to catch up`)
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
    this.writeRoomFile()
    this.excludeRoomFile()
    await this.startWatcher()
    this.trimBusIfLeader()
    if (this.busTrimMs > 0) this.every(this.busTrimMs, () => this.trimBusIfLeader())
    this.every(this.trackedRefreshMs, () => this.refreshTracked())
    this.every(this.basePollMs, () => this.pollHead())
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

  /** May this file's text (or its deletion) be published at the current level? */
  private isShared(relpath: string): boolean {
    if (this.share === 'full') return true
    if (this.share === 'intent') return false
    return scopeCovers({ paths: this.scopePaths() }, relpath)
  }

  /** Re-evaluate every tracked file against the current level: withdraw what is no longer allowed, publish what now is. */
  private async resharePaths(): Promise<void> {
    if (this.stopped) return
    const paths = new Set([...this.tracked, ...this.roomDoc.changedPaths(this.name), ...this.skips.share])
    for (const relpath of paths) {
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
    if (changed) this.skips.share.add(relpath)
    else this.skips.share.delete(relpath)
  }

  private loadRoomIgnore(): void {
    let text = ''
    try { text = fs.readFileSync(this.abs(ROOMIGNORE), 'utf8') } catch { /* none */ }
    this.roomIgnore = parseRoomIgnore(text)
    if (this.roomIgnore.patterns) this.log(`${ROOMIGNORE}: ${this.roomIgnore.patterns} pattern(s)`)
  }

  /** Bytes of overlay text this person currently shares, excluding one path (about to be replaced). */
  private sharedBytes(except: string): number {
    let total = 0
    for (const [relpath, text] of this.roomDoc.overlay(this.name)) if (relpath !== except) total += text.length
    return total
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const timer of this.timers) clearInterval(timer)
    for (const timer of this.debounce.values()) clearTimeout(timer)
    await this.watcher?.close().catch(() => {})
    try { this.provider.awareness.setLocalState(null) } catch { /* already disconnected */ }
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

  private setStatus(status: string): void {
    const current = (this.provider.awareness.getLocalState() ?? {}) as Partial<SharePresence>
    const state: SharePresence = {
      ...current,
      user: { name: this.name, kind: this.kind, owner: this.owner, ...(this.label ? { label: this.label } : {}), color: colorFor(this.name) },
      status,
      share: this.share,
      lastActive: this.lastActive,
    }
    this.provider.awareness.setLocalState(state)
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
      fs.writeFileSync(
        path.join(this.dir, ROOM_FILE),
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
      if (current.split(/\r?\n/).includes(ROOM_FILE)) return
      const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
      fs.appendFileSync(exclude, `${separator}${ROOM_FILE}\n`)
    } catch (error) {
      this.log(`warn: could not add ${ROOM_FILE} to .git/info/exclude: ${errMsg(error)}`)
    }
  }

  // ---- startup and disk -> overlay --------------------------------------

  // ---- base commit tracking ---------------------------------------------

  /** Local HEAD moved (commit, pull, checkout): re-seed the overlay and maybe advance the room base. */
  private async pollHead(): Promise<void> {
    if (this.stopped) return
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
    for (const relpath of this.roomDoc.changedPaths(this.name)) if (!this.tracked.has(relpath)) await this.publishDiskState(relpath)
    await this.refreshBaseStatus()
  }

  /** Advance the shared base only once the commit is on the remote; teammates cannot pull an unpushed commit. */
  private async maybeAdvance(from: string, to: string): Promise<void> {
    if (await gitIsOnRemote(this.dir, to)) await this.advanceBase(from, to)
    else { this.setStatus('ahead of base (unpushed): git push'); this.log(`HEAD ${to.slice(0, 10)} is ahead of the room base but not pushed; base stays at ${from.slice(0, 10)}`) }
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
      this.setStatus(`behind base by ${n || '?'} commit${n === 1 ? '' : 's'}: git pull`)
    } else if (rel === 'ahead') { await this.maybeAdvance(roomBase, this.base) }
    else this.setStatus(`${rel === 'unknown' ? 'behind base (fetch)' : 'diverged from base'}: git pull`)
  }

  private async seedLocalOverlay(): Promise<void> {
    for (const relpath of this.tracked) {
      if (!this.isSafeRoomPath(relpath)) continue
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
      // git stores a symlink as its target path; compare the same thing, not the target's content.
      if (stat.isSymbolicLink()) return fs.readlinkSync(this.abs(relpath))
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
        if (!quiet) this.log(`skip ${relpath}: not UTF-8`)
        return undefined
      }
    } catch {
      return undefined
    }
  }

  private isIgnoredPath(relpath: string): boolean {
    if (!relpath || relpath === ROOM_FILE) return true
    if (defaultIgnoredPath(relpath)) return true
    if (this.roomIgnore.ignores(relpath)) {
      if (!this.skips.ignore.has(relpath)) { this.skips.ignore.add(relpath); this.log(`skip ${relpath}: ${ROOMIGNORE}`) }
      return true
    }
    return false
  }

  private isSafeRoomPath(relpath: string): boolean {
    if (this.isIgnoredPath(relpath)) return false
    const target = path.resolve(this.dir, ...relpath.split('/'))
    const inside = path.relative(this.dir, target)
    return inside !== '' && inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside)
  }

  private async publishDiskState(relpath: string): Promise<void> {
    if (!this.isSafeRoomPath(relpath)) return
    const exists = fs.existsSync(this.abs(relpath))
    const beforeText = this.roomDoc.text(relpath, this.name)
    const beforeDeleted = this.roomDoc.deleted.get(this.name)?.has(relpath) ?? false

    if (!this.isShared(relpath)) {
      // Withheld by the sharing level: publish nothing, but remember whether it differs from base.
      if (!exists) { this.withhold(relpath, this.tracked.has(relpath) && (await gitShow(this.dir, this.base, relpath)) !== undefined); return }
      const disk = this.readText(relpath, true)
      this.withhold(relpath, disk !== undefined && disk !== await gitShow(this.dir, this.base, relpath))
      return
    }
    this.skips.share.delete(relpath)

    if (!exists) {
      this.roomDoc.doc.transact(() => {
        this.roomDoc.markDeleted(this.name, relpath, this)
        this.roomDoc.clearOverlay(this.name, relpath, this)
      }, this)
    } else {
      const disk = this.readText(relpath)
      if (disk === undefined) return
      const base = await gitShow(this.dir, this.base, relpath)
      await this.beforePublishWrite?.(relpath)
      // The level or scope may have changed while we waited on git: never write text the current level withholds.
      if (!this.isShared(relpath)) { this.withhold(relpath, disk !== base); return }
      if (disk !== base && this.sharedBytes(relpath) + disk.length > this.totalBudget) {
        if (!this.skips.budget.has(relpath)) { this.skips.budget.add(relpath); this.log(`skip ${relpath}: sharing it would exceed the ${Math.round(this.totalBudget / 1024)} KB total budget`) }
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
    if (beforeText !== afterText || beforeDeleted !== afterDeleted) {
      this.bumpLastActive()
      this.log(afterDeleted ? `marked ${relpath} deleted` : afterText === undefined ? `cleared ${relpath} overlay` : `published ${relpath} overlay`)
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
      persistent: true,
      ignored: (absolute: string) => {
        const relpath = path.relative(this.dir, absolute).split(path.sep).join('/')
        if (relpath === '') return false
        return defaultIgnoredPath(relpath)
      },
    })
    this.watcher = watcher
    watcher.on('all', (event, absolute) => {
      if (this.stopped) return
      if (event === 'add') countFile(absolute, true)
      else if (event === 'unlink') countFile(absolute, false)
      const relpath = path.relative(this.dir, absolute).split(path.sep).join('/')
      if (this.isIgnoredPath(relpath) || event === 'addDir' || event === 'unlinkDir') return
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
    for (const relpath of this.tracked) {
      const nowIgnored = this.isIgnoredPath(relpath)
      if (nowIgnored && this.roomDoc.overlayText(this.name, relpath)) {
        this.roomDoc.doc.transact(() => { this.roomDoc.clearOverlay(this.name, relpath, this); this.roomDoc.unmarkDeleted(this.name, relpath, this) }, this)
        this.log(`cleared ${relpath} overlay (${ROOMIGNORE})`)
      } else if (!nowIgnored && before.has(relpath)) this.scheduleDisk(relpath, false)
    }
  }

  private scheduleDisk(relpath: string, isNew: boolean): void {
    const previous = this.debounce.get(relpath)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.debounce.delete(relpath)
      this.onDiskChange(relpath, isNew).catch(error => this.log(`warn: ${relpath}: ${errMsg(error)}`))
    }, this.debounceMs)
    this.debounce.set(relpath, timer)
  }

  private async onDiskChange(relpath: string, isNew: boolean): Promise<void> {
    if (this.stopped) return
    if (!this.tracked.has(relpath)) {
      if (!isNew || !fs.existsSync(this.abs(relpath)) || await gitIgnored(this.dir, relpath)) return
      this.tracked.add(relpath)
    }
    await this.publishDiskState(relpath)
  }

  private async refreshTracked(): Promise<void> {
    if (this.stopped) return
    try {
      const next = await gitTracked(this.dir)
      const added = Array.from(next).filter(relpath => !this.tracked.has(relpath))
      const removed = Array.from(this.tracked).filter(relpath => !next.has(relpath))
      this.tracked = next
      for (const relpath of added) {
        if (!this.isIgnoredPath(relpath) && fs.existsSync(this.abs(relpath))) this.scheduleDisk(relpath, true)
      }
      // Untracked files disappear from ls-files when deleted, so polling must
      // publish their deletion even if the platform watcher misses the unlink.
      for (const relpath of removed) {
        if (this.roomDoc.overlayText(this.name, relpath) && !fs.existsSync(this.abs(relpath))) {
          await this.publishDiskState(relpath)
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
