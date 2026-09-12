import { diffLines } from 'diff'

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
