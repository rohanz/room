import chokidar, { type FSWatcher } from 'chokidar'
import fs from 'node:fs'
import path from 'node:path'

export interface WatchHandlers {
  ignored(path: string, stat?: fs.Stats): boolean
  event(event: string, path: string): void
  error(error: unknown): void
}

/** A checkout watch has no room or identity. Its callbacks belong to one daemon at a time. */
export class CheckoutWatch {
  readonly dir: string
  private readonly root: fs.Stats
  readonly ready: Promise<void>
  readonly files: Set<string>
  ignoredDirs = new Set<string>()
  unwatchedDirs = new Map<string, string[]>()
  private readonly watcher: FSWatcher
  private handlers: WatchHandlers
  private suspended = false
  private closed = false

  constructor(dir: string, handlers: WatchHandlers, files = new Set<string>()) {
    this.dir = path.resolve(dir)
    this.root = fs.statSync(dir)
    this.handlers = handlers
    this.files = files
    this.watcher = chokidar.watch(dir, {
      ignoreInitial: true, followSymlinks: false, persistent: true,
      ignored: (path, stat) => this.handlers.ignored(path, stat),
    })
    this.watcher.on('all', (event, path) => { if (!this.suspended) this.handlers.event(event, path) })
    this.watcher.on('error', error => { if (!this.suspended) this.handlers.error(error) })
    this.ready = new Promise((resolve, reject) => {
      const fatal = (error: unknown) => {
        const e = error as NodeJS.ErrnoException
        if (e.path === dir || e.path === this.dir || e.code === 'EMFILE' || e.code === 'ENOSPC') {
          this.watcher.off('ready', ready); this.watcher.off('error', fatal); reject(error)
        }
      }
      const ready = () => { this.watcher.off('error', fatal); resolve() }
      this.watcher.on('error', fatal); this.watcher.once('ready', ready)
    })
  }

  matches(dir: string): boolean {
    try { const root = fs.statSync(dir); return path.resolve(dir) === this.dir && root.dev === this.root.dev && root.ino === this.root.ino }
    catch { return false }
  }
  attach(handlers: WatchHandlers): void { this.handlers = handlers; this.suspended = false }
  suspend(): void { this.suspended = true }
  getWatched(): ReturnType<FSWatcher['getWatched']> { return this.watcher.getWatched() }
  add(paths: string | string[]): void { this.watcher.add(paths) }
  unwatch(paths: string | string[]): void { void this.watcher.unwatch(paths) }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true; this.suspended = true
    await this.watcher.close()
  }
}

/** Single-use handoff. A failed/abandoned reconnect cannot retain watches indefinitely. */
export class WatcherHandoff {
  private timer: ReturnType<typeof setTimeout>
  constructor(private watch: CheckoutWatch | undefined, ttlMs = 180_000) {
    watch?.suspend()
    this.timer = setTimeout(() => { void this.dispose().catch(() => {}) }, ttlMs)
    this.timer.unref()
  }
  take(dir: string): CheckoutWatch | undefined {
    if (!this.watch || !this.watch.matches(dir)) return undefined
    clearTimeout(this.timer)
    const watch = this.watch; this.watch = undefined
    return watch
  }
  async dispose(): Promise<void> {
    clearTimeout(this.timer)
    const watch = this.watch; this.watch = undefined
    await watch?.close()
  }
}
