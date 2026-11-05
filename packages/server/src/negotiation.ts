import type { EventEmitter } from 'node:events'
import * as decoding from 'lib0/decoding'
import {
  BOOTSTRAP_MAX_BYTES, BOOTSTRAP_HELLO_TIMEOUT_MS, BOOTSTRAP_ACK_TIMEOUT_MS,
  MSG_HUB, CURRENT_COMPAT, decodeFrame, encodeFrame, parseBootstrapHello, parseBootstrapAck,
  type BootstrapHello, type BootstrapSelection, type BootstrapRefusal, type ContractSelection,
} from '@room/hub-core'

interface NegotiationSocket extends Pick<EventEmitter, 'on' | 'once' | 'off'> {
  readonly readyState: number
  send(data: Uint8Array): void
  close(code: number, reason: string): void
}
const contracts = new WeakMap<object, ContractSelection>()
/**
 * ws exposes no public per-connection payload-limit setter. Its pinned v8 Receiver checks
 * _maxPayload at the frame header (including fragmented messages), before collecting payloads.
 * Keep this dependency in one guarded adapter: fail closed if ws changes that receiver shape.
 * Restoring its original limit preserves the existing Yjs transport after the ACK.
 */
export function boundNegotiationInput(socket: object): { remaining(bytes: number): void; restore(): void } {
  const receiver = (socket as { _receiver?: { _maxPayload?: number } })._receiver
  const maximum = receiver?._maxPayload
  if (!receiver || typeof maximum !== 'number' || !Number.isFinite(maximum) || maximum < 0) throw new Error('unsupported websocket receiver payload limit')
  return {
    remaining: bytes => { receiver._maxPayload = Math.max(1, Math.min(maximum || Infinity, bytes)) },
    restore: () => { receiver._maxPayload = maximum },
  }
}
/** Transport state only; never write negotiated contracts into the shared document. */
export const connectionContract = (socket: object): ContractSelection | undefined => contracts.get(socket)
export function recordConnectionContract(socket: object, selection: ContractSelection): void {
  if (contracts.has(socket)) throw new Error('connection contract is immutable')
  contracts.set(socket, Object.freeze({ ...selection, capabilities: Object.freeze({ ...selection.capabilities }) }))
}

/** Both directions stay disconnected from Yjs until the ACK has passed authority revalidation. */
export function beginNegotiation(socket: NegotiationSocket, options: {
  startedAt: number
  select(hello: BootstrapHello): Promise<BootstrapSelection | BootstrapRefusal>
  /** Revalidate under the repository lock, then call activate immediately before attaching Yjs. */
  attach(reply: BootstrapSelection, hello: BootstrapHello, activate: () => boolean): Promise<void>
  release(): void
  limitInput?(remainingBytes: number): void
}): void {
  let phase: 'hello' | 'selecting' | 'ack' | 'attaching' | 'attached' | 'closed' = 'hello'
  let bytes = 0, released = false, reply: BootstrapSelection, hello: BootstrapHello, requestId = 'bootstrap'
  let timer: ReturnType<typeof setTimeout>, expiresAt: number
  const release = () => { if (!released) { released = true; options.release() } }
  const cleanup = () => { clearTimeout(timer); socket.off('message', receive); release() }
  const close = () => { phase = 'closed'; cleanup() }
  const fail = (reason: string, alreadySent = false) => {
    if (phase === 'closed') return
    if (!alreadySent && socket.readyState === 1) {
      const side = reason.startsWith('server:') ? 'server' : reason.startsWith('room:') ? 'room' : 'client'
      try { socket.send(encodeFrame({ v: 1, re: requestId, ok: false, error: { code: 'invalid-advertisement', side, text: reason,
        requiredChanges: [{ side, action: 'update', contract: 'advertisement' }], missingCapabilities: {}, supported: { client: null, server: CURRENT_COMPAT } } })) }
      catch { /* close still releases the pending reservation */ }
    }
    close()
    socket.close(4406, reason.slice(0, 120))
  }
  const deadline = (at: number) => {
    expiresAt = at
    clearTimeout(timer)
    timer = setTimeout(() => fail('client: negotiation timed out; restart the client and rejoin'), Math.max(0, at - Date.now()))
    timer.unref?.()
  }
  const receive = (data: unknown, isBinary?: boolean) => {
    if (phase === 'closed' || phase === 'attached') return
    if (Date.now() >= expiresAt) return fail('client: negotiation timed out; restart the client and rejoin')
    // ws normally emits Buffer. Do not concatenate unbounded chunks or accept text JSON.
    if (isBinary === false || !(data instanceof Uint8Array)) return fail('client: expected a binary bootstrap frame; update the client')
    bytes += data.byteLength
    if (bytes > BOOTSTRAP_MAX_BYTES) return fail('client: bootstrap input exceeds 8 KiB; update the client')
    options.limitInput?.(BOOTSTRAP_MAX_BYTES - bytes)
    try {
      const decoder = decoding.createDecoder(data)
      if (decoding.readVarUint(decoder) !== MSG_HUB) return fail('client: document sync before negotiation; update the client')
      const frame = decodeFrame(decoder)
      if (decoding.hasContent(decoder)) return fail('client: trailing bootstrap data; update the client')
      if (phase === 'hello') {
        hello = parseBootstrapHello(frame)
        requestId = hello.id
        phase = 'selecting'
        void options.select(hello).then(selected => {
          if (phase !== 'selecting' || socket.readyState !== 1) return
          if (Date.now() >= expiresAt) return fail('client: negotiation timed out; restart the client and rejoin')
          const encoded = encodeFrame(selected)
          if (encoded.byteLength > BOOTSTRAP_MAX_BYTES) return fail('server: selection exceeds 8 KiB; update the server')
          socket.send(encoded)
          if (!selected.ok) return fail(`${selected.error.side}: ${selected.error.text}`, true)
          reply = selected
          phase = 'ack'
          deadline(Math.min(options.startedAt + BOOTSTRAP_HELLO_TIMEOUT_MS + BOOTSTRAP_ACK_TIMEOUT_MS, Date.now() + BOOTSTRAP_ACK_TIMEOUT_MS))
        }).catch(() => fail('server: negotiation unavailable; restart the connection'))
      } else if (phase === 'ack') {
        const ack = parseBootstrapAck(frame)
        if (ack.selectionId !== reply.selectionId) return fail('client: ACK names a different selection; rejoin')
        phase = 'attaching'
        void options.attach(reply, hello, () => {
          if (phase !== 'attaching' || socket.readyState !== 1) return false
          if (Date.now() >= expiresAt) { fail('client: negotiation timed out; restart the client and rejoin'); return false }
          socket.send(encodeFrame({ v: 1, re: ack.id, ok: true }))
          recordConnectionContract(socket, reply.selection)
          phase = 'attached'
          cleanup()
          return true
        }).then(() => {
          if (phase !== 'attaching') return
          fail('room: authority changed before sync; rejoin')
        }).catch(() => fail('server: negotiation unavailable; restart the connection'))
      } else fail('client: duplicate or early bootstrap input; rejoin')
    } catch { fail('client: invalid bootstrap or early document frame; update the client') }
  }
  socket.on('message', receive)
  socket.once('close', close)
  options.limitInput?.(BOOTSTRAP_MAX_BYTES)
  deadline(options.startedAt + BOOTSTRAP_HELLO_TIMEOUT_MS)
}
