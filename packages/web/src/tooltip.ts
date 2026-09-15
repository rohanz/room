/** One viewport-level tooltip, shared by HTML and SVG triggers. */
let root: HTMLDivElement | undefined
let anchor: Element | undefined
let pointer: { x: number; y: number } | undefined
let positionFrame: number | undefined
let previousDescription: string | null = null

function positionTooltip() {
  if (!anchor || !root) return
  if (!anchor.isConnected) { hideTooltip(); return }
  const box = anchor.getBoundingClientRect()
  const width = root.offsetWidth, height = root.offsetHeight
  const margin = pointer ? 16 : 8, horizontalMargin = 16
  const gap = pointer ? 12 : 8
  const left = Math.max(horizontalMargin, Math.min(pointer ? pointer.x + gap : box.left, window.innerWidth - width - horizontalMargin))
  let top = (pointer ? pointer.y : box.bottom) + gap
  if (top + height > window.innerHeight - margin) top = (pointer ? pointer.y : box.top) - height - gap
  root.style.left = `${left}px`
  root.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`
}

function moveTooltip(event: Event) {
  if (!pointer) return
  const { clientX, clientY } = event as MouseEvent
  pointer = { x: clientX, y: clientY }
  if (positionFrame !== undefined) return
  positionFrame = window.requestAnimationFrame(() => {
    positionFrame = undefined
    positionTooltip()
  })
}

export function hideTooltip() {
  if (positionFrame !== undefined) window.cancelAnimationFrame(positionFrame)
  positionFrame = undefined
  pointer = undefined
  if (anchor) {
    if (previousDescription === null) anchor.removeAttribute('aria-describedby')
    else anchor.setAttribute('aria-describedby', previousDescription)
    anchor.removeEventListener('pointerleave', hideTooltip)
    anchor.removeEventListener('blur', hideTooltip)
    anchor.removeEventListener('pointermove', moveTooltip)
  }
  anchor = undefined
  if (root) { root.hidden = true; root.replaceChildren() }
}

export function showTooltip(anchorEl: Element, content: Node | string, event?: MouseEvent) {
  hideTooltip()
  if (!root || root.ownerDocument !== document) {
    root = document.createElement('div')
    root.id = 'overlay-root'
    root.setAttribute('role', 'tooltip')
    document.body.append(root)
    // One shared handler per viewport event, never one per trigger.
    window.addEventListener('scroll', positionTooltip, true)
    window.addEventListener('resize', positionTooltip)
    window.addEventListener('blur', hideTooltip)
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip() })
  }
  pointer = event ? { x: event.clientX, y: event.clientY } : undefined
  anchor = anchorEl
  previousDescription = anchor.getAttribute('aria-describedby')
  anchor.setAttribute('aria-describedby', [previousDescription, root.id].filter(Boolean).join(' '))
  anchor.addEventListener('pointerleave', hideTooltip)
  anchor.addEventListener('blur', hideTooltip)
  if (pointer) anchor.addEventListener('pointermove', moveTooltip)
  root.replaceChildren(content)
  root.hidden = false
  positionTooltip()
}

export function bindTooltip(element: Element, content: Node | string | (() => Node | string)) {
  element.setAttribute('tabindex', '0')
  if (typeof content === 'string') element.setAttribute('data-tooltip', content)
  const show = (event: Event) => showTooltip(element, typeof content === 'function' ? content() : content,
    event.type === 'pointerenter' ? event as MouseEvent : undefined)
  element.addEventListener('pointerenter', show)
  element.addEventListener('focus', show)
}
