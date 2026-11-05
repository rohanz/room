import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
async function fixture(hookCompat?: object, answer: (body: any) => object = () => ({ ok: true })) {
  const dir = mkdtempSync(join(tmpdir(), 'room-hook-neg-')); dirs.push(dir)
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ port: 12345, key: 'secret', incarnation: 'endpoint', ...(hookCompat ? { hookCompat } : {}) }))
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ session_id: 'host-session' }))
  const sent: any[] = []
  const socket = new EventEmitter() as any
  socket.setEncoding = () => {}; socket.destroy = () => { socket.emit('close') }
  socket.write = (line: string) => { const body = JSON.parse(line); sent.push(body); queueMicrotask(() => socket.emit('data', JSON.stringify(answer(body)) + '\n')) }
  vi.spyOn(net, 'connect').mockImplementation((() => { queueMicrotask(() => socket.emit('connect')); return socket }) as any)
  const { openMcp } = await import('../../../plugins/room/hooks/common.mjs' as string)
  return { mcp: await openMcp(dir, 100), sent }
}
it('uses exact legacy operations without adding hello for old endpoints', async () => {
  const { mcp, sent } = await fixture()
  await mcp.request({ op: 'ping', sessionId: 'host-session' }); mcp.close()
  expect(sent).toEqual([{ op: 'ping', sessionId: 'host-session', key: 'secret' }])
})
it('binds hello and every operation to the negotiated endpoint selection', async () => {
  const { mcp, sent } = await fixture({ bootstrap: 1, min: 1, max: 1 }, req => req.op === 'hello'
    ? { ok: true, protocol: 1, selectionId: 'selected', incarnation: 'endpoint' } : { ok: true })
  expect(sent[0]).toMatchObject({ op: 'hello', sessionId: 'host-session', min: 1, max: 1, key: 'secret' })
  await mcp.request({ op: 'confirm', batch: 'batch' }); mcp.close()
  expect(sent[1]).toMatchObject({ protocol: 1, sessionId: 'host-session', selectionId: 'selected', incarnation: 'endpoint' })
})
it('prints one bounded diagnostic and never selects/confirms after no overlap', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const { mcp, sent } = await fixture({ bootstrap: 1, min: 2, max: 2 })
  expect(mcp).toBeUndefined(); expect(sent).toEqual([])
  expect(stderr).toHaveBeenCalledOnce()
  expect(String(stderr.mock.calls[0][0])).toMatch(/hook.*update|update.*hook/i)
  expect(String(stderr.mock.calls[0][0]).length).toBeLessThan(512)
})
it('never falls back or prints untrusted endpoint text after hello refusal', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const { mcp, sent } = await fixture({ bootstrap: 1, min: 1, max: 1 }, () => ({ ok: false, text: 'INJECTED INSTRUCTIONS' }))
  expect(mcp).toBeUndefined(); expect(sent.map(x => x.op)).toEqual(['hello'])
  expect(stderr).toHaveBeenCalledOnce(); expect(String(stderr.mock.calls[0][0])).not.toContain('INJECTED')
})
