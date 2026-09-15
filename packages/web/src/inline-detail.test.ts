import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { lineAnnotation, lineDetail, type Claim, type ConflictSpan } from '@room/shared'
import { renderCodeLines } from './panels.ts'
import * as tooltip from './tooltip.ts'

let dom: JSDOM
let host: HTMLElement
const claim: Claim = { id: 'c', path: 'a.ts', from: 1, to: 1, by: 'rohanz', byKind: 'agent', at: 1, intent: 'apply tier discount', plans: [{ kind: 'add', symbol: 'discount' }] }
const lines = [1, 2, 3].map(n => ({ text: 'line ' + n, side: 'common' as const, changedBy: n === 1 ? ['rohanz'] : [], conflict: false, lineNumbers: { rohanz: n } }))
beforeEach(() => {
  dom = new JSDOM('<body><main></main></body>')
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('window', dom.window)
  host = document.querySelector('main')!
})
afterEach(() => { vi.restoreAllMocks(); dom.window.close(); vi.unstubAllGlobals() })
const render = (conflicts: ConflictSpan[] = []) => renderCodeLines(host, lines, ['rohanz'], (_, n) => n === 1 ? [claim] : [], conflicts)
const rows = () => Array.from(host.querySelectorAll<HTMLElement>('.code-line'))
const details = () => host.querySelectorAll<HTMLElement>('.inline-detail')
const key = (el: HTMLElement, key: string) => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

it('derives short and long descriptions from the same claims and ownership', () => {
  const input = { owners: ['rohanz', 'rohanz'], claims: [claim, claim] }
  expect(lineAnnotation(input)).toBe('rohanz · claimed: apply tier discount')
  expect(lineDetail(input)).toMatchObject({ owners: ['rohanz'], claims: [claim], ownership: 'changed by rohanz' })
  expect(lineDetail(input).sections.flatMap(s => s.rows).join(' ')).toContain('add discount')
  expect(lineAnnotation({})).toBe(lineDetail({}).ownership)
})
it('shows a sticky annotation inside only the hovered row', () => {
  render()
  expect(host.querySelector('.line-annotation')).toBeNull()
  expect(host.querySelector<HTMLElement>('.conflict-code-grid')!.style.gridTemplateColumns).toBe('minmax(0, 1fr) 96px')
  rows()[0].dispatchEvent(new dom.window.Event('pointerenter'))
  expect(host.querySelector('.line-annotation')?.textContent).toBe('rohanz · claimed: apply tier discount')
  expect(rows()[0].classList.contains('line-hovered')).toBe(true)
  expect(host.querySelector('.line-annotation')!.parentElement).toBe(rows()[0])
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  const rule = css.match(/\.line-annotation \{([^}]+)\}/)![1]
  expect(rule).toContain('position: sticky')
  expect(rule).toContain('max-width: 50cqi')
  expect(rule).toContain('background: none')
  expect(css).toContain('.code-line { position: relative; }')
  rows()[0].dispatchEvent(new dom.window.Event('pointerleave'))
  expect(host.querySelector('.line-annotation')).toBeNull()
})
it('opens exactly one reachable detail immediately beneath the clicked row with all plans', () => {
  render(); rows()[0].click()
  expect(details()).toHaveLength(1)
  expect(rows()[0].nextElementSibling).toBe(details()[0])
  expect(details()[0].getAttribute('role')).toBe('region')
  expect(details()[0].getAttribute('aria-label')).toBe('Details for line 1')
  expect(details()[0].tabIndex).toBe(0)
  expect(details()[0].textContent).toContain('apply tier discount')
  expect(details()[0].textContent).toContain('add discount')
  expect(rows()[1].style.gridRow).toBe('3')
})
it('closes on repeat click, Escape from row or detail, and the close button', () => {
  render(); rows()[0].click(); rows()[0].click()
  expect(details()).toHaveLength(0)
  rows()[0].click(); key(rows()[0], 'Escape')
  expect(details()).toHaveLength(0)
  rows()[0].click(); details()[0].focus(); key(details()[0], 'Escape')
  expect(details()).toHaveLength(0)
  expect(document.activeElement).toBe(rows()[0])
  rows()[0].click(); host.querySelector<HTMLButtonElement>('.inline-detail-close')!.click()
  expect(details()).toHaveLength(0)
  expect(rows()[1].style.gridRow).toBe('2')
})
it('moves details to another row and supports Enter and Space activation', () => {
  render(); key(rows()[0], 'Enter'); rows()[2].click()
  expect(details()).toHaveLength(1)
  expect(rows()[2].nextElementSibling).toBe(details()[0])
  expect(details()[0].textContent).toContain('unchanged from base')
  expect(rows()[0].getAttribute('aria-expanded')).toBe('false')
  key(rows()[2], ' ')
  expect(details()).toHaveLength(0)
})
it('opens conflict-tag details with both participants, range, resolution and plans', () => {
  render([{ id: 's', path: 'a.ts', from: 1, to: 2, people: ['rohanz', 'codex'], claims: [claim], claimIds: ['c'], at: 1, events: [], hidden: false, resolvedBy: { how: 'released', who: 'codex', at: 2 } }])
  const tag = host.querySelector<HTMLButtonElement>('.conflict-tag')!
  tag.dispatchEvent(new dom.window.Event('pointerenter'))
  expect(host.querySelector('.line-annotation')?.textContent).toBe('rohanz ↔ codex · resolved')
  tag.click()
  expect(details()[0].textContent).toContain('rohanz ↔ codex')
  expect(details()[0].textContent).toContain('Merged lines 1-2')
  expect([...details()[0].querySelectorAll('.inline-detail-label')].map(el => el.textContent)).toEqual(['Line', 'Conflict', 'Claims', 'Resolution'])
  expect(details()[0].textContent).not.toContain('unavailable')
  expect(details()[0].textContent).toContain('codex released')
  expect(details()[0].textContent).toContain('add discount')
  expect(host.querySelector<HTMLElement>('.conflict-bar')!.style.gridRow).toBe('1 / 4')
  key(tag, ' ')
  expect(details()).toHaveLength(0)
  key(tag, 'Enter')
  expect(details()).toHaveLength(1)
})
it('never attaches or shows a floating tooltip from code rendering or interaction', () => {
  const bind = vi.spyOn(tooltip, 'bindTooltip'), show = vi.spyOn(tooltip, 'showTooltip')
  render(); rows()[0].focus(); rows()[0].dispatchEvent(new dom.window.Event('pointerenter')); rows()[0].click()
  expect(bind).not.toHaveBeenCalled(); expect(show).not.toHaveBeenCalled()
  expect(document.querySelector('#overlay-root')).toBeNull()
})

it('clears an open detail when the pane rerenders', () => {
  render(); rows()[0].click(); render()
  expect(details()).toHaveLength(0)
  rows()[1].click()
  expect(details()).toHaveLength(1)
  expect(rows()[1].nextElementSibling).toBe(details()[0])
})

it('keeps a focused annotation through pointer leave and removes it on blur', () => {
  render(); const row = rows()[0]
  row.focus()
  row.dispatchEvent(new dom.window.Event('pointerenter'))
  row.dispatchEvent(new dom.window.Event('pointerleave'))
  expect(row.querySelector('.line-annotation')).not.toBeNull()
  row.blur()
  expect(row.querySelector('.line-annotation')).toBeNull()
})
it('omits claims and resolution for an unclaimed unresolved text conflict', () => {
  renderCodeLines(host, [{ ...lines[0], conflict: true, conflictPair: ['rohanz', 'codex'] }], ['rohanz', 'codex'])
  rows()[0].click()
  expect([...details()[0].querySelectorAll('.inline-detail-label')].map(el => el.textContent)).toEqual(['Line', 'Conflict'])
  expect(details()[0].textContent).not.toContain('unavailable')
  expect(details()[0].textContent!.match(/rohanz ↔ codex/g)).toHaveLength(1)
})

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
const rule = (selector: string) => css.slice(css.indexOf(selector + ' {')).split('{')[1].split('}')[0]
it('paints one full-width row band with transparent annotation and marker slots', () => {
  render(); rows()[0].dispatchEvent(new dom.window.Event('pointerenter'))
  expect(rule('.conflict-code-grid > .line-text')).toContain('grid-column: 1 / -1')
  expect(rule('.conflict-code-grid .code-line.line-hovered')).toContain('background: var(--hover-row-bg)')
  expect(rule('.line-annotation')).toContain('background: none')
  expect(host.querySelector('.annotation-box')).toBeNull()
  const style = document.createElement('style')
  style.textContent = '.side-marker {' + rule('.side-marker') + '} .diff-prefix {' + rule('.conflict-code-grid .diff-prefix') + '}'
  document.head.append(style)
  for (const slot of host.querySelectorAll('.side-marker, .diff-prefix')) {
    const computed = dom.window.getComputedStyle(slot)
    expect(computed.backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(computed.borderTopWidth).toBe('')
  }
  expect(rows()[0].querySelectorAll('.side-marker .dot')).toHaveLength(1)
  expect(rows()[1].querySelectorAll('.side-marker .dot')).toHaveLength(0)
})
it.each([true, false])('aligns detail bounds to the code text area (merged=%s)', merged => {
  render(); const grid = host.querySelector('.conflict-code-grid')!
  grid.classList.toggle('merged-code', merged)
  rows()[0].click()
  const style = document.createElement('style')
  style.textContent = '.inline-detail {' + rule('.inline-detail') + '} .merged-code .inline-detail {' + rule('.merged-code .inline-detail') + '}'
  document.head.append(style)
  const computed = dom.window.getComputedStyle(details()[0])
  // JSDOM does not lay out grids: resolve the actual CSS tracks and computed
  // margins against several pane widths, including the narrow split-pane case.
  const tracks = rule(merged ? '.conflict-code-grid.merged-code .code-line' : '.conflict-code-grid .code-line').match(/grid-template-columns: (\d+)px (\d+)px (\d+)px/)!
  const codeTextLeft = 2 + Number(tracks[1]) + Number(tracks[2]) + Number(tracks[3]) + 9
  const detailLeft = parseFloat(computed.marginLeft)
  expect(detailLeft).toBe(codeTextLeft)
  for (const paneWidth of [320, 800, 1400]) {
    const detailWidth = paneWidth - detailLeft - parseFloat(computed.marginRight)
    expect(detailWidth).toBe(paneWidth - 96 - codeTextLeft)
  }
  expect(rule('.inline-detail-close')).toContain('width: 22px')
  expect(rule('.inline-detail-close')).toContain('height: 22px')
  expect(rule('.inline-detail-close')).toContain('border-radius: 50%')
  expect(rule('.inline-detail-close:hover')).toContain('border-color: var(--accent)')
})
it('fades code only in the 24px before the annotation, without painting a box', () => {
  render(); const row = rows()[0], code = row.querySelector('code')!
  vi.spyOn(code, 'getBoundingClientRect').mockReturnValue({ left: 69 } as DOMRect)
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 500 } as DOMRect)
  row.dispatchEvent(new dom.window.Event('pointerenter'))
  expect(code.style.maskImage).toBe('linear-gradient(to right, black 407px, transparent 431px)')
  row.dispatchEvent(new dom.window.Event('pointerleave'))
  expect(code.style.maskImage).toBe('')
})

it('leaves short code unfaded when its text ends before the annotation', () => {
  render()
  vi.spyOn(document, 'createRange').mockReturnValue({ selectNodeContents() {}, getBoundingClientRect: () => ({ right: 200 }) } as unknown as Range)
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 500 } as DOMRect)
  rows()[0].dispatchEvent(new dom.window.Event('pointerenter'))
  expect(rows()[0].querySelector('code')!.style.maskImage).toBe('')
})

it.each([true, false])('uses one pane scroller with pinned edges and detail (merged=%s)', merged => {
  renderCodeLines(host, lines.map(line => ({ ...line, text: 'long_code '.repeat(100) })), ['rohanz'], undefined, [], merged)
  expect(host.querySelectorAll('.code-scroll')).toHaveLength(1)
  expect(rule('.code-scroll')).toContain('overflow-x: auto')
  expect(rule('.code-scroll')).toContain('container-type: inline-size')
  for (const selector of ['.conflict-code-grid', '.conflict-code-grid > .line-text', '.conflict-code-grid .code-line', '.conflict-code-grid .code-line code']) {
    expect(rule(selector)).toContain('overflow: visible')
    const declarations = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selectors]) => selectors.split(',').some(s => s.trim() === selector))
    for (const [, , declarationsText] of declarations) {
      expect(declarationsText).not.toMatch(/overflow(?:-x)?:\s*(auto|scroll)/)
    }
  }
  expect(rule('.conflict-code-grid')).toContain('width: max-content')
  expect(rule('.conflict-code-grid')).toContain('min-width: 100%')
  expect(rule('.conflict-code-grid .code-line')).toContain('white-space: pre')
  expect(rule('.line-gutter')).toContain('position: sticky')
  expect(rule('.line-gutter')).toContain('left: 0')
  expect(rule('.conflict-edge')).toContain('position: sticky')
  expect(rule('.conflict-edge')).toContain('right: 0')
  expect(rule('.conflict-code-grid .code-line::after')).toContain('background: inherit')
  expect(rule('.conflict-code-grid .code-line::after')).toContain('right: 0')
  for (const row of rows()) {
    expect(row.querySelector('.line-gutter .line-number')).not.toBeNull()
    expect(row.querySelector('.line-gutter .diff-prefix')).not.toBeNull()
    if (merged) expect(row.querySelector('.line-gutter .side-marker')).not.toBeNull()
  }
  rows()[0].click()
  expect(rule('.inline-detail')).toContain('position: sticky')
  expect(rule(merged ? '.merged-code .inline-detail' : '.inline-detail'))
    .toContain(merged ? 'width: calc(100cqi - 165px)' : 'width: calc(100cqi - 185px)')
})

it('refreshes the hover fade when the pane scrolls', () => {
  render()
  const code = rows()[0].querySelector('code')!
  const mask = vi.fn()
  code.onscroll = mask
  host.querySelector('.code-scroll')!.dispatchEvent(new dom.window.Event('scroll'))
  expect(mask).toHaveBeenCalledOnce()
})
