import { Worker } from 'node:worker_threads'
import type { ParsedFile } from '@room/shared'

/** One lazy parser thread per graph. The graph's refresh queue bounds work in flight. */
export class ParseWorker {
  private worker?: Worker
  private failure?: Error
  private stopped = false
  private nextId = 0
  private pending = new Map<number, { resolve: (parsed: (ParsedFile | undefined)[]) => void; reject: (error: Error) => void }>()

  private start(): Worker {
    if (this.worker) return this.worker
    // The plugin is a single MCP bundle plus a separate, self-contained parser bundle.
    // Development checkouts use tsx in the worker too; compiled packages use worker.js.
    const source = import.meta.url.endsWith('.ts')
    const entry = new URL(import.meta.url.endsWith('.mjs') ? './parse-worker.mjs' : source ? './worker.ts' : './worker.js', import.meta.url)
    const worker = source
      ? new Worker(`import { register } from 'tsx/esm/api'; register(); await import(${JSON.stringify(entry.href)})`, { eval: true })
      : new Worker(entry)
    this.worker = worker
    worker.on('message', ({ id, parsed, error }: { id: number; parsed: (ParsedFile | undefined)[]; error?: string }) => {
      const request = this.pending.get(id)
      if (!request) return
      this.pending.delete(id)
      if (error) request.reject(new Error(error)); else request.resolve(parsed)
      if (!this.pending.size) worker.unref()
    })
    worker.on('error', error => this.fail(error))
    worker.on('exit', code => { if (!this.stopped) this.fail(new Error(`parser worker exited (${code})`)) })
    worker.unref()
    return worker
  }

  private fail(error: Error): void {
    this.failure = error
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }

  parse(path: string, texts: (string | undefined)[]): Promise<(ParsedFile | undefined)[]> {
    if (this.stopped || this.failure) return Promise.reject(this.failure ?? new Error('parser worker is closed'))
    return new Promise((resolve, reject) => {
      const worker = this.start(), id = ++this.nextId
      this.pending.set(id, { resolve, reject })
      worker.ref()
      worker.postMessage({ id, path, texts })
    })
  }

  stop(): void {
    this.stopped = true
    this.fail(new Error('parser worker is closed'))
    void this.worker?.terminate()
  }
}
