import { afterEach, expect, it, vi } from 'vitest'
import { RoomDoc } from '@room/shared'
import type { Conn } from './conn.ts'
import { createFocusState, participantsPanel } from './panels.ts'

// Minimal DOM surface used by h()/the rail; no browser or socket required.
class Element {
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
  vi.stubGlobal('document', { createElement: () => new Element(), activeElement: null })
  const room = new RoomDoc()
  room.scopes.set('Ada', { by: 'Ada', byKind: 'agent', area: 'web', summary: 'UI', paths: [], at: 1 })
  const states = new Map<number, unknown>([[1, { user: { name: 'Ada', kind: 'agent' } }]])
  const listeners = new Map<string, () => void>()
  const conn = { room, provider: { awareness: { getStates: () => states, on: (event: string, fn: () => void) => listeners.set(event, fn) } } } as unknown as Conn
  const rail = participantsPanel(conn, createFocusState()) as unknown as Element
  expect(rail.find('participant')?.className).not.toContain('offline')
  expect(rail.textContent).toContain('Online · activity unknown')
  expect(rail.textContent).not.toContain('not connected')
  states.clear(); listeners.get('change')!()
  expect(rail.find('participant')?.className).toContain('offline')
  states.set(1, { user: { name: 'Ada', kind: 'agent' }, lastActive: 83_000 })
  vi.advanceTimersByTime(15_000)
  expect(rail.find('participant')?.className).not.toContain('offline')
  expect(rail.textContent).toContain('active 32s ago')
  room.doc.destroy()
})
