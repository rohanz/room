/** One viewport-level tooltip, shared by HTML and SVG triggers. */
let root: HTMLDivElement | undefined
let anchor: Element | undefined
let previousDescription: string | null = null

function positionTooltip() {
  if (!anchor || !root) return
  if (!anchor.isConnected) { hideTooltip(); return }
  const box = anchor.getBoundingClientRect()
  const width = root.offsetWidth, height = root.offsetHeight
  const margin = 8, horizontalMargin = 16
  const left = Math.max(horizontalMargin, Math.min(box.left, window.innerWidth - width - horizontalMargin))
  let top = box.bottom + margin
  if (top + height > window.innerHeight - margin) top = box.top - height - margin
  root.style.left = `${left}px`
  root.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`
}

export function hideTooltip() {
  if (anchor) {
    if (previousDescription === null) anchor.removeAttribute('aria-describedby')
    else anchor.setAttribute('aria-describedby', previousDescription)
    anchor.removeEventListener('pointerleave', hideTooltip)
    anchor.removeEventListener('blur', hideTooltip)
  }
  anchor = undefined
  if (root) { root.hidden = true; root.replaceChildren() }
}

export function showTooltip(anchorEl: Element, content: Node | string) {
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
  anchor = anchorEl
  previousDescription = anchor.getAttribute('aria-describedby')
  anchor.setAttribute('aria-describedby', [previousDescription, root.id].filter(Boolean).join(' '))
  anchor.addEventListener('pointerleave', hideTooltip)
  anchor.addEventListener('blur', hideTooltip)
  root.replaceChildren(content)
  root.hidden = false
  positionTooltip()
}

export function bindTooltip(element: Element, content: Node | string | (() => Node | string)) {
  element.setAttribute('tabindex', '0')
  if (typeof content === 'string') element.setAttribute('data-tooltip', content)
  const show = () => showTooltip(element, typeof content === 'function' ? content() : content)
  element.addEventListener('pointerenter', show)
  element.addEventListener('focus', show)
}
