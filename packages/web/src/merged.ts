import { diffLines } from 'diff'
import { diff3Merge } from 'node-diff3'

export type MergedSide = 'common' | 'a' | 'b'

export interface MergedLine {
  text: string
  side: MergedSide
  conflict: boolean
  aLine?: number
  bLine?: number
}

function lines(value: string): string[] {
  if (!value) return []
  const result = value.split('\n')
  if (value.endsWith('\n')) result.pop()
  return result
}

/** Pairwise, line-oriented view. Adjacent remove/add hunks are competing edits. */
export function classifyMergedLines(a: string, b: string): MergedLine[] {
  const changes = diffLines(a, b)
  const result: MergedLine[] = []
  let aLine = 1
  let bLine = 1

  for (let index = 0; index < changes.length;) {
    const change = changes[index]
    if (!change.added && !change.removed) {
      for (const text of lines(change.value)) result.push({ text, side: 'common', conflict: false, aLine: aLine++, bLine: bLine++ })
      index++
      continue
    }

    const hunk = []
    while (index < changes.length && (changes[index].added || changes[index].removed)) hunk.push(changes[index++])
    const conflict = hunk.some(part => part.removed) && hunk.some(part => part.added)
    for (const part of hunk) {
      const side: MergedSide = part.removed ? 'a' : 'b'
      for (const text of lines(part.value)) {
        result.push({
          text,
          side,
          conflict,
          ...(side === 'a' ? { aLine: aLine++ } : { bLine: bLine++ }),
        })
      }
    }
  }
  return result
}

export interface UnifiedLine extends MergedLine { prefix: ' ' | '-' | '+' }

/** A compact unified diff from `before` to `after`, without pretending either is base. */
export function unifiedDiffLines(before: string, after: string): UnifiedLine[] {
  return classifyMergedLines(before, after).map(line => ({
    ...line,
    prefix: line.side === 'common' ? ' ' : line.side === 'a' ? '-' : '+',
  }))
}

/**
 * Three-way view when the base is known: lines only in A or only in B are tinted, lines
 * both sides changed differently are real conflicts (as git would see them), everything
 * else is plain.
 */
export function classifyThreeWay(base: string, a: string, b: string): MergedLine[] {
  const A = lines(a), B = lines(b), O = lines(base)
  // Merged text with conflict regions expanded (a-side lines then b-side lines).
  const merged: { text: string; conflict: false | 'a' | 'b' }[] = []
  for (const region of diff3Merge(A, O, B)) {
    if (region.ok) { for (const text of region.ok) merged.push({ text, conflict: false }); continue }
    const c = region.conflict
    if (!c) continue
    for (const text of c.a) merged.push({ text, conflict: 'a' })
    for (const text of c.b) merged.push({ text, conflict: 'b' })
  }
  const mergedText = merged.map(m => m.text).join('\n') + (merged.length ? '\n' : '')
  // Which merged lines are new relative to base, and which side has them.
  const newVsBase = markAdded(base, mergedText)
  const inA = lineMap(a, mergedText), inB = lineMap(b, mergedText)
  return merged.map((m, i) => {
    const aLine = inA[i], bLine = inB[i]
    let side: MergedSide = 'common'
    if (m.conflict) side = m.conflict
    else if (newVsBase[i]) side = aLine !== undefined && bLine === undefined ? 'a' : bLine !== undefined && aLine === undefined ? 'b' : 'common'
    return { text: m.text, side, conflict: !!m.conflict, ...(aLine !== undefined ? { aLine } : {}), ...(bLine !== undefined ? { bLine } : {}) }
  })
}

/** For each line of `after`, true when it is not present at that position in `before`. */
function markAdded(before: string, after: string): boolean[] {
  const out: boolean[] = []
  for (const ch of diffLines(before, after)) {
    if (ch.removed) continue
    for (let k = 0; k < lines(ch.value).length; k++) out.push(!!ch.added)
  }
  return out
}

/** For each line of `after`, its 1-based line number in `side` when the line is shared, else undefined. */
function lineMap(side: string, after: string): (number | undefined)[] {
  const out: (number | undefined)[] = []
  let n = 0
  for (const ch of diffLines(side, after)) {
    const count = lines(ch.value).length
    if (ch.removed) { n += count; continue }
    for (let k = 0; k < count; k++) { if (ch.added) out.push(undefined); else out.push(++n) }
  }
  return out
}
