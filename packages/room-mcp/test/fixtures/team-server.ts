import { CURRENT_COMPAT } from '@room/hub-core'

/** A compatible team server's discovery response, using the production advertisement. */
export function teamHealth(): Response {
  return Response.json({ ok: true, schema: 2, hub: 1, compat: CURRENT_COMPAT })
}
