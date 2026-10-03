import type { Session } from './session.js'

/** Completion must follow a replacement session, never write into its refused predecessor. */
export function waitForCompletionReconnect(current: () => Session | null, signal?: AbortSignal, timeoutMs = 30_000): Promise<'ready' | 'closed' | 'timeout' | 'cancelled'> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = Date.now() + timeoutMs
    const finish = (result: 'ready' | 'closed' | 'timeout' | 'cancelled') => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(result)
    }
    const abort = () => finish('cancelled')
    const check = () => {
      if (signal?.aborted) return finish('cancelled')
      const s = current()
      if (s?.closed || s?.rejected || (!s?.stale && ['taken', 'superseded', 'ended'].includes(s?.lease?.state ?? ''))) return finish('closed')
      if (s && !s.stale && s.provider.synced && !s.lease?.paused()) return finish('ready')
      if (Date.now() >= deadline) return finish('timeout')
      timer = setTimeout(check, Math.min(100, deadline - Date.now()))
    }
    signal?.addEventListener('abort', abort, { once: true })
    check()
  })
}
