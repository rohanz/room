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
