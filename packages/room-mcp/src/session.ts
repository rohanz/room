/**
 * A session is one joined room: the embedded daemon (which owns the Y.Doc and the
 * websocket provider) plus the identity the tools act as. `room_join` creates it,
 * `room_leave` tears it down.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { WebsocketProvider } from 'y-websocket'
import type { Awareness } from 'y-protocols/awareness'
import { startRoomd, RoomdError, type Roomd } from '@room/roomd'
import { git, gitBranch, gitOrigin } from '@room/roomd/git'
import type { Identity, RoomDoc } from '@room/shared'
import { GraphIndex } from './graph-index.js'

export const DEFAULT_SERVER = 'ws://localhost:1234'
export const DEFAULT_WEB = 'http://localhost:5173'

export interface Session {
  room: RoomDoc
  provider: WebsocketProvider
  awareness: Awareness
  daemon: Roomd
  me: Identity
  dir: string
  /** ws://server/<encoded room name> */
  roomUrl: string
  /** Human-readable room name, e.g. github.com/rohanz/room/main */
  roomName: string
  browserUrl: string
  /** Symbol graph over base + overlays; undefined in unit tests. */
  graph?: GraphIndex
}

export interface JoinOptions {
  dir: string
  name?: string
  room?: string
  server?: string
  web?: string
  connectTimeoutMs?: number
  log?: (line: string) => void
}

/** `.room.json` written by the daemon; lets a later process rejoin the same room. */
export interface RoomFile { room: string; name: string; dir: string }

export function findRoomFile(start: string): (RoomFile & { _from: string }) | undefined {
  let d = resolve(start)
  for (;;) {
    const f = resolve(d, '.room.json')
    if (existsSync(f)) {
      try { return { ...JSON.parse(readFileSync(f, 'utf8')), _from: dirname(f) } } catch { /* keep walking */ }
    }
    const up = dirname(d)
    if (up === d) return undefined
    d = up
  }
}

/** Room name from the clone: normalised origin + branch. Slashes are kept for humans; encode for the URL. */
export async function deriveRoomName(dir: string): Promise<{ roomName?: string; branch: string; repo?: string }> {
  const [repo, branch] = await Promise.all([gitOrigin(dir), gitBranch(dir)])
  return { repo, branch, roomName: repo ? `${repo}/${branch}` : undefined }
}

export async function defaultName(dir: string): Promise<string | undefined> {
  try { const n = (await git(dir, ['config', 'user.name'])).trim(); if (n) return n } catch { /* fall through */ }
  return process.env.USER || process.env.USERNAME || undefined
}

export function encodeRoom(roomName: string): string { return encodeURIComponent(roomName) }
export function decodeRoom(encoded: string): string { try { return decodeURIComponent(encoded) } catch { return encoded } }

export async function joinSession(opts: JoinOptions): Promise<Session> {
  const dir = resolve(opts.dir)
  const server = (opts.server ?? process.env.ROOM_SERVER ?? DEFAULT_SERVER).replace(/\/+$/, '')
  const web = (opts.web ?? process.env.ROOM_WEB ?? DEFAULT_WEB).replace(/\/+$/, '')
  const name = opts.name ?? await defaultName(dir)
  if (!name) throw new RoomdError('could not determine your name: pass name or set git config user.name', 2)

  let roomName = opts.room
  if (!roomName) {
    const d = await deriveRoomName(dir)
    if (!d.roomName) throw new RoomdError(`${dir} has no origin remote; pass room explicitly (e.g. room="myteam/shop/main")`, 2)
    roomName = d.roomName
  }
  const roomUrl = `${server}/${encodeRoom(roomName)}`
  const daemon = await startRoomd({ room: roomUrl, dir, name, kind: 'agent', connectTimeoutMs: opts.connectTimeoutMs, log: opts.log })
  const browserUrl = `${web}/?room=${encodeURIComponent(roomUrl)}`
  const graph = new GraphIndex(daemon.roomDoc, name, dir, opts.log)
  graph.start()
  return {
    graph,
    room: daemon.roomDoc,
    provider: daemon.provider,
    awareness: daemon.provider.awareness,
    daemon,
    me: { name, kind: 'agent' },
    dir,
    roomUrl,
    roomName,
    browserUrl,
  }
}

export async function leaveSession(s: Session): Promise<void> {
  s.graph?.stop()
  await s.daemon.stop()
}
