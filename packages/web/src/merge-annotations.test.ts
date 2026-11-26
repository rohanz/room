import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { colorFor } from '@room/shared'
import { classifyNWay } from './merged.ts'
import { renderCodeLines } from './panels.ts'

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
  expect(host.find('conflict-tag')[0].onfocus).toBeUndefined()
  expect(host.find('conflict-tag')[0].events.get('pointerenter')).toBeTypeOf('function')
  expect(host.find('conflict-line')).toHaveLength(6)
})

it('uses theme-aware participant tints, slim separated edge lines, and accessible tooltips', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  expect(css).toContain('--conflict-tint: 22%')
  expect(css).toContain('--conflict-tint: 28%')
  expect(css).toContain('--conflict-red: #B42318')
  expect(css).toContain('--conflict-red: #F97066')
  expect(css).toContain('var(--line-owner) var(--conflict-tint)')
  expect(css).toContain('column-gap: 2px')
  expect(css).toContain('width: 2px')
  expect(css).toContain('font: 11px/17px')
  expect(css).not.toContain('.conflict-gutter')
  expect(css).toContain('#overlay-root { position: fixed;')
  expect(css).not.toContain('.conflict-tooltip')
})

it('numbers merged rows once and uses participant-colored dots only on divergent rows', () => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  const lines = classifyNWay('same\nold\nend\n', [{ name: 'money', text: 'same\nA\nend\n' }, { name: 'tiers', text: 'same\nB\nend\n' }])
  renderCodeLines(host as unknown as HTMLElement, lines, ['money', 'tiers'])
  expect(host.find('line-number').map(n => n.textContent)).toEqual(['1', '2', '3', '4'])
  const rows = host.find('code-line')
  expect(rows.map(r => r.find('line-number').length)).toEqual([1, 1, 1, 1])
  expect(rows.map(r => r.find('dot').length)).toEqual([0, 1, 1, 0])
  expect(rows[1].find('dot')[0].style.background).toBe(colorFor('money'))
  expect(rows[2].find('dot')[0].style.background).toBe(colorFor('tiers'))
  renderCodeLines(host as unknown as HTMLElement, lines, ['money', 'tiers'], undefined, false)
  expect(host.find('line-number')).toHaveLength(8)
  expect(host.find('side-marker')).toHaveLength(0)
})

it('tints all base-relative edits and keeps stronger conflict annotations', () => {
  vi.stubGlobal('document', { createElement: () => new Element() })
  const host = new Element()
  const base = Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`).join('')
  const a = base.replace('line 2\n', 'A only\n').replace('line 8\n', 'joint\n').replace('line 10\nline 11\n', 'A ten\nA eleven\n')
  const b = base.replace('line 5\n', 'B only\n').replace('line 8\n', 'joint\n').replace('line 10\nline 11\n', 'B ten\nB eleven\n')
  const lines = classifyNWay(base, [{ name: 'rohanz+a', text: a }, { name: 'rohanz+tiers', text: b }])
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
    if (line.changedBy.length) return
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
  expect(css.indexOf('.conflict-code-grid .conflict-line')).toBeGreaterThan(css.indexOf('.conflict-code-grid .changed-line'))
})

it('reserves a sticky tag column while full-width rows share the pane scroller', () => {
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
  expect(text.find('conflict-tag')).toHaveLength(1)
  expect(grid.style.gridTemplateColumns).toBe('minmax(0, 1fr) 96px')
  expect(text.style.gridRow).toBe(gutter.style.gridRow)
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  expect(css).toContain('.conflict-code-grid > .line-text { grid-column: 1 / -1; display: grid; grid-template-rows: subgrid; grid-template-columns: minmax(0, 1fr); min-width: 0; overflow: visible; }')
  expect(css).toContain('.conflict-edge { position: sticky; right: 0; z-index: 3; grid-column: 2; display: grid; grid-template-rows: subgrid; column-gap: 2px; justify-content: end; overflow: hidden; }')
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
