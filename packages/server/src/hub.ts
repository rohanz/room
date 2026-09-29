/**
 * The server's side of the hub (docs/superpowers/specs/2026-09-28-hub.md §6): one hub per loaded room doc,
 * started after the doc's persisted state is loaded, answering message type 7 on the room's websocket.
 */
import crypto from 'node:crypto'
import fsp, { type FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { MSG_HUB, STARTING_RETRY_MS, decodeFrame, encodeFrame, serializedStore, startHub, type Hub, type IncarnationStore, type Principal, type Reply } from '@room/hub-core'
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

interface Entry { doc: Y.Doc; room: RoomDoc; hub?: Hub; stopped?: boolean }
interface Loading { loaded: Promise<void>; stored: () => Promise<unknown> }

export interface ServerHubsOptions {
  store: IncarnationStore
  log(line: string): void
  /** The room's document is over its size cap. */
  full(room: string): boolean
  mono?: () => number
  wall?: () => number
}

const owns = (p: Principal, name: string) => !('login' in p) || !p.login || ownsName(name, p.login)

/** The hubs of the rooms this process has loaded. */
export class ServerHubs {
  private readonly entries = new Map<string, Entry>()
  private readonly loads = new WeakMap<Y.Doc, Loading>()
  private readonly pendingWrites = new Map<string, Promise<unknown>>()
  constructor(private readonly opts: ServerHubsOptions) {}

  /** The stock bind code plus a `loaded` promise per doc; the hub starts after it (§6). */
  persistence(provider: PersistenceProvider): { provider: PersistenceProvider; bindState(docName: string, doc: Y.Doc): Promise<void>; writeState(docName: string): Promise<void> } {
    return {
      provider,
      bindState: (docName, doc) => {
        let last: Promise<unknown> = Promise.resolve()
        const store = (update: Uint8Array) => {
          last = last.then(() => provider.storeUpdate(docName, update))
          this.pendingWrites.set(docName, last)
        }
        const loaded = (async () => {
          await this.flushName(docName)
          const persisted = await provider.getYDoc(docName)
          store(Y.encodeStateAsUpdate(doc))
          Y.applyUpdate(doc, Y.encodeStateAsUpdate(persisted))
          doc.on('update', store)
        })()
        this.loads.set(doc, { loaded, stored: () => last })
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
    this.entries.set(name, entry)
    doc.once('destroy', () => { if (this.entries.get(name) === entry) this.stop(name) })
    const loading = this.loads.get(doc)
    const log = (line: string) => this.opts.log(`room ${name}: ${line}`)
    void (loading?.loaded ?? Promise.resolve())
      .then(() => startHub({
        doc: entry.room, mono: this.opts.mono ?? (() => performance.now()), wall: this.opts.wall ?? Date.now, log,
        store: this.opts.store, owns, full: () => this.opts.full(name),
      }))
      .then(async hub => {
        await loading?.stored() // the incarnation's meta mirror, stored before the hub serves
        if (entry.stopped) { hub.stop(); return }
        hub.onPush((conn, push) => (conn as { send(buf: Uint8Array): void }).send(encodeFrame(push)))
        entry.hub = hub
      })
      .catch(e => log(`the hub could not start: ${e instanceof Error ? e.message : e}`))
  }

  current(name: string): Hub | undefined { return this.entries.get(name)?.hub }

  /** Drain a loaded document's writes before migration clears its old key. */
  async flush(doc: Y.Doc): Promise<void> {
    const loading = this.loads.get(doc)
    await loading?.loaded
    await loading?.stored()
  }

  /** A disconnected document is already out of stock y-websocket's docs map. */
  async flushName(name: string): Promise<void> {
    const pending = this.pendingWrites.get(name)
    await pending
    if (pending && this.pendingWrites.get(name) === pending) this.pendingWrites.delete(name)
  }

  /** Stop a room's hub (its doc is going away: the last connection left, or the repo was closed). */
  stop(name: string): void {
    const entry = this.entries.get(name)
    if (!entry) return
    entry.stopped = true
    entry.hub?.stop()
    this.entries.delete(name)
  }

  tick(): void { for (const entry of this.entries.values()) entry.hub?.tick() }
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
export function bindHub(ws: HubSocket, hub: () => Hub | undefined, principal: Principal): void {
  const emit = ws.emit.bind(ws)
  ws.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event !== 'message') return emit(event, ...args)
    const buf = toBytes(args[0])
    if (buf[0] !== MSG_HUB) return emit(event, ...args)
    let frame: unknown
    try { frame = decodeFrame(buf) } catch { frame = undefined }
    const id = (frame as { id?: unknown } | undefined)?.id
    const re = typeof id === 'string' ? id : ''
    const current = hub()
    const reply: Reply = 'readOnly' in principal && principal.readOnly
      ? { v: 1, re, ok: false, reason: 'read-only', text: 'this connection is read-only' }
      : current ? current.handle(ws, frame, principal)
        : { v: 1, re, ok: false, reason: 'starting', text: 'the room is loading', retryMs: STARTING_RETRY_MS }
    try { ws.send(encodeFrame(reply)) } catch { /* the connection is closing */ }
    return true
  }) as HubSocket['emit']
  ws.once('close', () => hub()?.closed(ws))
}
