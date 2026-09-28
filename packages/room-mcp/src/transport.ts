/**
 * The stdio transport whose `send` resolves only once the host's pipe has accepted the bytes (ledger MF1).
 * The SDK's StdioServerTransport resolves when `write()` returns true, before a flush, and never
 * rejects; a receipt tied to it could describe a reply the host never got.
 */
import process from 'node:process'
import type { Readable, Writable } from 'node:stream'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js'
import type { Settle } from './tools/index.js'

export class FlushedStdioTransport extends StdioServerTransport {
  private readonly pending = new Map<RequestId, Settle>()

  constructor(stdin: Readable = process.stdin, private readonly out: Writable = process.stdout) {
    super(stdin, out)
  }

  /** The reply to request `id` carries a ledger batch: commit it once written, release it if the write fails. */
  expect(id: RequestId, settle: Settle): void { this.pending.set(id, settle) }

  /** The request was cancelled, so no reply will be written. */
  forget(id: RequestId): void {
    this.pending.get(id)?.release()
    this.pending.delete(id)
  }

  override send(message: JSONRPCMessage): Promise<void> {
    const id = 'id' in message && ('result' in message || 'error' in message) ? message.id : undefined
    const settle = id === undefined ? undefined : this.pending.get(id)
    if (id !== undefined) this.pending.delete(id)
    return new Promise((resolve, reject) => {
      try {
        this.out.write(serializeMessage(message), error => {
          if (error) { settle?.release(); reject(error) }
          else { settle?.commit(); resolve() }
        })
      } catch (error) { settle?.release(); reject(error) }
    })
  }
}
