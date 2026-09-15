import { afterEach, expect, it, vi } from 'vitest'
import { RoomDoc } from '@room/shared'
import { networkPanel } from './network.ts'
import type { Conn } from './conn.ts'

class Element {
  title = ''
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
const setup = () => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  vi.stubGlobal('location', { search: '' })
  vi.stubGlobal('ResizeObserver', class { observe() {} })
  const room = new RoomDoc()
  const conn = { room, provider: { awareness: { getStates: () => new Map(), on() {} } } } as unknown as Conn
  return { room, panel: networkPanel(conn) as unknown as Element }
}
it('renders compact zoom controls at 150%, help, three legend labels and details empty state', () => {
  const { room, panel } = setup()
  expect(panel.find('network-zoom')[0].textContent).toBe('−Fit+')
  expect(panel.find('network-percentage')[0].textContent).toBe('150%')
  expect((panel.find('network-help')[0].children[0] as Element).title).toContain('Impact is inferred')
  expect(panel.find('network-legend')[0].children).toHaveLength(3)
  expect(panel.find('network-details')[0].textContent).toContain('Select a file')
  expect(panel.find('network-footnote')).toHaveLength(0)
  expect(panel.textContent).not.toContain('Auto size')
  room.doc.destroy()
})
it('steps zoom by 25, clamps it to 50..300, and remembers it for this page session', () => {
  const { room, panel } = setup()
  const controls = panel.find('network-zoom')[0].children as Element[]
  const minus = controls[0] as Element & { onclick(): void }
  const plus = controls[2] as Element & { onclick(): void }
  minus.onclick()
  expect(panel.find('network-percentage')[0].textContent).toBe('125%')
  for (let i = 0; i < 10; i++) minus.onclick()
  expect(panel.find('network-percentage')[0].textContent).toBe('50%')
  for (let i = 0; i < 20; i++) plus.onclick()
  expect(panel.find('network-percentage')[0].textContent).toBe('300%')
  room.doc.destroy()

  const next = setup()
  expect(next.panel.find('network-percentage')[0].textContent).toBe('300%')
  next.room.doc.destroy()
})
