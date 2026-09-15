import { afterEach, expect, it, vi } from 'vitest'
import { RoomDoc } from '@room/shared'
import { networkPanel } from './network.ts'
import type { Conn } from './conn.ts'

class Element {
  className = ''; children: (Element | string)[] = []; style = {}; value = ''; clientWidth = 800
  attributes = new Map<string, string>()
  append(...children: (Element | string)[]) { this.children.push(...children) }
  replaceChildren(...children: (Element | string)[]) { this.children = children }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  addEventListener() {}
  get textContent(): string { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join('') }
  set textContent(value: string) { this.children = [value] }
  find(cls: string): Element[] { return [...(this.className.split(' ').includes(cls) ? [this] : []), ...this.children.flatMap(c => typeof c === 'string' ? [] : c.find(cls))] }
}
afterEach(() => vi.unstubAllGlobals())
it('renders compact zoom controls, help, three legend labels and details empty state', () => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  vi.stubGlobal('location', { search: '' })
  vi.stubGlobal('ResizeObserver', class { observe() {} })
  const room = new RoomDoc()
  const conn = { room, provider: { awareness: { getStates: () => new Map(), on() {} } } } as unknown as Conn
  const panel = networkPanel(conn) as unknown as Element
  expect(panel.find('network-zoom')[0].textContent).toBe('−Fit+')
  expect(panel.find('network-percentage')[0].textContent).toBe('100%')
  expect((panel.find('network-help')[0].children[0] as Element).attributes.get('data-tooltip')).toContain('Impact is inferred')
  expect(panel.find('network-legend')[0].children).toHaveLength(3)
  expect(panel.find('network-details')[0].textContent).toContain('Select a file')
  expect(panel.find('network-footnote')).toHaveLength(0)
  expect(panel.textContent).not.toContain('Auto size')
  room.doc.destroy()
})
