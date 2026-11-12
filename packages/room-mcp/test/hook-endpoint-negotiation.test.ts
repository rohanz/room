import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import net from 'node:net'
import { startArbitration } from '../src/arbitration.js'
const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks() })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hook-endpoint-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  let connect!: (socket: any) => void
  const server = new EventEmitter() as any
  server.listen = (_port: number, _host: string, ready: () => void) => ready()
  server.address = () => ({ port: 12345 }); server.unref = () => {}; server.close = (done: () => void) => done()
  vi.spyOn(net, 'createServer').mockImplementation(((handler: typeof connect) => { connect = handler; return server }) as any)
  let sid = 'session'
  const ledger = { commit: vi.fn(), release: vi.fn() }
  const select = vi.fn(() => ({ batch: { id: 'batch' }, items: [{ line: 'owed message' }], notices: [], more: 0 }))
  const endpoint = await startArbitration({ binding: { dir: () => dir, bound: () => ({ id: sid, host: 'codex' }) } as any, ledger: ledger as any, select: select as any })
  cleanup.push(() => endpoint.close())
  const published = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))
  const socket = new EventEmitter() as any, replies: any[] = []
  socket.setEncoding = () => {}; socket.write = (text: string) => replies.push(JSON.parse(text)); connect(socket)
  const request = (body: object) => { socket.emit('data', JSON.stringify({ ...body, key: published.key }) + '\n'); return replies.pop() }
  return { published, request, ledger, select, rebind: () => { sid = 'another-session' } }
}
it('advertises format one and never selects/commits on hello', async () => {
  const f = await fixture()
  expect(f.published.hookCompat).toEqual({ bootstrap: 1, min: 1, max: 1 })
  const hello = f.request({ op: 'hello', sessionId: 'session', bootstrap: 1, min: 1, max: 1, capabilities: {} })
  expect(hello).toMatchObject({ ok: true, protocol: 1, incarnation: f.published.incarnation })
  expect(f.select).not.toHaveBeenCalled(); expect(f.ledger.commit).not.toHaveBeenCalled()
  const bound = { sessionId: 'session', protocol: 1, selectionId: hello.selectionId, incarnation: hello.incarnation }
  expect(f.request({ op: 'select', ...bound })).toMatchObject({ ok: true, batch: 'batch' })
  expect(f.request({ op: 'confirm', batch: 'batch', ...bound })).toEqual({ ok: true })
  expect(f.ledger.commit).toHaveBeenCalledOnce()
})
it('a failed hello cannot fall back to select and messages remain owed', async () => {
  const f = await fixture()
  expect(f.request({ op: 'hello', sessionId: 'session', bootstrap: 1, min: 2, max: 2, capabilities: {} }).ok).toBe(false)
  expect(f.request({ op: 'select', sessionId: 'session' }).ok).toBe(false)
  expect(f.select).not.toHaveBeenCalled(); expect(f.ledger.commit).not.toHaveBeenCalled()
})
it('rebinding invalidates selection and a stale confirm cannot commit a batch', async () => {
  const f = await fixture()
  const hello = f.request({ op: 'hello', sessionId: 'session', bootstrap: 1, min: 1, max: 1, capabilities: {} })
  const bound = { sessionId: 'session', protocol: 1, selectionId: hello.selectionId, incarnation: hello.incarnation }
  f.request({ op: 'select', ...bound }); f.rebind()
  expect(f.request({ op: 'confirm', batch: 'batch', ...bound }).ok).toBe(false)
  expect(f.ledger.commit).not.toHaveBeenCalled()
})
it('unmodified format-one hooks still select and confirm on the new endpoint', async () => {
  const f = await fixture()
  expect(f.request({ op: 'select', sessionId: 'session' }).ok).toBe(true)
  expect(f.request({ op: 'confirm', batch: 'batch' }).ok).toBe(true)
  expect(f.ledger.commit).toHaveBeenCalledOnce()
})

it('a foreign-session hello cannot switch to legacy operations on the same connection', async () => {
  const f = await fixture()
  expect(f.request({ op: 'hello', sessionId: 'foreign', bootstrap: 1, min: 1, max: 1, capabilities: {} }).ok).toBe(false)
  expect(f.request({ op: 'select', sessionId: 'session' }).ok).toBe(false)
  expect(f.select).not.toHaveBeenCalled()
})
