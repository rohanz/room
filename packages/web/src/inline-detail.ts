import { lineAnnotation, lineDetail, type LineDetailInput } from '@room/shared'

/** One controller per rendered pane; no document listeners or floating overlays. */
export function inlineDetails(onLayout: (open: number | null) => void) {
  let opened: { index: number; row: HTMLElement; region: HTMLElement; clearHover: () => void; resize?: ResizeObserver } | undefined
  const close = (restoreFocus = false) => {
    if (!opened) return
    const { row, region, clearHover, resize } = opened
    resize?.disconnect()
    region.remove()
    row.classList.remove('line-expanded')
    if (!row.matches(':hover')) clearHover()
    row.setAttribute('aria-expanded', 'false')
    opened = undefined
    onLayout(null)
    if (restoreFocus) row.focus()
  }
  return (row: HTMLElement, annotation: HTMLElement, index: number, number: number, input: LineDetailInput) => {
    row.tabIndex = 0
    row.setAttribute('aria-expanded', 'false')
    row.setAttribute('aria-label', 'Line ' + number + '. Show details')
    const targets = new Set<HTMLElement>()
    const hovered = new Set<HTMLElement>()
    let resize: ResizeObserver | undefined
    const update = () => {
      const active = hovered.size > 0
      for (const target of targets) target.classList.toggle('line-hovered', active)
      const code = row.querySelector('code')!
      if (active) {
        annotation.textContent = lineAnnotation(input)
        row.querySelector('.line-band')!.prepend(annotation)
        // Mask only code under the annotation: short text remains untouched and
        // the row itself supplies the one continuous background, including the fade.
        const mask = () => {
          if (!row.isConnected) { resize?.disconnect(); resize = undefined; return }
          const annotationLeft = annotation.getBoundingClientRect().left
          const range = document.createRange()
          range.selectNodeContents(code)
          if (typeof range.getBoundingClientRect === 'function' && range.getBoundingClientRect().right <= annotationLeft) {
            code.style.maskImage = ''
            return
          }
          const end = annotationLeft - code.getBoundingClientRect().left
          code.style.maskImage = 'linear-gradient(to right, black ' + Math.max(0, end - 24) + 'px, transparent ' + Math.max(0, end) + 'px)'
        }
        mask()
        code.onscroll = mask
        if (!resize && typeof ResizeObserver !== 'undefined') {
          resize = new ResizeObserver(mask)
          resize.observe(row)
          resize.observe(annotation)
        }
      } else {
        resize?.disconnect()
        resize = undefined
        annotation.remove()
        code.style.maskImage = ''
        code.onscroll = null
      }
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
      button.setAttribute('aria-label', 'Close')
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
      const scroller = row.closest<HTMLElement>('.code-scroll')
      let detailResize: ResizeObserver | undefined
      const sizeDetail = () => {
        if (!region.isConnected) { detailResize?.disconnect(); return }
        if (!scroller) return
        const style = window.getComputedStyle(region)
        // Subtract the sticky gutter and reserved tag column, including when
        // a vertical scrollbar reduces the pane's usable width.
        const reserved = (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0)
        region.style.width = Math.max(0, scroller.clientWidth - reserved) + 'px'
      }
      sizeDetail()
      if (scroller && typeof ResizeObserver !== 'undefined') {
        detailResize = new ResizeObserver(sizeDetail)
        detailResize.observe(scroller)
      }
      row.setAttribute('aria-expanded', 'true')
      row.classList.add('line-expanded')
      row.focus()
      opened = { index, row, region, resize: detailResize, clearHover: () => { hovered.clear(); update() } }
      onLayout(index)
      region.style.gridRow = String(index + 2)
      region.style.gridColumn = '1'
    }
    const bind = (target: HTMLElement) => {
      targets.add(target)
      target.addEventListener('pointerenter', () => { hovered.add(target); update() })
      target.addEventListener('pointerleave', () => { if (target === row) hovered.clear(); else hovered.delete(target); update() })
      target.onclick = event => { event.stopPropagation(); toggle() }
      target.onkeydown = event => {
        if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); close(true) }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle() }
      }
    }
    bind(row)
    return bind
  }
}
