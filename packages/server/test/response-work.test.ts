import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { expect, it, vi } from 'vitest'
import { ResponseWork, WorkSlots, scanRooms, archiveListing, waitForResult } from '../src/http.js'
import { OutboundBudget } from '../src/sockets.js'

class Response extends EventEmitter {
  destroyed = false
  writableFinished = false
  writableEnded = false
  status = 0
  body = ''
  headers: Record<string, unknown> = {}
  writeHead(status: number, headers: Record<string, unknown>) { this.status = status; this.headers = headers }
  end(body: string) { this.body = body; this.writableEnded = true }
  destroy() { this.destroyed = true; this.emit('close') }
  asHttp() { return this as unknown as http.ServerResponse }
}
it('cancels one coalesced response wait without canceling the shared work', async () => {
  let finish!: (result: string) => void
  const work = new Promise<string>(resolve => { finish = resolve }), controller = new AbortController()
  const res = new Response(), slots = new WorkSlots(1, 1, new OutboundBudget(100, 100))
  const lease = ResponseWork.reserve(slots, 'a', res.asHttp(), 1000)!, release = lease.hold()
  const waiter = waitForResult(work, controller.signal).finally(release)
  res.destroy(); controller.abort()
  await expect(waiter).resolves.toBeUndefined()
  expect(slots.count).toBe(0)
  finish('inventory'); await expect(work).resolves.toBe('inventory')
})
it('each coalesced waiter owns a slot and byte reservation until finish or deadline', async () => {
  vi.useFakeTimers()
  try {
    const budget = new OutboundBudget(1000, 1000), slots = new WorkSlots(3, 3, budget)
    const responses = [new Response(), new Response(), new Response()]
    const leases = responses.map(r => ResponseWork.reserve(slots, 'same', r.asHttp(), 100)!)
    expect(slots.count).toBe(3)
    expect(ResponseWork.reserve(slots, 'other', new Response().asHttp(), 100)).toBeUndefined()
    const shared = Promise.resolve('shared listing')
    await Promise.all(leases.map(async lease => lease.send(200, await shared)))
    expect(budget.queuedBytes).toBe(3 * Buffer.byteLength('shared listing'))
    responses[0].emit('finish')
    expect(slots.count).toBe(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(responses[1].destroyed).toBe(true)
    expect(slots.count).toBe(0)
    expect(budget.queuedBytes).toBe(0)
  } finally { vi.useRealTimers() }
})
it('refuses bytes before enqueueing and releases on close', () => {
  const budget = new OutboundBudget(10, 10), slots = new WorkSlots(2, 2, budget), r = new Response()
  const lease = ResponseWork.reserve(slots, 'a', r.asHttp(), 1000)!
  expect(lease.send(200, 'x'.repeat(11))).toBe(false)
  expect(r.body).toBe('')
  r.destroy()
  expect(slots.count).toBe(0)
})
it('caps archive listings without enumerating all keys into an array', () => {
  const keys = new Map(Array.from({ length: 1005 }, (_, i) => [String(i), true]))
  const body = JSON.parse(archiveListing('repo', ['legacy'], keys, 1000))
  expect(body.unresolved).toHaveLength(1000)
  expect(body.unresolvedTotal).toBe(1005)
  expect(body.truncated).toBe(true)
})
it('room scans stop at the next repository after a disconnect', async () => {
  const controller = new AbortController(), calls: string[] = []
  const result = await scanRooms(new Map([['a', { at: 1 }], ['b', { at: 2 }]]), async repo => {
    calls.push(repo); controller.abort(); return true
  }, controller.signal, 100)
  expect(calls).toEqual(['a'])
  expect(result).toEqual([])
})
it('room scans are bounded by the registry limit', async () => {
  const calls: string[] = []
  await scanRooms(new Map([['a', {}], ['b', {}]]), async repo => { calls.push(repo); return true }, new AbortController().signal, 1)
  expect(calls).toEqual(['a'])
})

it('limits concurrent room scans per identity and globally before delayed permission checks', async () => {
  const { githubPushChecker } = await import('../src/admit.js')
  const slots = new WorkSlots(2, 1, new OutboundBudget(1000, 1000))
  let active = 0, peak = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const upstream = new Map<string, number>()
  const checker = githubPushChecker({ fetch: (async (_url, init) => {
    const token = (init?.headers as Record<string, string>).authorization
    upstream.set(token, (upstream.get(token) ?? 0) + 1)
    active++; peak = Math.max(peak, active)
    await gate; active--
    return new globalThis.Response(JSON.stringify({ permissions: { push: false } }))
  }) as typeof fetch })
  const start = (identity: string) => {
    const r = new Response(), lease = ResponseWork.reserve(slots, identity, r.asHttp(), 1000)
    if (!lease) return undefined
    return scanRooms(new Map([['o/r', {}]]), repo => checker(identity, repo).then(Boolean), new AbortController().signal, 100)
      .then(out => { lease.send(200, JSON.stringify(out)); r.emit('finish') })
  }
  const a = start('a'), b = start('b')
  expect(start('a')).toBeUndefined()
  expect(start('c')).toBeUndefined()
  // A concurrent admission check shares the listing's upstream request.
  const admitted = checker('a', 'o/r')
  expect(upstream.get('Bearer a')).toBe(1)
  expect(peak).toBe(2)
  release()
  await Promise.all([a, b, admitted])
  expect(slots.count).toBe(0)
  const c = start('c')
  expect(c).toBeDefined()
  await c
  expect(slots.count).toBe(0)
})

it('keeps a disconnected scan in the work budget until its pending permission check settles', () => {
  const slots = new WorkSlots(1, 1, new OutboundBudget(100, 100)), r = new Response()
  const lease = ResponseWork.reserve(slots, 'a', r.asHttp(), 1000)!
  const complete = lease.hold()
  r.destroy()
  expect(slots.count).toBe(1)
  expect(ResponseWork.reserve(slots, 'b', new Response().asHttp(), 1000)).toBeUndefined()
  complete()
  expect(slots.count).toBe(0)
})
