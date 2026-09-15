import { deriveConflictSpans } from './conflicts.ts'
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { colorFor, type Claim, type Msg } from '@room/shared'
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
  expect(deriveConflictSpans([conflict, note("your a.ts and tiers's merge cleanly again")], claims)[0].resolvedBy).toBeUndefined()
  for (const m of [note("your b.ts and tiers's merge cleanly again"), note("your a.ts and other's merge cleanly again"), note("your a.ts and tiers's merge cleanly again", 5)]) expect(deriveConflictSpans([conflict, m], claims)[0].resolvedBy).toBeUndefined()
})
it('hides spans when the observed base advances, retaining resolution in history', () => {
  expect(deriveConflictSpans([conflict, base], claims, 'new')[0]).toMatchObject({ hidden: true, resolvedBy: { how: 'base moved', at: 30 } })
  expect(deriveConflictSpans([conflict, base], claims, 'old')[0].hidden).toBe(false)
  expect(deriveConflictSpans([conflict, note("your a.ts and tiers's merge cleanly again"), base], claims, 'new')[0]).toMatchObject({ hidden: true, resolvedBy: { how: 'base moved' } })
})
it('collapses matching conflicts but keeps pair-only resolution notes separate', () => {
  const events: Msg[] = [conflict, { ...conflict, id: 'copy', priority: 'notify', at: 11, claimId: 'c1', otherClaimId: 'c0' }, note("your a.ts and tiers's merge cleanly again")]
  const cards = collapseConflictTimeline(events, claims)
  expect(cards).toHaveLength(2)
  expect(cards.find(card => card.conflict)?.conflict?.events.map(m => m.id)).toEqual(['conflict', 'copy'])
})
it('folds pairwise merge notes and both addressed overlap notifications', () => {
  const notices = [note("your a.ts and tiers's now conflict around lines 2, 7; room_preview_merge(tiers) for detail", 10), note("your a.ts and tiers's merge cleanly again")]
  expect(collapseConflictTimeline(notices)).toHaveLength(1)
  const copies: Msg[] = [{ ...conflict, otherClaimId: '', to: 'tiers', text: "you edited a.ts:2-7 inside money's claim c0" }, { ...conflict, id: 'other', otherClaimId: '', to: 'money', text: "tiers's agent edited a.ts:2-7 inside your claim c0" }]
  expect(collapseConflictTimeline(copies, [claims[0]])).toHaveLength(1)
})

class Element {
  className = ''; children: (Element | string)[] = []; properties = new Map<string, string>(); style = { setProperty: (name: string, value: string) => this.properties.set(name, value), gridRow: '', gridColumn: '', gridTemplateColumns: '' }; dataset = {}
  ariaLabel = ''; onfocus?: () => void; onmouseenter?: () => void
  get textContent(): string { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join('') }
  classList = { add: (name: string) => { this.className += ` ${name}` } }
  append(...children: (Element | string)[]) { this.children.push(...children) }
  replaceChildren(...children: (Element | string)[]) { this.children = children }
  find(cls: string): Element[] { return [...(this.className.split(' ').includes(cls) ? [this] : []), ...this.children.flatMap(c => typeof c === 'string' ? [] : c.find(cls))] }
}
afterEach(() => vi.unstubAllGlobals())
it('renders one right-edge tag and tints each conflict line by its participant', () => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  renderCodeLines(host as unknown as HTMLElement, Array.from({ length: 6 }, (_, i) => ({ text: 'changed', side: i < 3 ? 'a' : 'b', conflict: true })), ['money', 'tiers'])
  expect(host.find('conflict-tag').map(label => label.children[0])).toEqual(['conflict'])
  expect(host.find('conflict-bracket')).toHaveLength(0)
  expect(host.find('conflict-bar')).toHaveLength(1)
  const bar = host.find('conflict-bar')[0]
  expect(bar.style.gridRow).toBe('1 / 7')
  expect(host.find('conflict-line').map(row => row.properties.get('--line-owner'))).toEqual([
    ...Array(3).fill(colorFor('money')), ...Array(3).fill(colorFor('tiers')),
  ])
  expect(host.find('conflict-gutter')).toHaveLength(0)
  expect(host.find('conflict-span-gutter')).toHaveLength(0)
  expect(host.find('conflict-tag')[0].ariaLabel).toContain('money ↔ tiers')
  expect(host.find('conflict-tag')[0].ariaLabel).toContain('Unresolved')
  expect(host.find('conflict-tag')[0].onfocus).toBeTypeOf('function')
  expect(host.find('conflict-tag')[0].onmouseenter).toBeTypeOf('function')
  expect(host.find('conflict-line')).toHaveLength(6)
})

it('packs overlapping spans into right-edge lanes, reuses lanes, and includes intent and resolution details', () => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  const span = deriveConflictSpans([conflict], claims)[0]
  renderCodeLines(host as unknown as HTMLElement, Array.from({ length: 12 }, (_, i) => ({ text: 'code', side: 'common', conflict: false, aLine: i + 1 })), ['money', 'tiers'], undefined, [
    span,
    { ...span, id: 'overlap', people: ['money', 'third'], from: 3, to: 6 },
    { ...span, id: 'resolved', from: 9, to: 11, resolvedBy: { how: 'released', who: 'money', at: 20 } },
  ])
  expect(host.find('conflict-edge')).toHaveLength(1)
  expect(host.find('conflict-code-grid')[0].style.gridTemplateColumns).toBe('minmax(max-content, 1fr) max-content')
  expect(host.find('code-line').every(row => row.style.gridColumn === '1')).toBe(true)
  expect(host.find('conflict-edge')[0].style.gridTemplateColumns).toBe('repeat(2, 2px)')
  const bars = host.find('conflict-bar')
  expect(bars.map(bar => bar.style.gridColumn)).toEqual(['1', '2', '1'])
  expect(bars.map(bar => bar.style.gridRow)).toEqual(['2 / 8', '3 / 7', '9 / 12'])
  expect(host.find('conflict-tag')[1].ariaLabel).toContain('third')
  expect(host.find('conflict-tag').map(label => label.children[0])).toEqual(['conflict', 'conflict', 'resolved'])
  expect(host.find('conflict-tag')[0].ariaLabel).toContain('money: update money')
  expect(host.find('conflict-tag')[0].ariaLabel).toContain('tiers: update tiers')
  expect(bars[2].className).toContain('resolved')
  expect(host.find('conflict-tag')[2].ariaLabel).toContain('resolved · money released')
  expect(host.find('resolved-conflict-line')).toHaveLength(3)
})
it('uses theme-aware participant tints, slim separated edge lines, and accessible tooltips', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  expect(css).toContain('--conflict-tint: 12%')
  expect(css).toContain('--conflict-tint: 18%')
  expect(css).toContain('--conflict-red: #B42318')
  expect(css).toContain('--conflict-red: #F97066')
  expect(css).toContain('var(--line-owner) var(--conflict-tint)')
  expect(css).toContain('column-gap: 2px')
  expect(css).toContain('width: 2px')
  expect(css).toContain('font: 11px/16px')
  expect(css).not.toContain('.conflict-gutter')
  expect(css).toContain('.conflict-tag:hover .conflict-tooltip, .conflict-tag:focus .conflict-tooltip { display: block; }')
})

it('does not duplicate a text region with a recorded conflict and preserves outside ownership', () => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  const span = deriveConflictSpans([conflict], claims)[0]
  renderCodeLines(host as unknown as HTMLElement, Array.from({ length: 8 }, (_, i) => ({
    text: 'code', side: i < 4 ? 'a' : 'b', conflict: i >= 1 && i <= 6, aLine: i + 1,
  })), ['money', 'tiers'], undefined, [span])
  expect(host.find('conflict-tag')).toHaveLength(1)
  expect(host.find('conflict-tag')[0].ariaLabel).toContain('update money')
  const rows = host.find('code-line')
  expect(rows[0].className).not.toContain('conflict-line')
  expect(rows[7].className).not.toContain('conflict-line')
  expect(rows[0].properties.get('--line-owner')).toBe(colorFor('money'))
  expect(rows[7].properties.get('--line-owner')).toBe(colorFor('tiers'))
})

it('ignores releases from earlier sessions and requires exact claim ids at or after opening', () => {
  const oldRelease: Msg = { id: 'old-release', type: 'release', priority: 'fyi', from: 'money', fromKind: 'agent', at: 5, claimId: 'c0', path: 'a.ts' }
  const unrelated = { ...oldRelease, id: 'unrelated', at: 11, claimId: 'previous-session' }
  expect(deriveConflictSpans([oldRelease, conflict, unrelated], claims)[0].resolvedBy).toBeUndefined()
  const exact = { ...oldRelease, id: 'exact', at: 10 }
  expect(deriveConflictSpans([conflict, exact], claims)[0].resolvedBy).toMatchObject({ how: 'released', at: 10 })
})

it('keeps earlier and current claim sessions separate even for one-claim edit conflicts', () => {
  const oldClaim = { ...claims[0], id: 'old-c0' }
  const oldConflict = { ...conflict, id: 'old-conflict', claimId: oldClaim.id, otherClaimId: '', to: 'tiers', text: "you edited a.ts:2-7 inside money's claim", at: 2 }
  const release: Msg = { id: 'release-old', type: 'release', priority: 'fyi', from: 'money', fromKind: 'agent', at: 5, claimId: oldClaim.id, path: 'a.ts' }
  const current = { ...oldConflict, id: 'new-conflict', claimId: 'c0', at: 10 }
  const spans = deriveConflictSpans([oldConflict, release, current], [oldClaim, claims[0]])
  expect(spans.find(s => s.claimIds.includes('old-c0'))?.resolvedBy?.how).toBe('released')
  expect(spans.find(s => s.claimIds.includes('c0'))?.resolvedBy).toBeUndefined()
})
