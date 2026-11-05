import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { AnyObjectSchema, SchemaOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { InitializeRequestSchema } from '@modelcontextprotocol/sdk/types.js'

type SdkHandler = Parameters<Server['setRequestHandler']>[1]

// SDK 1.30.0's complete protocol set, pinned rather than inherited on SDK upgrades:
// docs/archive/reports/host-survey-2026-11-05-codex.md shows Codex 0.166.0 pools
// stdio servers negotiating 2026-07-28 without supplying per-chat identity.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']

/** Keep the SDK's initialize state and response, restricting only version negotiation. */
export class RoomMcpServer extends Server {
  // SDK 1.30 has no supported-version option. Its constructor registers initialize
  // through this public method, so wrap that handler without accessing SDK internals.
  override setRequestHandler<T extends AnyObjectSchema>(schema: T,
    handler: (request: SchemaOutput<T>, extra: Parameters<SdkHandler>[1]) => ReturnType<SdkHandler>): void {
    if ((schema as AnyObjectSchema) !== InitializeRequestSchema) return super.setRequestHandler(schema, handler)
    super.setRequestHandler(schema, async (request, extra) => {
      const result = await handler(request, extra)
      const requested = InitializeRequestSchema.parse(request).params.protocolVersion
      return { ...result, protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0] }
    })
  }
}
