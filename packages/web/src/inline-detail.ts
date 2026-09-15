import { lineAnnotation, lineDetail, type LineDetailInput } from '@room/shared'

/** One controller per rendered pane; no document listeners or floating overlays. */
export function inlineDetails(onLayout: (open: number | null) => void) {
  let opened: { index: number; row: HTMLElement; region: HTMLElement } | undefined
  const close = (restoreFocus = false) => {
    if (!opened) return
    const { row, region } = opened
    region.remove()
    row.setAttribute('aria-expanded', 'false')
    opened = undefined
    onLayout(null)
    if (restoreFocus) row.focus()
  }
  return (row: HTMLElement, annotation: HTMLElement, index: number, number: number, input: LineDetailInput) => {
    row.tabIndex = 0
    row.setAttribute('aria-expanded', 'false')
    row.setAttribute('aria-label', 'Line ' + number + '. Show details')
    const hovered = new Set<HTMLElement>()
    const focused = new Set<HTMLElement>()
    const update = () => {
      const active = hovered.size > 0 || focused.size > 0
      row.classList.toggle('line-hovered', active)
      if (active) { annotation.textContent = lineAnnotation(input); row.append(annotation) }
      else annotation.remove()
    }
    const toggle = () => {
      if (opened?.index === index) { close(); return }
      close()
      const region = document.createElement('div')
      region.className = 'inline-detail'
      region.tabIndex = 0
      region.setAttribute('role', 'region')
      region.setAttribute('aria-label', 'Details for line ' + number)
      const button = document.createElement('button')
      button.className = 'inline-detail-close'
      button.textContent = '×'
      button.setAttribute('aria-label', 'Close line details')
      button.onclick = () => close(true)
      const content = document.createElement('div')
      for (const section of lineDetail(input).sections) {
        const block = document.createElement('section')
        const label = document.createElement('div')
        label.className = 'inline-detail-label'
        label.textContent = section.label
        block.append(label)
        for (const text of section.rows) {
          const item = document.createElement('div')
          item.textContent = text
          block.append(item)
        }
        content.append(block)
      }
      region.append(button, content)
      region.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); close(true) } }
      row.insertAdjacentElement('afterend', region)
      row.setAttribute('aria-expanded', 'true')
      row.focus()
      opened = { index, row, region }
      onLayout(index)
      region.style.gridRow = String(index + 2)
      region.style.gridColumn = '1'
    }
    const bind = (target: HTMLElement) => {
      target.addEventListener('pointerenter', () => { hovered.add(target); update() })
      target.addEventListener('pointerleave', () => { hovered.delete(target); update() })
      target.onfocus = () => { focused.add(target); update() }
      target.onblur = () => { focused.delete(target); update() }
      target.onclick = toggle
      target.onkeydown = event => {
        if (event.key === 'Escape') { event.preventDefault(); close(true) }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle() }
      }
    }
    bind(row)
    return bind
  }
}
