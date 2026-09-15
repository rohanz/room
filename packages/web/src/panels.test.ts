import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomDoc, roomNameParts, type Claim, type Presence, type Scope } from '@room/shared'
import { parseRoomUrl, type Conn } from './conn.ts'
import { deriveParticipants, deriveStatePill, shortPill, header } from './panels.ts'

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
