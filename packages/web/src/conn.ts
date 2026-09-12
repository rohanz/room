import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { RoomDoc, colorFor, type Presence } from '@room/shared'

export interface RoomLocation {
  serverUrl: string
  /** Kept encoded because y-websocket uses this as the document name. */
  encodedRoomName: string
  /** Human-readable room name for the header. */
  displayRoomName: string
}

export function parseRoomUrl(raw: string): RoomLocation {
  const url = new URL(raw)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('room must be a ws:// or wss:// URL')

  const slash = url.pathname.lastIndexOf('/')
  const encodedRoomName = url.pathname.slice(slash + 1)
  if (!encodedRoomName) throw new Error('room URL must end with an encoded room name')

  let displayRoomName = encodedRoomName
  try { displayRoomName = decodeURIComponent(encodedRoomName) } catch { /* display the malformed value verbatim */ }

  url.pathname = url.pathname.slice(0, slash) || '/'
  url.search = ''
  url.hash = ''
  return {
    serverUrl: url.toString().replace(/\/$/, ''),
    encodedRoomName,
    displayRoomName,
  }
}

export function roomLocationFromQuery(search = location.search): RoomLocation {
  const raw = new URLSearchParams(search).get('room') ?? 'ws://localhost:1234/demo'
  return parseRoomUrl(raw)
}

export interface Conn extends RoomLocation {
  room: RoomDoc
  provider: WebsocketProvider
  connected: boolean
  onStatus(fn: (connected: boolean) => void): void
}

export function connect(search = location.search): Conn {
  const roomLocation = roomLocationFromQuery(search)
  const doc = new Y.Doc()
  const room = new RoomDoc(doc)
  const q = new URLSearchParams(location.search)
  const token = q.get('token') ?? '', view = q.get('view') ?? ''
  const provider = new WebsocketProvider(roomLocation.serverUrl, roomLocation.encodedRoomName, doc, { params: view ? { view } : token ? { token } : {} })
  const viewerName = new URLSearchParams(search).get('name')?.trim()
  if (viewerName) {
    provider.awareness.setLocalState({
      user: { name: viewerName, kind: 'human', color: colorFor(viewerName) },
      status: 'viewing',
      lastActive: Date.now(),
    })
  } else {
    provider.awareness.setLocalState(null)
  }

  const listeners: ((connected: boolean) => void)[] = []
  const conn: Conn = {
    ...roomLocation,
    room,
    provider,
    connected: false,
    onStatus(fn) { listeners.push(fn); fn(conn.connected) },
  }
  provider.on('status', (event: { status: string }) => {
    conn.connected = event.status === 'connected'
    for (const listener of listeners) listener(conn.connected)
  })
  return conn
}

/** Read awareness states defensively: other clients may publish arbitrary data. */
export function presences(provider: WebsocketProvider): Presence[] {
  const out: Presence[] = []
  provider.awareness.getStates().forEach((state: unknown) => {
    if (!state || typeof state !== 'object') return
    const value = state as Record<string, unknown>
    const user = value.user as Record<string, unknown> | undefined
    if (!user || typeof user.name !== 'string' || !user.name) return
    out.push({
      user: {
        name: user.name,
        kind: user.kind === 'agent' ? 'agent' : 'human',
        color: typeof user.color === 'string' ? user.color : colorFor(user.name),
      },
      status: typeof value.status === 'string' ? value.status : undefined,
      lastActive: typeof value.lastActive === 'number' ? value.lastActive : undefined,
    })
  })
  return out.sort((a, b) => a.user.name.localeCompare(b.user.name) || a.user.kind.localeCompare(b.user.kind))
}
