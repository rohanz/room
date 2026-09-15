import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attach, readLayout } from './resizable.ts'

class Element extends EventTarget {
  values = new Map<string, string>()
  attrs = new Map<string, string>()
  style = { setProperty: (key: string, value: string) => this.values.set(key, value) }
  classes = new Set<string>()
  classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) }
  tabIndex = -1
  parentElement: Element | null = null
  captured = new Set<number>()
  setAttribute(key: string, value: string) { this.attrs.set(key, value) }
  getBoundingClientRect() { return { width: 0 } }
  setPointerCapture = vi.fn((id: number) => this.captured.add(id))
  hasPointerCapture(id: number) { return this.captured.has(id) }
  releasePointerCapture = vi.fn((id: number) => this.captured.delete(id))
}
function event(target: Element, type: string, props = {}) {
  target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), props))
}
let stored: Map<string, string>
beforeEach(() => {
  stored = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) })
  vi.stubGlobal('window', { innerWidth: 1440 })
})
afterEach(() => vi.unstubAllGlobals())
function setup(key: 'people' | 'files' | 'timeline' = 'people') {
  const grid = new Element(), pane = new Element(), handle = new Element()
  handle.parentElement = grid
  const el = pane as unknown as HTMLElement
  const cleanup = attach(handle as unknown as HTMLElement, { left: key === 'timeline' ? null : el, right: key === 'timeline' ? el : null, min: key === 'timeline' ? 260 : key === 'files' ? 200 : 180, max: 400, key })
  return { grid, handle, cleanup, width: () => grid.values.get(`--${key}-width`) }
}
it('captures pointer drag and clamps the CSS width at both limits', () => {
  const { handle, width } = setup()
  event(handle, 'pointerdown', { pointerId: 1, button: 0, clientX: 100 })
  expect(handle.setPointerCapture).toHaveBeenCalledWith(1)
  expect(handle.classes.has('resize-dragging')).toBe(true)
  event(handle, 'pointermove', { pointerId: 2, clientX: 200 })
  expect(width()).toBe('224px')
  event(handle, 'pointermove', { pointerId: 1, clientX: 200 })
  expect(width()).toBe('324px')
  event(handle, 'pointermove', { pointerId: 1, clientX: 1000 })
  expect(width()).toBe('400px')
  event(handle, 'pointermove', { pointerId: 1, clientX: -1000 })
  expect(width()).toBe('180px')
  event(handle, 'pointerup', { pointerId: 1 })
  expect(handle.releasePointerCapture).toHaveBeenCalledWith(1)
  expect(handle.classes.has('resize-dragging')).toBe(false)
  event(handle, 'pointermove', { pointerId: 1, clientX: 200 })
  expect(width()).toBe('180px')
})
it('double-click and Home restore defaults; arrows move the divider 16px', () => {
  const { handle, width } = setup()
  expect(handle.tabIndex).toBe(0)
  expect(handle.attrs.get('role')).toBe('separator')
  event(handle, 'keydown', { key: 'ArrowRight' })
  expect(width()).toBe('240px')
  event(handle, 'keydown', { key: 'ArrowLeft' })
  expect(width()).toBe('224px')
  event(handle, 'keydown', { key: 'ArrowRight' })
  event(handle, 'dblclick')
  expect(width()).toBe('224px')
  event(handle, 'keydown', { key: 'ArrowRight' })
  event(handle, 'keydown', { key: 'Home' })
  expect(width()).toBe('224px')
})
it('resizes a right-hand pane in the opposite direction', () => {
  const { handle, width } = setup('timeline')
  event(handle, 'keydown', { key: 'ArrowLeft' })
  expect(width()).toBe('320px')
  event(handle, 'pointerdown', { pointerId: 1, button: 0, clientX: 100 })
  event(handle, 'pointermove', { pointerId: 1, clientX: 120 })
  expect(width()).toBe('300px')
})
it('round-trips all widths without overwriting other columns, before mounting', () => {
  for (const key of ['people', 'files', 'timeline'] as const) event(setup(key).handle, 'keydown', { key: 'ArrowLeft' })
  expect(readLayout()).toEqual({ people: 208, files: 200, timeline: 320 })
  expect(setup().width()).toBe('208px')
  expect(setup('timeline').width()).toBe('320px')
})
it('ignores interactions on mobile and cleans up cancelled drags and listeners', () => {
  const { handle, width, cleanup } = setup()
  event(handle, 'pointerdown', { pointerId: 1, button: 0, clientX: 0 })
  event(handle, 'pointercancel', { pointerId: 1 })
  event(handle, 'pointermove', { pointerId: 1, clientX: 100 })
  expect(width()).toBe('224px')
  window.innerWidth = 800
  event(handle, 'keydown', { key: 'ArrowRight' })
  event(handle, 'pointerdown', { pointerId: 1, button: 0, clientX: 0 })
  event(handle, 'pointermove', { pointerId: 1, clientX: 100 })
  expect(width()).toBe('224px')
  window.innerWidth = 1440
  cleanup()
  event(handle, 'keydown', { key: 'ArrowRight' })
  expect(width()).toBe('224px')
})
it('ignores malformed storage and tolerates unavailable storage', () => {
  stored.set('room.layout', '{broken')
  expect(setup().width()).toBe('224px')
  stored.set('room.layout', '{"people":"300","files":-1,"timeline":300}')
  expect(readLayout()).toEqual({ timeline: 300 })
  vi.stubGlobal('localStorage', { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } })
  const { handle, width } = setup()
  event(handle, 'keydown', { key: 'ArrowRight' })
  expect(width()).toBe('240px')
})

it('clamps restored sizes to configured bounds', () => {
  stored.set('room.layout', '{"people":9999,"timeline":1}')
  expect(setup().width()).toBe('400px')
  expect(setup('timeline').width()).toBe('260px')
})

import { readFileSync } from 'node:fs'
it('uses a centered short grip in the 6px hit area, with hover, focus and drag states', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  const handle = css.match(/^\.resize-handle \{([^}]+)\}/m)![1]
  const grip = css.match(/^\.resize-handle::after \{([^}]+)\}/m)![1]
  const active = css.match(/^\.resize-handle:hover::after, \.resize-handle:focus::after, \.resize-handle.resize-dragging::after \{([^}]+)\}/m)![1]
  expect(handle).toContain('width: 6px')
  for (const property of ['top: 50%', 'left: 50%', 'translate(-50%, -50%)', 'width: 3px', 'height: 28px', 'border-radius: 999px', 'background: var(--muted)', 'opacity: .6']) expect(grip).toContain(property)
  expect(grip).not.toContain('bottom:')
  expect(active).toContain('height: 40px')
  expect(active).toContain('background: var(--accent)')
  expect(active).toContain('opacity: 1')
  expect(setup().handle.classes.has('resize-handle')).toBe(true)
  expect(setup().handle.classes.has('resize-dragging')).toBe(false)
})
it.each(['pointercancel', 'lostpointercapture'])('clears active grip after %s, ignoring other pointers', type => {
  const { handle, cleanup } = setup()
  event(handle, 'pointerdown', { pointerId: 1, button: 0, clientX: 0 })
  event(handle, type, { pointerId: 2 })
  expect(handle.classes.has('resize-dragging')).toBe(true)
  event(handle, type, { pointerId: 1 })
  expect(handle.classes.has('resize-dragging')).toBe(false)
  event(handle, 'pointerdown', { pointerId: 3, button: 0, clientX: 0 })
  cleanup()
  expect(handle.classes.has('resize-dragging')).toBe(false)
})
