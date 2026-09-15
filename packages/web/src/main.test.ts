import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./conn.ts', () => ({ connect: () => ({ room: { doc: { on: vi.fn() } }, onStatus: vi.fn() }) }))
vi.mock('./panels.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./panels.ts')>()
  const panel = (className: string) => actual.h('div', { class: className })
  return {
    ...actual,
    centrePanel: () => actual.h('main', { class: 'center' }, panel('center-files'), panel('viewer')),
    participantsPanel: () => panel('participants'), timelinePanel: () => panel('timeline'),
    header: () => panel('header'),
  }
})
vi.mock('./network.ts', () => ({ networkPanel: () => document.createElement('section') }))
vi.mock('./board.ts', () => ({ boardPanel: () => document.createElement('section') }))
vi.mock('./theme.ts', () => ({ applyTheme: vi.fn(), readTheme: () => 'light', nextTheme: () => 'dark' }))

let dom: JSDOM
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); dom?.window.close() })

it('gives all three grips the same centre across layout and tab heights, including a Network round trip', async () => {
  dom = new JSDOM('<div id="app"></div>', { url: 'https://room.test/?view=code' })
  for (const key of ['document', 'window', 'localStorage', 'history', 'location'] as const) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  await import('./main.ts')
  expect(document.querySelector('.fatal')).toBeNull()
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  const rule = (selector: string) => css.slice(css.indexOf(selector + ' {')).split('{')[1].split('}')[0]
  expect(css).toContain('grid-template-rows: auto minmax(0, 1fr)')
  expect(rule('.center > .workspace-tabs')).toContain('grid-row: 1')
  expect(rule('.center > .center-files')).toContain('grid-row: 2')
  expect(rule('.center > .viewer')).toContain('grid-row: 2')
  expect(rule('.center > .files-handle')).toContain('grid-row: 1 / -1')
  expect(rule('.resize-handle::after')).toContain('top: 50%')
  const files = document.querySelector<HTMLElement>('.center')!
  const tabs = document.querySelector<HTMLElement>('.workspace-tabs')!
  const handles = [...document.querySelectorAll<HTMLElement>('.resize-handle')]
  expect(handles).toHaveLength(3)
  const check = () => {
    expect(tabs.parentElement).toBe(files)
    expect(files.querySelector('.files-handle')?.parentElement).toBe(files)
    // jsdom has no grid layout: model the tracks from the production placement rules.
    for (const height of [400, 800]) for (const tabHeight of [40, 64]) {
      for (const handle of handles) vi.spyOn(handle, 'getBoundingClientRect').mockImplementation(() => {
        const fullHeight = handle.parentElement !== files ||
          (tabs.parentElement === files && rule('.center > .files-handle').includes('grid-row: 1 / -1'))
        return { y: 80 + (fullHeight ? 0 : tabHeight), height: height - (fullHeight ? 0 : tabHeight) } as DOMRect
      })
      const centres = handles.map(handle => { const r = handle.getBoundingClientRect(); return r.y + r.height / 2 })
      expect(centres).toEqual([80 + height / 2, 80 + height / 2, 80 + height / 2])
    }
  }
  check()
  const [filesButton, networkButton] = tabs.querySelectorAll('button')
  networkButton.focus()
  networkButton.click()
  expect(document.activeElement).toBe(networkButton)
  expect(files.hidden).toBe(true)
  expect(tabs.parentElement?.className).toBe('workspace')
  filesButton.focus()
  filesButton.click()
  expect(document.activeElement).toBe(filesButton)
  expect(files.hidden).toBe(false)
  check()
  const handle = files.querySelector<HTMLElement>('.files-handle')!
  vi.spyOn(files, 'getBoundingClientRect').mockReturnValue({ width: 1000 } as DOMRect)
  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight' }))
  expect(files.style.getPropertyValue('--files-width')).toBe('216px')
})
