import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { RoomDoc, type ConflictSpan, type Msg } from '@room/shared'
import type { Conn } from './conn.ts'
import {
  CHIP_ROW_LIMIT,
  TIMELINE_PRIORITIES,
  clipTimelineEpisodes,
  createFocusState,
  filterPriorityTimeline,
  readTimelinePriorities,
  timelinePanel,
  type TimelinePriority,
} from './panels.ts'
import type { Episode } from './timeline.ts'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllGlobals() })

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set('room.timeline.priorities', initial)
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    values,
  }
}

function setup(messages: Msg[], stored?: string, storage: Pick<Storage, 'getItem' | 'setItem'> = memoryStorage(stored), online: string[] = []) {
  const dom = new JSDOM('<body></body>')
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const room = new RoomDoc()
  room.bus.push(messages)
  const states = new Map(online.map((name, i) => [i + 1, { user: { name, kind: 'agent' } }]))
  const conn = { room, provider: { awareness: { getStates: () => states, on: vi.fn() } } } as unknown as Conn
  const panel = timelinePanel(conn, createFocusState())
  document.body.append(panel)
  cleanups.push(() => { room.doc.destroy(); dom.window.close() })
  const priority = (name: TimelinePriority) => panel.querySelector<HTMLButtonElement>(`.priority-filter-chip.priority-${name}`)!
  const filter = (name: string) => [...panel.querySelectorAll<HTMLButtonElement>('.filter-chip')].find(button => button.textContent === name)!
  return { panel, room, storage, priority, filter }
}

const scope = (id: string, from: string, area: string, at: number, priority: TimelinePriority = 'notify'): Msg =>
  ({ id, type: 'scope', priority, from, fromKind: 'agent', at, area, summary: `${from} ${area}`, paths: [area] })
const note = (id: string, from: string, at: number, priority: TimelinePriority): Msg =>
  ({ id, type: 'note', priority, from, fromKind: 'agent', at, text: id })

describe('timeline priority chips', () => {
  it('defaults all levels on, reports counts, and toggles with accessible greyed buttons', () => {
    const s = setup([scope('scope', 'Ada', 'api', 1), note('notice', 'Ada', 2, 'notify'), note('background', 'Ada', 3, 'fyi'), note('urgent', 'Ada', 4, 'interrupt')])
    expect(s.panel.querySelector('.priority-filters')?.getAttribute('aria-label')).toBe('Filter by priority')
    expect(TIMELINE_PRIORITIES.map(level => [s.priority(level).textContent, s.priority(level).getAttribute('aria-pressed')])).toEqual([
      ['interrupt 1', 'true'], ['notify 2', 'true'], ['fyi 1', 'true'],
    ])
    s.priority('notify').click()
    expect(s.panel.textContent).not.toContain('notice')
    expect(s.panel.textContent).toContain('background')
    expect(s.priority('notify').getAttribute('aria-pressed')).toBe('false')
    expect(s.priority('notify').classList.contains('greyed')).toBe(true)
    s.priority('notify').click()
    expect(s.panel.textContent).toContain('notice')
  })

  it('combines with person and area filters while All leaves priority selection alone', () => {
    const s = setup([
      scope('ada-scope', 'Ada', 'api', 1), note('ada-fyi', 'Ada', 2, 'fyi'),
      scope('ben-scope', 'Ben', 'web', 3), note('ben-interrupt', 'Ben', 4, 'interrupt'),
    ])
    s.filter("Ada's agent").click()
    expect(TIMELINE_PRIORITIES.map(level => s.priority(level).textContent)).toEqual(['interrupt 0', 'notify 1', 'fyi 1'])
    s.priority('fyi').click()
    s.filter('All').click()
    expect(s.priority('fyi').getAttribute('aria-pressed')).toBe('false')
    expect(s.panel.textContent).not.toContain('ada-fyi')
    s.filter('web').click()
    expect(TIMELINE_PRIORITIES.map(level => s.priority(level).textContent)).toEqual(['interrupt 1', 'notify 1', 'fyi 0'])
    expect(s.panel.textContent).toContain('ben-interrupt')
    expect(s.panel.textContent).not.toContain('Ada api')
  })

  it('never moves, expands or collapses the area/people row above it', () => {
    const s = setup([scope('s-old', 'Old', 'legacy', 0, 'fyi'), ...Array.from({ length: 5 }, (_, i) => note(`old-${i}`, 'Old', i + 1, 'fyi')), scope('s-ada', 'Ada', 'api', 9), ...Array.from({ length: 35 }, (_, i) => note(`new-${i}`, 'Ada', i + 10, 'notify'))])
    const row = () => [...s.panel.querySelectorAll<HTMLElement>('.timeline-head > .filter-chips > *')].map(node => `${node.textContent}${node.hidden ? ' (hidden)' : ''}`)
    const before = row()
    expect(before).toContain("Old's agent (hidden)") // Old is outside the window, so it sits behind "Show all"
    s.priority('notify').click()             // only Old's fyi notes are left in the list
    expect(s.panel.textContent).toContain('old-0')
    expect(row()).toEqual(before)
    s.panel.querySelector<HTMLButtonElement>('.more-chips')!.click()
    const expanded = row()
    s.priority('notify').click()
    expect(row()).toEqual(expanded)          // and an expanded row stays expanded
  })

  it('caps a busy row behind "Show all", keeps the selected chip, hides directory areas, and ignores addressees that are not people', () => {
    const workers = Array.from({ length: 14 }, (_, i) => `lead+w${String(i).padStart(2, '0')}`)
    const s = setup([
      ...workers.map((name, i) => scope(`s-${i}`, name, `area${String(i).padStart(2, '0')}`, i + 1)),
      scope('s-dir', 'lead+w00', 'packages/shared/', 20),
      { ...note('to-tag', 'lead+w00', 21, 'notify'), to: 'graph' } as Msg,
    ], undefined, undefined, workers) // all fourteen are online, so all fourteen are "prominent"
    const row = () => [...s.panel.querySelectorAll<HTMLElement>('.timeline-head > .filter-chips > .filter-chip')]
    const visible = () => row().filter(chip => !chip.hidden).map(chip => chip.textContent)
    expect(visible()).toHaveLength(CHIP_ROW_LIMIT + 1) // "All" plus the capped row
    expect(s.panel.querySelector('.more-chips')?.textContent).toMatch(/^Show all \(\d+ more\)$/)
    expect(row().map(chip => chip.textContent)).not.toContain('graph') // a bare tag in "to" is not a person
    expect(visible()).not.toContain('packages/shared/')
    const last = row().find(chip => chip.textContent === 'lead+w13')!
    expect(last.hidden).toBe(true)
    last.click()
    expect(visible()).toContain('lead+w13') // the selected chip is never hidden by the cap
    expect(visible()).toHaveLength(CHIP_ROW_LIMIT + 1)
  })

  it('filters before windowing so the last 30 selected entries are shown', () => {
    const messages = [scope('scope', 'Ada', 'api', 0, 'fyi')]
    for (let i = 0; i < 35; i++) messages.push(note(`interrupt-${i}`, 'Ada', i + 1, 'interrupt'))
    for (let i = 0; i < 35; i++) messages.push(note(`fyi-${i}`, 'Ada', i + 101, 'fyi'))
    const s = setup(messages)
    s.priority('notify').click()
    s.priority('fyi').click()
    const text = s.panel.querySelector('.timeline-list')!.textContent!
    expect(text).toContain('interrupt-34')
    expect(text).toContain('interrupt-5')
    expect(text).not.toContain('interrupt-4')
    expect(text).not.toContain('fyi-34')
    expect(s.panel.querySelector('.timeline-more')).not.toBeNull()
  })

  it('uses a done message real priority and names hidden levels in the empty state', () => {
    const done: Msg = { id: 'finished', type: 'done', priority: 'notify', from: 'Ada', fromKind: 'agent', at: 2, tag: 'worker', summary: 'notify completion', changed: [] }
    const s = setup([scope('scope', 'Ada', 'api', 1, 'notify'), done])
    s.priority('interrupt').click()
    s.priority('fyi').click()
    expect(s.panel.textContent).toContain('notify completion')
    expect(s.panel.querySelector('.priority.done')?.textContent).toBe('done')
    s.priority('notify').click() // Last-on protection restores every level.
    expect(TIMELINE_PRIORITIES.map(level => s.priority(level).getAttribute('aria-pressed'))).toEqual(['true', 'true', 'true'])
    s.priority('interrupt').click()
    s.priority('notify').click()
    expect(s.panel.textContent).toContain('Hidden priorities: interrupt, notify')
  })

  it('round-trips storage and falls back for corrupt, empty, and throwing storage', () => {
    const storage = memoryStorage()
    const first = setup([scope('scope', 'Ada', 'api', 1)], undefined, storage)
    first.priority('fyi').click()
    expect(storage.values.get('room.timeline.priorities')).toBe('["interrupt","notify"]')
    const second = setup([scope('scope-2', 'Ada', 'api', 1)], undefined, storage)
    expect(second.priority('fyi').getAttribute('aria-pressed')).toBe('false')
    for (const value of ['not json', '[]', '["other"]']) {
      expect([...readTimelinePriorities(memoryStorage(value))]).toEqual(TIMELINE_PRIORITIES)
    }
    const blocked = { getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') } }
    expect([...readTimelinePriorities(blocked)]).toEqual(TIMELINE_PRIORITIES)
    const third = setup([scope('scope-3', 'Ada', 'api', 1)], undefined, blocked)
    expect(() => third.priority('notify').click()).not.toThrow()
  })
})

it('keeps conflict spans regardless of selected priorities', () => {
  const conflict = {} as ConflictSpan
  const entry = { message: note('conflict-event', 'room', 1, 'fyi'), conflict }
  expect(filterPriorityTimeline([entry], new Set<TimelinePriority>(['interrupt'])).window).toEqual([entry])
})

it('keeps a hidden parent and episode header when a shown reply survives', () => {
  const parent = note('parent', 'Ada', 2, 'fyi')
  const reply = note('reply', 'Ben', 3, 'interrupt')
  const episode: Episode = {
    id: 'scope', person: 'Ada', area: 'api', summary: 'work', at: 1, paths: [], status: 'in progress', alsoSentTo: [],
    items: [{ message: parent, alsoSentTo: [], replies: [{ message: reply, alsoSentTo: [], replies: [] }] }],
  }
  const clipped = clipTimelineEpisodes([episode], new Set(['reply']))
  expect(clipped).toHaveLength(1)
  expect(clipped[0].items.map(item => item.message.id)).toEqual(['parent'])
  expect(clipped[0].items[0].replies.map(item => item.message.id)).toEqual(['reply'])
})
