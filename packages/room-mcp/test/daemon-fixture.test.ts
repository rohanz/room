import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ensureLocalDaemon } from '@room/relay'
import { disposePreviewFixture } from './fixtures/preview-disposal.js'
import { recordTestDaemon, stopTestDaemon, stopTestDaemons } from './daemon-fixture.js'

const seam = vi.hoisted(() => ({ stop: vi.fn<(...args: unknown[]) => Promise<void | 'different daemon instance'>>(), ensure: vi.fn(), alive: true }))
vi.mock('@room/relay', async importOriginal => ({ ...await importOriginal<typeof import('@room/relay')>(), stopLocalDaemon: seam.stop, ensureLocalDaemon: (...args: unknown[]) => seam.ensure(...args) }))
vi.mock('@room/relay/process', async importOriginal => ({ ...await importOriginal<typeof import('@room/relay/process')>(), pidAlive: () => seam.alive }))
vi.mock('@room/relay/leases', async importOriginal => ({ ...await importOriginal<typeof import('@room/relay/leases')>(), liveness: () => seam.alive ? 'alive' : 'dead' }))

const roots: string[] = []
afterEach(() => { seam.stop.mockReset(); seam.ensure.mockReset(); seam.alive = true; for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-fixture-dispose-')); roots.push(dir); return dir }
function record(dir: string, runtime = 'daemon', nonce = '11111111-1111-1111-1111-111111111111') {
  const common = path.join(dir, '.git')
  fs.mkdirSync(path.join(common, 'room'), { recursive: true })
  fs.writeFileSync(path.join(common, 'room', 'relay.json'), JSON.stringify({ schema: 2, runtime, nonce, pid: 2147483000, port: 1, key: 'test-only', lead: { pid: 2147483000, startTime: 'test', executable: 'node' } }))
  return common
}

it('waits for durable daemon exit before removing a clone, and preserves the fixture when stop fails', async () => {
  const dir = root(), common = record(dir)
  recordTestDaemon(common)
  let rejectStop!: (error: Error) => void
  seam.stop.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectStop = reject }))
  const removing = disposePreviewFixture(dir)
  const failed = expect(removing).rejects.toThrow('save blocked')
  await vi.waitFor(() => expect(seam.stop).toHaveBeenCalledWith(common, undefined, '11111111-1111-1111-1111-111111111111'))
  expect(fs.existsSync(dir)).toBe(true)
  rejectStop(new Error('save blocked'))
  await failed
  expect(fs.existsSync(dir)).toBe(true)

  let finish!: () => void
  seam.stop.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const retry = disposePreviewFixture(dir)
  await vi.waitFor(() => expect(seam.stop).toHaveBeenCalledTimes(2))
  expect(fs.existsSync(dir)).toBe(true)
  finish()
  await retry
  expect(fs.existsSync(dir)).toBe(false)
})

it('stops every independent clone under the owned root, skipping legacy, dead and linked external clones', async () => {
  const dir = root(), outside = root()
  const a = record(path.join(dir, 'a')), b = record(path.join(dir, 'nested', 'b'))
  recordTestDaemon(a); recordTestDaemon(b)
  record(path.join(dir, 'legacy'), 'session-relay')
  record(outside)
  fs.symlinkSync(outside, path.join(dir, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
  seam.stop.mockResolvedValue(undefined)
  await stopTestDaemons(dir)
  expect(seam.stop.mock.calls.map(([common]) => common).sort()).toEqual([a, b].sort())
  seam.stop.mockClear()
  seam.alive = false
  await stopTestDaemon(a)
  expect(seam.stop).not.toHaveBeenCalled()
})

it('leaves an unowned or replacement instance running and preserves its fixture directory', async () => {
  const dir = root(), common = record(dir)
  expect(await stopTestDaemon(common)).toBe(false)
  expect(seam.stop).not.toHaveBeenCalled()
  recordTestDaemon(common)
  record(dir, 'daemon', '22222222-2222-2222-2222-222222222222')
  expect(await stopTestDaemon(common)).toBe(false)
  expect(seam.stop).not.toHaveBeenCalled()
  await disposePreviewFixture(dir)
  expect(fs.existsSync(dir)).toBe(true)
})

it('handles a replacement between the fixture check and authenticated stop without throwing', async () => {
  const dir = root(), common = record(dir)
  recordTestDaemon(common)
  seam.stop.mockResolvedValueOnce('different daemon instance')
  expect(await stopTestDaemon(common)).toBe(false)
  expect(fs.existsSync(dir)).toBe(true)
})

it('records a daemon the fixture starts through ensure, but does not acquire an adopted daemon', async () => {
  const dir = root(), common = record(dir)
  seam.ensure.mockResolvedValue({ pid: 2147483000, launched: false })
  await ensureLocalDaemon(common, 'local/test', { admitStart: async () => {} })
  expect(await stopTestDaemon(common)).toBe(false)
  expect(seam.stop).not.toHaveBeenCalled()
  seam.ensure.mockImplementationOnce(async () => {
    record(dir, 'daemon', '33333333-3333-3333-3333-333333333333')
    return { pid: 2147483000, launched: true }
  })
  await ensureLocalDaemon(common, 'local/test', { admitStart: async () => {} })
  seam.stop.mockResolvedValueOnce(undefined)
  expect(await stopTestDaemon(common)).toBe(true)
  expect(seam.stop).toHaveBeenCalledWith(common, undefined, '33333333-3333-3333-3333-333333333333')
})

it('does not stop a racing launcher winner even when discovery changes during ensure', async () => {
  const dir = root(), common = record(dir)
  seam.ensure.mockImplementationOnce(async () => {
    record(dir, 'daemon', '44444444-4444-4444-4444-444444444444')
    return { pid: 2147483000, launched: false }
  })
  await ensureLocalDaemon(common, 'local/test', { admitStart: async () => {} })
  expect(await stopTestDaemon(common)).toBe(false)
  await disposePreviewFixture(dir)
  expect(seam.stop).not.toHaveBeenCalled()
  expect(fs.existsSync(dir)).toBe(true)
})
