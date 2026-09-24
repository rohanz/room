import { renderScheduler } from './scheduler.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { RoomDoc } from '@room/shared'
import type { Conn } from './conn.ts'
import { readFileSync } from 'node:fs'
import { boardPanel } from './board.ts'
import { createFocusState, participantsPanel } from './panels.ts'

// Minimal DOM surface used by h()/the rail; no browser or socket required.
class Element {
  attributes = new Map<string, string>()
  events = new Map<string, unknown>()
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  addEventListener(name: string, fn: unknown) { this.events.set(name, fn) }
  classList = { toggle: vi.fn() }
  className = ''; title = ''; style = {}; children: (Element | string)[] = []
  append(...children: (Element | string)[]) { this.children.push(...children) }
  replaceChildren(...children: (Element | string)[]) { this.children = children }
  contains() { return false }
  get textContent(): string { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join('') }
  find(cls: string): Element | undefined { return this.className.split(' ').includes(cls) ? this : this.children.flatMap(c => typeof c === 'string' ? [] : [c.find(cls)]).find(Boolean) }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('renders live Code presence without treating missing activity as disconnected, and refreshes reconnects', () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('document', { createElement: () => new Element(), activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const room = new RoomDoc()
  room.scopes.set('Ada', { by: 'Ada', byKind: 'agent', area: 'web', summary: 'UI', paths: [], at: 1 })
  const states = new Map<number, unknown>([[1, { user: { name: 'Ada', kind: 'agent' } }]])
  const listeners = new Map<string, () => void>()
  const conn = { room, provider: { awareness: { getStates: () => states, on: (event: string, fn: () => void) => listeners.set(event, fn) } } } as unknown as Conn
  const rail = participantsPanel(conn, createFocusState()) as unknown as Element
  expect(rail.find('participant')?.className).not.toContain('offline')
  expect(rail.textContent).toContain('Online · activity unknown')
  expect(rail.textContent).not.toContain('not connected')
  states.clear(); listeners.get('change')!(); renderScheduler.flushNow()
  expect(rail.find('participant')?.className).toContain('offline')
  states.set(1, { user: { name: 'Ada', kind: 'agent' }, lastActive: 83_000 })
  vi.advanceTimersByTime(15_000)
  expect(rail.find('participant')?.className).not.toContain('offline')
  expect(rail.textContent).toContain('Online · working')
  vi.advanceTimersByTime(120_000)
  expect(rail.find('participant')?.className).not.toContain('offline')
  expect(rail.textContent).toContain('Online · last action 2m ago')
  expect(rail.textContent).not.toContain('Offline')
  room.doc.destroy()
})

it('renders the shared model line with ellipsis styling and full title/tooltip on both cards', () => {
  vi.useFakeTimers()
  vi.stubGlobal('document', { createElement: () => new Element(), activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const room = new RoomDoc()
  const model = 'model-' + 'x'.repeat(74)
  const states = new Map([[1, { user: { name: 'Ada', kind: 'agent', label: 'codex' }, model, effort: 'medium' }]])
  const conn = { room, provider: { awareness: { getStates: () => states, on: vi.fn() } } } as unknown as Conn
  const people = participantsPanel(conn, createFocusState()) as unknown as Element
  const board = boardPanel(conn, vi.fn()) as unknown as Element
  const line = 'codex · ' + model + ' · medium'
  expect(people.find('participant-identity')?.textContent).toBe(line)
  expect(people.find('participant-identity')?.title).toBe(line)
  expect(board.find('participant-identity')?.textContent).toBe(line)
  expect(board.find('participant-identity')?.attributes.get('data-tooltip')).toBe(line)
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  expect(css).toMatch(/\.participant-identity\s*\{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/)
  room.doc.destroy()
})

it.each(['done', 'failed', 'dismissed', 'running'] as const)('shares %s worker recency across People and Board', status => {
  vi.useFakeTimers(); vi.setSystemTime(600_000)
  vi.stubGlobal('document', { createElement: () => new Element(), activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const room = new RoomDoc()
  room.setWorker({ name: 'Ada+test', tag: 'test', lead: 'Ada', host: 'codex', task: 'test', dir: '/', branch: 'test', pid: 1, startedAt: 0, status, finishedAt: 240_000 })
  const states = new Map([[1, { user: { name: 'Ada+test', kind: 'agent' }, lastActive: 599_000 }]])
  const conn = { room, provider: { awareness: { getStates: () => states, on: vi.fn() } } } as unknown as Conn
  const people = participantsPanel(conn, createFocusState()) as unknown as Element
  const board = boardPanel(conn, vi.fn()) as unknown as Element
  const label = status === 'running' ? 'running' : 'finished 6m ago'
  expect(people.find('card-foot')?.textContent).toBe('Online · ' + label)
  expect(board.find('board-card-footer')?.textContent).toContain(label)
  room.doc.destroy()
})
