import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { mintTicket, takeLinkCredentials } from './conn.js'

describe('browser link credentials', () => {
  it('strips a view key from the address and retains it for a reload', () => {
    const dom = new JSDOM('', { url: 'https://room.test/?room=wss%3A%2F%2Froom.test%2Frepo&view=secret&view=code' })
    vi.stubGlobal('location', dom.window.location)
    const replace = vi.fn()
    const first = takeLinkCredentials(dom.window.location.search, dom.window.sessionStorage, replace)
    expect(first.view).toBe('secret')
    expect(replace.mock.calls[0]![0]).not.toContain('secret')
    expect(takeLinkCredentials('?room=wss%3A%2F%2Froom.test%2Frepo&view=code', dom.window.sessionStorage, replace).view).toBe('secret')
  })

  it('mints with a body credential and never a credential URL', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ticket: 'fresh' }) })
    const ticket = await mintTicket({ serverUrl: 'wss://room.test', encodedRoomName: 'repo', displayRoomName: 'repo' }, { view: 'secret', key: '', token: '' }, request)
    expect(ticket).toBe('fresh')
    expect(request.mock.calls[0]![0]).toBe('https://room.test/ws-ticket')
    expect(JSON.parse(request.mock.calls[0]![1].body).view).toBe('secret')
  })
})
