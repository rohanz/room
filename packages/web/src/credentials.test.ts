import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { webcrypto } from 'node:crypto'
import { mintTicket, takeLinkCredentials, browserViewProof, roomLocationFromQuery } from './conn.js'
import { viewTicketProof } from '../../relay/src/proof.js'

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

  it('parses a fragment capability and proves a local view without sending it', async () => {
    const dom = new JSDOM('', { url: 'file:///opt/room%20plugin/viewer.html#room=ws%3A%2F%2F127.0.0.1%3A4444%2Flocal%252Frepo&view=read-only&participant=Pat&relay=1' })
    vi.stubGlobal('location', dom.window.location)
    vi.stubGlobal('crypto', webcrypto)
    const storage = { getItem: vi.fn(() => { throw new Error('unavailable') }), setItem: vi.fn(() => { throw new Error('unavailable') }) }
    const replace = vi.fn()
    const auth = takeLinkCredentials('', storage, replace)
    expect(auth.view).toBe('read-only')
    expect(roomLocationFromQuery()).toMatchObject({ serverUrl: 'ws://127.0.0.1:4444', displayRoomName: 'local/repo' })
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(dom.window.location.hash).toContain('view=read-only')
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ticket: 'local' }) })
    await mintTicket(roomLocationFromQuery(), auth, request)
    expect(request.mock.calls[0]![0]).toBe('http://127.0.0.1:4444/ws-ticket')
    const body = JSON.parse(request.mock.calls[0]![1].body)
    expect(body).not.toHaveProperty('view')
    expect(body).not.toHaveProperty('key')
    expect(body.proof).toBe(viewTicketProof('read-only', 'local/repo', body.ts, body.nonce))
    expect(await browserViewProof('read-only', 'local/repo', body.ts, body.nonce)).toBe(body.proof)
    vi.unstubAllGlobals()
  })
  it('sends an ordinary view credential to a loopback team server without a relay marker', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ticket: 'team' }) })
    await mintTicket({ serverUrl: 'ws://localhost:1234', encodedRoomName: 'team', displayRoomName: 'team' }, { view: 'team-view', key: '', token: '', relay: false }, request)
    expect(JSON.parse(request.mock.calls[0]![1].body)).toMatchObject({ room: 'team', schema: 2, view: 'team-view' })
  })
})
