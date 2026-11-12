import { decodeFrame, encodeFrame } from './protocol.js'
import {
  BOOTSTRAP_MAX_BYTES, BOOTSTRAP_HELLO_TIMEOUT_MS, BOOTSTRAP_ACK_TIMEOUT_MS,
  parseBootstrapFrame, validateSelection,
  type CompatAdvertisement, type BootstrapSelection,
} from './negotiation.js'

/** Transport-neutral bootstrap. The caller authenticates/encrypts before start, and forwards Yjs only when ready. */
export function createBootstrapClient(options: {
  offer: CompatAdvertisement
  sessionId: string
  activeSchema?: number
  send(data: Uint8Array): void
  onOpen(selection: BootstrapSelection): void
  onRefusal(text: string): void
}) {
  let phase: 'idle' | 'selection' | 'ack' | 'open' | 'closed' = 'idle'
  let selected: BootstrapSelection | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const close = () => { phase = 'closed'; clearTimeout(timer) }
  const refuse = (reason: string): false => {
    if (phase === 'closed') return false
    close()
    options.onRefusal(reason)
    return false
  }
  const deadline = (ms: number, reason: string) => {
    clearTimeout(timer)
    timer = setTimeout(() => refuse(reason), ms)
    timer.unref?.()
  }
  return {
    get ready(): boolean { return phase === 'open' },
    close,
    refuse,
    start(): boolean {
      if (phase !== 'idle') return refuse('Unexpected Room bootstrap start')
      phase = 'selection'
      deadline(BOOTSTRAP_HELLO_TIMEOUT_MS, 'Room server did not select a contract within 5 seconds')
      options.send(encodeFrame({ v: 1, op: 'compat-hello', id: 'compat-hello', sessionId: options.sessionId, offer: options.offer }))
      return true
    },
    receive(raw: Uint8Array): boolean {
      if (phase === 'closed') return false
      try {
        if (raw.byteLength > BOOTSTRAP_MAX_BYTES) throw new Error('Room server bootstrap response exceeded 8 KiB')
        const frame = parseBootstrapFrame(decodeFrame(raw))
        if ((phase !== 'selection' && phase !== 'ack') || !('re' in frame) || frame.re !== (phase === 'selection' ? 'compat-hello' : 'compat-ack')) throw new Error('Unexpected Room bootstrap response')
        if (!frame.ok) return refuse(frame.error.text)
        if (phase === 'selection') {
          if (!('selection' in frame)) throw new Error('Room server did not select a contract')
          validateSelection(frame.selection, options.offer, frame.compat, {
            activeSchema: options.activeSchema, readOnly: options.offer.schemas.write.length === 0, requiredCapabilities: frame.requiredCapabilities,
          })
          selected = frame
          phase = 'ack'
          deadline(BOOTSTRAP_ACK_TIMEOUT_MS, 'Room server did not acknowledge contract selection within 5 seconds')
          options.send(encodeFrame({ v: 1, op: 'compat-ack', id: 'compat-ack', selectionId: frame.selectionId }))
          return true
        }
        if ('selection' in frame) throw new Error('Unexpected Room selection after ACK')
        clearTimeout(timer)
        phase = 'open'
        options.onOpen(selected!)
        return true
      } catch (error) { return refuse(error instanceof Error ? error.message : 'Invalid Room server contract selection') }
    },
  }
}
