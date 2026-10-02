import { describe, expect, it } from 'vitest'
import { claimInMyLines, mapRange, prepareClaimLineMap } from './claims.js'

/** A CHANGES.rst-shaped file: version headings, blank lines and many alike entry lines. */
function changelog(lines: number): string {
  const out: string[] = []
  for (let v = 0; out.length < lines; v++) {
    out.push(`Version 3.${99 - v}.0`, '-------------', '', 'Released 2026-01-01', '')
    for (let i = 0; i < 20 && out.length < lines; i++) out.push(`-   Fix item ${v}.${i}. :issue:\`${v * 20 + i}\``)
    out.push('')
  }
  return out.slice(0, lines).join('\n') + '\n'
}

/** Insert lines after 1-based line `after`. */
function insertAt(text: string, after: number, add: string[]): string {
  const lines = text.slice(0, -1).split('\n')
  lines.splice(after, 0, ...add)
  return lines.join('\n') + '\n'
}

describe('claims across bases', () => {
  it('moves a claim past inserted lines and widens a changed hunk', () => {
    expect(claimInMyLines({ from: 1, to: 1 }, 'x = 1\n', 'x = 1\n')).toEqual({ from: 1, to: 1, approximate: false })
    expect(claimInMyLines({ from: 1, to: 1 }, 'old\n', 'inserted\nold\n')).toEqual({ from: 2, to: 2, approximate: false })
    expect(mapRange('a\nb\nc\n', 'new\na\nb\nc\n', { from: 2, to: 2 })).toEqual({ from: 3, to: 3 })
    expect(mapRange('a\nb\nc\n', 'a\nB\nC\nc\n', { from: 2, to: 2 })).toEqual({ from: 2, to: 3 })
    expect(mapRange('a\nb\nc\n', 'a\nb\nnew\nc\n', { from: 2, to: 3 })).toEqual({ from: 2, to: 4 })
  })

  it('keeps the claimed lines, marked approximate, when the owner text is unavailable', () => {
    const local = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    expect(claimInMyLines({ from: 4, to: 6 }, undefined, local)).toEqual({ from: 4, to: 6, approximate: true })
    // Past my end of file the holder's numbers stay theirs: clamping them would invent an overlap at my last line.
    expect(claimInMyLines({ from: 4, to: 6 }, undefined, 'a\nb\nc\n')).toEqual({ from: 4, to: 6, approximate: true })
    expect(claimInMyLines({ from: 1000, to: 1010 }, undefined, 'a\n'.repeat(100))).toEqual({ from: 1000, to: 1010, approximate: true })
  })

  it('maps a long file exactly when it differs by a line', () => {
    const owner = Array.from({ length: 1001 }, (_, i) => `line ${i}`).join('\n')
    expect(claimInMyLines({ from: 500, to: 500 }, owner, `inserted\n${owner}`)).toEqual({ from: 501, to: 501, approximate: false })
  })

  it('maps entries added in different places of a 3,000-line changelog exactly', () => {
    const base = changelog(3000)
    const owner = insertAt(base, 6, ['-   Owner entry at the top. :issue:`6`', ''])
    const local = insertAt(insertAt(insertAt(base, 2990, ['-   Mine near the end.']), 1500, ['-   Mine in the middle.']), 9, ['-   Mine at the top. :issue:`9`'])
    const map = prepareClaimLineMap(owner, local)
    // The owner's new lines 7-8 are not in my text: they map to my line 7, above my insertion at line 10.
    expect(map({ from: 7, to: 8 })).toEqual({ from: 7, to: 7, approximate: false })
    expect(map({ from: 7, to: 8 }).to).toBeLessThan(10)
    // Base line 1400 is the owner's line 1402 and my line 1401.
    expect(map({ from: 1402, to: 1402 })).toEqual({ from: 1401, to: 1401, approximate: false })
    // The owner's last line is my last line.
    expect(map({ from: 3002, to: 3002 })).toEqual({ from: 3003, to: 3003, approximate: false })
  })

  it('maps every kept line to its exact place across scattered insertions and deletions', () => {
    let seed = 7
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n }
    for (let round = 0; round < 50; round++) {
      const base = Array.from({ length: 40 + random(400) }, (_, i) => `base ${i}`)
      // Each side drops some base lines and adds its own: a kept base line maps to its index on my side.
      const side = (tag: string) => {
        const lines: string[] = [], at = new Map<number, number>()
        base.forEach((line, i) => {
          if (random(8) === 0) lines.push(`${tag} ${round}.${i}`)
          if (random(10) === 0) return
          at.set(i, lines.length + 1)
          lines.push(line)
        })
        return { text: lines.join('\n') + '\n', at }
      }
      const owner = side('owner'), local = side('local')
      const map = prepareClaimLineMap(owner.text, local.text)
      for (const [i, line] of owner.at) {
        const mine = local.at.get(i)
        if (mine !== undefined) expect(map({ from: line, to: line })).toEqual({ from: mine, to: mine, approximate: false })
      }
    }
  })

  it('degrades only the unmappable middle of a long file, never to the whole file', () => {
    const head = Array.from({ length: 50 }, (_, i) => `head ${i}`), tail = Array.from({ length: 50 }, (_, i) => `tail ${i}`)
    const owner = [...head, ...Array.from({ length: 2000 }, (_, i) => `owner ${i}`), ...tail].join('\n') + '\n'
    const local = [...head, ...Array.from({ length: 2001 }, (_, i) => `local ${i}`), ...tail].join('\n') + '\n'
    const map = prepareClaimLineMap(owner, local)
    expect(map({ from: 10, to: 10 })).toEqual({ from: 10, to: 10, approximate: false })
    expect(map({ from: 2080, to: 2080 })).toEqual({ from: 2081, to: 2081, approximate: false })
    // Lines in the undiffed middle keep the holder's own numbers, unclamped and marked approximate.
    expect(map({ from: 1000, to: 1001 })).toEqual({ from: 1000, to: 1001, approximate: true })
    expect(map({ from: 40, to: 1000 })).toEqual({ from: 40, to: 1000, approximate: true })
  })

  it('never moves an unmappable claim to my end of file', () => {
    // rc12 review: two unrelated copies; the owner's line 4,000 is past my 2,000 lines and must not become my line 2,000.
    const owner = Array.from({ length: 5000 }, (_, i) => `owner ${i}`).join('\n') + '\n'
    const local = Array.from({ length: 2000 }, (_, i) => `local ${i}`).join('\n') + '\n'
    expect(prepareClaimLineMap(owner, local)({ from: 4000, to: 4001 })).toEqual({ from: 4000, to: 4001, approximate: true })
  })

  it('reuses a prepared map across different ranges with the same results', () => {
    const owner = 'a\nb\nc\nd\n'
    const local = 'new\na\nB\nC\nd\n'
    const prepared = prepareClaimLineMap(owner, local)
    for (const range of [{ from: 1, to: 1 }, { from: 2, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 4 }]) {
      expect(prepared(range)).toEqual(claimInMyLines(range, owner, local))
      const { from, to } = prepared(range)
      expect({ from, to }).toEqual(mapRange(owner, local, range))
    }
  })
})
