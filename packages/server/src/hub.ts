/**
 * The server's side of the hub (docs/superpowers/specs/2026-09-28-hub.md §6): one hub per loaded room doc,
 * started after the doc's persisted state is loaded, answering message type 7 on the room's websocket.
 */
import crypto from 'node:crypto'
import fsp, { type FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { HUB_ORIGIN, MSG_HUB, RoomStateError, STARTING_RETRY_MS, decodeFrame, encodeFrame, serializedStore, startHub, type Hub, type IncarnationStore, type Principal, type Reply } from '@room/hub-core'
import { RoomDoc } from '@room/shared'
import { ownsName, toBytes } from './readonly.js'

// The relay's durable-file procedure (relay/src/leases.ts), async; the server does not depend on the relay.

async function syncDirectory(dir: string): Promise<void> {
  // Directory fsync is unsupported by some filesystems; the file itself was fsynced. Any other error is real.
  let handle: FileHandle | undefined
  try { handle = await fsp.open(dir, 'r'); await handle.sync() }
  catch (e) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e }
  finally { await handle?.close() }
}

async function ensureDurableDirectory(dir: string): Promise<void> {
  const parent = path.dirname(dir)
  if (parent !== dir) await ensureDurableDirectory(parent)
  try { await fsp.mkdir(dir, { mode: 0o700 }) }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  // EEXIST may mean another writer created this directory but has not fsynced its parent yet.
  if (parent !== dir) await syncDirectory(parent)
}

/** Temp, fsync, rename, fsync-dir, in a directory whose own entry is durable. */
async function writeDurable(file: string, content: object): Promise<void> {
  const dir = path.dirname(file)
  await ensureDurableDirectory(dir)
  const temp = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`
  const handle = await fsp.open(temp, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(content) + '\n'); await handle.sync() }
  finally { await handle.close() }
  try { await fsp.rename(temp, file) } catch (e) { await fsp.rm(temp, { force: true }); throw e }
  await syncDirectory(dir)
}

/**
 * The process's durable incarnation record, taken one room at a time (§3): `<YPERSISTENCE>/hub/incarnation.json`,
 * or without a volume `<tmpdir>/room-server-hub-<port>/incarnation.json`, which outlives the process as the
 * clients' replicas of its in-memory rooms do.
 */
export function incarnationFile(dir: string | undefined, port: number): IncarnationStore {
  const file = dir ? path.join(dir, 'hub', 'incarnation.json') : path.join(os.tmpdir(), `room-server-hub-${port}`, 'incarnation.json')
  return serializedStore({
    read: async () => {
      try { const max = (JSON.parse(await fsp.readFile(file, 'utf8')) as { max?: unknown }).max; return typeof max === 'number' ? max : undefined }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
    },
    write: max => writeDurable(file, { max }),
  })
}

/** What the server's LevelDB persistence offers (y-leveldb). */
export interface PersistenceProvider {
  getYDoc(docName: string): Promise<Y.Doc>
  storeUpdate(docName: string, update: Uint8Array): Promise<unknown>
  clearDocument?(docName: string): Promise<void>
}

interface Entry { doc: Y.Doc; room: RoomDoc; hub?: Hub; stopped?: boolean; startError?: string; startFailed?: boolean; lastTickError?: number }
interface Loading { loaded: Promise<void>; stored: () => Promise<void> }
interface WriteState { doc: Y.Doc; provider: PersistenceProvider; dirty: boolean; pendingUpdate?: Uint8Array; pending?: Promise<void>; error?: string; retry?: ReturnType<typeof setTimeout>; delay: number }

export interface ServerHubsOptions {
  store: IncarnationStore
  log(line: string): void
  /** The room's document is over its size cap. */
  full(room: string): boolean
  hubBytes?(room: string, bytes: number): void
  mono?: () => number
  wall?: () => number
}

const owns = (p: Principal, name: string) => !('login' in p) || !p.login || ownsName(name, p.login)

/** The hubs of the rooms this process has loaded. */
export class ServerHubs {
  private readonly entries = new Map<string, Entry>()
  private readonly freshRooms = new Set<string>()
  private readonly loads = new WeakMap<Y.Doc, Loading>()
  private readonly writes = new Map<string, WriteState>()
  private readonly maxDirtyRooms = 16
  constructor(private readonly opts: ServerHubsOptions) {}

  /** Called only by the room-opening endpoint after it creates a room with no prior document. */
  markFresh(name: string): void { this.freshRooms.add(name) }

  storageFailure(name: string): string | undefined {
    const state = this.writes.get(name)
    if (state?.error) return `room storage is failing; retry: ${state.error}`
    if (this.dirtyCount() >= this.maxDirtyRooms && !state?.dirty) return 'room storage backlog is full; retry'
    return undefined
  }

  anyStorageFailure(): boolean { return [...this.writes.values()].some(state => !!state.error) }
  private dirtyCount(): number { return [...this.writes.values()].filter(state => state.dirty || state.pending || state.error).length }

  private queueWrite(name: string, state: WriteState, update?: Uint8Array): void {
    if (!state.pending && !state.error) state.pendingUpdate = update
    state.dirty = true
    if (!state.error) this.write(name, state)
  }

  private write(name: string, state: WriteState): void {
    if (state.pending || !state.dirty) return
    const run = async () => {
      while (state.dirty) {
        state.dirty = false
        try {
          const update = state.pendingUpdate ?? Y.encodeStateAsUpdate(state.doc)
          state.pendingUpdate = undefined
          await state.provider.storeUpdate(name, update)
          if (state.error) {
            this.opts.log(`room ${name}: storage recovered`)
            const entry = this.entries.get(name)
            if (entry?.startFailed && !entry.startError) this.restart(name, entry)
          }
          state.error = undefined
          state.delay = 250
        } catch (error) {
          state.dirty = true
          state.pendingUpdate = undefined
          state.error = error instanceof Error ? error.message : String(error)
          this.opts.log(`room ${name}: storage failed: ${state.error}`)
          state.retry = setTimeout(() => { state.retry = undefined; this.write(name, state) }, state.delay)
          state.retry.unref?.()
          state.delay = Math.min(state.delay * 2, 10_000)
          break
        }
      }
    }
    state.pending = run().finally(() => { state.pending = undefined; if (state.dirty && !state.retry) this.write(name, state) })
  }

  /** The stock bind code plus a `loaded` promise per doc; the hub starts after it (§6). */
  persistence(provider: PersistenceProvider): { provider: PersistenceProvider; bindState(docName: string, doc: Y.Doc): Promise<void>; writeState(docName: string): Promise<void> } {
    return {
      provider,
      bindState: (docName, doc) => {
        const state: WriteState = { doc, provider, dirty: false, delay: 250 }
        const store = (update: Uint8Array, origin: unknown) => {
          if (origin === HUB_ORIGIN) this.opts.hubBytes?.(docName, update.byteLength)
          this.queueWrite(docName, state, update)
        }
        const loaded = (async () => {
          await this.flushName(docName)
          const persisted = await provider.getYDoc(docName)
          this.writes.set(docName, state)
          doc.once('destroy', () => { if (this.writes.get(docName) === state && !state.dirty && !state.pending && !state.error) this.writes.delete(docName) })
          Y.applyUpdate(doc, Y.encodeStateAsUpdate(persisted))
          doc.on('update', store)
          this.queueWrite(docName, state, Y.encodeStateAsUpdate(doc))
        })()
        this.loads.set(doc, { loaded, stored: () => this.flushName(docName) })
        return loaded
      },
      writeState: async docName => { await this.flushName(docName) },
    }
  }

  /** After a connection is set up: start the room's hub for this doc, once, after it has loaded. */
  ensure(name: string, doc: Y.Doc): void {
    const current = this.entries.get(name)
    if (current?.doc === doc) return
    if (current) this.stop(name)
    const entry: Entry = { doc, room: new RoomDoc(doc) }
    const fresh = this.freshRooms.delete(name)
    this.entries.set(name, entry)
    doc.once('destroy', () => { if (this.entries.get(name) === entry) this.stop(name) })
    const loading = this.loads.get(doc)
    const log = (line: string) => this.opts.log(`room ${name}: ${line}`)
    void (loading?.loaded ?? Promise.resolve())
      .then(() => startHub({
        doc: entry.room, mono: this.opts.mono ?? (() => performance.now()), wall: this.opts.wall ?? Date.now, log,
        store: this.opts.store, owns, full: () => this.opts.full(name), unavailable: () => this.storageFailure(name), fresh,
      }))
      .then(async hub => {
        await loading?.stored() // the incarnation's meta mirror, stored before the hub serves
        if (entry.stopped) { hub.stop(); return }
        hub.onPush((conn, push) => (conn as { send(buf: Uint8Array): void }).send(encodeFrame(push)))
        entry.hub = hub
      })
      .catch(e => {
        entry.startError = e instanceof RoomStateError ? e.message : undefined
        entry.startFailed = true
        log(`the hub could not start: ${e instanceof Error ? e.message : e}`)
        if (!entry.startError && !this.storageFailure(name)) this.restart(name, entry)
      })
  }

  current(name: string): Hub | undefined { return this.entries.get(name)?.hub }
  startFailure(name: string): string | undefined { return this.entries.get(name)?.startError }

  private restart(name: string, entry: Entry): void {
    const retry = setTimeout(() => {
      if (this.entries.get(name) !== entry || entry.hub || entry.startError) return
      this.stop(name)
      this.ensure(name, entry.doc)
    }, 1000)
    retry.unref?.()
  }

  /** Drain a loaded document's writes before migration clears its old key. */
  async flush(doc: Y.Doc): Promise<void> {
    const loading = this.loads.get(doc)
    await loading?.loaded
    await loading?.stored()
  }

  /** A disconnected document is already out of stock y-websocket's docs map. */
  async flushName(name: string): Promise<void> {
    const state = this.writes.get(name)
    if (!state) return
    if (state.error) throw new Error(`room ${name}: storage is failing: ${state.error}`)
    if (state.dirty && !state.pending) this.write(name, state)
    while (state.pending) {
      await state.pending
      if (state.error) throw new Error(`room ${name}: storage is failing: ${state.error}`)
    }
  }

  /** Stop a room's hub (its doc is going away: the last connection left, or the repo was closed). */
  stop(name: string): void {
    const entry = this.entries.get(name)
    if (!entry) return
    entry.stopped = true
    entry.hub?.stop()
    this.entries.delete(name)
  }

  tick(): void { for (const [name, entry] of this.entries) try { entry.hub?.tick() } catch (error) {
    const now = Date.now()
    if (now - (entry.lastTickError ?? 0) >= 60_000) { entry.lastTickError = now; this.opts.log(`room ${name}: hub tick failed: ${error instanceof Error ? error.message : error}`) }
  } }
}

interface HubSocket {
  emit(event: string | symbol, ...args: unknown[]): boolean
  once(event: 'close', listener: () => void): unknown
  send(data: Uint8Array): void
}

/**
 * Answer hub frames (type 7) on a room connection. Installed before the other wrappers, so it is the
 * innermost: they pass type 7 through, and it consumes those frames instead of forwarding them.
 */
export function bindHub(ws: HubSocket, hub: () => Hub | undefined, principal: Principal, unavailable?: () => string | undefined): void {
  const emit = ws.emit.bind(ws)
  ws.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event !== 'message') return emit(event, ...args)
    const buf = toBytes(args[0])
    if (buf[0] !== MSG_HUB) return emit(event, ...args)
    let frame: unknown
    try { frame = decodeFrame(buf) } catch { frame = undefined }
    const id = (frame as { id?: unknown } | undefined)?.id
    const re = typeof id === 'string' ? id : ''
    let reply: Reply
    try {
      const current = hub(), failure = unavailable?.()
      reply = 'readOnly' in principal && principal.readOnly
        ? { v: 1, re, ok: false, reason: 'read-only', text: 'this connection is read-only' }
        : failure ? { v: 1, re, ok: false, reason: 'unavailable', text: failure, retryMs: STARTING_RETRY_MS }
          : current ? current.handle(ws, frame, principal)
            : { v: 1, re, ok: false, reason: 'starting', text: 'the room is loading', retryMs: STARTING_RETRY_MS }
    } catch (error) { reply = { v: 1, re, ok: false, reason: 'invalid', text: error instanceof Error ? error.message : String(error) } }
    try { ws.send(encodeFrame(reply)) } catch { /* the connection is closing */ }
    return true
  }) as HubSocket['emit']
  ws.once('close', () => { try { hub()?.closed(ws) } catch { /* the connection is closing */ } })
}
