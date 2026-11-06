/** Socket boundary regressions: run on the lead/native hosts when the worker sandbox denies bind. */
import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { startLocalDaemon, type StartedLocalDaemon } from '../src/daemon.js'
import { AuthorityLock, deterministicPort, localProofHeader, relayFile, relayHealth } from '../src/index.js'
import { privateStateDirectory } from '@room/local-state/private-state'
import { holder } from '../../hub-core/test/contract.js'

const dirs: string[] = [], daemons: StartedLocalDaemon[] = []
const room = 'local/authority'
function common() { const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-authority-'))); dirs.push(dir); return dir }
afterEach(async () => { vi.restoreAllMocks(); for (const daemon of daemons.splice(0)) await daemon.close(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
async function start(dir: string) { const daemon = await startLocalDaemon({ commonDir: dir, room, finalSaveRetryMs: [1] }); expect(daemon).toBeDefined(); daemons.push(daemon!); return daemon! }

it.each(['truncated', 'invalid-row', 'unreadable'])('refuses daemon readiness on %s lease evidence and leaves it unchanged', async kind => {
  const dir = common(), file = path.join(dir, 'room', 'hub-leases', crypto.createHash('sha256').update(room).digest('hex') + '.json')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const evidence = kind === 'invalid-row' ? '[{"name":"ada"}]' : kind === 'unreadable' ? '[]' : '[truncated'
  fs.writeFileSync(file, evidence, { mode: 0o600 })
  if (kind === 'unreadable') {
    const read = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation(((name: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(name) === file) throw Object.assign(new Error('EACCES lease evidence unavailable'), { code: 'EACCES' })
      return (read as (...args: unknown[]) => unknown)(name, ...args)
    }) as typeof fs.readFileSync)
  }
  const startup = startLocalDaemon({ commonDir: dir, room })
  await expect(startup).rejects.toThrow(/authority lease recovery failed/)
  if (kind === 'unreadable') await expect(startup).rejects.toThrow(/EACCES/)
  vi.restoreAllMocks()
  expect(fs.readFileSync(file, 'utf8')).toBe(evidence)
  expect(fs.existsSync(relayFile(dir))).toBe(false)
  expect(fs.existsSync(path.join(dir, 'room/hub/authority.lock'))).toBe(false)
  // A failed startup has no orphan listener; the canonical port is reusable immediately.
  const server = http.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(deterministicPort(dir), '127.0.0.1', resolve) })
  await new Promise<void>(resolve => server.close(() => resolve()))
})

it('publication failure after bind removes the unpublished listener, preserves discovery and releases authority', async () => {
  const dir = common(), file = relayFile(dir), rename = fs.renameSync
  privateStateDirectory(path.dirname(file))
  const previous = JSON.stringify({ schema: 2, port: deterministicPort(dir), pid: 99999999, room, key: 'retained-key', startedAt: 1 })
  fs.writeFileSync(file, previous, { mode: 0o600 })
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === file) throw Object.assign(new Error('EIO discovery publication'), { code: 'EIO' })
    rename(from, to)
  })
  await expect(startLocalDaemon({ commonDir: dir, room })).rejects.toThrow(/EIO discovery publication/)
  expect(fs.readFileSync(file, 'utf8')).toBe(previous)
  const lock = AuthorityLock.take(dir); expect(lock).toBeDefined(); lock!.release()
  vi.restoreAllMocks()
  const daemon = await start(dir)
  expect(daemon.info.key).toBe('retained-key')
  expect((await relayHealth(daemon.info.port, daemon.info.key))?.ready).toBe(true)
})

it('lease-flush failure refuses stop, retains authority and admission, then saves without a new update', async () => {
  const dir = common(), daemon = await start(dir), hub = daemon.relay.hubRoom(room)!.hub!
  const conn = {}, principal = { local: true } as const
  hub.handle(conn, { v: 1, id: 'hello', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: 's1' }, principal)
  await vi.waitFor(() => expect(hub.handle(conn, { v: 1, id: 'acquire', op: 'acquire', name: 'ada', holder: holder('s1') }, principal).ok).toBe(true), { timeout: 10_000 })
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).includes('hub-leases')) throw Object.assign(new Error('EIO lease flush'), { code: 'EIO' })
    rename(from, to)
  })
  const release = hub.handle(conn, { v: 1, id: 'release', op: 'release', name: 'ada', epoch: (daemon.relay.hubRoom(room)!.doc.participants.get('ada\0holder') as { epoch: number }).epoch }, principal)
  expect(release.ok).toBe(true)
  const target = `/daemon/stop?pid=${daemon.info.pid}&nonce=${daemon.info.nonce}`
  const stop = () => fetch(`http://127.0.0.1:${daemon.info.port}${target}`, { method: 'POST', headers: { Authorization: localProofHeader(daemon.info.key, 'POST', target, daemon.info.port) } })
  const response = await stop()
  expect(response.status).toBe(409); expect(await response.text()).toMatch(/lease store write failed/)
  expect((await relayHealth(daemon.info.port, daemon.info.key))?.draining).toBe(false)
  expect(AuthorityLock.take(dir)).toBeUndefined()
  vi.restoreAllMocks()
  expect((await stop()).status).toBe(200)
  await daemon.closed
  expect(fs.existsSync(path.join(dir, 'room/hub/authority.lock'))).toBe(false)
})

it('maintenance refuses wrong instance identity and a concurrent drain without joining its success', async () => {
  const daemon = await start(common()), target = (nonce: string) => `/daemon/stop?pid=${daemon.info.pid}&nonce=${nonce}`
  const stop = (nonce = daemon.info.nonce!) => {
    const resource = target(nonce)
    return fetch(`http://127.0.0.1:${daemon.info.port}${resource}`, { method: 'POST', headers: { Authorization: localProofHeader(daemon.info.key, 'POST', resource, daemon.info.port) } })
  }
  const wrong = await stop('wrong-instance')
  expect(wrong.status).toBe(409); expect(await wrong.text()).toMatch(/identity changed/)
  const hub = daemon.relay.hubRoom(room)!.hub!, flush = hub.flushLeases.bind(hub)
  let resume!: () => void
  const pending = new Promise<void>(resolve => { resume = resolve })
  vi.spyOn(hub, 'flushLeases').mockImplementation(async () => { await pending; await flush() })
  try {
    const first = stop()
    await vi.waitFor(async () => expect((await relayHealth(daemon.info.port, daemon.info.key))?.draining).toBe(true))
    const second = await stop()
    expect(second.status).toBe(409); expect(await second.text()).toMatch(/already draining/)
    resume()
    expect((await first).status).toBe(200)
    await daemon.closed
  } finally { resume() }
})
