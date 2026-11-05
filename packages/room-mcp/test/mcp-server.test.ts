import { expect, it } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { SUPPORTED_PROTOCOL_VERSIONS, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { RoomMcpServer } from '../src/mcp-server.js'

it('pins the SDK 1.30 protocol set even if a newer SDK accepts the pooling protocol', async () => {
  const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
  const original = [...SUPPORTED_PROTOCOL_VERSIONS]
  SUPPORTED_PROTOCOL_VERSIONS.push('2026-07-28')
  const server = new RoomMcpServer({ name: 'room-test', version: '1' }, { capabilities: { tools: {} }, instructions: 'instructions' })
  const [client, transport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(transport)
    await client.start()
    for (const [index, requested] of [...versions, '2026-07-28', 'unknown'].entries()) {
      const reply = new Promise<JSONRPCMessage>(resolve => { client.onmessage = resolve })
      await client.send({ jsonrpc: '2.0', id: index, method: 'initialize', params: {
        protocolVersion: requested, capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'codex-test', version: '0.166.0' },
      } })
      expect(await reply).toMatchObject({ result: {
        protocolVersion: versions.includes(requested) ? requested : versions[0],
        capabilities: { tools: {} }, serverInfo: { name: 'room-test', version: '1' }, instructions: 'instructions',
      } })
      expect(server.getClientVersion()).toEqual({ name: 'codex-test', version: '0.166.0' })
      expect(server.getClientCapabilities()).toEqual({ roots: { listChanged: true } })
    }
  } finally {
    SUPPORTED_PROTOCOL_VERSIONS.splice(0, SUPPORTED_PROTOCOL_VERSIONS.length, ...original)
    await server.close()
    await client.close()
  }
})
