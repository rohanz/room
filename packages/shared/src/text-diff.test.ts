import { describe, expect, it } from 'vitest'
import { RoomDoc } from './doc.js'
import { boundedTextDiff } from './text-diff.js'

/** Deterministic pseudo-random generator, so fixtures are the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

/** A single-line JSON fixture shaped like the planner fixtures (subzones.json): numbers and short keys. */
function jsonFixture(seed: number, bytes: number): string {
  const r = rng(seed), rows: string[] = []
  let size = 2
  while (size < bytes) {
    const row = `{"id":"SZ${Math.floor(r() * 1e4)}","lst":${(38 + r() * 8).toFixed(2)},"seniors":${Math.floor(r() * 5000)},"geom":[[${(103.6 + r() * 0.4).toFixed(5)},${(1.2 + r() * 0.25).toFixed(5)}]]}`
    rows.push(row)
    size += row.length + 1
  }
  return `[${rows.join(',')}]`
}

/** A multi-line source file shaped like a rewritten planner.js. */
function sourceFixture(seed: number, lines: number): string {
  const r = rng(seed), out: string[] = []
  for (let i = 0; i < lines; i++) out.push(`  const v${Math.floor(r() * 1e5)} = layer.get('${Math.floor(r() * 1e6).toString(36)}') ?? ${Math.floor(r() * 100)}`)
  return out.join('\n') + '\n'
}

function apply(before: string, ops: [number, string][]): string {
  let out = '', at = 0
  for (const [kind, value] of ops) {
    if (kind === 0) { expect(before.slice(at, at + value.length)).toBe(value); out += value; at += value.length }
    else if (kind === -1) { expect(before.slice(at, at + value.length)).toBe(value); at += value.length }
    else out += value
  }
  expect(at).toBe(before.length)
  return out
}

const changed = (ops: [number, string][]) => ops.filter(([kind]) => kind !== 0).reduce((n, [, v]) => n + v.length, 0)

describe('overlay text diff', () => {
  // 2026-09-28: the lead replaced its collected planner with another worker's version (same paths, unrelated
  // contents). Publishing its own overlay ran an unbounded character diff on the event loop, which pinned the
  // Room MCP process at ~100% CPU for minutes; room_spawn and room_state queued behind it.
  it('publishes a rewrite of large files without an unbounded diff', () => {
    const room = new RoomDoc()
    const pairs: [string, string, string][] = [
      ['app/static/fixtures/planner/subzones.json', jsonFixture(1, 60_000), jsonFixture(2, 60_000)],
      ['app/static/planner/planner.js', sourceFixture(3, 800), sourceFixture(4, 900)],
    ]
    for (const [file, before] of pairs) room.setOverlay('lead', file, before)
    const started = performance.now()
    for (const [file, , after] of pairs) room.setOverlay('lead', file, after)
    const elapsed = performance.now() - started
    for (const [file, , after] of pairs) expect(room.text(file, 'lead')).toBe(after)
    expect(elapsed).toBeLessThan(1000)
  }, 120_000)

  it('keeps a character-level diff for small edits in a large file', () => {
    const before = sourceFixture(5, 5000)
    const lines = before.split('\n')
    lines[10] = lines[10].replace('layer', 'layers')
    lines[2500] = 'inserted line\n' + lines[2500]
    lines.splice(4000, 1)
    const after = lines.join('\n')
    const ops = boundedTextDiff(before, after)
    expect(apply(before, ops)).toBe(after)
    expect(changed(ops)).toBeLessThan(200)
  })

  it('handles CRLF and trailing-newline changes through RoomDoc', () => {
    const room = new RoomDoc()
    const cases = [
      ['one\r\ntwo\r\n', 'one\r\ninserted\r\ntwo\r\n'],
      ['one\r\ntwo\r\n', 'one\r\ntwo'],
      ['one\ntwo', 'one\ntwo\n'],
      ['one\r\ntwo', 'one\ntwo\n'],
    ] as const
    for (const [before, after] of cases) {
      room.setOverlay('p', 'lines.txt', before)
      expect(apply(before, boundedTextDiff(before, after))).toBe(after)
      room.setOverlay('p', 'lines.txt', after)
      expect(room.text('lines.txt', 'p')).toBe(after)
    }
  })

  it('keeps outer claim anchors when an unrelated middle exhausts the character budget', () => {
    const room = new RoomDoc()
    const before = `first\n${'a'.repeat(6_000)}\nlast\n`
    const after = `first\n${'b'.repeat(6_000)}\ninserted\nlast\n`
    room.setOverlay('p', 'large.txt', before)
    const first = room.addClaim({ path: 'large.txt', from: 1, to: 1, by: 'p', byKind: 'agent', intent: 'first' })
    const middle = room.addClaim({ path: 'large.txt', from: 2, to: 2, by: 'p', byKind: 'agent', intent: 'middle' })
    const last = room.addClaim({ path: 'large.txt', from: 3, to: 3, by: 'p', byKind: 'agent', intent: 'last' })
    const ops = boundedTextDiff(before, after)
    expect(apply(before, ops)).toBe(after)
    expect(ops).toContainEqual([-1, 'a'.repeat(6_000)])
    room.setOverlay('p', 'large.txt', after)
    expect(room.text('large.txt', 'p')).toBe(after)
    expect(room.claimRange(first)).toEqual({ from: 1, to: 1 })
    expect(room.claimRange(middle)).toEqual({ from: 2, to: 2 })
    expect(room.claimRange(last)).toEqual({ from: 4, to: 4 })
  })

  it('diffs 100 small rewrites within a comparable time to the previous character diff', () => {
    const before = 'a'.repeat(500), after = 'b'.repeat(500)
    const start = performance.now()
    for (let i = 0; i < 100; i++) expect(apply(before, boundedTextDiff(before, after))).toBe(after)
    expect(performance.now() - start).toBeLessThan(1_000)
  })

  it('shares the character work allowance across many changed hunks', () => {
    const before: string[] = [], after: string[] = []
    for (let i = 0; i < 60; i++) {
      before.push(`${'a'.repeat(100)}x${'a'.repeat(100)}\n`, `keep-${i}\n`)
      after.push(`${'b'.repeat(100)}x${'b'.repeat(100)}\n`, `keep-${i}\n`)
    }
    const original = before.join(''), replacement = after.join('')
    const ops = boundedTextDiff(original, replacement)
    expect(apply(original, ops)).toBe(replacement)
    // Six early hunks can keep their interior x. Later ones replace whole regions
    // after the shared character budget is consumed, while the unchanged lines survive.
    const preserved = ops.filter(([kind, value]) => kind === 0 && value === 'x').length
    expect(preserved).toBeGreaterThanOrEqual(5)
    expect(preserved).toBeLessThanOrEqual(7)
    expect(ops.some(([kind, value]) => kind === 0 && value.includes('keep-59'))).toBe(true)
  })

  it('reproduces the new text for random edits, including surrogate pairs at the edges', () => {
    const r = rng(7)
    const alphabet = ['a', 'b', '\n', ' ', '😀', 'é', '{', '"']
    for (let round = 0; round < 300; round++) {
      const make = (n: number) => Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)])
      const points = make(Math.floor(r() * 60)), before = points.join('')
      const cut = Math.floor(r() * points.length)
      const after = round % 3 === 0 ? make(Math.floor(r() * 60)).join('')
        : [...points.slice(0, cut), ...make(Math.floor(r() * 8)), ...points.slice(cut + Math.floor(r() * 5))].join('')
      const ops = boundedTextDiff(before, after)
      expect(apply(before, ops)).toBe(after)
      for (const [, value] of ops) {
        expect(/^[\uDC00-\uDFFF]/.test(value)).toBe(false)
        expect(/[\uD800-\uDBFF]$/.test(value)).toBe(false)
      }
    }
    const room = new RoomDoc()
    room.setOverlay('p', 'e.txt', 'x😀y')
    room.setOverlay('p', 'e.txt', 'x😁y')
    expect(room.text('e.txt', 'p')).toBe('x😁y')
  })
})
