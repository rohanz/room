/// <reference types="node" />
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { h } from './panels.ts'
import { bindTooltip, hideTooltip, showTooltip } from './tooltip.ts'

let dom: JSDOM
let trigger: HTMLButtonElement
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON() {} })
beforeEach(() => {
  dom = new JSDOM('<body><div style="overflow:hidden"><button>Inspect</button></div></body>')
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document)
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true })
  trigger = document.querySelector('button')!
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(100, 100, 40, 30))
  vi.spyOn(dom.window.HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200)
  vi.spyOn(dom.window.HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100)
})
afterEach(() => { hideTooltip(); vi.restoreAllMocks(); dom.window.close(); vi.unstubAllGlobals() })
const overlay = () => document.querySelector<HTMLDivElement>('#overlay-root')!
it('portals outside clipping ancestors, positions below-left, and reuses one root', () => {
  showTooltip(trigger, 'First')
  expect(overlay().parentElement).toBe(document.body)
  expect(overlay().style.left).toBe('100px'); expect(overlay().style.top).toBe('138px')
  showTooltip(trigger, 'Second')
  expect(document.querySelectorAll('#overlay-root')).toHaveLength(1)
  expect(overlay().textContent).toBe('Second')
})
it('clamps horizontally, flips above, and follows nested scroll and resize', () => {
  vi.mocked(trigger.getBoundingClientRect).mockReturnValue(rect(984, 740, 40, 20))
  showTooltip(trigger, 'Edge')
  expect(overlay().style.left).toBe('808px'); expect(overlay().style.top).toBe('632px')
  vi.mocked(trigger.getBoundingClientRect).mockReturnValue(rect(200, 200, 40, 20))
  trigger.parentElement!.dispatchEvent(new dom.window.Event('scroll'))
  expect(overlay().style.left).toBe('200px'); expect(overlay().style.top).toBe('228px')
  vi.mocked(trigger.getBoundingClientRect).mockReturnValue(rect(-30, -30, 10, 10))
  window.dispatchEvent(new dom.window.Event('resize'))
  expect(overlay().style.left).toBe('16px'); expect(overlay().style.top).toBe('8px')
})
it('keeps a card anchored 40px from the right edge inside the viewport', () => {
  vi.mocked(trigger.getBoundingClientRect).mockReturnValue(rect(window.innerWidth - 40, 100, 40, 20))
  showTooltip(trigger, 'Conflict details')
  expect(Number.parseFloat(overlay().style.left) + overlay().offsetWidth).toBe(window.innerWidth - 16)
})
it('keeps a card anchored at the left edge at least 16px inside', () => {
  vi.mocked(trigger.getBoundingClientRect).mockReturnValue(rect(0, 100, 40, 20))
  showTooltip(trigger, 'Details')
  expect(Number.parseFloat(overlay().style.left)).toBeGreaterThanOrEqual(16)
})
it('constrains long messages to wrapping and places their measured taller card', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  const rule = css.match(/#overlay-root \{([^}]+)\}/)![1]
  expect(rule).toContain('max-width: min(420px, calc(100vw - 32px))')
  expect(rule).toContain('white-space: normal')
  expect(rule).toContain('overflow-wrap: anywhere')
  expect(rule).toContain('font: 12px/1.4')
  showTooltip(trigger, 'Short')
  const shortHeight = overlay().offsetHeight
  // JSDOM does not lay out text: supply the browser's wrapped size and check placement.
  vi.spyOn(dom.window.HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(420)
  vi.spyOn(dom.window.HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(180)
  vi.mocked(trigger.getBoundingClientRect).mockReturnValue(rect(984, 650, 40, 20))
  const message = 'A long conflict message with an unbroken path ' + 'very-long-path/'.repeat(30)
  showTooltip(trigger, message)
  expect(overlay().textContent).toBe(message)
  expect(overlay().offsetWidth).toBeLessThanOrEqual(420)
  expect(overlay().offsetHeight).toBeGreaterThan(shortHeight)
  expect(overlay().style.left).toBe('588px')
  expect(overlay().style.top).toBe('462px')
})
it('shows on keyboard focus and Escape closes and restores an existing description', () => {
  trigger.setAttribute('aria-describedby', 'existing')
  bindTooltip(trigger, 'Details'); trigger.focus()
  expect(overlay().hidden).toBe(false)
  expect(trigger.getAttribute('aria-describedby')).toBe('existing overlay-root')
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
  expect(overlay().hidden).toBe(true)
  expect(trigger.getAttribute('aria-describedby')).toBe('existing')
})
it.each(['pointerleave', 'blur'])('closes on %s', event => {
  showTooltip(trigger, 'Details'); trigger.dispatchEvent(new dom.window.Event(event))
  expect(overlay().hidden).toBe(true)
})
it('closes on window blur and detached triggers', () => {
  showTooltip(trigger, 'Details'); window.dispatchEvent(new dom.window.Event('blur'))
  expect(overlay().hidden).toBe(true)
  showTooltip(trigger, 'Details'); trigger.remove(); window.dispatchEvent(new dom.window.Event('resize'))
  expect(overlay().hidden).toBe(true)
})
it('converts native title props to focusable shared tooltips', () => {
  const label = h('span', { title: 'Full path' }, 'short')
  document.body.append(label)
  expect(label.hasAttribute('title')).toBe(false)
  expect(label.tabIndex).toBe(0)
  label.focus()
  expect(overlay().textContent).toBe('Full path')
})
it('keeps a 40px border-box mark and all theme geometry identical', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  const mark = [...css.matchAll(/^\.product-mark \{([^}]+)\}/gm)].map(m => m[1]).join(' ')
  const style = document.createElement('style')
  style.textContent = `* { box-sizing: border-box } .product-mark { ${mark} }`
  document.head.append(style)
  const el = document.createElement('div'); el.className = 'product-mark'; document.body.append(el)
  const boxes = ['light', 'dark', 'system'].map(theme => {
    document.documentElement.setAttribute('data-theme', theme)
    const computed = window.getComputedStyle(el)
    return [computed.width, computed.height, computed.padding, computed.boxSizing]
  })
  expect(boxes).toEqual(Array(3).fill(['40px', '40px', '3px', 'border-box']))
  for (const match of css.matchAll(/:root\[data-theme="(?:dark|system)"\]\s*\{([^{}]*)\}/g)) {
    expect(match[1]).not.toMatch(/(?:^|[;\s])(?:width|height|padding|margin|border-width)\s*:/)
    expect(match[1]).not.toMatch(/[{}]/)
  }
})
it('limits transitions to six containers, excludes code and canvas, and has only three stacking layers', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  expect(css).not.toMatch(/transition\s*:\s*all\b/)
  expect(css).toContain('transition: background-color 160ms ease, color 160ms ease')
  expect(css).toContain('.code-line, .code-line *, .cm-line, .cm-line *, .network-canvas, .network-canvas * { transition: none !important; }')
  expect(css.match(/z-index:/g)).toHaveLength(3)
  expect(css).toContain('prefers-reduced-motion: reduce')
})
