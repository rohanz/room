import type { Conn } from './conn.ts'

/** One batch per frame, with bounded progress when the page is in the background. */
export function createRenderScheduler() {
  const pending = new Map<unknown, () => void>()
  const reported = new Set<unknown>()
  let frame: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let page: Document | undefined
  let disposed = false
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (timer !== undefined) clearTimeout(timer)
    frame = undefined; timer = undefined
  }
  const flushNow = () => {
    cancel()
    const batch = [...pending]
    pending.clear()
    for (const [key, fn] of batch) {
      if (disposed) break
      try { fn() } catch (error) {
        if (!reported.has(key)) { reported.add(key); console.error('Room render failed', key, error) }
      }
    }
  }
  const arm = () => {
    if (disposed || !pending.size || frame !== undefined || timer !== undefined) return
    if (page?.hidden) timer = setTimeout(flushNow, 1000)
    else frame = requestAnimationFrame(flushNow)
  }
  const visibility = () => {
    cancel()
    if (page?.hidden) arm()
    else flushNow()
  }
  return {
    schedule(key: unknown, fn: () => void) {
      if (disposed) return
      // Lazy binding also lets DOM-free imports use the page singleton.
      if (page !== document) {
        page?.removeEventListener('visibilitychange', visibility)
        page = document
        page.addEventListener('visibilitychange', visibility)
      }
      pending.set(key, fn)
      arm()
    },
    flushNow,
    dispose() {
      disposed = true
      cancel(); pending.clear(); reported.clear()
      page?.removeEventListener('visibilitychange', visibility)
    },
  }
}

/** Shared by every panel on the page; direct interactions continue to call render. */
export const renderScheduler = createRenderScheduler()

/** A document update covers all Yjs maps, including nested overlay text changes. */
export function subscribeRender(conn: Conn, render: () => void, awareness = true): void {
  let alive = true
  const schedule = () => renderScheduler.schedule(render, () => { if (alive) render() })
  conn.room.doc.on('update', schedule)
  if (awareness) conn.provider.awareness.on('change', schedule)
  conn.room.doc.on('destroy', () => {
    alive = false
    conn.room.doc.off('update', schedule)
    if (awareness) conn.provider.awareness.off?.('change', schedule)
  })
}
