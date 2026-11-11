import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthorityLock, startRelay } from '../src/index.js'

afterEach(() => vi.restoreAllMocks())

it('contains a hub maintenance error and logs the affected room without killing the relay', async () => {
  const commonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-relay-'))
  // Only replace the transport boundary; initialize a real relay document and hub.
  vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (this: http.Server, ...args: unknown[]) {
    const ready = args.find(arg => typeof arg === 'function') as () => void
    queueMicrotask(ready)
    return this
  } as never)
  vi.spyOn(http.Server.prototype, 'close').mockImplementation(function (this: http.Server, done?: () => void) {
    done?.()
    return this
  } as never)
  const interval = globalThis.setInterval
  let maintenance: (() => void) | undefined
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms?: number, ...args: unknown[]) => {
    const timer = interval(callback, ms, ...args)
    if (ms === 1000) { maintenance = callback; clearInterval(timer) }
    return timer
  }) as typeof setInterval)
  const lines: string[] = [], room = 'local/review'
  const relay = await startRelay(4405, { commonDir, hub: { lock: AuthorityLock.take(commonDir)! }, log: line => lines.push(line) })
  try {
    await relay.initialize(room)
    const other = 'local/healthy'
    await relay.initialize(other)
    const tick = vi.spyOn(relay.hubRoom(room)!.hub!, 'tick').mockImplementation(() => { throw new Error('maintenance failed') })
    const healthyTick = vi.spyOn(relay.hubRoom(other)!.hub!, 'tick')
    expect(maintenance).toBeTypeOf('function')
    expect(() => maintenance!()).not.toThrow()
    expect(tick).toHaveBeenCalledOnce()
    expect(healthyTick).toHaveBeenCalledOnce()
    expect(lines).toContain(`hub maintenance ${encodeURIComponent(room)}: maintenance failed`)
  } finally {
    await relay.abortUnpublished()
    fs.rmSync(commonDir, { recursive: true, force: true })
  }
})
