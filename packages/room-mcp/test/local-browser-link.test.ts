import { describe, expect, it } from 'vitest'
import { localBrowserLink } from '../src/session.js'

describe('local browser link', () => {
  it('opens the installed file with an encoded path and fragment capability', () => {
    const link = localBrowserLink('ws://127.0.0.1:4444/local%2Frepo', 'Pat Lee', 'view/key', '/opt/Room plugin/web/viewer.html')
    const url = new URL(link)
    expect(url.protocol).toBe('file:')
    expect(url.pathname).toBe('/opt/Room%20plugin/web/viewer.html')
    expect(url.search).toBe('')
    const fragment = new URLSearchParams(url.hash.slice(1))
    expect(fragment.get('room')).toBe('ws://127.0.0.1:4444/local%2Frepo')
    expect(fragment.get('view')).toBe('view/key')
    expect(fragment.get('participant')).toBe('Pat Lee')
    expect(fragment.get('relay')).toBe('1')
  })
  it('reports an unbuilt viewer unless ROOM_WEB overrides it for development', () => {
    expect(localBrowserLink('ws://127.0.0.1:4/local%2Fx', 'Pat', 'view', '')).toContain('not built')
    expect(localBrowserLink('ws://127.0.0.1:4/local%2Fx', 'Pat', 'view', '', 'http://localhost:5173')).toMatch(/^http:\/\/localhost:5173\/#room=/)
  })
})
