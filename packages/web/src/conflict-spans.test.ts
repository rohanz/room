import { afterEach, expect, it, vi } from 'vitest'
import { deriveConflictSpans, type Claim, type Msg } from '@room/shared'
import { collapseConflictTimeline } from './timeline.ts'
import { renderCodeLines } from './panels.ts'

const claims: Claim[] = ['money', 'tiers'].map((by, i) => ({ id: `c${i}`, by, byKind: 'agent', path: 'a.ts', from: 2, to: 7, intent: `update ${by}`, at: 1 }))
const conflict: Msg = { id: 'conflict', type: 'conflict', priority: 'interrupt', from: 'room', fromKind: 'bot', at: 10, claimId: 'c0', otherClaimId: 'c1', path: 'a.ts', text: 'overlap' }
const note = (text: string, at = 20): Msg => ({ id: `note${at}`, type: 'note', priority: 'notify', from: 'room', fromKind: 'bot', to: 'money', at, text })
const base: Msg = { id: 'base', type: 'base', priority: 'notify', from: 'tiers', fromKind: 'agent', at: 30, base: 'new', prev: 'old', commits: 1, paths: ['a.ts'], summary: 'landed' }

it('keeps an overlapping pair open', () => {
  expect(deriveConflictSpans([conflict], claims)[0]).toMatchObject({ from: 2, to: 7, hidden: false })
  expect(deriveConflictSpans([conflict], claims)[0].resolvedBy).toBeUndefined()
})
it('detects release and retains the original range after the claim leaves the map', () => {
  const announce: Msg = { id: 'claim', type: 'claim', priority: 'fyi', from: 'money', fromKind: 'agent', at: 1, claimId: 'c0', path: 'a.ts', from_line: 2, to_line: 7, intent: 'money' }
  const release: Msg = { id: 'release', type: 'release', priority: 'fyi', from: 'money', fromKind: 'agent', at: 20, claimId: 'c0', path: 'a.ts' }
  expect(deriveConflictSpans([announce, conflict, release], claims.slice(1))[0]).toMatchObject({ from: 2, to: 7, resolvedBy: { how: 'released', who: 'money', at: 20 }, hidden: false })
})
it('detects narrowing', () => {
  expect(deriveConflictSpans([conflict], [claims[0], { ...claims[1], from: 8, to: 10, at: 20 }])[0].resolvedBy).toEqual({ how: 'narrowed', who: 'tiers', at: 20 })
})
it('only accepts later clean messages for the exact path and participants', () => {
  expect(deriveConflictSpans([conflict, note("your a.ts and tiers's merge cleanly again")], claims)[0].resolvedBy?.how).toBe('merged clean')
  for (const m of [note("your b.ts and tiers's merge cleanly again"), note("your a.ts and other's merge cleanly again"), note("your a.ts and tiers's merge cleanly again", 5)]) expect(deriveConflictSpans([conflict, m], claims)[0].resolvedBy).toBeUndefined()
})
it('hides spans when the observed base advances, retaining resolution in history', () => {
  expect(deriveConflictSpans([conflict, base], claims, 'new')[0]).toMatchObject({ hidden: true, resolvedBy: { how: 'base moved', at: 30 } })
  expect(deriveConflictSpans([conflict, base], claims, 'old')[0].hidden).toBe(false)
  expect(deriveConflictSpans([conflict, note("your a.ts and tiers's merge cleanly again"), base], claims, 'new')[0]).toMatchObject({ hidden: true, resolvedBy: { how: 'merged clean' } })
})
it('collapses three events into one card, preserving each event', () => {
  const events: Msg[] = [conflict, { ...conflict, id: 'copy', priority: 'notify', at: 11, claimId: 'c1', otherClaimId: 'c0' }, note("your a.ts and tiers's merge cleanly again")]
  const cards = collapseConflictTimeline(events, claims)
  expect(cards).toHaveLength(1)
  expect(cards[0].conflict?.events.map(m => m.id)).toEqual(['conflict', 'copy', 'note20'])
})
it('folds pairwise merge notes and both addressed overlap notifications', () => {
  const notices = [note("your a.ts and tiers's now conflict around lines 2, 7; room_preview_merge(tiers) for detail", 10), note("your a.ts and tiers's merge cleanly again")]
  expect(collapseConflictTimeline(notices)).toHaveLength(1)
  const copies: Msg[] = [{ ...conflict, otherClaimId: '', to: 'tiers', text: "you edited a.ts:2-7 inside money's claim c0" }, { ...conflict, id: 'other', otherClaimId: '', to: 'money', text: "tiers's agent edited a.ts:2-7 inside your claim c0" }]
  expect(collapseConflictTimeline(copies, [claims[0]])).toHaveLength(1)
})

class Element {
  className = ''; children: (Element | string)[] = []; style = { setProperty() {}, gridRow: '', gridColumn: '', gridTemplateColumns: '' }; dataset = {}
  classList = { add: (name: string) => { this.className += ` ${name}` } }
  append(...children: (Element | string)[]) { this.children.push(...children) }
  replaceChildren(...children: (Element | string)[]) { this.children = children }
  find(cls: string): Element[] { return [...(this.className.split(' ').includes(cls) ? [this] : []), ...this.children.flatMap(c => typeof c === 'string' ? [] : c.find(cls))] }
}
afterEach(() => vi.unstubAllGlobals())
it('renders a six-line text conflict as one pill and one bracket', () => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  renderCodeLines(host as unknown as HTMLElement, Array.from({ length: 6 }, (_, i) => ({ text: 'changed', side: i < 3 ? 'a' : 'b', conflict: true })), ['money', 'tiers'])
  expect(host.find('conflict-pill')).toHaveLength(1)
  expect(host.find('conflict-bracket')).toHaveLength(1)
  expect(host.find('conflict-bracket')[0].style.gridRow).toBe('1 / 7')
  expect(host.find('conflict-line')).toHaveLength(6)
})
