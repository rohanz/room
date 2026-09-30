import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { RoomDoc, colorFor, type Presence } from '@room/shared'
import { secureWebSocket } from './secure-websocket.js'

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

function roomLocationFromQuery(search = location.search): RoomLocation {
  const raw = new URLSearchParams(location.hash.slice(1)).get('room') ?? new URLSearchParams(search).get('room') ?? 'ws://localhost:1234/demo'
  return parseRoomUrl(raw)
}

/** Read fragment capabilities from browser memory; strip old query credentials after arrival. */
export function takeLinkCredentials(search: string, storage: Pick<Storage, 'getItem' | 'setItem'>, replace: (url: string) => void): { view: string; key: string; token: string; relay: boolean } {
  const url = new URL(location.href)
  const q = new URLSearchParams(search)
  const fragment = new URLSearchParams(url.hash.slice(1))
  const room = fragment.get('room') ?? q.get('room') ?? ''
  const slot = `room-credential:${room}`
  const incoming = { view: fragment.get('view') ?? q.getAll('view').find(v => v !== 'board' && v !== 'code') ?? '', key: q.get('key') ?? '', token: fragment.get('token') ?? q.get('token') ?? '', relay: fragment.get('relay') === '1' }
  if (incoming.view || incoming.key || incoming.token) try { storage.setItem(slot, JSON.stringify(incoming)) } catch { /* this tab still holds it in memory */ }
  for (const name of ['view', 'key', 'token']) {
    const values = url.searchParams.getAll(name).filter(v => name === 'view' && (v === 'board' || v === 'code'))
    url.searchParams.delete(name)
    for (const value of values) url.searchParams.append(name, value)
  }
  if (url.hash) { url.searchParams.set('room', room); url.hash = '' }
  if (incoming.view || incoming.key || incoming.token || location.hash) replace(url.toString())
  try { return incoming.view || incoming.key || incoming.token ? incoming : JSON.parse(storage.getItem(slot) ?? '{}') }
  catch { return { view: '', key: '', token: '', relay: false } }
}

export async function browserViewProof(view: string, room: string, ts: number, nonce: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(view), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`room-relay-v1\0ticket\0${room}\0${ts}\0${nonce}`))
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function mintTicket(loc: RoomLocation, auth: { view: string; key: string; token: string; relay?: boolean }, request: typeof fetch = fetch): Promise<string> {
  const http = loc.serverUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const local = !!auth.relay
  if (auth.key) throw new Error('this local link is from an older Room; ask your agent for a new one')
  let credential: Record<string, unknown> = auth.view ? { view: auth.view } : {}
  if (local && auth.view) {
    const ts = Date.now(), nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(v => v.toString(16).padStart(2, '0')).join('')
    credential = { ts, nonce, proof: await browserViewProof(auth.view, loc.displayRoomName, ts, nonce) }
  }
  const response = await request(`${http}/ws-ticket`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth.token ? { 'x-room-token': auth.token } : {}) },
    body: JSON.stringify({ room: loc.displayRoomName, schema: 2, ...credential }) })
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`)
  return ((await response.json()) as { ticket: string }).ticket
}

export interface Conn extends RoomLocation {
  room: RoomDoc
  provider: WebsocketProvider
  connected: boolean
  onStatus(fn: (connected: boolean) => void): void
}

export function connect(search = location.search): Conn {
  const roomLocation = roomLocationFromQuery(search)
  const viewerName = (new URLSearchParams(location.hash.slice(1)).get('participant') ?? new URLSearchParams(search).get('name'))?.trim()
  const doc = new Y.Doc()
  const room = new RoomDoc(doc)
  const storage = (() => { try { return sessionStorage } catch { return { getItem: () => null, setItem: () => {} } } })()
  const auth = takeLinkCredentials(search, storage, url => history.replaceState(history.state, '', url))
  const provider = new WebsocketProvider(roomLocation.serverUrl, roomLocation.encodedRoomName, doc, { connect: false, params: { schema: '2' }, ...(auth.relay && auth.view ? { WebSocketPolyfill: secureWebSocket(auth.view) } : {}) })
  let stopped = false
  const showError = (why: string) => {
    const el = document.getElementById('access-error') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'access-error' }))
    el.className = 'access-error'; el.textContent = `Cannot open ${roomLocation.displayRoomName}: ${why}`
  }
  const reconnect = async () => {
    try {
      if (!auth.view && !auth.key && !auth.token) { provider.connect(); return }
      const ticket = await mintTicket(roomLocation, auth)
      if (stopped) return
      provider.params.ticket = ticket
      provider.connect()
    } catch (e) { showError(e instanceof Error ? e.message : String(e)); setTimeout(() => { if (!stopped) void reconnect() }, 5000) }
  }
  provider.on('connection-close', (event: CloseEvent | null) => {
    provider.shouldConnect = false
    if (event?.code === 4401 || event?.code === 4403) { stopped = true; showError(event.reason || 'access revoked'); return }
    setTimeout(() => { if (!stopped) void reconnect() }, 1000)
  })
  void reconnect()
  // For hosted links without a view key, explain admission errors via HTTP.
  const host = new URL(roomLocation.serverUrl).hostname
  const hosted = host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]'
  if (hosted && !auth.view && !auth.key) void explainAccess(roomLocation, { view: auth.view, token: auth.token }, provider)
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
      host: typeof value.host === 'string' ? value.host.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 80) || undefined : undefined,
      model: typeof value.model === 'string' ? value.model.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 80) || undefined : undefined,
      effort: typeof value.effort === 'string' ? value.effort.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 80) || undefined : undefined,
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
    const res = await fetch(`${http}/view-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, schema: 2, ...(auth.token ? { token: auth.token } : {}) }) })
    if (res.ok) return
    if (!auth.view && !auth.token) show('this link has no access key. Ask your agent for the room view URL, or use room_state.')
    else if (auth.view) show('the view key on this link has expired or is for another room. Ask your agent for a fresh link (room_state prints it).')
    else show((await res.text()) || 'access refused')
  } catch { show(`cannot reach ${loc.serverUrl}`) }
}
