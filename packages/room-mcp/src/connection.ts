import type { Session } from './session.js'

export const OFFLINE_GRACE_MS = 2000
interface Connection { connectedOnce: boolean; disconnectedAt?: number; update: () => void }
const connections = new WeakMap<Session, Connection>()

/** Observe each provider independently, including transitions between tool calls. */
export function trackConnection(session: Session, now: () => number = Date.now): void {
  if (connections.has(session)) return
  const state: Connection = { connectedOnce: false, update: () => {} }
  state.update = () => {
    const connected = !session.closed && session.provider.wsconnected === true && session.provider.synced
    if (connected) { state.connectedOnce = true; delete state.disconnectedAt }
    else if (state.connectedOnce && state.disconnectedAt === undefined) state.disconnectedAt = now()
  }
  connections.set(session, state)
  session.provider.on?.('status', state.update)
  session.provider.on?.('sync', state.update)
  session.provider.on?.('connection-close', state.update)
  state.update()
}

/** Only a sustained loss after a successful connection is an offline room. */
export function offlineSince(session: Session, now: () => number = Date.now): number | undefined {
  trackConnection(session, now)
  const state = connections.get(session)!
  state.update()
  return state.disconnectedAt !== undefined && now() - state.disconnectedAt > OFFLINE_GRACE_MS
    ? state.disconnectedAt : undefined
}

export function connectedBefore(session: Session): boolean {
  return connections.get(session)?.connectedOnce ?? false
}
