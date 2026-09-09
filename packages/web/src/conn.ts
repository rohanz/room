import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { RoomDoc, colorFor, type Presence, type Cursor } from '@room/shared'

export const NAME_KEY = 'room.name'

export function roomUrlFromQuery(): { serverUrl: string; roomName: string } {
  const q = new URLSearchParams(location.search)
  const raw = q.get('room') ?? 'ws://localhost:1234/demo'
  const u = new URL(raw)
  const roomName = u.pathname.replace(/^\/+/, '') || 'demo'
  return { serverUrl: `${u.protocol}//${u.host}`, roomName }
}

export function storedName(): string | null {
  const q = new URLSearchParams(location.search).get('name')
  if (q) { try { localStorage.setItem(NAME_KEY, q) } catch {} ; return q }
  try { return localStorage.getItem(NAME_KEY) } catch { return null }
}

export interface Conn {
  room: RoomDoc
  provider: WebsocketProvider
  me: Presence['user'] & { colorLight: string }
  setCursor(c: Cursor | undefined): void
  onStatus(fn: (connected: boolean) => void): void
  connected: boolean
}

export function connect(name: string): Conn {
  const { serverUrl, roomName } = roomUrlFromQuery()
  const doc = new Y.Doc()
  const room = new RoomDoc(doc)
  const provider = new WebsocketProvider(serverUrl, roomName, doc)
  const color = colorFor(name)
  const me = { name, kind: 'human' as const, color, colorLight: color + '33' }
  provider.awareness.setLocalState({ user: me, status: 'editing' })

  const listeners: ((c: boolean) => void)[] = []
  const conn: Conn = {
    room, provider, me, connected: false,
    setCursor(c) { provider.awareness.setLocalStateField('cursor', c) },
    onStatus(fn) { listeners.push(fn); fn(conn.connected) },
  }
  provider.on('status', (e: { status: string }) => {
    conn.connected = e.status === 'connected'
    listeners.forEach(f => f(conn.connected))
  })
  return conn
}

/** Read awareness states defensively: other clients may publish anything. */
export function presences(provider: WebsocketProvider): { clientId: number; p: Presence }[] {
  const out: { clientId: number; p: Presence }[] = []
  provider.awareness.getStates().forEach((s: unknown, clientId: number) => {
    if (!s || typeof s !== 'object') return
    const st = s as Record<string, unknown>
    const u = st.user as Record<string, unknown> | undefined
    if (!u || typeof u.name !== 'string' || !u.name) return
    const kind = u.kind === 'agent' ? 'agent' : 'human'
    const c = st.cursor as Record<string, unknown> | undefined
    const cursor = c && typeof c.path === 'string' && typeof c.from === 'number' && typeof c.to === 'number'
      ? { path: c.path, from: c.from, to: c.to } : undefined
    out.push({ clientId, p: { user: { name: u.name, kind, color: typeof u.color === 'string' ? u.color : colorFor(u.name) }, cursor, status: typeof st.status === 'string' ? st.status : undefined } })
  })
  return out.sort((a, b) => a.p.user.name.localeCompare(b.p.user.name) || a.p.user.kind.localeCompare(b.p.user.kind))
}
