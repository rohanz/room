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
  expect(lineDetail(input).text).toContain('add discount')
  expect(lineAnnotation({})).toBe(lineDetail({}).text)
})
it('hovers a row with an ellipsized annotation in the reserved right column', () => {
  render()
  rows()[0].dispatchEvent(new dom.window.Event('pointerenter'))
  expect(host.querySelector('.line-annotation')?.textContent).toBe('rohanz · claimed: apply tier discount')
  expect(rows()[0].classList.contains('line-hovered')).toBe(true)
  rows()[0].dispatchEvent(new dom.window.Event('pointerleave'))
  expect(host.querySelector('.line-annotation')?.textContent).toBe('')
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
  expect(details()[0].textContent).toContain('a.ts:1-2')
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
