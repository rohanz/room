import { expect, it } from 'vitest'
import { openPreferred } from '../src/daemon.js'

const refused = (code: string) => Object.assign(new Error(code), { code })

it.each(['EADDRINUSE', 'EACCES'])('falls back to any free port when the preferred port refuses with %s', async code => {
  const tried: number[] = []
  const opened = await openPreferred(4400, async port => { tried.push(port); if (port === 4400) throw refused(code); return `listening on ${port}` }, async () => false)
  expect(opened).toBe('listening on 0')
  expect(tried).toEqual([4400, 0])
})

it.each(['EADDRINUSE', 'EACCES'])('refuses to start beside this clone\'s own Room owner on %s', async code => {
  const tried: number[] = []
  await expect(openPreferred(4400, async port => { tried.push(port); throw refused(code) }, async () => true)).rejects.toThrow('still answers on port 4400')
  expect(tried).toEqual([4400])
})

it('propagates a failure from the fallback open', async () => {
  const tried: number[] = [], failure = refused('EACCES')
  await expect(openPreferred(4400, async port => {
    tried.push(port)
    throw port === 4400 ? refused('EADDRINUSE') : failure
  }, async () => false)).rejects.toBe(failure)
  expect(tried).toEqual([4400, 0])
})

it('does not hide other listen errors', async () => {
  await expect(openPreferred(4400, async () => { throw refused('EADDRNOTAVAIL') }, async () => false)).rejects.toThrow('EADDRNOTAVAIL')
})
