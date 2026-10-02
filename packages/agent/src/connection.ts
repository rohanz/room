import { STALE_REPLICA_CODE, STALE_REPLICA_REASON } from '@room/shared'

export interface SyncProvider {
  synced: boolean
  on(event: 'sync', listener: (synced: boolean) => void): unknown
  off(event: 'sync', listener: (synced: boolean) => void): unknown
}

export type RoomConnectionCredentials = Partial<Record<'token' | 'session' | 'key', string>>

/** Preserve credentials carried by a room URL, with explicit values taking precedence. */
export function roomConnectionParams(roomUrl: string | URL, explicit: RoomConnectionCredentials = {}): Record<string, string> {
  const url = typeof roomUrl === 'string' ? new URL(roomUrl) : roomUrl
  const value = (name: keyof RoomConnectionCredentials) => explicit[name]?.trim() || url.searchParams.get(name)?.trim() || undefined
  return Object.fromEntries((['token', 'session', 'key'] as const).flatMap(name => {
    const found = value(name)
    return found ? [[name, found]] : []
  }))
}

/** Wait for the first successful Yjs sync, then remove the listener on success or timeout. */
export async function waitForRoomSync(provider: SyncProvider, timeoutMs = 15_000, destination = 'the room'): Promise<void> {
  if (provider.synced) return
  const deadlineMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const done = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      provider.off('sync', onSync)
      error ? reject(error) : resolve()
    }
    const onSync = (synced: boolean) => { if (synced) done() }
    provider.on('sync', onSync)
    if (provider.synced) done()
    if (!settled) timer = setTimeout(() => done(new Error(`could not sync with ${destination} within ${deadlineMs}ms`)), deadlineMs)
  })
}

/** A close no reconnect can fix: the room's compacted copy needs a fresh replica (4409, a restart takes one), or
 *  access ended (4401, 4403). The process exits with the reason; any other close reconnects. */
export function finalClose(event: { code?: number; reason?: string } | null): { exitCode: number; line: string } | undefined {
  if (event?.code === STALE_REPLICA_CODE) return { exitCode: 75, line: `${event.reason || STALE_REPLICA_REASON}; restart roomagent to rejoin with a fresh copy` }
  if (event?.code === 4401 || event?.code === 4403) return { exitCode: 1, line: `${event.reason || 'access ended'}; not reconnecting` }
  return undefined
}
