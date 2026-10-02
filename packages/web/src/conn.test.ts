import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'

const mocks = vi.hoisted(() => ({ provider: vi.fn(), connect: vi.fn(), events: new Map<string, (...args: unknown[]) => void>() }))
vi.mock('y-websocket', () => ({ WebsocketProvider: class {
  awareness = { setLocalState: vi.fn() }
  params: Record<string, string>
  shouldConnect = false
  on = vi.fn((event: string, fn: (...args: unknown[]) => void) => mocks.events.set(event, fn))
  connect = mocks.connect
  constructor(...args: unknown[]) { this.params = (args[3] as { params: Record<string, string> }).params; mocks.provider(...args) }
} }))
import { connect } from './conn.js'

function browser(url: string) {
  const dom = new JSDOM('<div id="app"></div>', { url })
  vi.stubGlobal('location', dom.window.location)
  vi.stubGlobal('history', dom.window.history)
  try { vi.stubGlobal('sessionStorage', dom.window.sessionStorage) } catch { vi.stubGlobal('sessionStorage', undefined) }
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('crypto', webcrypto)
  return dom
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); mocks.events.clear() })

describe('browser ticket connection', () => {
  it('removes a view capability and connects with a fresh ticket', async () => {
    const dom = browser('https://room.example/?room=wss%3A%2F%2Froom.example%2Frepo&view=secret&view=code')
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ticket: 'one-use' }) })
    vi.stubGlobal('fetch', request)
    const conn = connect(dom.window.location.search)
    expect(dom.window.location.href).not.toContain('secret')
    expect(mocks.provider.mock.calls[0]![3]).toEqual({ connect: false, params: { schema: '2', gen: 'fresh' }, disableBc: true })
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
    expect(conn.provider.params.ticket).toBe('one-use')
    expect(request.mock.calls[0]![0]).toBe('https://room.example/ws-ticket')
    expect(JSON.parse(request.mock.calls[0]![1].body).view).toBe('secret')
  })

  it('proves a local view capability without sending it', async () => {
    const dom = browser('file:///opt/room%20plugin/viewer.html#room=ws%3A%2F%2F127.0.0.1%2Flocal%252Frepo&view=local-view&relay=1')
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ticket: 'local-ticket' }) })
    vi.stubGlobal('fetch', request)
    const conn = connect(dom.window.location.search)
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
    expect(dom.window.location.hash).toContain('local-view')
    expect(conn.provider.params).toEqual({ schema: '2', gen: 'fresh', ticket: 'local-ticket' })
    const body = JSON.parse(request.mock.calls[0]![1].body)
    expect(body.proof).toMatch(/^[a-f0-9]{64}$/)
    expect(body).not.toHaveProperty('view')
    expect(mocks.provider.mock.calls[0]![3]).toHaveProperty('WebSocketPolyfill')
  })

  it('reloads when the server refuses its replica after a compacting restart (4409), and never reconnects it', async () => {
    const dom = browser('https://room.example/?room=wss%3A%2F%2Froom.example%2Frepo&view=secret')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ticket: 'first' }) }))
    connect(dom.window.location.search)
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
    const reload = vi.fn()
    vi.stubGlobal('location', { search: dom.window.location.search, hash: dom.window.location.hash, reload })
    mocks.events.get('connection-close')?.({ code: 4409, reason: 'compacted' })
    expect(reload).toHaveBeenCalledOnce()
    await new Promise(r => setTimeout(r, 1200))
    expect(mocks.connect).toHaveBeenCalledOnce()
  })

  it('mints a new ticket after a disconnected websocket', async () => {
    const dom = browser('https://room.example/?room=wss%3A%2F%2Froom.example%2Frepo&view=secret')
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: 'first' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: 'second' }) })
    vi.stubGlobal('fetch', request)
    const conn = connect(dom.window.location.search)
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
    mocks.events.get('connection-close')?.(null)
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(2), { timeout: 2000 })
    expect(conn.provider.params.ticket).toBe('second')
  })

  it('presents the viewer only while the room is synced, so a refused link shows nobody online', async () => {
    const dom = browser('file:///opt/room/viewer.html#room=ws%3A%2F%2F127.0.0.1%2Flocal%252Frepo&view=wrong&participant=Pat&relay=1')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'Forbidden' }))
    const conn = connect(dom.window.location.search)
    const states = () => vi.mocked(conn.provider.awareness.setLocalState).mock.calls.map(([state]) => state && (state as { user: { name: string } }).user.name)
    await vi.waitFor(() => expect(dom.window.document.getElementById('access-error')?.textContent).toBe('Cannot open local/repo: Forbidden'))
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(states()).toEqual([null])
    mocks.events.get('sync')?.(true)
    expect(states()).toEqual([null, 'Pat'])
    mocks.events.get('connection-close')?.(null)
    expect(states()).toEqual([null, 'Pat', null])
  })
})

it('keeps the access error above the header and the reconnect banner', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  const layer = (selector: string) => Math.max(...[...css.matchAll(new RegExp(`(?:^|\\n)\\${selector} \\{[^}]*z-index: (\\d+)`, 'g'))].map(match => Number(match[1])), 0)
  expect(layer('.access-error')).toBeGreaterThan(Math.max(layer('.header'), layer('.reconnecting')))
})
