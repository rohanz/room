/** Widths are applied synchronously while the grids are still detached, before first paint. */
export const layoutDefaults = { people: 224, files: 200, timeline: 304 } as const
export type LayoutKey = keyof typeof layoutDefaults
const storageKey = 'room.layout'

export function readLayout(): Partial<Record<LayoutKey, number>> {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    return Object.fromEntries(Object.keys(layoutDefaults).flatMap(key => {
      const width = value?.[key]
      return typeof width === 'number' && Number.isFinite(width) && width > 0 ? [[key, width]] : []
    }))
  } catch { return {} }
}

export interface ResizeOptions {
  /** The fixed-width pane on one side; the other side is fluid and is null. */
  left: HTMLElement | null
  right: HTMLElement | null
  min: number
  /** Available width after reserving the other columns' minimum widths. */
  max: number | (() => number)
  key: LayoutKey
}

export function attach(handle: HTMLElement, { left, right, min, max, key }: ResizeOptions): () => void {
  if (!!left === !!right) throw new Error('A resize handle needs exactly one fixed-width side')
  const pane = (left ?? right)!
  const grid = handle.parentElement!
  const direction = left ? 1 : -1
  const variable = `--${key}-width`
  const desktop = () => window.innerWidth > 900
  let width = Math.max(min, Math.min(typeof max === 'number' ? Math.max(min, max) : Infinity, readLayout()[key] ?? layoutDefaults[key]))
  const limit = () => Math.max(min, typeof max === 'function' ? max() : max)
  const paint = () => {
    grid.style.setProperty(variable, `${width}px`)
    handle.setAttribute('aria-valuenow', String(Math.round(width)))
  }
  const update = (value: number) => {
    width = Math.max(min, Math.min(limit(), value))
    paint()
    handle.setAttribute('aria-valuemax', String(Math.round(limit())))
    try { localStorage.setItem(storageKey, JSON.stringify({ ...readLayout(), [key]: width })) } catch { /* Private browsing can disable storage. */ }
  }
  handle.classList.add('resize-handle')
  handle.tabIndex = 0
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-orientation', 'vertical')
  handle.setAttribute('aria-label', `Resize ${key} column`)
  handle.setAttribute('aria-valuemin', String(min))
  paint()
  let drag: { id: number; x: number; width: number } | undefined
  const down = (event: PointerEvent) => {
    if (!desktop() || event.button !== 0 || drag) return
    event.preventDefault()
    drag = { id: event.pointerId, x: event.clientX, width: pane.getBoundingClientRect().width || width }
    handle.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent) => {
    if (desktop() && drag?.id === event.pointerId) update(drag.width + direction * (event.clientX - drag.x))
  }
  const end = (event: PointerEvent) => {
    if (drag?.id !== event.pointerId) return
    drag = undefined
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
  }
  const reset = () => { if (desktop()) update(layoutDefaults[key]) }
  const keyboard = (event: KeyboardEvent) => {
    if (!desktop() || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') reset()
    else update((pane.getBoundingClientRect().width || width) + direction * (event.key === 'ArrowRight' ? 16 : -16))
  }
  handle.addEventListener('pointerdown', down)
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
  handle.addEventListener('lostpointercapture', end)
  handle.addEventListener('dblclick', reset)
  handle.addEventListener('keydown', keyboard)
  return () => {
    if (drag && handle.hasPointerCapture(drag.id)) handle.releasePointerCapture(drag.id)
    handle.removeEventListener('pointerdown', down)
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
    handle.removeEventListener('lostpointercapture', end)
    handle.removeEventListener('dblclick', reset)
    handle.removeEventListener('keydown', keyboard)
  }
}
