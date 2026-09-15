import { diffLines } from 'diff'
import { diff3Merge } from 'node-diff3'

export type MergedSide = 'common' | 'a' | 'b'

export interface MergedLine {
  text: string
  side: MergedSide
  changedBy: 'a' | 'b' | 'both' | null | string[]
  lineNumbers?: Record<string, number>
  conflictPair?: [string, string]
  conflictOwner?: string
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
      for (const text of lines(change.value)) result.push({ text, side: 'common', changedBy: null, conflict: false, aLine: aLine++, bLine: bLine++ })
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
          changedBy: null,
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

export interface MergeParticipant { name: string; text: string }
export interface NamedMergedLine extends MergedLine { changedBy: string[]; lineNumbers: Record<string, number> }

/** Fold against the same base; expanded conflict alternatives retain their provenance. */
export function classifyNWay(base: string, participants: readonly MergeParticipant[]): NamedMergedLine[] {
  base = asText(lines(base))
  participants = participants.map(p => ({ ...p, text: asText(lines(p.text)) }))
  const O = lines(base)
  let running: NamedMergedLine[] = O.map(text => ({ text, side: 'common', changedBy: [], conflict: false, lineNumbers: {} }))
  const prior: MergeParticipant[] = []
  for (const participant of participants) {
    const before = running
    const beforeText = asText(before.map(l => l.text))
    const next: NamedMergedLine[] = []
    for (const region of diff3Merge(before.map(l => l.text), O, lines(participant.text))) {
      if (region.ok) {
        next.push(...region.ok.map(text => ({ text, side: 'common' as const, changedBy: [], conflict: false, lineNumbers: {} })))
      } else if (region.conflict) {
        const c = region.conflict
        const previous = before.slice(c.aIndex, c.aIndex + c.a.length)
        // Include deletion authors, which have no surviving line in the running result.
        const opponent = previous.flatMap(l => l.changedBy)[0] ?? prior.find(p =>
          diff3Merge(lines(p.text), O, lines(participant.text)).some(r => r.conflict && r.conflict.oIndex <= c.oIndex + c.o.length && r.conflict.oIndex + r.conflict.o.length >= c.oIndex))?.name
        const pair: [string, string] = [opponent ?? prior[0]?.name ?? participant.name, participant.name]
        next.push(...previous.map(l => ({ ...l, conflict: true, conflictPair: l.conflictPair ?? pair, conflictOwner: l.conflictOwner ?? l.changedBy[0] ?? pair[0] })))
        next.push(...c.b.map(text => ({ text, side: 'common' as const, changedBy: [], lineNumbers: {}, conflict: true, conflictPair: pair, conflictOwner: participant.name })))
      }
    }
    const text = asText(next.map(l => l.text))
    const previousMap = lineMap(beforeText, text)
    const versions = [...prior, participant].map(p => ({ ...p, map: lineMap(p.text, text), added: markAdded(base, p.text) }))
    running = next.map((line, i) => {
      const old = previousMap[i] === undefined ? undefined : before[previousMap[i]! - 1]
      const lineNumbers: Record<string, number> = {}
      const changedBy: string[] = []
      for (const p of versions) {
        const n = p.map[i]
        if (n !== undefined) { lineNumbers[p.name] = n; if (p.added[n - 1]) changedBy.push(p.name) }
      }
      return { ...line, ...(old?.conflict && !line.conflict ? { conflict: true, conflictPair: old.conflictPair, conflictOwner: old.conflictOwner } : {}), changedBy, lineNumbers }
    })
    prior.push(participant)
  }
  return running
}

function asText(value: string[]): string { return value.join('\n') + (value.length ? '\n' : '') }

/** Compatibility adapter: the two-party API is the N=2 model. */
export function classifyThreeWay(base: string, a: string, b: string): MergedLine[] {
  return classifyNWay(base, [{ name: 'a', text: a }, { name: 'b', text: b }]).map(line => {
    const { a: aLine, b: bLine } = line.lineNumbers
    const changedBy = line.changedBy.length === 2 ? 'both' : line.changedBy[0] as 'a' | 'b' | undefined
    const side = line.conflict ? line.conflictOwner as 'a' | 'b' : changedBy && changedBy !== 'both' ? changedBy : 'common'
    return { text: line.text, side, changedBy: changedBy ?? null, conflict: line.conflict, ...(aLine !== undefined ? { aLine } : {}), ...(bLine !== undefined ? { bLine } : {}) }
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
