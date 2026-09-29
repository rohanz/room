import { renderScheduler } from './scheduler.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { RoomDoc } from '@room/shared'
import { centrePanel, createFocusState } from './panels.ts'
import type { Conn } from './conn.ts'
import { publish } from './test-manifest.ts'

afterEach(() => vi.unstubAllGlobals())
function setup(room: RoomDoc) {
  const dom = new JSDOM('<body></body>')
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('window', dom.window)
  const focus = createFocusState()
  const conn = { room, provider: { awareness: { getStates: () => new Map(), on: vi.fn() } } } as unknown as Conn
  const panel = centrePanel(conn, focus)
  document.body.append(panel)
  return { dom, panel, focus }
}

it('bounds 300,000-character lines in every tab, expands independently, and preserves annotations/details', async () => {
  const room = new RoomDoc()
  const text = 'x'.repeat(300000)
  publish(room, 'Ada', 'a.js', text + '\n' + text)
  publish(room, 'Ada', 'b.js', text)
  const { dom, panel, focus } = setup(room)
  try {
    for (const tab of ['Merged', 'Diff', 'File']) {
      Array.from(panel.querySelectorAll<HTMLButtonElement>('.tab')).find(b => b.textContent === tab)!.click()
      await vi.waitFor(() => expect(panel.querySelector('.code-line')?.textContent?.length).toBeLessThanOrEqual(2100))
      const row = panel.querySelector<HTMLElement>('.code-line')!
      expect(row.textContent!.length).toBeLessThanOrEqual(2100)
      expect(row.querySelector('code')!.firstChild!.textContent).toHaveLength(2000)
      const show = row.querySelector<HTMLButtonElement>('.line-text-show')!
      expect(show.textContent).toBe('… +298,000 chars · show')
      show.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      expect(panel.querySelector('.inline-detail')).toBeNull()
      show.click()
      expect(row.querySelector('code')!.textContent).toBe(text)
      expect(panel.querySelectorAll('.code-line')[1].textContent!.length).toBeLessThanOrEqual(2100)
      expect(panel.querySelector('.inline-detail')).toBeNull()
      row.dispatchEvent(new dom.window.Event('pointerenter'))
      expect(panel.querySelector('.line-annotation')!.textContent).toBe(tab === 'Diff' ? 'unchanged from base' : 'changed by Ada')
      row.click()
      expect(panel.querySelector('.inline-detail')).not.toBeNull()
      focus.set(focus.person ? null : 'Ada')
      expect(panel.querySelector('code')!.textContent).toBe(text)
    }
    panel.querySelector<HTMLButtonElement>('.file-item[title="b.js"]')!.click()
    panel.querySelector<HTMLButtonElement>('.file-item[title="a.js"]')!.click()
    await vi.waitFor(() => expect(panel.querySelector('.code-line')!.textContent!.length).toBeLessThanOrEqual(2100))
  } finally { room.doc.destroy(); dom.window.close() }
})

it('caps 5,000 grouped files, retains a selected path beyond the cap, and keeps show-all for the session', () => {
  const room = new RoomDoc()
  // Select the final path before a large batch of earlier-sorting paths arrives.
  publish(room, 'Ada', 'z/selected.ts', 'selected')
  const { dom, panel, focus } = setup(room)
  try {
    room.doc.transact(() => {
      for (let i = 0; i < 4999; i++) publish(room, 'Ada', `${i < 150 ? 'a' : 'b'}/${String(i).padStart(4, '0')}.ts`, 'x')
      room.scopes.set('A', { by: 'A', byKind: 'agent', area: 'alpha', summary: '', paths: ['a/'], at: 1 })
      room.scopes.set('B', { by: 'B', byKind: 'agent', area: 'beta', summary: '', paths: ['b/'], at: 1 })
    })
    renderScheduler.flushNow()
    expect(panel.querySelectorAll('.file-item')).toHaveLength(301)
    expect(panel.querySelector('.file-item.active')!.getAttribute('title')).toBe('z/selected.ts')
    expect(Array.from(panel.querySelectorAll('.file-area'), e => e.textContent)).toEqual(['alpha', 'beta', 'other'])
    expect(panel.querySelector('.file-more')!.textContent).toBe('and 4,699 more files · show all')
    panel.querySelector<HTMLButtonElement>('.file-more')!.click()
    expect(panel.querySelectorAll('.file-item')).toHaveLength(5000)
    expect(panel.querySelector('.file-more')).toBeNull()
    focus.set('Ada')
    expect(panel.querySelectorAll('.file-item')).toHaveLength(5000)
  } finally { room.doc.destroy(); dom.window.close() }
}, 120_000)
