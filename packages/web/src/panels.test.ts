import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomDoc, colorFor, roomNameParts, type Claim, type Presence, type Scope } from '@room/shared'
import { parseRoomUrl, type Conn } from './conn.ts'
import { deriveParticipants, deriveStatePill, shortPill, header, centrePanel, createFocusState } from './panels.ts'

describe('shortPill', () => {
  it('keeps the state and a short detail', () => {
    expect(shortPill('editing api/handlers.py:22-24 — Use Order.to_json total as subtotal')).toBe('editing handlers.py:22-24')
    expect(shortPill('editing create_order — restructuring validation')).toBe('editing create_order')
    expect(shortPill('waiting on Kieran')).toBe('waiting on Kieran')
    expect(shortPill('done')).toBe('done')
    expect(shortPill('behind base')).toBe('behind base')
  })
})

describe('state pill: done and working', () => {
  it('shows done after room_done and working while scoped', () => {
    const base = { online: true, behindBase: false, claims: [] as never[] }
    expect(deriveStatePill({ ...base, statuses: [{ kind: 'agent', status: 'done: coupons landed' }] })).toBe('done')
    expect(deriveStatePill({ ...base, statuses: [{ kind: 'agent', status: 'on orders: coupons' }] })).toBe('working')
  })
})

describe('room URL parsing', () => {
  it('keeps the last segment encoded and decodes it for display', () => {
    expect(parseRoomUrl('ws://localhost:1244/local%2Fbare%2Fmain')).toEqual({
      serverUrl: 'ws://localhost:1244',
      encodedRoomName: 'local%2Fbare%2Fmain',
      displayRoomName: 'local/bare/main',
    })
  })
})

describe('participant cards', () => {
  it('unions awareness, scopes and overlay keys', () => {
    const now = 2_000_000
    const presences: Presence[] = [
      { user: { name: 'Rohan', kind: 'human', color: '#111' }, status: 'viewing', lastActive: now - 2_000 },
      { user: { name: 'Rohan', kind: 'agent', color: '#222' }, status: 'working', lastActive: now - 1_000 },
    ]
    const scope: Scope = { by: 'Kieran', byKind: 'agent', area: 'auth', summary: 'tokens', paths: ['src/auth'], at: 1 }
    const oldClaim: Claim = { id: 'c1', path: 'src/auth/token.ts', from: 2, to: 4, by: 'Kieran', byKind: 'agent', intent: 'rotate token', at: now - 11 * 60_000 }
    const result = deriveParticipants({
      presences,
      scopes: [['Kieran', scope]],
      overlayPeople: ['Ada'],
      changesByPerson: new Map([['Rohan', ['src/ui.ts']], ['Kieran', ['src/auth/token.ts']], ['Ada', ['README.md']]]),
      claims: [oldClaim],
      now,
    })
    expect(result.map(person => person.name)).toEqual(['Ada', 'Kieran', 'Rohan'])
    expect(result.find(person => person.name === 'Rohan')).toMatchObject({ online: true, files: ['src/ui.ts'] })
    expect(result.find(person => person.name === 'Kieran')).toMatchObject({ online: false, claims: [{ stale: true }] })
  })

  it('derives one state pill with operational states taking precedence', () => {
    const base = { online: true, behindBase: false, statuses: [] as { kind: 'agent'; status: string }[], claims: [] as (Claim & { stale: boolean })[] }
    const claim: Claim & { stale: boolean } = {
      id: 'c', path: 'src/parser.ts', from: 1, to: 3, by: 'Ada', byKind: 'agent', intent: 'rename parser', at: 1, stale: false,
      plans: [{ kind: 'rename', symbol: 'parse', detail: 'parse_payload' }],
    }
    expect(deriveStatePill({ ...base, online: false })).toBe('offline')
    expect(deriveStatePill({ ...base, statuses: [{ kind: 'agent', status: 'waiting on Rohan' }] })).toBe('waiting on Rohan')
    expect(deriveStatePill({ ...base, behindBase: true })).toBe('behind base')
    expect(deriveStatePill({ ...base, statuses: [{ kind: 'agent', status: 'ahead by 1' }] })).toBe('ahead (unpushed)')
    expect(deriveStatePill({ ...base, claims: [claim] })).toBe('editing parse')
    expect(deriveStatePill(base)).toBe('idle')
  })
})


describe('roomNameParts', () => {
  it.each([
    ['github.com/rohanz/room/main', { host: 'github.com', owner: 'rohanz', repo: 'room', branch: 'main', local: false }],
    ['local/room/main', { repo: 'room', branch: 'main', local: true }],
    ['git/gitlab.com/team/room/main', { host: 'gitlab.com', owner: 'team', repo: 'room', branch: 'main', local: false }],
    ['github.com/rohanz/room/feature/header/chips', { host: 'github.com', owner: 'rohanz', repo: 'room', branch: 'feature/header/chips', local: false }],
    ['local/room/feature/header', { repo: 'room', branch: 'feature/header', local: true }],
    ['git/gitlab.com/team/room/feature/header', { host: 'gitlab.com', owner: 'team', repo: 'room', branch: 'feature/header', local: false }],
    ['demo', { repo: 'demo', branch: '', local: false }],
  ])('parses %s', (name, expected) => {
    expect(roomNameParts(name)).toEqual(expected)
  })
})

// Minimal DOM surface for the header, following the other render tests.
class HeaderElement {
  attributes = new Map<string, string>()
  events = new Map<string, unknown>()
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  addEventListener(name: string, fn: unknown) { this.events.set(name, fn) }
  className = ''; title = ''; children: (HeaderElement | string)[] = []
  classList = { toggle: vi.fn() }
  append(...children: (HeaderElement | string)[]) { this.children.push(...children) }
  get textContent(): string { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join('') }
  set textContent(value: string) { this.children = [value] }
  find(cls: string): HeaderElement | undefined {
    return this.className === cls ? this : this.children.flatMap(c => typeof c === 'string' ? [] : [c.find(cls)]).find(Boolean)
  }
}

describe('room header', () => {
  afterEach(() => vi.unstubAllGlobals())
  it.each([
    ['github.com/rohanz/room/feature/header', 'rohanz / room', ['feature/header']],
    ['local/room/main', 'room', ['local', 'main']],
    ['git/gitlab.com/team/room/main', 'team / room', ['main']],
  ])('renders %s with host only in the title', (displayRoomName, label, chips) => {
    vi.stubGlobal('document', { createElement: () => new HeaderElement() })
    const room = new RoomDoc()
    room.metaMap.set('base', 'abcdef123456')
    const conn = {
      displayRoomName, room,
      provider: { awareness: { getStates: () => new Map(), on: vi.fn() } },
      onStatus: (fn: (connected: boolean) => void) => fn(true),
    } as unknown as Conn
    try {
      const element = header(conn) as unknown as HeaderElement
      expect(element.textContent).not.toContain('github.com')
      expect(element.textContent).not.toContain('gitlab.com')
      expect(element.find('room-name')?.textContent).toBe(label)
      expect(element.find('room-name')?.attributes.get('data-tooltip')).toBe(displayRoomName)
      expect(element.children.filter((c): c is HeaderElement => typeof c !== 'string' && c.className === 'room-chip mono').map(c => c.textContent)).toEqual(chips)
      expect(element.textContent).toContain('base abcdef1')
      expect(element.textContent).toContain('0 participants')
    } finally { room.doc.destroy() }
  })
})

// Exercise the real merged-pane render and click handlers without CodeMirror.
class MergeElement extends HeaderElement {
  style = { background: '', opacity: '', setProperty: vi.fn() }
  dataset = {}
  hidden = false
  ariaPressed = ''
  onclick = () => {}
  classList = { toggle: vi.fn(), remove: vi.fn(), add: vi.fn() }
  replaceChildren(...children: (HeaderElement | string)[]) { this.children = children }
  querySelectorAll(selector: string): MergeElement[] {
    const cls = selector.slice(1)
    return this.children.flatMap(c => typeof c === 'string' ? [] : [
      ...(c.className.split(' ').includes(cls) ? [c as MergeElement] : []),
      ...(c as MergeElement).querySelectorAll(selector),
    ])
  }
}

describe('merged pane participant choices', () => {
  afterEach(() => vi.unstubAllGlobals())
  const setup = (online: string[]) => {
    vi.stubGlobal('document', { createElement: () => new MergeElement() })
    const room = new RoomDoc()
    for (const person of ['Ada', 'Ben', 'Cy']) {
      room.setBaseOf(person, 'base')
      for (const path of ['a.ts', 'b.ts']) {
        room.setBaseText('base', path, 'base')
        room.setOverlay(person, path, person)
      }
    }
    const states = new Map<number, unknown>()
    const listeners = new Map<string, () => void>()
    const presence = (names: string[]) => {
      states.clear()
      names.forEach((name, i) => states.set(i, { user: { name, kind: 'agent' } }))
      listeners.get('change')?.()
    }
    presence(online)
    const conn = { room, provider: { awareness: { getStates: () => states, on: (event: string, fn: () => void) => listeners.set(event, fn) } } } as unknown as Conn
    const panel = centrePanel(conn, createFocusState()) as unknown as MergeElement
    const chips = () => panel.querySelectorAll('.merge-chip')
    const selected = () => chips().filter(c => c.ariaPressed === 'true').map(c => c.textContent)
    return { room, panel, presence, chips, selected }
  }

  it('defaults all chips on when no participant with file changes is online', () => {
    const s = setup(['Unrelated'])
    try {
      expect(s.selected()).toEqual(['Ada', 'Ben', 'Cy'])
      expect(s.panel.find('merge-hint muted')?.textContent).toBe("Showing 3 participants' changes")
      expect(s.panel.find('editor-wrap')?.textContent).toContain('Ada')
    } finally { s.room.doc.destroy() }
  })

  it('defaults two online participants on and the offline participant off', () => {
    const s = setup(['Ada', 'Ben'])
    try {
      expect(s.selected()).toEqual(['Ada', 'Ben'])
      expect(s.panel.find('merge-hint muted')?.textContent).toBe('1 offline participants hidden — toggle their chips to include them')
    } finally { s.room.doc.destroy() }
  })

  it('preserves manual toggles and per-file defaults across presence changes and file switches', () => {
    const s = setup(['Ada', 'Ben'])
    try {
      s.chips()[0].onclick()
      s.chips()[2].onclick()
      s.presence(['Ada', 'Cy'])
      expect(s.selected()).toEqual(['Ben', 'Cy'])
      s.panel.querySelectorAll('.file-item')[1].onclick()
      expect(s.selected()).toEqual(['Ada', 'Cy'])
      s.presence([])
      expect(s.selected()).toEqual(['Ada', 'Cy'])
      s.panel.querySelectorAll('.file-item')[0].onclick()
      expect(s.selected()).toEqual(['Ben', 'Cy'])
    } finally { s.room.doc.destroy() }
  })

  it('renders every file participant dot in assigned colours regardless of chips or presence', () => {
    const s = setup(['Ada', 'Ben'])
    try {
      const check = (offline: string[]) => {
        for (const row of s.panel.querySelectorAll('.file-item')) {
          const dots = row.querySelectorAll('.dot')
          expect(dots.map(d => d.style.background)).toEqual(['Ada', 'Ben', 'Cy'].map(colorFor))
          dots.forEach((d, i) => {
            const absent = offline.includes(['Ada', 'Ben', 'Cy'][i])
            expect(d.style.opacity).toBe(absent ? '0.5' : '')
            if (absent) expect(d.title).toBe('offline')
          })
        }
      }
      check(['Cy'])
      s.chips()[0].onclick()
      s.chips()[2].onclick()
      check(['Cy'])
      s.presence([])
      check(['Ada', 'Ben', 'Cy'])
    } finally { s.room.doc.destroy() }
  })
})
