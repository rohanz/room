import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ provider: vi.fn() }))
vi.mock('y-websocket', () => ({ WebsocketProvider: class {
  awareness = { setLocalState: vi.fn() }
  on = vi.fn()
  constructor(...args: unknown[]) { mocks.provider(...args) }
} }))
import { connect } from './conn.ts'
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
describe('read-only access preflight', () => {
  it.each(['view=secret', 'view=secret&view=code', 'view=board', 'view=', 'key=local'])('skips /view-token for %s', query => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    connect(`?room=${encodeURIComponent('wss://room.example/repo')}&${query}`)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps the read-only key as the websocket credential when Code is selected', () => {
    connect('?room=wss%3A%2F%2Froom.example%2Frepo&view=secret&view=code')
    expect(mocks.provider.mock.calls[0][3]).toEqual({ params: { view: 'secret' } })
  })
  it('does not send presentation values as credentials', () => {
    connect('?room=wss%3A%2F%2Froom.example%2Frepo&view=board&token=token')
    expect(mocks.provider.mock.calls[0][3]).toEqual({ params: { token: 'token' } })
  })
  it('still checks hosted links without read-only or local credentials', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetch)
    connect('?room=wss%3A%2F%2Froom.example%2Frepo&token=token')
    expect(fetch).toHaveBeenCalledWith('https://room.example/view-token', expect.objectContaining({ method: 'POST' }))
  })
})
