import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ provider: vi.fn(), disconnect: vi.fn() }))
vi.mock('y-websocket', () => ({ WebsocketProvider: class {
  awareness = { setLocalState: vi.fn() }
  on = vi.fn()
  disconnect = mocks.disconnect
  constructor(...args: unknown[]) { mocks.provider(...args) }
} }))
import { connect } from './conn.ts'
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
describe('read-only access preflight', () => {
  it.each(['view=board', 'view=', 'key=local'])('skips /view-token for %s', query => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    connect(`?room=${encodeURIComponent('wss://room.example/repo')}&${query}`)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('shows a terminal old-link explanation for a migrated branch view link', async () => {
    const error = { id: '', className: '', textContent: '' }
    vi.stubGlobal('document', { getElementById: vi.fn(() => null), createElement: vi.fn(() => error), body: { appendChild: vi.fn(() => error) } })
    const fetch = vi.fn().mockResolvedValue({ status: 410, ok: false, text: async () => '<!doctype html><body>this link was for a branch room that no longer exists; ask for a new link</body>' })
    vi.stubGlobal('fetch', fetch)
    connect(`?room=${encodeURIComponent('wss://room.example/github.com%2Fo%2Fr%2Fmain')}&view=old-key`)
    await vi.waitFor(() => expect(error.textContent).toContain('ask for a new link'))
    expect(error.textContent).not.toContain('<body>')
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('view=old-key'), expect.objectContaining({ method: 'GET' }))
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })
  it('keeps the read-only key as the websocket credential when Code is selected', () => {
    connect('?room=wss%3A%2F%2Froom.example%2Frepo&view=secret&view=code')
    expect(mocks.provider.mock.calls[0][3]).toEqual({ params: { schema: '2', view: 'secret' } })
  })
  it('does not send presentation values as credentials', () => {
    connect('?room=wss%3A%2F%2Froom.example%2Frepo&view=board&token=token')
    expect(mocks.provider.mock.calls[0][3]).toEqual({ params: { schema: '2', token: 'token' } })
  })
  it('still checks hosted links without read-only or local credentials', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetch)
    connect('?room=wss%3A%2F%2Froom.example%2Frepo&token=token')
    expect(fetch).toHaveBeenCalledWith('https://room.example/view-token', expect.objectContaining({ method: 'POST' }))
  })
})
