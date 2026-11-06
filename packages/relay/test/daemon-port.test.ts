import { expect, it } from 'vitest'
import { openPreferred } from '../src/daemon.js'

const refused = (code: string) => Object.assign(new Error(code), { code })

it.each(['EADDRINUSE', 'EACCES'])('falls back to any free port when the preferred port refuses with %s', async code => {
  const tried: number[] = []
  const opened = await openPreferred(4400, async port => { tried.push(port); if (port === 4400) throw refused(code); return `listening on ${port}` }, async () => false)
  expect(opened).toBe('listening on 0')
  expect(tried).toEqual([4400, 0])
})

it('refuses to start beside this clone\'s own Room owner on the preferred port', async () => {
  await expect(openPreferred(4400, async () => { throw refused('EADDRINUSE') }, async () => true)).rejects.toThrow('still answers on port 4400')
})

it('does not hide other listen errors', async () => {
  await expect(openPreferred(4400, async () => { throw refused('EADDRNOTAVAIL') }, async () => false)).rejects.toThrow('EADDRNOTAVAIL')
})
