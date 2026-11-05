import { EventEmitter } from 'node:events'
import { Receiver } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_COMPAT, decodeFrame, encodeFrame, type BootstrapHello, type BootstrapSelection } from '@room/hub-core'
import { beginNegotiation, boundNegotiationInput, connectionContract } from '../src/negotiation.js'

class Socket extends EventEmitter {
  readyState = 1
  sent: Uint8Array[] = []
  closed: [number, string][] = []
  send(data: Uint8Array) { this.sent.push(data) }
  close(code: number, reason: string) { this.closed.push([code, reason]); this.readyState = 3; this.emit('close') }
}
const hello: BootstrapHello = { v: 1, id: 'hello', op: 'compat-hello', sessionId: 's', offer: CURRENT_COMPAT }
const selection = (): BootstrapSelection => ({ v: 1, re: 'hello', ok: true, selectionId: 'selection', compat: CURRENT_COMPAT,
  selection: { bootstrap: 1, hub: 1, schema: 2, capabilities: {} }, generation: '0', policyRevision: 1, incarnation: 1,
  ttlMs: 45000, renewMs: 15000, requiredCapabilities: {} })
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
function fixture(options: Partial<Parameters<typeof beginNegotiation>[1]> = {}) {
  const socket = new Socket(), attach = vi.fn(async (_r, _h, activate: () => boolean) => { activate() }), release = vi.fn()
  beginNegotiation(socket, { startedAt: Date.now(), select: async () => selection(), attach, release, ...options })
  return { socket, attach, release }
}
afterEach(() => vi.useRealTimers())

describe('hosted negotiation synchronization gate', () => {
  it('rejects an oversized fragmented message from its header before buffering its payload', async () => {
    const receiver = new Receiver({ isServer: false, maxPayload: 16 * 1024 * 1024 })
    const input = boundNegotiationInput({ _receiver: receiver })
    input.remaining(8192)
    const error = new Promise<Error & { code?: string }>(resolve => receiver.once('error', resolve))
    // FIN=false, binary, length8193: only the header arrives, with no payload to allocate/concatenate.
    receiver.write(Buffer.from([0x02, 126, 0x20, 0x01]))
    expect((await error).code).toBe('WS_ERR_UNSUPPORTED_MESSAGE_LENGTH')
  })
  it('restores the existing document frame ceiling only after bootstrap activation', async () => {
    const receiver = new Receiver({ isServer: false, maxPayload: 16 * 1024 * 1024 })
    const input = boundNegotiationInput({ _receiver: receiver })
    input.remaining(8192); input.restore()
    const message = new Promise<Buffer>(resolve => receiver.once('message', resolve))
    receiver.write(Buffer.concat([Buffer.from([0x82, 126, 0x20, 0x01]), Buffer.alloc(8193)]))
    expect((await message).byteLength).toBe(8193)
    receiver.destroy()
    expect(() => boundNegotiationInput({})).toThrow('receiver')
  })
  it('advertises and freezes a per-connection contract before attaching document handlers', async () => {
    const { socket, attach, release } = fixture()
    expect(socket.sent).toEqual([])
    socket.emit('message', encodeFrame(hello)); await tick()
    expect(socket.sent.map(decodeFrame)).toEqual([selection()])
    expect(attach).not.toHaveBeenCalled()
    socket.emit('message', encodeFrame({ v: 1, id: 'ack', op: 'compat-ack', selectionId: 'selection' })); await tick()
    expect(attach).toHaveBeenCalledOnce()
    expect(decodeFrame(socket.sent[1])).toEqual({ v: 1, re: 'ack', ok: true })
    expect(connectionContract(socket)).toEqual(selection().selection)
    expect(Object.isFrozen(connectionContract(socket))).toBe(true)
    expect(release).toHaveBeenCalledOnce()
    socket.close(1000, '')
    expect(release).toHaveBeenCalledOnce()
  })
  it.each(['hello', 'ack'])('rejects early Yjs input while waiting for %s', async stage => {
    const { socket, attach, release } = fixture()
    if (stage === 'ack') { socket.emit('message', encodeFrame(hello)); await tick() }
    socket.emit('message', Uint8Array.of(0, 0, 1, 0)); await tick()
    expect(socket.closed[0][0]).toBe(4406)
    expect(attach).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })
  it('rejects a duplicate hello while authority selection is pending', async () => {
    let resolve!: (s: BootstrapSelection) => void
    const { socket, attach } = fixture({ select: () => new Promise(r => { resolve = r }) })
    socket.emit('message', encodeFrame(hello)); socket.emit('message', encodeFrame(hello))
    resolve(selection()); await tick()
    expect(socket.closed[0][0]).toBe(4406)
    expect(socket.sent).toHaveLength(1)
    expect(decodeFrame(socket.sent[0])).toMatchObject({ ok: false, error: { side: 'client' } })
    expect(attach).not.toHaveBeenCalled()
  })
  it('rejects an ACK for another selection and never records it', async () => {
    const { socket, attach } = fixture()
    socket.emit('message', encodeFrame(hello)); await tick()
    socket.emit('message', encodeFrame({ v: 1, id: 'a', op: 'compat-ack', selectionId: 'other' })); await tick()
    expect(socket.closed[0][0]).toBe(4406)
    expect(connectionContract(socket)).toBeUndefined()
    expect(attach).not.toHaveBeenCalled()
  })
  it('does not attach or retain a selection after authority revalidation fails', async () => {
    const { socket } = fixture({ attach: async () => {} })
    socket.emit('message', encodeFrame(hello)); await tick()
    socket.emit('message', encodeFrame({ v: 1, id: 'a', op: 'compat-ack', selectionId: 'selection' })); await tick()
    expect(connectionContract(socket)).toBeUndefined()
  })
  it('bounds total bootstrap bytes before parsing', () => {
    const { socket, release } = fixture()
    socket.emit('message', new Uint8Array(8193))
    expect(socket.closed[0][0]).toBe(4406)
    expect(release).toHaveBeenCalledOnce()
  })
  it('rejects text framing and trailing bytes instead of parsing a prefix', () => {
    const text = fixture(), trailing = fixture()
    text.socket.emit('message', encodeFrame(hello), false)
    trailing.socket.emit('message', Uint8Array.from([...encodeFrame(hello), 0]))
    for (const { socket, attach } of [text, trailing]) {
      expect(socket.closed[0][0]).toBe(4406)
      expect(attach).not.toHaveBeenCalled()
    }
  })
  it('cancels an in-flight selection on disconnect', async () => {
    let resolve!: (s: BootstrapSelection) => void
    const { socket, release } = fixture({ select: () => new Promise(r => { resolve = r }) })
    socket.emit('message', encodeFrame(hello)); socket.close(1000, '')
    resolve(selection()); await tick()
    expect(socket.sent).toHaveLength(0)
    expect(release).toHaveBeenCalledOnce()
  })
  it('cannot activate a delayed ACK after disconnect or deadline, even before a timer callback runs', async () => {
    vi.useFakeTimers()
    let activate!: () => boolean
    const { socket, release } = fixture({ attach: async (_r, _h, complete) => { activate = complete; await new Promise(() => {}) } })
    socket.emit('message', encodeFrame(hello)); await tick()
    socket.emit('message', encodeFrame({ v: 1, id: 'a', op: 'compat-ack', selectionId: 'selection' })); await tick()
    vi.setSystemTime(Date.now() + 5001)
    expect(activate()).toBe(false)
    expect(connectionContract(socket)).toBeUndefined()
    expect(release).toHaveBeenCalledOnce()
  })
  it('counts admission time against the hello deadline', async () => {
    vi.useFakeTimers()
    const { socket, release } = fixture({ startedAt: Date.now() - 4900 })
    await vi.advanceTimersByTimeAsync(101)
    expect(socket.closed[0][0]).toBe(4406)
    expect(release).toHaveBeenCalledOnce()
  })
  it('gives the ACK a bounded deadline and cancels pending selection on disconnect', async () => {
    vi.useFakeTimers()
    const { socket, attach, release } = fixture()
    socket.emit('message', encodeFrame(hello)); await tick()
    await vi.advanceTimersByTimeAsync(5001)
    expect(socket.closed[0][0]).toBe(4406)
    expect(attach).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
