import { afterEach, expect, it, vi } from 'vitest'
import { createBootstrapClient } from '../src/bootstrap-client.js'
import { CURRENT_COMPAT, selectContract, encodeFrame, decodeFrame, type CompatAdvertisement, type BootstrapSelection } from '../src/protocol.js'

afterEach(() => vi.useRealTimers())
function fixture(offer: CompatAdvertisement = CURRENT_COMPAT) {
  const sent: Uint8Array[] = [], opened = vi.fn(), refused = vi.fn()
  const client = createBootstrapClient({ offer, sessionId: 'session', activeSchema: 2, send: data => sent.push(data), onOpen: opened, onRefusal: refused })
  const result = selectContract(offer, CURRENT_COMPAT, { activeSchema: 2, readOnly: !offer.schemas.write.length })
  if (!result.ok) throw new Error(result.error.text)
  const selection: BootstrapSelection = { v: 1, re: 'compat-hello', ok: true, selectionId: 'selected', selection: result.selection,
    compat: CURRENT_COMPAT, generation: '0', policyRevision: 1, incarnation: 1, ttlMs: 45000, renewMs: 15000, requiredCapabilities: {} }
  const receive = (value: unknown) => client.receive(encodeFrame(value as never))
  client.start()
  return { client, sent, opened, refused, selection, receive }
}
it('shares hello, validated selection, ACK and open ordering for writer and reader offers', () => {
  for (const write of [[2], []]) {
    const f = fixture({ ...CURRENT_COMPAT, schemas: { read: [2], write } })
    expect(decodeFrame(f.sent[0])).toMatchObject({ op: 'compat-hello', sessionId: 'session' })
    f.receive(f.selection)
    expect(f.client.ready).toBe(false)
    expect(f.opened).not.toHaveBeenCalled()
    expect(decodeFrame(f.sent[1])).toEqual({ v: 1, op: 'compat-ack', id: 'compat-ack', selectionId: 'selected' })
    f.receive({ v: 1, re: 'compat-ack', ok: true })
    expect(f.client.ready).toBe(true)
    expect(f.opened).toHaveBeenCalledExactlyOnceWith(f.selection)
    f.client.close()
  }
})
it('accepts retained-process advertisements without tolerating other selection fields', () => {
  const f = fixture({ ...CURRENT_COMPAT, legacy: { schema: 2, hub: 1 } } as CompatAdvertisement)
  f.receive({ ...f.selection, compat: { ...CURRENT_COMPAT, legacy: { schema: 2, hub: 1 } } })
  expect(f.refused).not.toHaveBeenCalled()
  f.receive({ v: 1, re: 'compat-ack', ok: true, advisory: 'not allowed' })
  expect(f.refused).toHaveBeenCalledOnce()
  expect(f.opened).not.toHaveBeenCalled()
})
it.each(['schema', 'capability', 'requirements', 'selection-fields'])('refuses a dishonest %s before exposing open', kind => {
  const f = fixture()
  const frame = structuredClone(f.selection)
  if (kind === 'schema') frame.selection.schema = 3
  if (kind === 'capability') frame.selection.capabilities['other.unoffered'] = 1
  if (kind === 'requirements') frame.requiredCapabilities = { 'other.required': [1] }
  if (kind === 'selection-fields') Object.assign(frame, { future: true })
  f.receive(frame)
  expect(f.refused).toHaveBeenCalledOnce()
  expect(f.opened).not.toHaveBeenCalled()
  expect(f.client.ready).toBe(false)
})
it.each([false, true])('keeps both bootstrap deadlines and releases timers on shutdown (ACK=%s)', ack => {
  vi.useFakeTimers()
  const f = fixture()
  if (ack) f.receive(f.selection)
  vi.advanceTimersByTime(5000)
  expect(f.refused).toHaveBeenCalledExactlyOnceWith(ack ? 'Room server did not acknowledge contract selection within 5 seconds' : 'Room server did not select a contract within 5 seconds')
  f.receive({ v: 1, re: 'compat-ack', ok: true })
  expect(f.opened).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  const other = fixture(); other.client.close()
  expect(vi.getTimerCount()).toBe(0)
})
it('rejects binary document data and oversized bootstrap messages before open', () => {
  for (const bytes of [new Uint8Array([0, 0]), new Uint8Array(8193)]) {
    const f = fixture()
    f.client.receive(bytes)
    expect(f.refused).toHaveBeenCalledOnce()
    expect(f.opened).not.toHaveBeenCalled()
  }
})
