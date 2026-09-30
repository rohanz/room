import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

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
  vi.stubGlobal('sessionStorage', dom.window.sessionStorage)
  vi.stubGlobal('document', dom.window.document)
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
    expect(mocks.provider.mock.calls[0]![3]).toEqual({ connect: false, params: { schema: '2' } })
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
    expect(conn.provider.params.ticket).toBe('one-use')
    expect(request.mock.calls[0]![0]).toBe('https://room.example/ws-ticket')
    expect(JSON.parse(request.mock.calls[0]![1].body).view).toBe('secret')
  })

  it('does not send a local key in a websocket URL', async () => {
    const dom = browser('http://127.0.0.1/?room=ws%3A%2F%2F127.0.0.1%2Flocal%252Frepo&key=local-key')
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ticket: 'local-ticket' }) })
    vi.stubGlobal('fetch', request)
    const conn = connect(dom.window.location.search)
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
    expect(dom.window.location.href).not.toContain('local-key')
    expect(conn.provider.params).toEqual({ schema: '2', ticket: 'local-ticket' })
    expect(JSON.parse(request.mock.calls[0]![1].body).key).toBe('local-key')
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
})
