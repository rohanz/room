import { describe, expect, it } from 'vitest'
import { Auth } from '../src/auth.js'

const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('device polling budget', () => {
  it('S1 enforces GitHub interval and permits only one exchange per code', async () => {
    let now = 0, exchanges = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const fetcher = (async (url: string) => {
      if (url.endsWith('/device/code')) return reply({ device_code: 'code', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
      exchanges++
      await gate
      return reply({ error: 'authorization_pending' })
    }) as typeof fetch
    const auth = new Auth({ clientId: 'client', fetch: fetcher, now: () => now })
    const { device } = await auth.startDevice()
    const first = auth.poll(device)
    const second = auth.poll(device)
    release()
    expect(await first).toEqual({ pending: true })
    expect(await second).toEqual({ pending: true })
    expect(exchanges).toBe(1)
    expect(await auth.poll(device)).toEqual({ pending: true })
    expect(exchanges).toBe(1)
    now = 5000
    expect(await auth.poll(device)).toEqual({ pending: true })
    expect(exchanges).toBe(2)
  })
})
