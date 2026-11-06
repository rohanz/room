/** Durable gate I/O and synchronous identity probes run only on this thread in production. */
import { parentPort } from 'node:worker_threads'
import { FileStorageGate } from './gate.js'
import { StorageRefused } from './protocol.js'
import type { GateRequest, GateResponse } from './gate-thread.js'

if (!parentPort) throw new Error('storage gate worker requires a parent port')
parentPort.on('message', async ({ id, commonDir, options, method, args }: GateRequest) => {
  let response: GateResponse
  try {
    // Gate objects are cheap and stateless for these methods. Avoid retaining every clone ever
    // visited by a long-lived MCP. The observation cache belongs to the main-thread reader.
    // The first Windows write independently verifies the room/ ACL in this thread; never import
    // the main thread's privacy trust cache. The shared privacy module retains this proof for
    // later writes here, at the cost of one extra cold verification off the MCP event loop.
    const gate = new FileStorageGate(commonDir, options)
    const invoke = gate[method] as (...args: unknown[]) => Promise<unknown>
    response = { id, value: await invoke.apply(gate, args) }
  } catch (error) {
    response = { id, error: error instanceof StorageRefused
      ? { reason: error.reason, detail: error.detail, remedy: error.remedy }
      : { detail: String((error as Error).message ?? error).slice(0, 512), code: (error as NodeJS.ErrnoException).code } }
  }
  parentPort!.postMessage(response)
})
