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
import { RoomDoc, colorFor, type BaseMsg, type Kind, type Presence } from '@room/shared'
import { gitBranch, gitCountBetween, gitHead, gitIgnored, gitIsOnRemote, gitOrigin, gitPathsBetween, gitRelation, gitShow, gitSubject, gitTracked } from './git.js'

export interface RoomdOptions {
  /** Full room URL, e.g. ws://host:1234/my-room */
  room: string
  /** Path to the git clone. */
  dir: string
  /** Person whose overlay this daemon publishes. */
  name: string
  /** Presence kind to publish; 'agent' when embedded in the MCP server. Default 'human'. */
  kind?: Kind
  /** Shared room token, sent as ?token= on the websocket. Default: ROOM_TOKEN env. */
  token?: string
  /** GitHub token proving read access to the repo, sent as ?gh=. */
  githubToken?: string
  log?: (line: string) => void
  /** Max time to wait for the initial sync; default 15s. */
  connectTimeoutMs?: number
  /** Overrides for tests. */
  debounceMs?: number
  trackedRefreshMs?: number
  /** How often to check whether local HEAD moved (commit/pull); default 3s. */
  basePollMs?: number
  sizeCap?: number
  /** In-memory transport override for tests that cannot open loopback sockets. */
  providerFactory?: (serverUrl: string, roomName: string, doc: Y.Doc) => WebsocketProvider
}

export interface Roomd {
  stop(): Promise<void>
  touch(): void
  readonly dir: string
  readonly name: string
  readonly roomDoc: RoomDoc
  readonly provider: WebsocketProvider
  readonly branch: string
  readonly base: string
}

export class RoomdError extends Error {
  constructor(message: string, public readonly code: number) {
    super(message)
    this.name = 'RoomdError'
  }
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv'])
const ROOM_FILE = '.room.json'

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
  private readonly log: (line: string) => void
  private readonly debounceMs: number
  private readonly trackedRefreshMs: number
  private readonly basePollMs: number
  private readonly sizeCap: number
  private readonly connectTimeoutMs: number
  private readonly roomUrl: string

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
    this.roomUrl = options.room
    this.log = options.log ?? (line => process.stderr.write(`[roomd] ${line}\n`))
    this.debounceMs = options.debounceMs ?? 50
    this.trackedRefreshMs = options.trackedRefreshMs ?? 10_000
    this.basePollMs = options.basePollMs ?? 3_000
    this.sizeCap = options.sizeCap ?? 512 * 1024
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000
    const { serverUrl, roomName } = splitRoomUrl(options.room)
    this.provider = options.providerFactory
      ? options.providerFactory(serverUrl, roomName, this.roomDoc.doc)
      : new WebsocketProvider(serverUrl, roomName, this.roomDoc.doc, {
          WebSocketPolyfill: WebSocket as any,
          params: { ...tokenParams(options.token ?? process.env.ROOM_TOKEN), ...(options.githubToken ? { gh: options.githubToken } : {}) },
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

    await this.seedLocalOverlay()
    this.writeRoomFile()
    this.excludeRoomFile()
    await this.startWatcher()
    this.every(this.trackedRefreshMs, () => this.refreshTracked())
    this.every(this.basePollMs, () => this.pollHead())
    this.roomDoc.metaMap.observe(() => { void this.refreshBaseStatus() })
    await this.refreshBaseStatus()
    this.log(`synced ${this.roomDoc.changedPaths(this.name).length} changed paths as ${this.name} (${this.branch}@${this.base.slice(0, 7)})`)
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
    const current = (this.provider.awareness.getLocalState() ?? {}) as Partial<Presence>
    const state: Presence = {
      ...current,
      user: { name: this.name, kind: this.kind, color: colorFor(this.name) },
      status,
      lastActive: this.lastActive,
    }
    this.provider.awareness.setLocalState(state)
  }

  /** Mark this party active now (tool calls count as activity). */
  touch(): void { this.bumpLastActive() }

  private bumpLastActive(): void {
    this.lastActive = Date.now()
    const current = this.provider.awareness.getLocalState() as Presence | null
    this.setStatus(current?.status ?? 'synced')
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
    const exclude = path.join(this.dir, '.git', 'info', 'exclude')
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
    if (head === this.base) return
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
      this.roomDoc.post<BaseMsg>({ name: this.name, kind: this.kind }, { type: 'base', base: to, prev: from, commits, paths, summary }, this)
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
      const stat = fs.statSync(this.abs(relpath))
      if (!stat.isFile()) return undefined
      if (stat.size > this.sizeCap) {
        if (!quiet) this.log(`skip ${relpath}: ${stat.size} bytes > cap`)
        return undefined
      }
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
    return relpath.split('/').some(segment => IGNORED_DIRS.has(segment))
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

    if (!exists) {
      this.roomDoc.doc.transact(() => {
        this.roomDoc.markDeleted(this.name, relpath, this)
        this.roomDoc.clearOverlay(this.name, relpath, this)
      }, this)
    } else {
      const disk = this.readText(relpath)
      if (disk === undefined) return
      const base = await gitShow(this.dir, this.base, relpath)
      this.roomDoc.doc.transact(() => {
        this.roomDoc.unmarkDeleted(this.name, relpath, this)
        if (disk === base) this.roomDoc.clearOverlay(this.name, relpath, this)
        else this.roomDoc.setOverlay(this.name, relpath, disk, this)
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

  private async startWatcher(): Promise<void> {
    const watcher = chokidar.watch(this.dir, {
      ignoreInitial: true,
      persistent: true,
      ignored: (absolute: string) => {
        const relpath = path.relative(this.dir, absolute).split(path.sep).join('/')
        if (relpath === '') return false
        return relpath.split('/').some(segment => IGNORED_DIRS.has(segment))
      },
    })
    this.watcher = watcher
    watcher.on('all', (event, absolute) => {
      if (this.stopped) return
      const relpath = path.relative(this.dir, absolute).split(path.sep).join('/')
      if (this.isIgnoredPath(relpath) || event === 'addDir' || event === 'unlinkDir') return
      if (path.basename(relpath) === '.gitignore') this.refreshTracked().catch(() => {})
      this.scheduleDisk(relpath, event === 'add')
    })
    watcher.on('error', error => this.log(`watcher error: ${errMsg(error)}`))
    await new Promise<void>(resolve => watcher.on('ready', () => resolve()))
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
