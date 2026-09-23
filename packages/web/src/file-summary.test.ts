import { afterEach, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { RoomDoc } from '@room/shared'
import type { Conn } from './conn.ts'
import { createFocusState, participantsPanel } from './panels.ts'
import { renderScheduler } from './scheduler.ts'
import { readFileSync } from 'node:fs'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllGlobals() })
function panel(paths: string[]) {
  const dom = new JSDOM('<body></body>')
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const room = new RoomDoc()
  for (const path of paths) room.setOverlay('Ada', path, 'changed')
  const states = new Map([[1, { user: { name: 'Ada', kind: 'agent' } }]])
  const conn = { room, provider: { awareness: { getStates: () => states, on: vi.fn() } } } as unknown as Conn
  const rail = participantsPanel(conn, createFocusState())
  document.body.append(rail)
  cleanups.push(() => { room.doc.destroy(); dom.window.close() })
  return { rail, room, dom }
}

it('shows a compact 48-file People summary and expands folder groups', () => {
  const paths = [...Array.from({ length: 44 }, (_, i) => `art/main-street/scene-${i}.md`), 'TOWN.md', 'README.md', 'TODO.md', 'src/app.ts']
  const { rail, room } = panel(paths)
  expect(rail.querySelector('.files-head')?.textContent).toBe('48 changed · mostly art/main-street/ (44)')
  expect([...rail.querySelectorAll('.files-named > .files-name')].map(node => node.textContent)).toEqual(['README.md', 'TODO.md', 'TOWN.md'])
  const toggle = rail.querySelector<HTMLButtonElement>('.files-toggle')!
  expect(toggle.textContent).toBe('Show all 48')
  expect(rail.querySelector('.files-groups')).toBeNull()
  toggle.click()
  expect(rail.querySelector('.files-toggle')?.textContent).toBe('Show less')
  const group = [...rail.querySelectorAll('.files-group')].find(node => node.querySelector('summary')?.textContent === 'art/main-street/ (44)')!
  expect(group).toBeTruthy()
  expect(group.querySelectorAll('.files-name')).toHaveLength(44)
  room.setOverlay('Ada', 'src/new.ts', 'changed')
  renderScheduler.flushNow()
  expect(rail.querySelector('.files-toggle')?.textContent).toBe('Show less')
  expect(rail.querySelector('.files-groups')).toBeTruthy()
})

it('lists up to five files directly and keeps full paths in tooltips without breaking names', () => {
  const long = 'art/main-street/deep/SHOP_JOINERY_REVIEW.md'
  const { rail } = panel([long, 'src/SHOP_JOINERY_REVIEW.md'])
  expect(rail.querySelector('.files-head')).toBeNull()
  expect(rail.querySelector('.files-toggle')).toBeNull()
  const entry = [...rail.querySelectorAll<HTMLElement>('.files-name')].find(node => node.title === long)!
  expect(entry.textContent).toContain('SHOP_JOINERY_REVIEW.md')
  expect(entry.textContent).toContain('…')
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  expect(css).toMatch(/\.files-name\s*\{[^}]*white-space: nowrap;/)
})

it('keeps none for zero files', () => {
  const { rail } = panel([])
  expect(rail.querySelector('.files-summary')?.textContent).toContain('none')
})
