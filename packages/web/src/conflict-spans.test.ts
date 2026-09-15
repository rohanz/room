import { deriveConflictSpans } from './conflicts.ts'
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { colorFor, type Claim, type Msg } from '@room/shared'
import { collapseConflictTimeline } from './timeline.ts'
import { classifyThreeWay } from './merged.ts'
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
  attributes = new Map<string, string>()
  events = new Map<string, unknown>()
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  addEventListener(name: string, fn: unknown) { this.events.set(name, fn) }
  className = ''; children: (Element | string)[] = []; properties = new Map<string, string>(); style = { top: '', right: '', minHeight: '', background: '', setProperty: (name: string, value: string) => this.properties.set(name, value), gridRow: '', gridColumn: '', gridTemplateColumns: '' }; dataset = {}
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
  renderCodeLines(host as unknown as HTMLElement, Array.from({ length: 6 }, (_, i) => ({ text: 'changed', side: i < 3 ? 'a' : 'b', changedBy: null, conflict: true })), ['money', 'tiers'])
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
  expect(host.find('conflict-tag')[0].events.get('pointerenter')).toBeTypeOf('function')
  expect(host.find('conflict-line')).toHaveLength(6)
})

it('packs overlapping spans into right-edge lanes, reuses lanes, and includes intent and resolution details', () => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  const span = deriveConflictSpans([conflict], claims)[0]
  renderCodeLines(host as unknown as HTMLElement, Array.from({ length: 12 }, (_, i) => ({ text: 'code', side: 'common', changedBy: null, conflict: false, aLine: i + 1 })), ['money', 'tiers'], undefined, [
    span,
    { ...span, id: 'overlap', people: ['money', 'third'], from: 3, to: 6 },
    { ...span, id: 'resolved', from: 9, to: 11, resolvedBy: { how: 'released', who: 'money', at: 20 } },
  ])
  expect(host.find('conflict-edge')).toHaveLength(1)
  expect(host.find('conflict-code-grid')[0].style.gridTemplateColumns).toBe('minmax(0, 1fr) 96px')
  expect(host.find('code-line').every(row => row.style.gridColumn === '1')).toBe(true)
  expect(host.find('conflict-edge')[0].style.gridTemplateColumns).toBe('repeat(2, 2px)')
  const bars = host.find('conflict-bar')
  expect(bars.map(bar => bar.style.gridColumn)).toEqual(['1', '2', '1'])
  expect(bars.map(bar => bar.style.gridRow)).toEqual(['2 / 8', '3 / 7', '9 / 12'])
  expect(host.find('conflict-tag')[1].ariaLabel).toContain('third')
  expect(host.find('conflict-tag').map(label => label.children[0])).toEqual(['both claimed', 'both claimed', 'resolved'])
  expect(host.find('conflict-tag')[0].ariaLabel).toContain('money: update money')
  expect(host.find('conflict-tag')[0].ariaLabel).toContain('tiers: update tiers')
  expect(bars[2].className).toContain('resolved')
  expect(host.find('conflict-tag')[2].ariaLabel).toContain('resolved · money released')
  expect(host.find('resolved-conflict-line')).toHaveLength(3)
})
it('uses theme-aware participant tints, slim separated edge lines, and accessible tooltips', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  expect(css).toContain('--conflict-tint: 22%')
  expect(css).toContain('--conflict-tint: 28%')
  expect(css).toContain('--conflict-red: #B42318')
  expect(css).toContain('--conflict-red: #F97066')
  expect(css).toContain('--claim-amber: #B54708')
  expect(css).toContain('--claim-amber: #F79009')
  expect(css).toContain('.conflict-bar.claim-overlap { background: var(--claim-amber); color: var(--claim-amber); }')
  expect(css).toContain('var(--line-owner) var(--conflict-tint)')
  expect(css).toContain('column-gap: 2px')
  expect(css).toContain('width: 2px')
  expect(css).toContain('font: 11px/16px')
  expect(css).not.toContain('.conflict-gutter')
  expect(css).toContain('#overlay-root { position: fixed;')
  expect(css).not.toContain('.conflict-tooltip')
})

it('does not duplicate a text region with a recorded conflict and preserves outside ownership', () => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  const span = deriveConflictSpans([conflict], claims)[0]
  renderCodeLines(host as unknown as HTMLElement, Array.from({ length: 8 }, (_, i) => ({
    text: 'code', side: i < 4 ? 'a' : 'b', changedBy: null, conflict: i >= 1 && i <= 6, aLine: i + 1,
  })), ['money', 'tiers'], undefined, [span])
  expect(host.find('conflict-tag')).toHaveLength(1)
  expect(host.find('conflict-tag')[0].children[0]).toBe('conflict')
  expect(host.find('conflict-bar')[0].className).not.toContain('claim-overlap')
  expect(host.find('conflict-tag')[0].ariaLabel).toContain('both claimed')
  expect(host.find('conflict-tag')[0].ariaLabel).toContain('update tiers')
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

it('numbers merged rows once and uses participant-colored dots only on divergent rows', () => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  const lines = classifyThreeWay('same\nold\nend\n', 'same\nA\nend\n', 'same\nB\nend\n')
  renderCodeLines(host as unknown as HTMLElement, lines, ['money', 'tiers'])
  expect(host.find('line-number').map(n => n.textContent)).toEqual(['1', '2', '3', '4'])
  const rows = host.find('code-line')
  expect(rows.map(r => r.find('line-number').length)).toEqual([1, 1, 1, 1])
  expect(rows.map(r => r.find('dot').length)).toEqual([0, 1, 1, 0])
  expect(rows[1].find('dot')[0].style.background).toBe(colorFor('money'))
  expect(rows[2].find('dot')[0].style.background).toBe(colorFor('tiers'))
  renderCodeLines(host as unknown as HTMLElement, lines, ['money', 'tiers'], undefined, [], false)
  expect(host.find('line-number')).toHaveLength(8)
  expect(host.find('side-marker')).toHaveLength(0)
})

it.each(['identical', 'clean', 'conflicting'])('classifies %s text with overlapping claims and includes both intents and plans', kind => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  const base = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n'
  const a = kind === 'identical' ? base : base.replace('two', 'A')
  const b = kind === 'conflicting' ? base.replace('two', 'B') : kind === 'clean' ? base.replace('seven', 'B') : base
  const cs = claims.map(c => ({ ...c, plans: [{ kind: 'add' as const, symbol: c.by + 'Helper' }] }))
  const spans = deriveConflictSpans([], cs)
  renderCodeLines(host as unknown as HTMLElement, classifyThreeWay(base, a, b), ['money', 'tiers'],
    (person, line) => cs.filter(c => c.by === person && c.from <= line && c.to >= line), spans)
  const tags = host.find('conflict-tag')
  const red = host.find('conflict-bar').filter(b => !b.className.includes('claim-overlap'))
  expect(red).toHaveLength(kind === 'conflicting' ? 1 : 0)
  expect(tags[0].children[0]).toBe(kind === 'conflicting' ? 'conflict' : 'both claimed')
  for (const tag of tags) {
    expect(tag.ariaLabel).toContain('money: update money (plans: add moneyHelper)')
    expect(tag.ariaLabel).toContain('tiers: update tiers (plans: add tiersHelper)')
    expect(tag.ariaLabel).toContain('a.ts:2-7')
    expect(tag.ariaLabel).toContain('Unresolved: both claimed')
  }
  if (kind !== 'conflicting') expect(host.find('conflict-line')).toHaveLength(0)
  else expect(red[0].style.gridRow).toBe('2 / 4')
})

it('tints all base-relative edits and keeps stronger conflict annotations', () => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  const base = Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`).join('')
  const a = base.replace('line 2\n', 'A only\n').replace('line 8\n', 'joint\n').replace('line 10\nline 11\n', 'A ten\nA eleven\n')
  const b = base.replace('line 5\n', 'B only\n').replace('line 8\n', 'joint\n').replace('line 10\nline 11\n', 'B ten\nB eleven\n')
  const lines = classifyThreeWay(base, a, b)
  renderCodeLines(host as unknown as HTMLElement, lines, ['rohanz+a', 'rohanz+tiers'])
  const rows = host.find('code-line')
  for (const [index, author, color] of [[1, 'rohanz+a', colorFor('rohanz+a')], [4, 'rohanz+tiers', colorFor('rohanz+tiers')], [7, 'rohanz+a and rohanz+tiers', colorFor('rohanz+a')]] as const) {
    expect(rows[index].className).toContain('changed-line')
    expect(rows[index].className).not.toContain('conflict-line')
    expect(rows[index].properties.get('--line-change-owner')).toBe(color)
    expect(rows[index].attributes.get('aria-label')).toContain('Show details')
    expect(rows[index].find('dot')[0].style.background).toBe(color)
  }
  lines.forEach((line, i) => {
    if (line.changedBy !== null) return
    expect(rows[i].className).not.toContain('changed-line')
    expect(rows[i].properties.has('--line-change-owner')).toBe(false)
    expect(rows[i].find('dot')).toHaveLength(0)
  })
  expect(host.find('conflict-line')).toHaveLength(4)
  expect(host.find('conflict-tag').map(t => t.textContent)).toEqual(['conflict'])
  expect(host.find('conflict-bar')[0].style.gridRow).toBe('10 / 14')
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  expect(css).toContain('--change-tint: 14%')
  expect(css).toContain('--change-tint: 20%')
  expect(css).toContain('var(--line-change-owner) var(--change-tint)')
  expect(css.indexOf('.conflict-code-grid :is(.conflict-line')).toBeGreaterThan(css.indexOf('.conflict-code-grid .changed-line'))
  expect(css).toContain('.claim-overlap-line:not(.conflict-line):not(.changed-line)')
})


it.each([false, true])('stacks open tags above resolved tags at distinct offsets (text conflict: %s)', textConflict => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  const span = deriveConflictSpans([conflict], claims)[0]
  renderCodeLines(host as unknown as HTMLElement, Array.from({ length: 8 }, (_, i) => ({
    text: 'code', side: 'a', changedBy: 'a', conflict: textConflict && i >= 1 && i <= 6, aLine: i + 1,
  })), ['money', 'tiers'], undefined, [
    { ...span, resolvedBy: { how: 'released', who: 'money', at: 20 } }, span,
  ])
  const tags = host.find('conflict-tag')
  expect(tags.map(t => t.textContent)).toEqual([textConflict ? 'conflict' : 'both claimed', 'resolved'])
  expect(tags.map(t => t.style.top)).toEqual(['0px', '20px'])
  expect(host.find('code-line')[1].style.minHeight).toBe('40px')
  expect(host.find('conflict-bar').map(b => b.style.gridColumn)).toEqual(['1', '2'])
})

it('collapses multiple resolved same-line regions into one pill while retaining edge bars', () => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  const span = deriveConflictSpans([conflict], claims)[0]
  renderCodeLines(host as unknown as HTMLElement, Array.from({ length: 10 }, (_, i) => ({
    text: 'code', side: 'common', changedBy: null, conflict: false, aLine: i + 1,
  })), ['money', 'tiers'], undefined, [
    ...[3, 4, 5].map(to => ({ ...span, to, resolvedBy: { how: 'released' as const, who: 'money', at: to } })),
    span, { ...span, to: 8 },
    { ...span, from: 3, to: 9 },
  ])
  const tags = host.find('conflict-tag')
  expect(tags.map(t => t.textContent)).toEqual(['both claimed', 'both claimed', '3 resolved', 'both claimed'])
  expect(tags.slice(0, 3).map(t => t.style.top)).toEqual(['0px', '20px', '40px'])
  expect(tags[2].className).toContain('resolved')
  expect(tags[2].ariaLabel.match(/money released/g)).toHaveLength(3)
  expect(host.find('conflict-bar')).toHaveLength(6)
  const rowHeights = host.find('code-line').map(r => parseFloat(r.style.minHeight) || 17)
  const tops = host.find('conflict-bar').flatMap(bar => bar.find('conflict-tag').map(tag =>
    rowHeights.slice(0, Number(bar.style.gridRow.split(' / ')[0]) - 1).reduce((a, b) => a + b, 0) + parseFloat(tag.style.top)))
  expect(new Set(tops).size).toBe(tags.length)
  const sorted = [...tops].sort((a, b) => a - b)
  expect(sorted.slice(1).every((top, i) => top - sorted[i] >= 20)).toBe(true)
})

it.each([
  { open: 1, resolved: 3, labels: ['conflict', '3 resolved'] },
  { open: 2, resolved: 1, labels: ['conflict', 'both claimed', 'resolved'] },
  { open: 0, resolved: 2, labels: ['2 resolved'] },
])('renders the exact same-line stack for $open open and $resolved resolved regions', ({ open, resolved, labels }) => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  const span = deriveConflictSpans([conflict], claims)[0]
  renderCodeLines(host as unknown as HTMLElement, Array.from({ length: 8 }, (_, i) => ({
    text: 'code', side: 'a', changedBy: null, conflict: open > 0 && i === 1, aLine: i + 1,
  })), ['money', 'tiers'], undefined, [
    ...(open === 2 ? [{ ...span, people: ['money', 'third'], claims: claims.map(c => c.by === 'tiers' ? { ...c, by: 'third' } : c) }] : []),
    ...Array.from({ length: resolved }, (_, i) => ({
      ...span, to: i + 3, resolvedBy: { how: 'released' as const, who: 'money', at: i + 20 },
    })),
  ])
  const tags = host.find('conflict-tag')
  expect(tags.map(t => t.textContent)).toEqual(labels)
  expect(tags).toHaveLength(labels.length)
  const pill = tags.at(-1)!
  expect(pill.className).toContain('resolved')
  for (let i = 0; i < resolved; i++) {
    expect(pill.ariaLabel).toContain(`a.ts:2-${i + 3}`)
  }
  expect(pill.ariaLabel).toContain('money ↔ tiers')
  expect(pill.ariaLabel.match(/money released/g)).toHaveLength(resolved)
})

it('reserves a tag column while full-width rows contain scrolling code cells', () => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  renderCodeLines(host as unknown as HTMLElement, [{
    text: 'long line '.repeat(200), side: 'a', changedBy: null, conflict: true, aLine: 1,
  }], ['money', 'tiers'])
  const grid = host.find('conflict-code-grid')[0]
  const text = host.find('line-text')[0]
  const gutter = host.find('conflict-edge')[0]
  expect(grid.children).toEqual([text, gutter, ...host.find('line-annotation')])
  expect(text.find('code-line')).toHaveLength(1)
  expect(text.find('conflict-tag')).toHaveLength(0)
  expect(grid.style.gridTemplateColumns).toBe('minmax(0, 1fr) 96px')
  expect(text.style.gridRow).toBe(gutter.style.gridRow)
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  expect(css).toContain('.conflict-code-grid > .line-text { grid-column: 1 / -1; display: grid; grid-template-rows: subgrid; grid-template-columns: minmax(0, 1fr); min-width: 0; }')
  expect(css).toContain('.conflict-edge { grid-column: 2; display: grid; grid-template-rows: subgrid; column-gap: 2px; justify-content: end; overflow: hidden; }')
  // Model the grid's rects at narrow and wide viewport sizes. The scrollable
  // content can be wider, but its visible box ends before every tag's box.
  for (const width of [240, 800]) {
    const textRect = { left: 0, right: width - 96 }
    for (const bar of gutter.find('conflict-bar')) for (const tag of bar.find('conflict-tag')) {
      const lane = Number(bar.style.gridColumn) - 1
      const barRight = width - (gutter.find('conflict-bar').length - 1 - lane) * 4
      const tagRight = barRight - parseFloat(tag.style.right)
      const tagRect = { left: tagRight - 80, right: tagRight }
      expect(tagRect.left).toBeGreaterThanOrEqual(textRect.right)
      expect(tagRect.right).toBeLessThanOrEqual(width)
    }
  }
})

it('uses the specified theme tints and 60% owner borders with at least 4.5:1 code contrast', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  expect(css).toContain('--change-tint: 14%; --conflict-tint: 22%')
  expect(css.match(/--change-tint: 20%; --conflict-tint: 28%/g)).toHaveLength(2)
  expect(css).toContain('border-left: 2px solid transparent; box-shadow: none; color: var(--code-ink)')
  expect(css).toContain('border-left-color: color-mix(in srgb, var(--line-change-owner) 60%, transparent)')
  const rgb = (hex: string) => hex.match(/[a-f0-9]{2}/gi)!.map(c => parseInt(c, 16) / 255)
  const luminance = (rgb: number[]) => rgb.map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0)
  const identity = readFileSync(new URL('../../shared/src/identity.ts', import.meta.url), 'utf8')
  const palette = identity.match(/#[a-f0-9]{6}/gi)!.map(rgb).sort((a, b) => luminance(a) - luminance(b))
  expect(palette.length).toBeGreaterThan(0)
  // Check every owner, beginning with the darkest; dark mode's worst case may be brighter.
  const themes = [...css.matchAll(/--code-bg: (#[a-f0-9]{6}); --code-gutter: #[a-f0-9]{6}; --code-ink: (#[a-f0-9]{6})/gi)]
  expect(themes).toHaveLength(3)
  for (const [index, theme] of themes.entries()) {
    const bg = rgb(theme[1]), ink = luminance(rgb(theme[2]))
    for (const tint of index === 0 ? [.14, .22] : [.20, .28]) for (const owner of palette) {
      const background = luminance(bg.map((c, i) => c * (1 - tint) + owner[i] * tint))
      expect((Math.max(ink, background) + .05) / (Math.min(ink, background) + .05)).toBeGreaterThanOrEqual(4.5)
    }
  }
})
