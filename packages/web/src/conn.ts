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
  const q = new URLSearchParams(search)
  const token = q.get('token') ?? '', view = q.getAll('view').find(value => value !== 'board' && value !== 'code') ?? '', key = q.get('key') ?? ''
  const provider = new WebsocketProvider(roomLocation.serverUrl, roomLocation.encodedRoomName, doc, { params: key ? { key } : view ? { view } : token ? { token } : {} })
  // A refused websocket never surfaces a status code; ask the server over HTTP why, and say so.
  // Shared view links and local keys already carry access; avoid an unauthenticated preflight.
  // A local relay has no /view-token endpoint.
  const host = new URL(roomLocation.serverUrl).hostname
  if (!q.has('view') && !q.has('key') && host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') void explainAccess(roomLocation, { view, token }, provider)
  // A successful sync supersedes any earlier HTTP preflight error.
  provider.on('sync', (synced: boolean) => {
    if (synced) {
      document.getElementById('access-error')?.remove()
      if (viewerName) {
        room.assignColor(viewerName, provider)
        provider.awareness.setLocalState({ user: { name: viewerName, kind: 'human', color: colorFor(viewerName, room) }, status: 'viewing', lastActive: Date.now() })
      }
    }
  })
  const viewerName = new URLSearchParams(search).get('name')?.trim()
  if (viewerName) {
    provider.awareness.setLocalState({
      user: { name: viewerName, kind: 'human', color: colorFor(viewerName, room) },
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
export function presences(provider: WebsocketProvider, room?: RoomDoc): Presence[] {
  const out: Presence[] = []
  provider.awareness.getStates().forEach((state: unknown) => {
    if (!state || typeof state !== 'object') return
    const value = state as Record<string, unknown>
    const user = value.user as Record<string, unknown> | undefined
    if (!user || typeof user.name !== 'string' || !user.name) return
    out.push({
      user: {
        name: user.name,
        kind: user.kind === 'agent' || user.kind === 'bot' || user.kind === 'ci' ? user.kind : 'human',
        ...(typeof user.owner === 'string' ? { owner: user.owner } : {}),
        ...(typeof user.label === 'string' ? { label: user.label } : {}),
        color: typeof user.color === 'string' ? user.color : colorFor(user.name, room),
      },
      status: typeof value.status === 'string' ? value.status : undefined,
      lastActive: typeof value.lastActive === 'number' ? value.lastActive : undefined,
    })
  })
  return out.sort((a, b) => a.user.name.localeCompare(b.user.name) || a.user.kind.localeCompare(b.user.kind))
}

async function explainAccess(loc: RoomLocation, auth: { view: string; token: string }, provider: WebsocketProvider): Promise<void> {
  const http = loc.serverUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const roomName = decodeURIComponent(loc.encodedRoomName)
  const show = (why: string) => {
    if (provider.synced) return
    const el = document.getElementById('access-error') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'access-error' }))
    el.className = 'access-error'
    el.textContent = `Cannot open ${roomName}: ${why}`
  }
  try {
    const res = await fetch(`${http}/view-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, ...(auth.token ? { token: auth.token } : {}) }) })
    if (res.ok) return
    if (!auth.view && !auth.token) show('this link has no access key. Ask your agent for the room view URL (it ends with &view=...), or use room_state.')
    else if (auth.view) show('the view key on this link has expired or is for another room. Ask your agent for a fresh link (room_state prints it).')
    else show((await res.text()) || 'access refused')
  } catch { show(`cannot reach ${loc.serverUrl}`) }
}
