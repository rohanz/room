import { afterEach, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { RoomDoc, type RetiredWorker, type Worker } from '@room/shared'
import { boardPanel } from './board.ts'
import { centrePanel, createFocusState, header, participantsPanel, timelinePanel } from './panels.ts'
import { renderScheduler } from './scheduler.ts'
import type { Conn } from './conn.ts'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.useRealTimers(); vi.unstubAllGlobals() })
function setup() {
  vi.useFakeTimers()
  const dom = new JSDOM('<body></body>')
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const room = new RoomDoc()
  const states = new Map([[1, { user: { name: 'Lead', kind: 'agent' } }]])
  const conn = { room, displayRoomName: 'local/repo/main', onStatus: vi.fn(), provider: { awareness: { getStates: () => states, on: vi.fn() } } } as unknown as Conn
  cleanups.push(() => { room.doc.destroy(); dom.window.close() })
  return { room, conn, dom }
}
function worker(tag: string, status: Worker['status'] = 'running'): Worker {
  return { name: `Lead+${tag}`, tag, lead: 'Lead', host: 'codex', model: 'model', task: 'Task', dir: '/tmp/example', branch: tag, pid: 1, startedAt: 1, status }
}
function retired(tag: string): RetiredWorker {
  return { name: `Lead+${tag}`, tag, lead: 'Lead', host: 'codex', model: 'model', task: 'Task', summary: 'Finished the task', files: ['a.ts'], fileCount: 61, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'merged' }
}

it('nests active and failed workers, collapses archives, and counts active in both presentations', () => {
  const { room, conn, dom } = setup()
  room.workers.set('running', worker('running'))
  room.workers.set('failed', worker('failed', 'failed'))
  room.scopes.set('Away', { by: 'Away', byKind: 'agent', area: 'api', summary: 'Away', paths: [], at: 1 })
  room.retireParticipant('Lead+old', retired('old'))
  const focus = createFocusState()
  const people = participantsPanel(conn, focus), board = boardPanel(conn, vi.fn()), top = header(conn)
  document.body.append(people, board, top)
  expect(top.textContent).toContain('3 active')
  for (const panel of [people, board]) {
    expect(panel.textContent).toContain('Lead · 1 running · 1 finished')
    expect(panel.querySelector('.worker-children')!.textContent).toContain('failed')
    expect(panel.querySelector('.offline-group')!.textContent).toContain('Away')
    const details = panel.querySelector<HTMLDetailsElement>('.finished-workers')!
    expect(details.open).toBe(false)
    details.open = true
    details.dispatchEvent(new dom.window.Event('toggle'))
    expect(details.textContent).toContain('model · merged')
    expect(details.textContent).toContain('61 files')
    expect(details.textContent).toContain('Finished the task')
  }
  room.retireParticipant('Lead+running', retired('running'))
  renderScheduler.flushNow()
  expect(top.textContent).toContain('2 active')
  expect(people.textContent).toContain('Lead · 0 running · 2 finished')
  expect(people.querySelector<HTMLDetailsElement>('.finished-workers')!.open).toBe(true)
})

it('bounds timeline and merge controls while retaining older filters and scope context', () => {
  const { room, conn } = setup()
  room.retireParticipant('Lead+archived', retired('archived'))
  for (const name of ['Lead', 'Old', 'Recent']) room.setOverlay(name, 'a.ts', name)
  room.bus.push([{ id: 'old', type: 'scope', from: 'Old', fromKind: 'agent', at: 1, priority: 'fyi', area: 'old-area', summary: 'Old task', paths: [] },
    { id: 'recent', type: 'scope', from: 'Recent', fromKind: 'agent', at: 2, priority: 'fyi', area: 'current-area', summary: 'Current task', paths: [] }])
  for (let i = 0; i < 35; i++) room.bus.push([{ id: `note-${i}`, type: 'note', from: 'Recent', fromKind: 'agent', at: i + 3, priority: 'fyi', text: `Recent note ${i}` }])
  const focus = createFocusState(), center = centrePanel(conn, focus), timeline = timelinePanel(conn, focus), board = boardPanel(conn, vi.fn())
  document.body.append(center, timeline, board)
  expect(timeline.textContent).toContain('Current task') // scope predates the window
  expect(timeline.querySelector('.timeline-list')!.textContent).not.toContain('Old task')
  for (const panel of [timeline, board]) {
    const more = panel.querySelector<HTMLButtonElement>('.more-chips')!
    const extra = () => [...panel.querySelectorAll<HTMLElement>('.filter-chips > .filter-chip')].filter(chip => /Old|Lead\+archived|old-area/.test(chip.textContent ?? ''))
    expect(more.ariaExpanded).toBe('false')
    expect(more.textContent).toMatch(/^Show all \(\d+ more\)$/)
    expect(extra().length).toBeGreaterThanOrEqual(3)
    expect(extra().every(chip => chip.hidden)).toBe(true)
    more.click() // expands inline, in the same row
    expect(more.textContent).toBe('Show less')
    expect(extra().every(chip => !chip.hidden && chip.parentElement === more.parentElement)).toBe(true)
    more.click()
    expect(extra().every(chip => chip.hidden)).toBe(true)
  }
  expect([...center.querySelectorAll<HTMLElement>('.merge-chips > .merge-chip')].filter(chip => chip.hidden).map(chip => chip.textContent)).toContain('Old')
  expect([...center.querySelectorAll<HTMLElement>('.merge-chips > .merge-chip')].filter(chip => !chip.hidden).map(node => node.textContent)).toEqual(['Lead', 'Recent'])
  timeline.querySelector<HTMLButtonElement>('.timeline-more')!.click()
  expect(timeline.querySelector('.timeline-list')!.textContent).toContain('Old task')
  expect(center.querySelector('.more-chips')).toBeNull()
})


it('shows dismissed uncommitted files in the archive row', () => {
  const { room, conn } = setup()
  room.retireParticipant('Lead+dirty', { ...retired('dirty'), outcome: 'dismissed', uncommitted: 2 })
  expect(participantsPanel(conn, createFocusState()).textContent).toContain('dismissed with 2 uncommitted files left in its worktree')
})

it('chip rows never stretch their chips to the height of a taller neighbour', async () => {
  const { readFileSync } = await import('node:fs')
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  const rule = [...css.matchAll(/^\.filter-chips \{([^}]*)\}/gm)].map(m => m[1]).join(' ')
  expect(rule).toContain('flex-wrap: wrap')
  expect(rule).toContain('align-items: flex-start')
})
