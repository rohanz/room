/** One lazy I/O worker per module/process. No durable-write implementation lives in this proxy. */
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { StorageRefused, type StorageGate, type StorageRefusalReason } from './protocol.js'
import type { GateOptions } from './gate.js'

export type GateMethod = Exclude<keyof StorageGate, 'commonDir' | 'observe'>
export interface GateRequest {
  id: number
  commonDir: string
  options: Pick<GateOptions, 'limits'>
  method: GateMethod
  args: unknown[]
}
export type GateResponse = { id: number; value?: unknown; error?: {
  reason?: StorageRefusalReason; detail: string; remedy?: string; code?: string
} }

let worker: Worker | undefined
let sequence = 0
let closing: Promise<void> | undefined
const inFlight = new Set<Promise<unknown>>()
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

function thread(): Worker {
  if (worker) return worker
  // Source execution uses the same tsx loader as the parser worker. Installed bundles need only
  // the sibling, self-contained gate-worker.mjs; no node_modules or inherited host loaders.
  const source = import.meta.url.endsWith('.ts')
  const entry = new URL(import.meta.url.endsWith('.mjs') ? './gate-worker.mjs' : source ? './gate-worker.ts' : './gate-worker.js', import.meta.url)
  const current = source
    ? new Worker(`import { register } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)}; register(); await import(${JSON.stringify(entry.href)})`, { eval: true, execArgv: [] })
    : new Worker(entry, { execArgv: [] })
  worker = current
  const fail = (detail: string) => {
    // Do not replay failed calls: a worker may have published before it stopped.
    if (worker !== current) return
    worker = undefined
    for (const request of pending.values()) request.reject(new StorageRefused('unavailable', detail,
      'inspect storage gate status before retrying; an interrupted write may have completed'))
    pending.clear()
    current.unref()
  }
  current.on('message', (message: GateResponse) => {
    if (worker !== current) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (!pending.size) current.unref()
    const error = message.error
    if (!error) request.resolve(message.value)
    else request.reject(error.reason ? new StorageRefused(error.reason, error.detail, error.remedy)
      : Object.assign(new Error(error.detail), { code: error.code }))
  })
  current.on('error', error => fail(`storage gate worker failed: ${error.message.slice(0, 400)}`))
  current.on('exit', code => fail(`storage gate worker exited (${code})`))
  current.unref()
  return current
}

export function callGateThread<M extends GateMethod>(commonDir: string, options: GateOptions, method: M,
  args: Parameters<StorageGate[M]>): ReturnType<StorageGate[M]> {
  if (closing) return Promise.reject(new StorageRefused('unavailable', 'storage gates are closing')) as ReturnType<StorageGate[M]>
  const result = new Promise<unknown>((resolve, reject) => {
    const current = thread(), id = ++sequence
    pending.set(id, { resolve, reject })
    // Awaited operations must complete even in short-lived CLI processes. The idle worker is
    // unreferenced, so it never extends the process lifetime after its outstanding work settles.
    current.ref()
    try { current.postMessage({ id, commonDir, options: { limits: options.limits }, method, args } satisfies GateRequest) }
    catch (error) {
      pending.delete(id)
      if (!pending.size) current.unref()
      reject(error)
    }
  })
  inFlight.add(result)
  void result.then(() => inFlight.delete(result), () => inFlight.delete(result))
  return result as ReturnType<StorageGate[M]>
}

/** Finish accepted RPCs before stopping the shared worker. New calls refuse during close;
 * after it settles, a later call may lazily start a fresh worker. Safe to call repeatedly. */
export function closeStorageGates(): Promise<void> {
  if (closing) return closing
  closing = (async () => {
    await Promise.allSettled([...inFlight])
    const current = worker
    worker = undefined
    if (current) await current.terminate()
  })().finally(() => { closing = undefined })
  return closing
}
