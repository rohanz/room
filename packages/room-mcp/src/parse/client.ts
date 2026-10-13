import { Worker } from 'node:worker_threads'
import type { ParsedFile } from '@room/shared'

type ParseResult = (ParsedFile | undefined)[]
/** The caller may schedule fresh work after cooldown; failed requests are never replayed here. */
export class TransientParserError extends Error {
  constructor(message: string, readonly retryAt: number) { super(message); this.name = 'TransientParserError' }
}
export interface ParseWorkerOptions {
  idleMs?: number
  maxRestarts?: number
  restartWindowMs?: number
  restartCooldownMs?: number
  log?: (message: string) => void
  /** Lifecycle seams for tests; production always uses the bundled parser worker. */
  createWorker?: () => Worker
  onExit?: (threadId: number) => void
}

/** Lazy, recyclable runtime. Callers bound their own work in flight. Requests are never replayed. */
export class ParseWorker {
  private worker?: Worker
  private failure?: Error
  private stopped = false
  private nextId = 0
  private pending = new Map<number, { resolve: (parsed: ParseResult) => void; reject: (error: Error) => void }>()
  private idle?: ReturnType<typeof setTimeout>
  private crashes: number[] = []
  private retryAt = 0
  private lastCrash?: Error
  private readonly idleMs: number
  private readonly maxRestarts: number
  private readonly restartWindowMs: number
  private readonly restartCooldownMs: number

  constructor(private readonly options: ParseWorkerOptions = {}) {
    this.idleMs = options.idleMs ?? 30_000
    this.maxRestarts = options.maxRestarts ?? 3
    this.restartWindowMs = options.restartWindowMs ?? 10 * 60_000
    this.restartCooldownMs = options.restartCooldownMs ?? 1000
  }

  /** Test-only visibility without exposing the mutable Worker instance. */
  get threadIdForTest(): number | undefined { return this.worker?.threadId }

  private cancelIdle(): void { clearTimeout(this.idle); this.idle = undefined }

  private dispose(worker: Worker): void {
    this.cancelIdle()
    // Detach before terminating: the next request may create a replacement before this exit arrives.
    this.worker = undefined
    worker.unref()
    void worker.terminate().catch(() => {})
  }

  private scheduleIdle(worker: Worker): void {
    if (this.worker !== worker || this.pending.size || this.stopped) return
    worker.unref()
    this.cancelIdle()
    this.idle = setTimeout(() => {
      if (this.worker === worker && !this.pending.size) this.dispose(worker)
    }, this.idleMs)
    this.idle.unref()
  }

  private start(): Worker {
    if (this.worker) return this.worker
    // The plugin is a single MCP bundle plus a separate, self-contained parser bundle.
    // Development checkouts use tsx in the worker too; compiled packages use worker.js.
    const source = import.meta.url.endsWith('.ts')
    const entry = new URL(import.meta.url.endsWith('.mjs') ? './parse-worker.mjs' : source ? './worker.ts' : './worker.js', import.meta.url)
    let worker: Worker
    try {
      worker = this.options.createWorker?.() ?? (source
        ? new Worker(`import { register } from 'tsx/esm/api'; register(); await import(${JSON.stringify(entry.href)})`, { eval: true })
        : new Worker(entry))
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.recordCrash(failure)
      throw this.failure ?? new TransientParserError(failure.message, this.retryAt)
    }
    this.worker = worker
    const threadId = worker.threadId
    worker.on('message', ({ id, parsed, error }: { id: number; parsed: ParseResult; error?: string }) => {
      if (this.worker !== worker) return
      const request = this.pending.get(id)
      if (!request) return
      this.pending.delete(id)
      if (error) request.reject(new Error(error)); else request.resolve(parsed)
      if (!this.pending.size) this.scheduleIdle(worker)
    })
    worker.on('error', error => this.fail(worker, error))
    worker.on('exit', code => {
      this.fail(worker, new Error(`parser worker exited (${code})`))
      this.options.onExit?.(threadId)
    })
    worker.unref()
    return worker
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }

  private recordCrash(error: Error): void {
    const now = Date.now()
    this.crashes = this.crashes.filter(at => now - at < this.restartWindowMs)
    this.crashes.push(now)
    this.lastCrash = error
    this.retryAt = now + this.restartCooldownMs
    if (this.crashes.length > this.maxRestarts) {
      this.failure = new Error(`parser worker restart budget exhausted (${this.maxRestarts} restarts in ${this.restartWindowMs}ms): ${error.message}`)
      const log = this.options.log ?? console.warn
      log(this.failure.message)
    }
  }

  private fail(worker: Worker, error: Error): void {
    // An error is followed by exit. Neither the duplicate exit nor an old instance may poison its successor.
    if (this.worker !== worker || this.stopped) return
    this.dispose(worker)
    this.recordCrash(error)
    this.rejectPending(this.failure ?? new TransientParserError(error.message, this.retryAt))
  }

  parse(path: string, texts: (string | undefined)[]): Promise<ParseResult> {
    if (this.stopped) return Promise.reject(new Error('parser worker is closed'))
    if (this.failure) return Promise.reject(this.failure)
    if (Date.now() < this.retryAt) return Promise.reject(new TransientParserError(`parser worker cooling down: ${this.lastCrash?.message}`, this.retryAt))
    this.cancelIdle()
    return new Promise((resolve, reject) => {
      const worker = this.start(), id = ++this.nextId
      this.pending.set(id, { resolve, reject })
      worker.ref()
      try { worker.postMessage({ id, path, texts }) }
      catch (error) { this.fail(worker, error instanceof Error ? error : new Error(String(error))) }
    })
  }

  stop(): void {
    this.stopped = true
    this.cancelIdle()
    this.rejectPending(new Error('parser worker is closed'))
    if (this.worker) this.dispose(this.worker)
  }
}

// Graphs in multiple rooms and short-lived contract/claim lookups share one runtime per process.
// Keep the client object across lease releases so cooldown and exhausted crash budgets remain effective.
const sharedParser = new ParseWorker()
export const parseInWorker = (path: string, texts: (string | undefined)[]): Promise<ParseResult> => sharedParser.parse(path, texts)

/** A graph owns cancellation of its requests, while the shared runtime owns idle disposal. */
export function acquireParseWorker(): Pick<ParseWorker, 'parse' | 'stop'> {
  let stopped = false
  const pending = new Set<(error: Error) => void>()
  return {
    parse(path, texts) {
      if (stopped) return Promise.reject(new Error('parser worker is closed'))
      return new Promise((resolve, reject) => {
        pending.add(reject)
        void parseInWorker(path, texts).then(parsed => {
          pending.delete(reject); resolve(parsed)
        }, error => {
          pending.delete(reject); reject(error)
        })
      })
    },
    stop() {
      stopped = true
      for (const reject of pending) reject(new Error('parser worker is closed'))
      pending.clear()
    },
  }
}
