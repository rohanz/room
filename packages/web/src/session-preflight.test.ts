import { afterEach, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

const events = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>())
vi.mock('y-websocket', () => ({ WebsocketProvider: class {
  awareness = { setLocalState: vi.fn() }
  params = {}
  synced = false
  on(event: string, fn: (...args: unknown[]) => void) { events.set(event, fn) }
  connect() {} // Keep the real websocket handshake pending while HTTP diagnostics finish.
} }))
import { connect } from './conn.js'

afterEach(() => { vi.unstubAllGlobals(); events.clear() })

it('does not report a missing access key while a valid hosted session link is connecting', async () => {
  const dom = new JSDOM('<div id="app"></div>', {
    url: 'https://room.example/#room=wss%3A%2F%2Froom.example%2Flocal%252Freview&session=valid-session',
  })
  for (const name of ['location', 'history', 'sessionStorage', 'document'] as const) vi.stubGlobal(name, dom.window[name])
  let finishPreflight!: () => void
  let preflightBody: Record<string, unknown> | undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith('/ws-ticket')) return { ok: true, json: async () => ({ ticket: 'valid-ticket' }) }
    preflightBody = JSON.parse(options.body as string)
    await new Promise<void>(resolve => { finishPreflight = resolve })
    return { ok: preflightBody?.session === 'valid-session', text: async () => 'not logged in: run room_login' }
  }))
  const conn = connect()
  await vi.waitFor(() => expect(finishPreflight).toBeTypeOf('function'))
  expect(dom.window.document.getElementById('access-error')).toBeNull()
  finishPreflight()
  await new Promise(resolve => setTimeout(resolve, 0))
  conn.room.doc.destroy()
  expect(dom.window.document.getElementById('access-error')?.textContent ?? null).toBeNull()
})
