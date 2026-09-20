import { afterEach, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { RoomDoc } from '@room/shared'
import { classifyNWay, unifiedDiffLines } from './merged.ts'
import { centrePanel, createFocusState, renderCodeLines } from './panels.ts'
import type { Conn } from './conn.ts'
const csv = Array.from({ length: 32000 }, (_, i) => `${i},a,b`).join('\n') + '\n'
afterEach(() => vi.unstubAllGlobals())
it('bounds 32k-line computations including additions, deletions, identical and unrelated versions', () => {
  const timings: Record<string, number> = {}
  const measure = <T>(name: string, fn: () => T): T => {
    const start = performance.now(); const result = fn(); timings[name] = Math.round(performance.now() - start)
    expect(timings[name]).toBeLessThan(3000)
    return result
  }
  expect(measure('merge addition', () => classifyNWay('', [{ name: 'rohanz', text: csv }]))).toHaveLength(32000)
  expect(measure('diff addition', () => unifiedDiffLines('', csv))).toHaveLength(32000)
  expect(measure('diff deletion', () => unifiedDiffLines(csv, ''))).toHaveLength(32000)
  expect(measure('diff identical', () => unifiedDiffLines(csv, csv))).toHaveLength(32000)
  const other = csv.replaceAll('a,b', 'c,d')
  expect(measure('diff replacement', () => unifiedDiffLines(csv, other))).toHaveLength(64000)
  expect(measure('merge competing', () => classifyNWay('base\n'.repeat(32000), [{ name: 'A', text: csv }, { name: 'B', text: other }])).some(l => l.conflict)).toBe(true)
  console.log('32k fixture timings (ms):', timings)
})
it('limits all three tabs, pages 500 more rows and resets on tab/file selection', () => {
  const dom = new JSDOM('<body></body>')
  vi.stubGlobal('document', dom.window.document); vi.stubGlobal('window', dom.window)
  const room = new RoomDoc()
  room.setOverlay('rohanz', 'big.csv', csv)
  room.setOverlay('other', 'big.csv', '')
  room.setOverlay('rohanz', 'small.csv', 'small\n')
  const conn = { room, provider: { awareness: { getStates: () => new Map(), on: vi.fn() } } } as unknown as Conn
  try {
    const focus = createFocusState(); focus.set('rohanz')
    const panel = centrePanel(conn, focus); document.body.append(panel)
    for (const tab of ['Merged', 'Diff', 'File']) {
      Array.from(panel.querySelectorAll<HTMLButtonElement>('.tab')).find(b => b.textContent === tab)!.click()
      expect(panel.querySelectorAll('.code-line')).toHaveLength(500)
      expect(panel.querySelector('.large-file-notice')?.textContent).toContain('32,000 lines, showing 500')
      panel.querySelector<HTMLButtonElement>('.line-gap-show')!.click()
      expect(panel.querySelectorAll('.code-line')).toHaveLength(1000)
      expect(panel.querySelectorAll('.code-line')[500].getAttribute('aria-label')).toContain('Line 501.')
    }
    const files = Array.from(panel.querySelectorAll<HTMLButtonElement>('.file-item'))
    files.find(b => b.title === 'small.csv')!.click()
    files.find(b => b.title === 'big.csv')!.click()
    expect(panel.querySelectorAll('.code-line')).toHaveLength(500)
  } finally { room.doc.destroy(); dom.window.close() }
})
it('renders show all in 500-row frames and cancels when the host is replaced', () => {
  const dom = new JSDOM('<body></body>')
  vi.stubGlobal('document', dom.window.document)
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => frames.push(fn))
  const host = document.createElement('div')
  renderCodeLines(host, classifyNWay('', [{ name: 'A', text: csv }]), ['A'])
  Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'show all')!.click()
  expect(host.querySelectorAll('.code-line')).toHaveLength(500)
  frames.shift()!(0)
  expect(host.querySelectorAll('.code-line')).toHaveLength(1000)
  host.replaceChildren()
  frames.shift()!(0)
  expect(host.children).toHaveLength(0)
  expect(frames).toHaveLength(0)
  dom.window.close()
})
