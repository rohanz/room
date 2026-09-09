/**
 * roomd — sync daemon between a git clone on disk and a room Y.Doc (spec §4).
 *
 * Library entry: `startRoomd(opts)` returns `{ stop() }`; the CLI (cli.ts) and
 * `packages/agent` embed it in-process.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import chokidar, { type FSWatcher } from 'chokidar'
import { RoomDoc, colorFor, type Presence } from '@room/shared'
import { git, gitBranch, gitHead, gitTracked } from './git.js'
import { applyLocalEdit } from './merge.js'

export interface RoomdOptions {
  /** Full room URL, e.g. ws://host:1234/my-room */
  room: string
  /** Path to the git clone. */
  dir: string
  /** Person's name (the daemon joins as this human). */
  name: string
  log?: (line: string) => void
  /** Max time to wait for the initial sync; default 15s. */
  connectTimeoutMs?: number
  /** Overrides for tests. */
  debounceMs?: number
  basePollMs?: number
  trackedRefreshMs?: number
  sizeCap?: number
}

export interface Roomd {
  stop(): Promise<void>
  readonly roomDoc: RoomDoc
  readonly provider: WebsocketProvider
  readonly branch: string
  readonly base: string
}

export class RoomdError extends Error {
  constructor(message: string, public readonly code: number) { super(message) }
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv'])
const ROOM_FILE = '.room.json'

export function splitRoomUrl(room: string): { serverUrl: string; roomName: string } {
  const u = new URL(room)
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length === 0) throw new RoomdError(`room URL must end with /<room>: ${room}`, 1)
  const roomName = parts.pop()!
  u.pathname = parts.length ? '/' + parts.join('/') : ''
  return { serverUrl: u.toString().replace(/\/$/, ''), roomName }
}

export async function startRoomd(opts: RoomdOptions): Promise<Roomd> {
  const d = new Daemon(opts)
  try {
    await d.start()
  } catch (err) {
    await d.stop().catch(() => {})
    throw err
  }
  return d
}

class Daemon implements Roomd {
  readonly roomDoc = new RoomDoc()
  readonly provider: WebsocketProvider
  branch = ''
  base = ''
  private readonly dir: string
  private readonly name: string
  private readonly log: (line: string) => void
  private readonly debounceMs: number
  private readonly basePollMs: number
  private readonly trackedRefreshMs: number
  private readonly sizeCap: number
  private readonly connectTimeoutMs: number
  private readonly roomUrl: string

  /** Last text known to be identical on disk and in the room, per path. */
  private shadow = new Map<string, string>()
  private tracked = new Set<string>()
  private watcher: FSWatcher | null = null
  private timers = new Set<NodeJS.Timeout>()
  private debounce = new Map<string, NodeJS.Timeout>()
  private stopped = false
  private lastTrackedRefresh = 0
  private observer: ((events: Y.YEvent<any>[], tr: Y.Transaction) => void) | null = null
  private metaObserver: ((e: Y.YMapEvent<any>, tr: Y.Transaction) => void) | null = null
  private mergeInFlight = false

  constructor(opts: RoomdOptions) {
    this.dir = path.resolve(opts.dir)
    this.name = opts.name
    this.roomUrl = opts.room
    this.log = opts.log ?? (l => process.stderr.write(`[roomd] ${l}\n`))
    this.debounceMs = opts.debounceMs ?? 50
    this.basePollMs = opts.basePollMs ?? 2000
    this.trackedRefreshMs = opts.trackedRefreshMs ?? 10_000
    this.sizeCap = opts.sizeCap ?? 512 * 1024
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000
    const { serverUrl, roomName } = splitRoomUrl(opts.room)
    this.provider = new WebsocketProvider(serverUrl, roomName, this.roomDoc.doc, {
      WebSocketPolyfill: WebSocket as any,
    })
    this.setStatus('syncing')
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (!fs.existsSync(path.join(this.dir, '.git'))) throw new RoomdError(`${this.dir} is not a git repository`, 1)
    ;[this.branch, this.base] = await Promise.all([gitBranch(this.dir), gitHead(this.dir)])
    this.tracked = await gitTracked(this.dir)
    this.lastTrackedRefresh = Date.now()

    await this.waitForSync()

    const meta = this.roomDoc.meta
    if (!meta.base) {
      await this.seed()
    } else {
      if (meta.base !== this.base || (meta.branch && meta.branch !== this.branch)) {
        const msg = `room is at ${meta.base.slice(0, 7)} on ${meta.branch ?? '?'}, you are at ${this.base.slice(0, 7)} on ${this.branch} — git checkout / pull to match, then retry`
        this.setStatus(`error: ${msg}`)
        throw new RoomdError(msg, 2)
      }
      await this.adopt()
    }

    this.writeRoomFile()
    this.observer = (events, tr) => this.onRoomChange(events, tr)
    this.roomDoc.files.observeDeep(this.observer)
    this.metaObserver = (e, tr) => this.onMetaChange(e, tr)
    this.roomDoc.metaMap.observe(this.metaObserver)
    await this.startWatcher()
    this.every(this.basePollMs, () => this.pollBase())
    this.every(this.trackedRefreshMs, () => this.refreshTracked())
    this.setStatus('synced')
    this.log(`synced ${this.roomDoc.paths().length} files as ${this.name} (${this.branch}@${this.base.slice(0, 7)})`)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    for (const t of this.debounce.values()) clearTimeout(t)
    if (this.observer) this.roomDoc.files.unobserveDeep(this.observer)
    if (this.metaObserver) this.roomDoc.metaMap.unobserve(this.metaObserver)
    await this.watcher?.close().catch(() => {})
    try { this.provider.awareness.setLocalState(null) } catch { /* ignore */ }
    this.provider.destroy()
    this.roomDoc.doc.destroy()
  }

  private every(ms: number, fn: () => unknown): void {
    const t = setInterval(() => { Promise.resolve(fn()).catch(e => this.log(`warn: ${errMsg(e)}`)) }, ms)
    t.unref?.()
    this.timers.add(t)
  }

  private setStatus(status: string): void {
    const state: Presence = { user: { name: this.name, kind: 'human', color: colorFor(this.name) }, status }
    this.provider.awareness.setLocalState(state)
  }

  private waitForSync(): Promise<void> {
    if (this.provider.synced) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.provider.off('sync', onSync)
        reject(new RoomdError(`could not sync with ${this.roomUrl} within ${this.connectTimeoutMs}ms`, 1))
      }, this.connectTimeoutMs)
      const onSync = (state: boolean) => {
        if (!state) return
        clearTimeout(timer)
        this.provider.off('sync', onSync)
        resolve()
      }
      this.provider.on('sync', onSync)
    })
  }

  private writeRoomFile(): void {
    try {
      fs.writeFileSync(path.join(this.dir, ROOM_FILE), JSON.stringify({ room: this.roomUrl, name: this.name, dir: this.dir }, null, 2) + '\n')
    } catch (e) { this.log(`warn: could not write ${ROOM_FILE}: ${errMsg(e)}`) }
  }

  // ---- startup: seed / adopt ----------------------------------------------

  private async seed(): Promise<void> {
    let n = 0
    this.roomDoc.doc.transact(() => {
      for (const p of this.tracked) {
        const text = this.readText(p)
        if (text === undefined) continue
        this.roomDoc.setFile(p, text)
        this.shadow.set(p, text)
        n++
      }
      this.roomDoc.setMeta({ repo: path.basename(this.dir), branch: this.branch, base: this.base, createdAt: Date.now(), seededBy: this.name })
    }, this)
    this.log(`seeded room with ${n} files from ${this.dir}`)
  }

  private async adopt(): Promise<void> {
    let written = 0, added = 0
    for (const p of this.roomDoc.paths()) {
      const room = this.roomDoc.text(p)!
      const disk = this.readText(p, true)
      if (disk !== room) {
        try { this.writeAtomic(p, room); written++ } catch (e) { this.log(`warn: ${p}: ${errMsg(e)}`) }
      }
      this.shadow.set(p, room)
    }
    this.roomDoc.doc.transact(() => {
      for (const p of this.tracked) {
        if (this.roomDoc.hasFile(p)) continue
        const text = this.readText(p)
        if (text === undefined) continue
        this.roomDoc.setFile(p, text)
        this.shadow.set(p, text)
        added++
      }
    }, this)
    this.log(`adopted room: ${written} files written to disk, ${added} local files added`)
  }

  // ---- disk helpers ---------------------------------------------------------

  private abs(p: string): string { return path.join(this.dir, ...p.split('/')) }

  /** Read a file as UTF-8 text; undefined if missing, binary, or over the cap. */
  private readText(p: string, quiet = false): string | undefined {
    try {
      const st = fs.statSync(this.abs(p))
      if (!st.isFile()) return undefined
      if (st.size > this.sizeCap) { if (!quiet) this.log(`skip ${p}: ${st.size} bytes > cap`); return undefined }
      const buf = fs.readFileSync(this.abs(p))
      try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch {
        if (!quiet) this.log(`skip ${p}: not UTF-8`)
        return undefined
      }
    } catch { return undefined }
  }

  private writeAtomic(p: string, content: string): void {
    const target = this.abs(p)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.roomd-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`)
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, target)
  }

  private isIgnoredPath(rel: string): boolean {
    if (!rel || rel === ROOM_FILE) return true
    const segs = rel.split('/')
    if (segs.some(s => IGNORED_DIRS.has(s))) return true
    if (/\.roomd-\d+-[a-z0-9]+\.tmp$/.test(rel)) return true
    return false
  }

  // ---- disk -> room ---------------------------------------------------------

  private async startWatcher(): Promise<void> {
    const w = chokidar.watch(this.dir, {
      ignoreInitial: true,
      persistent: true,
      ignored: (abs: string) => {
        const rel = path.relative(this.dir, abs).split(path.sep).join('/')
        if (rel === '') return false
        const segs = rel.split('/')
        return segs.some(s => IGNORED_DIRS.has(s))
      },
    })
    this.watcher = w
    w.on('all', (event, abs) => {
      if (this.stopped) return
      const rel = path.relative(this.dir, abs).split(path.sep).join('/')
      if (this.isIgnoredPath(rel)) return
      if (path.basename(rel) === '.gitignore') this.refreshTracked().catch(() => {})
      if (event === 'addDir' || event === 'unlinkDir') return
      this.scheduleDisk(rel, event === 'add')
    })
    w.on('error', e => this.log(`watcher error: ${errMsg(e)}`))
    await new Promise<void>(resolve => w.on('ready', () => resolve()))
  }

  private scheduleDisk(rel: string, isNew: boolean): void {
    const prev = this.debounce.get(rel)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      this.debounce.delete(rel)
      this.onDiskChange(rel, isNew).catch(e => this.log(`warn: ${rel}: ${errMsg(e)}`))
    }, this.debounceMs)
    this.debounce.set(rel, t)
  }

  private async onDiskChange(rel: string, isNew: boolean): Promise<void> {
    if (this.stopped) return
    if (!this.tracked.has(rel) && !this.roomDoc.hasFile(rel)) {
      // A brand-new file might have just been `git add`ed; refresh the set (throttled).
      if (isNew && Date.now() - this.lastTrackedRefresh > 1000) await this.refreshTracked()
      if (!this.tracked.has(rel)) return
    }
    if (!fs.existsSync(this.abs(rel))) {
      if (this.roomDoc.hasFile(rel)) {
        this.roomDoc.deleteFile(rel, this)
        this.shadow.delete(rel)
        this.log(`deleted ${rel} from room`)
      }
      return
    }
    const disk = this.readText(rel)
    if (disk === undefined) return
    this.pushDisk(rel, disk)
  }

  /** Merge the disk text of `rel` into the room, then reconcile disk with the result. */
  private pushDisk(rel: string, disk: string): void {
    const shadow = this.shadow.get(rel)
    if (shadow === disk) return // echo of our own write, or nothing changed
    let yt = this.roomDoc.files.get(rel)
    this.roomDoc.doc.transact(() => {
      if (!yt) {
        yt = new Y.Text()
        this.roomDoc.files.set(rel, yt)
        yt.insert(0, disk)
      } else {
        applyLocalEdit(yt, shadow ?? yt.toString(), disk)
      }
    }, this)
    const merged = yt!.toString()
    this.shadow.set(rel, merged)
    if (merged !== disk) {
      // Remote edits had landed in between; disk now gets the merged text.
      this.writeAtomic(rel, merged)
    }
  }

  private async refreshTracked(): Promise<void> {
    if (this.stopped) return
    try {
      this.tracked = await gitTracked(this.dir)
      this.lastTrackedRefresh = Date.now()
    } catch (e) { this.log(`warn: git ls-files: ${errMsg(e)}`) }
  }

  // ---- room -> disk ---------------------------------------------------------

  private onRoomChange(events: Y.YEvent<any>[], tr: Y.Transaction): void {
    if (tr.origin === this || this.stopped) return
    const changed = new Set<string>()
    const deleted = new Set<string>()
    for (const ev of events) {
      if (ev.target === this.roomDoc.files) {
        for (const [key, ch] of (ev as Y.YMapEvent<Y.Text>).keys) {
          if (ch.action === 'delete') deleted.add(key)
          else changed.add(key)
        }
      } else if (typeof ev.path[0] === 'string') {
        changed.add(ev.path[0])
      }
    }
    for (const p of deleted) {
      if (changed.has(p)) continue
      try {
        this.shadow.delete(p)
        if (fs.existsSync(this.abs(p))) { fs.unlinkSync(this.abs(p)); this.log(`deleted ${p} (removed from room)`) }
      } catch (e) { this.log(`warn: ${p}: ${errMsg(e)}`) }
    }
    for (const p of changed) {
      try { this.pullRoom(p) } catch (e) { this.log(`warn: ${p}: ${errMsg(e)}`) }
    }
  }

  /** Bring disk up to date with the room text of `rel`, merging in any unflushed local edit. */
  private pullRoom(rel: string): void {
    if (this.isIgnoredPath(rel) || rel.split('/').includes('..')) return
    const pending = this.debounce.get(rel)
    if (pending) { clearTimeout(pending); this.debounce.delete(rel) }
    const disk = this.readText(rel, true)
    const shadow = this.shadow.get(rel)
    if (disk !== undefined && shadow !== undefined && disk !== shadow) {
      // Local edit not yet pushed: merge it into the room first, which also rewrites disk.
      this.pushDisk(rel, disk)
      return
    }
    const room = this.roomDoc.text(rel)
    if (room === undefined) return
    if (disk !== room) this.writeAtomic(rel, room)
    this.shadow.set(rel, room)
  }

  // ---- base tracking --------------------------------------------------------

  private async pollBase(): Promise<void> {
    if (this.stopped) return
    const head = await gitHead(this.dir).catch(() => undefined)
    if (!head || head === this.base) return
    this.base = head
    this.branch = await gitBranch(this.dir).catch(() => this.branch)
    if (this.roomDoc.meta.base !== head) {
      this.roomDoc.setMeta({ base: head, branch: this.branch }, this)
      this.log(`base -> ${head.slice(0, 7)} (published)`)
    }
  }

  private onMetaChange(e: Y.YMapEvent<any>, tr: Y.Transaction): void {
    if (tr.origin === this || this.stopped || !e.keysChanged.has('base')) return
    const base = this.roomDoc.meta.base
    if (!base || base === this.base) return
    this.log(`room base -> ${base.slice(0, 7)}, local HEAD is ${this.base.slice(0, 7)}; trying fast-forward`)
    this.fastForward(base).catch(e => this.log(`warn: ${errMsg(e)}`))
  }

  private async fastForward(base: string): Promise<void> {
    if (this.mergeInFlight) return
    this.mergeInFlight = true
    try {
      await git(this.dir, ['fetch', '--quiet']).catch(e => this.log(`fetch skipped: ${errMsg(e)}`))
      try {
        await git(this.dir, ['merge', '--ff-only', base])
        this.base = base
        this.log(`fast-forwarded to ${base.slice(0, 7)}`)
      } catch (e) {
        this.log(`warn: could not fast-forward to ${base.slice(0, 7)} (${errMsg(e)}); still syncing text`)
      }
    } finally { this.mergeInFlight = false }
  }
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e) }
