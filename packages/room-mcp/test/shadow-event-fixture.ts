import { ConflictShadow, type ShadowEvent } from '../src/conflict-shadow.js'

/** Manual fixtures supply the same synchronous boundary fact as real lifecycle hooks. */
export async function applyShadowEvent(shadow: ConflictShadow, event: ShadowEvent): Promise<void> {
  const ticket = shadow.reserve(event.kind, shadow.preparation())!
  const privateEvent = shadow as unknown as { event(e: ShadowEvent): Promise<void>; applied: number; issued: number; queue: Map<number, unknown>; remember(g: number): void; mutating: number }
  await privateEvent.event({ ...event, generation: ticket.generation })
  privateEvent.applied = ticket.order; privateEvent.queue.delete(ticket.order)
  if (event.kind !== 'spawn') privateEvent.mutating--
  privateEvent.remember(ticket.order)
}
