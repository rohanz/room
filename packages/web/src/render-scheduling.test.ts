import { afterEach, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { RoomDoc } from '@room/shared'
import * as merge from './merged.ts'
import { centrePanel, createFocusState } from './panels.ts'
import { renderScheduler } from './scheduler.ts'
import type { Conn } from './conn.ts'

vi.setConfig({ testTimeout: 120_000 })
afterEach(() => { renderScheduler.flushNow(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('retains code DOM and merge results across 50 unrelated updates; edits and clicks render once', () => {
  const dom = new JSDOM('', { pretendToBeVisual: true })
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const room = new RoomDoc()
  const text = Array.from({ length: 2523 }, (_, i) => `line ${i}`).join('\n')
  room.setOverlay('Ada', 'a.ts', text)
  room.setOverlay('Ada', 'b.ts', 'other')
  const classify = vi.spyOn(merge, 'classifyNWay')
  const diff = vi.spyOn(merge, 'unifiedDiffLines')
  const conn = { room, provider: { awareness: { getStates: () => new Map(), on: vi.fn(), off: vi.fn() } } } as unknown as Conn
  const panel = centrePanel(conn, createFocusState())
  document.body.append(panel)
  const host = panel.querySelector<HTMLElement>('.editor-wrap')!
  const rebuild = vi.spyOn(host, 'replaceChildren')
  const clickTab = (tab: string) => Array.from(panel.querySelectorAll<HTMLButtonElement>('.tab')).find(b => b.textContent === tab)!.click()
  try {
    for (const tab of ['Merged', 'Diff', 'File']) {
      clickTab(tab)
      classify.mockClear(); diff.mockClear(); rebuild.mockClear()
      const pane = host.firstChild
      for (let i = 0; i < 50; i++) room.setOverlay('Ben', 'z.ts', `unrelated ${tab} ${i}`)
      expect(rebuild).not.toHaveBeenCalled()
      renderScheduler.flushNow()
      expect(classify).not.toHaveBeenCalled(); expect(diff).not.toHaveBeenCalled()
      expect(rebuild).not.toHaveBeenCalled(); expect(host.firstChild).toBe(pane)
      room.setOverlay('Ada', 'a.ts', `${text}\n${tab}`)
      expect(classify).not.toHaveBeenCalled(); expect(diff).not.toHaveBeenCalled()
      renderScheduler.flushNow()
      expect(tab === 'Diff' ? diff : classify).toHaveBeenCalledTimes(1)
      expect(rebuild).toHaveBeenCalledTimes(1)
    }
    classify.mockClear(); rebuild.mockClear()
    panel.querySelector<HTMLButtonElement>('.file-item[title="b.ts"]')!.click()
    expect(classify).toHaveBeenCalledTimes(1); expect(rebuild).toHaveBeenCalledTimes(1)
    expect(host.querySelector('code')!.textContent).toBe('other')
    classify.mockClear(); rebuild.mockClear()
    room.claims.set('c', { id: 'c', by: 'Ada', byKind: 'agent', path: 'b.ts', from: 1, to: 1, intent: 'new annotation', at: Date.now() })
    renderScheduler.flushNow()
    expect(classify).not.toHaveBeenCalled(); expect(rebuild).toHaveBeenCalledTimes(1)
    host.querySelector<HTMLElement>('.code-line')!.click()
    expect(host.querySelector('.inline-detail')!.textContent).toContain('new annotation')
    room.markDeleted('Ada', 'b.ts'); renderScheduler.flushNow()
    expect(host.textContent).toBe('deleted by Ada')
    rebuild.mockClear()
    room.setOverlay('Ben', 'z.ts', 'another unrelated edit'); renderScheduler.flushNow()
    expect(rebuild).not.toHaveBeenCalled()
    room.unmarkDeleted('Ada', 'b.ts'); renderScheduler.flushNow()
    expect(host.querySelector('code')!.textContent).toBe('other')
  } finally { room.doc.destroy(); dom.window.close() }
})
