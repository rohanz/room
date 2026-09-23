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
  const changes = boundedDiff(a, b)
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

/** `base` is the participant's own baseline text when it differs from the common base (a carried worker). */
export interface MergeParticipant { name: string; text: string; base?: string }
export interface NamedMergedLine extends MergedLine { changedBy: string[]; lineNumbers: Record<string, number> }

/**
 * Fold in order, like the tools' preview: the first participant's tree, then each other's changes
 * against the pair's base, which is a participant's own base when either has one (a carried worker),
 * else the common base. Lines are credited against each participant's own base; expanded conflict
 * alternatives retain their provenance.
 */
export function classifyNWay(base: string, participants: readonly MergeParticipant[]): NamedMergedLine[] {
  base = asText(lines(base))
  participants = participants.map(p => ({ ...p, text: asText(lines(p.text)), ...(p.base === undefined ? {} : { base: asText(lines(p.base)) }) }))
  const O = lines(base)
  const pairBase = (a: MergeParticipant | undefined, b: MergeParticipant) => lines(b.base ?? a?.base ?? base)
  let running: NamedMergedLine[] = O.map(text => ({ text, side: 'common', changedBy: [], conflict: false, lineNumbers: {} }))
  const prior: MergeParticipant[] = []
  for (const participant of participants) {
    const before = running
    const beforeText = asText(before.map(l => l.text))
    const next: NamedMergedLine[] = []
    for (const region of boundedMerge(before.map(l => l.text), prior.length ? pairBase(prior[0], participant) : O, lines(participant.text))) {
      if (region.ok) {
        next.push(...region.ok.map(text => ({ text, side: 'common' as const, changedBy: [], conflict: false, lineNumbers: {} })))
      } else if (region.conflict) {
        const c = region.conflict
        const previous = before.slice(c.aIndex, c.aIndex + c.a.length)
        // Include deletion authors, which have no surviving line in the running result.
        const opponent = previous.flatMap(l => l.changedBy)[0] ?? prior.find(p =>
          boundedMerge(lines(p.text), pairBase(p, participant), lines(participant.text)).some(r => r.conflict && r.conflict.oIndex <= c.oIndex + c.o.length && r.conflict.oIndex + r.conflict.o.length >= c.oIndex))?.name
        const pair: [string, string] = [opponent ?? prior[0]?.name ?? participant.name, participant.name]
        next.push(...previous.map(l => ({ ...l, conflict: true, conflictPair: l.conflictPair ?? pair, conflictOwner: l.conflictOwner ?? l.changedBy[0] ?? pair[0] })))
        next.push(...c.b.map(text => ({ text, side: 'common' as const, changedBy: [], lineNumbers: {}, conflict: true, conflictPair: pair, conflictOwner: participant.name })))
      }
    }
    const text = asText(next.map(l => l.text))
    const previousMap = lineMap(beforeText, text)
    const versions = [...prior, participant].map(p => ({ ...p, map: lineMap(p.text, text), added: markAdded(p.base ?? base, p.text) }))
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
  for (const ch of boundedDiff(before, after)) {
    if (ch.removed) continue
    const count = lines(ch.value).length
    for (let k = 0; k < count; k++) out.push(!!ch.added)
  }
  return out
}

/** For each line of `after`, its 1-based line number in `side` when the line is shared, else undefined. */
function lineMap(side: string, after: string): (number | undefined)[] {
  const out: (number | undefined)[] = []
  let n = 0
  for (const ch of boundedDiff(side, after)) {
    const count = lines(ch.value).length
    if (ch.removed) { n += count; continue }
    for (let k = 0; k < count; k++) { if (ch.added) out.push(undefined); else out.push(++n) }
  }
  return out
}

const MAX_DIFF_LINES = 20000

/** Trivial cases never enter Myers; large edits have a fixed edit-distance budget. */
function boundedDiff(before: string, after: string): { value: string; added?: boolean; removed?: boolean }[] {
  if (before === after) return before ? [{ value: before }] : []
  if (!before) return [{ value: after, added: true }]
  if (!after) return [{ value: before, removed: true }]
  const a = lines(before), b = lines(after)
  if (Math.max(a.length, b.length) <= MAX_DIFF_LINES) return diffLines(before, after)
  const exact = diffLines(before, after, { maxEditLength: 128 })
  if (exact) return exact
  // Preserve common edges; report the unresolved middle as a replacement.
  let from = 0, tail = 0
  while (from < Math.min(a.length, b.length) && a[from] === b[from]) from++
  while (tail < Math.min(a.length, b.length) - from && a[a.length - tail - 1] === b[b.length - tail - 1]) tail++
  return [
    { value: asText(a.slice(0, from)) },
    { value: asText(a.slice(from, a.length - tail)), removed: true },
    { value: asText(b.slice(from, b.length - tail)), added: true },
    { value: asText(a.slice(a.length - tail)) },
  ].filter(change => change.value.length)
}

/** Avoid node-diff3's unbounded LCS on large inputs. Keep uncertain edits as conflicts. */
function boundedMerge(a: string[], o: string[], b: string[]): ReturnType<typeof diff3Merge<string>> {
  const equal = (x: string[], y: string[]) => x.length === y.length && x.every((line, i) => line === y[i])
  if (equal(a, b) || equal(o, b)) return [{ ok: a }]
  if (equal(a, o)) return [{ ok: b }]
  if (Math.max(a.length, o.length, b.length) <= MAX_DIFF_LINES) return diff3Merge(a, o, b)
  let from = 0, tail = 0
  const shortest = Math.min(a.length, o.length, b.length)
  while (from < shortest && a[from] === o[from] && b[from] === o[from]) from++
  while (tail < shortest - from && a[a.length - tail - 1] === o[o.length - tail - 1] && b[b.length - tail - 1] === o[o.length - tail - 1]) tail++
  return [
    { ok: a.slice(0, from) },
    { conflict: { a: a.slice(from, a.length - tail), aIndex: from, o: o.slice(from, o.length - tail), oIndex: from, b: b.slice(from, b.length - tail), bIndex: from } },
    { ok: a.slice(a.length - tail) },
  ]
}
