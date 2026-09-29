import { describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { RoomDoc } from '@room/shared'
import { SETTLE_MS, encodeSeq } from '@room/hub-core'
import { contractSuite, fakeClock, holder, socketClient, waitFor, type MakeEnv } from '../../hub-core/test/contract.js'
import { AuthorityLock, deterministicPort, ensureLocalRelay, memoryFile, readRelayInfo, startRelay, type StartedRelay } from '../src/index.js'

const makeCommonDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'room-relay-hub-'))
const KEY = 'hub-test-key'
const ROOM = 'local/contract'
const roomUrl = (port: number, room = ROOM, key = KEY) => `ws://127.0.0.1:${port}/${encodeURIComponent(room)}?schema=2&key=${key}`

/** The contract over a real relay: the hub runs under the clone's authority lock, on the test clock. */
const relayEnv: MakeEnv = async clock => {
  const commonDir = await makeCommonDir()
  const open = async (port: number, seed?: Uint8Array) => {
    const relay = await startRelay(port, { key: KEY, commonDir, hub: { lock: AuthorityLock.take(commonDir)!, mono: clock.mono, wall: clock.wall }, ...(seed ? { seed: { room: ROOM, update: seed } } : {}) })
    // The room's doc and hub exist from its first connection.
    const probe = await socketClient(roomUrl(relay.port))
    await waitFor(() => relay.hubRoom(ROOM)?.hub)
    await probe.close()
    return relay
  }
  let relay: StartedRelay = await open(0)
  const port = relay.port
  const current = () => relay.hubRoom(ROOM)!
  return {
    clock,
    doc: () => current().doc,
    incarnation: () => current().hub!.incarnation,
    connect: () => socketClient(roomUrl(port)),
    async tick() { current().hub!.tick() },
    async restart(state) {
      const update = state ?? Y.encodeStateAsUpdate(current().doc.doc)
      await relay.close()
      fs.rmSync(memoryFile(commonDir, ROOM), { force: true })
      relay = await open(port, update)
    },
    async close() { await relay.close(); fs.rmSync(commonDir, { recursive: true, force: true }) },
  }
}

contractSuite('local relay', relayEnv)

describe('relay hub wiring', () => {
  it('two racers with the derived port taken: one lock holder serves the hub; a relay without the lock answers only not-authority', async () => {
    const common = await makeCommonDir()
    const squatter = http.createServer((_q, res) => { res.end('not a relay') })
    await new Promise<void>(r => squatter.listen(deterministicPort(common), '127.0.0.1', r))
    const [a, b] = await Promise.all([ensureLocalRelay(common, 'local/x', { watchMs: 100 }), ensureLocalRelay(common, 'local/x', { watchMs: 100 })])
    const stray = await startRelay(0, { key: a.key, commonDir: common })
    try {
      expect([a.owned, b.owned].filter(Boolean)).toHaveLength(1)
      expect(a.port).toBe(b.port)
      expect(readRelayInfo(common)?.port).toBe(a.port)
      const client = await socketClient(roomUrl(a.port, 'local/x', a.key))
      await waitFor(async () => (await client.hello()).ok)
      expect(await client.hello()).toMatchObject({ ok: true, authority: true })
      const lease = await waitFor(async () => { const r = await client.send({ op: 'acquire', name: 'ada', holder: holder('s1') }) as { ok: boolean; epoch: number }; return r.ok && r }, 10_000)
      expect(await client.send({ op: 'post', lease: { name: 'ada', epoch: lease.epoch }, msg: { id: 'm1', type: 'note', from: 'ada', text: 'hi' } })).toMatchObject({ ok: true })
      await client.close()

      const other = await socketClient(roomUrl(stray.port, 'local/x', a.key))
      expect(await other.hello()).toMatchObject({ ok: false, reason: 'not-authority' })
      expect(await other.send({ op: 'acquire', name: 'ada', holder: holder('s1') })).toMatchObject({ ok: false, reason: 'not-authority' })
      await other.close()
    } finally { await a.stop(); await b.stop(); await stray.close(); squatter.close() }
  }, 30_000) // the hub settles for SETTLE_MS (5 s, real clock) before its first lease

  it('a relay that loses its lock answers not-authority and tells its holders', async () => {
    const common = await makeCommonDir()
    const clock = fakeClock()
    const lock = AuthorityLock.take(common)!
    expect(AuthorityLock.take(common)).toBeUndefined()
    const relay = await startRelay(0, { key: KEY, commonDir: common, hub: { lock, mono: clock.mono, wall: clock.wall } })
    try {
      const c = await socketClient(roomUrl(relay.port))
      await waitFor(() => relay.hubRoom(ROOM)?.hub)
      clock.advance(SETTLE_MS)
      expect(await c.hello()).toMatchObject({ ok: true })
      const { epoch } = await c.send({ op: 'acquire', name: 'ada', holder: holder('s1') }) as { epoch: number }
      // Someone replaced the lock (a successor recovered it while this relay stalled).
      fs.writeFileSync(lock.file, JSON.stringify({ pid: 1, startTime: '', executable: '', sessionId: 'x', nonce: 'someone-else' }))
      expect(await c.send({ op: 'renew', name: 'ada', epoch })).toMatchObject({ ok: false, reason: 'not-authority' })
      await waitFor(() => c.pushes.length)
      expect(c.pushes[0]).toMatchObject({ push: 'lease-lost', name: 'ada', epoch, reason: 'not-authority' })
      await c.close()
    } finally { await relay.close() }
    // Closing never removes a lock that is not its own.
    expect(JSON.parse(fs.readFileSync(lock.file, 'utf8')).nonce).toBe('someone-else')
  })

  it("ends a dead local holder's lease at once", async () => {
    const common = await makeCommonDir()
    const clock = fakeClock()
    const relay = await startRelay(0, { key: KEY, commonDir: common, hub: { lock: AuthorityLock.take(common)!, mono: clock.mono, wall: clock.wall } })
    try {
      const gone = spawnSync(process.execPath, ['-e', '']).pid!
      const c = await socketClient(roomUrl(relay.port))
      await waitFor(() => relay.hubRoom(ROOM)?.hub)
      clock.advance(SETTLE_MS)
      await c.hello()
      expect(await c.send({ op: 'acquire', name: 'ada', holder: holder('s-dead', { pid: gone }) })).toMatchObject({ ok: true })
      expect(await c.send({ op: 'acquire', name: 'ada', holder: holder('s2') })).toMatchObject({ ok: true })
      expect(relay.hubRoom(ROOM)!.doc.participants.get('ada\u0000holder')).toMatchObject({ sessionId: 's2' })
      await c.close()
    } finally { await relay.close() }
  })

  it('separate processes: one authority; a stalled owner is not replaced; a killed one is, and the survivor grants', async () => {
    const common = await makeCommonDir()
    const barrier = path.join(common, 'go')
    const here = path.dirname(fileURLToPath(import.meta.url))
    type Report = { pid: number; owned: boolean; port: number; key: string }
    const reports = new Map<number, Report>()
    const contender = (): ChildProcess => {
      // `--import tsx`, not tsx's CLI, which runs the script in a second process that the signals would miss.
      const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'authority-child.ts'), common, 'local/x', barrier], { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] })
      let buffered = ''
      child.stdout!.on('data', chunk => {
        buffered += chunk
        const lines = buffered.split('\n'); buffered = lines.pop()!
        for (const line of lines) { const r = JSON.parse(line) as Report; reports.set(r.pid, r) }
      })
      return child
    }
    const children = [contender(), contender()]
    const lockOwner = () => JSON.parse(fs.readFileSync(path.join(common, 'room', 'hub', 'authority.lock'), 'utf8')).pid as number
    try {
      // Both are loaded and waiting; they start together.
      await new Promise(r => setTimeout(r, 1500))
      fs.writeFileSync(barrier, '')
      await waitFor(() => children.every(c => reports.has(c.pid!)), 20_000)
      const owners = children.filter(c => reports.get(c.pid!)!.owned)
      expect(owners).toHaveLength(1)
      const [owner] = owners, survivor = children.find(c => c !== owner)!
      const { port, key } = reports.get(owner.pid!)!
      expect(reports.get(survivor.pid!)).toMatchObject({ owned: false, port, key })
      expect(lockOwner()).toBe(owner.pid)
      const client = await socketClient(roomUrl(port, 'local/x', key))
      const first = await waitFor(async () => { const r = await client.hello(); return r.ok && r }, 5000)
      const epoch = (await waitFor(async () => { const r = await client.send({ op: 'acquire', name: 'ada', holder: holder('s1') }); return r.ok && r }, 10_000)).epoch as number
      await client.close()

      // Stalled but alive: its lock is not recoverable, so nobody takes over.
      owner.kill('SIGSTOP')
      await new Promise(r => setTimeout(r, 3000))
      expect(reports.get(survivor.pid!)!.owned).toBe(false)
      expect(lockOwner()).toBe(owner.pid)
      owner.kill('SIGCONT')
      const resumed = await socketClient(roomUrl(port, 'local/x', key))
      expect(await waitFor(async () => { const r = await resumed.hello(); return r.ok && r }, 5000)).toMatchObject({ incarnation: first.incarnation })
      await resumed.close()

      // Killed without cleanup: the survivor recovers the lock and serves on the same port.
      owner.kill('SIGKILL')
      await new Promise(r => owner.once('exit', r))
      await waitFor(() => reports.get(survivor.pid!)!.owned, 10_000)
      expect(lockOwner()).toBe(survivor.pid)
      const next = await waitFor(async () => { try { return await socketClient(roomUrl(port, 'local/x', key)) } catch { return undefined } }, 5000)
      const hello = await waitFor(async () => { const r = await next.hello(); return r.ok && r }, 5000)
      expect(hello.incarnation as number).toBeGreaterThan(first.incarnation as number)
      expect(await next.send({ op: 'renew', name: 'ada', epoch })).toMatchObject({ ok: true })
      const bob = await waitFor(async () => { const r = await next.send({ op: 'acquire', name: 'bob', holder: holder('s2') }); return r.ok && r }, 10_000)
      expect(bob.epoch as number).toBeGreaterThan(epoch)
      await next.close()
    } finally {
      await Promise.all(children.map(c => new Promise<void>(resolve => {
        if (c.exitCode !== null || c.signalCode !== null) { resolve(); return }
        c.once('exit', () => resolve())
        c.kill('SIGCONT')
        c.kill('SIGKILL')
      })))
      fs.rmSync(common, { recursive: true, force: true })
    }
  }, 60_000)

  it('a survivor takes the authority from the stopped owner and starts from its own replica', async () => {
    const common = await makeCommonDir()
    const replica = new RoomDoc()
    const inherited = encodeSeq(5, 3)
    replica.participants.set('ada\u0000holder', { ...holder('s1'), epoch: inherited, at: 1 })
    const owner = await ensureLocalRelay(common, 'local/x', { watchMs: 30_000 })
    const b = await ensureLocalRelay(common, 'local/x', { watchMs: 100, seed: () => Y.encodeStateAsUpdate(replica.doc) })
    try {
      await owner.stop()
      await waitFor(() => b.owned, 8000)
      const c = await socketClient(roomUrl(b.port, 'local/x', b.key))
      const hello = await waitFor(async () => { const r = await c.hello(); return r.ok && r })
      expect(hello.incarnation as number).toBeGreaterThan(5)
      expect(await c.send({ op: 'renew', name: 'ada', epoch: inherited })).toMatchObject({ ok: true })
      expect(await c.send({ op: 'acquire', name: 'ada', holder: holder('other') })).toMatchObject({ ok: false, reason: 'held' })
      await c.close()
    } finally { await owner.stop(); await b.stop() }
    expect(fs.existsSync(path.join(common, 'room', 'hub', 'authority.lock'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(common, 'room', 'hub', 'incarnation.json'), 'utf8')).max).toBeGreaterThan(5)
  })
})
