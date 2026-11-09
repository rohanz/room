import { CollectionReview } from '../collection-review.js'
import { createSessionBinding } from '../binding.js'
import { registryForDir } from '../worker-registry.js'
import { currentToolTiming } from '../timing.js'
import { RW, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [{
  name: 'room_review', annotations: RW,
  description: 'Hold collection for a requested review, release it, or list holds; never collects.',
  inputSchema: { ...{ additionalProperties: false }, type: 'object', properties: {
    action: { type: 'string', enum: ['hold', 'release', 'status'] },
    reason: { type: 'string' }, reviewToken: { type: 'string' },
  }, required: ['action'] },
}]

export function handlers(state: HandlerState): Record<string, Handler> {
  return { room_review: async a => {
    const session = state.S()
    const unknown = Object.keys(a).find(key => !['action', 'reason', 'reviewToken'].includes(key))
    if (unknown) return 'error: unknown argument ' + unknown
    if (typeof a.action !== 'string' || !['hold', 'release', 'status'].includes(a.action)) return 'error: action must be hold, release or status'
    if (a.reason !== undefined && (a.action !== 'hold' || typeof a.reason !== 'string')) return 'error: reason is only for hold'
    if (a.reviewToken !== undefined && (a.action !== 'release' || typeof a.reviewToken !== 'string' || !/^[a-f0-9]{64}$/.test(a.reviewToken))) return 'error: reviewToken is only for release and must be the private recovery token'
    if (a.action === 'hold' && (typeof a.reason !== 'string' || !a.reason.trim() || a.reason.length > 1000)) return 'error: hold requires a reason of 1–1000 characters'
    const registry = await registryForDir(session.dir)
    const endLease = currentToolTiming()?.begin('lease')
    try { return await registry.withCollectLease(session.dir, async () => {
      endLease?.()
      const review = new CollectionReview(registry.root, session.dir)
      if (a.action === 'status') return review.status()
      // Bound host IDs survive MCP restarts; the recovery token also serves unbound controllers.
      const owner = (state.ctx.binding ?? createSessionBinding(session.dir)).id()
      return a.action === 'hold' ? review.hold(owner, session.me.name, (a.reason as string).trim())
        : review.release(owner, a.reviewToken as string | undefined)
    }) }
    catch (error) { return `error: ${error instanceof Error ? error.message : String(error)}` }
    finally { endLease?.() }
  } }
}
