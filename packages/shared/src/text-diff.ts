/**
 * Overlay text diff with a fixed work budget.
 *
 * setOverlay applies edits as character operations so Yjs relative positions (claim anchors) follow them.
 * An exact character diff costs O((N+M)·D): two unrelated 230 KB files took minutes, on the event loop.
 * Here the diff runs by lines first, then by characters inside each changed hunk, each with an edit-length
 * budget. Past a budget the unresolved region is replaced whole: the text is still exact, only anchors
 * inside that region collapse to its edges.
 */
import { diffChars, diffLines, type ChangeObject } from 'diff'

/** fast-diff's tuple shape: -1 delete, 0 equal, 1 insert. */
export type TextOp = [-1 | 0 | 1, string]

/** Myers steps (tokens × edit length) allowed per diff call. */
const WORK = 2_000_000

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

/** Common prefix and suffix lengths that never split a surrogate pair. */
function commonEdges(a: string, b: string): [number, number] {
  const shortest = Math.min(a.length, b.length)
  let head = 0
  while (head < shortest && a.charCodeAt(head) === b.charCodeAt(head)) head++
  if (head > 0 && isHigh(a.charCodeAt(head - 1))) head--
  let tail = 0
  while (tail < shortest - head && a.charCodeAt(a.length - 1 - tail) === b.charCodeAt(b.length - 1 - tail)) tail++
  if (tail > 0 && isLow(a.charCodeAt(a.length - tail))) tail--
  return [head, tail]
}

/** Largest edit length whose Myers work over `tokens` stays within `budget`. */
const editBudget = (tokens: number, budget: number) => Math.floor(budget / Math.max(1, tokens))

const replace = (before: string, after: string): TextOp[] => [
  ...(before ? [[-1, before] as TextOp] : []),
  ...(after ? [[1, after] as TextOp] : []),
]

function fromChanges(changes: ChangeObject<string>[]): TextOp[] {
  return changes.map(c => [c.added ? 1 : c.removed ? -1 : 0, c.value])
}

/** Character diff of one changed hunk, or a whole replacement past the budget; returns the work spent. */
function hunk(before: string, after: string, budget: number): [TextOp[], number] {
  if (!before || !after) return [replace(before, after), 0]
  const [head, tail] = commonEdges(before, after)
  const a = before.slice(head, before.length - tail), b = after.slice(head, after.length - tail)
  const edges = (middle: TextOp[]): TextOp[] => [
    ...(head ? [[0, before.slice(0, head)] as TextOp] : []),
    ...middle,
    ...(tail ? [[0, before.slice(before.length - tail)] as TextOp] : []),
  ]
  if (!a || !b) return [edges(replace(a, b)), 0]
  const tokens = a.length + b.length
  const maxEditLength = editBudget(tokens, budget)
  const changes = maxEditLength > 0 ? diffChars(a, b, { maxEditLength }) : undefined
  if (!changes) return [edges(replace(a, b)), tokens * maxEditLength]
  const ops = fromChanges(changes)
  return [edges(ops), tokens * ops.filter(([kind]) => kind !== 0).reduce((n, [, v]) => n + v.length, 0)]
}

/** Edit operations turning `before` into `after`, computed in bounded time. */
export function boundedTextDiff(before: string, after: string): TextOp[] {
  if (before === after) return before ? [[0, before]] : []
  const [head, tail] = commonEdges(before, after)
  const a = before.slice(head, before.length - tail), b = after.slice(head, after.length - tail)
  const out: TextOp[] = head ? [[0, before.slice(0, head)]] : []
  let budget = WORK
  const lineCount = (s: string) => s.split('\n').length
  const lineEdits = editBudget(lineCount(a) + lineCount(b), budget / 2)
  const lines = a && b && lineEdits > 0 ? diffLines(a, b, { maxEditLength: lineEdits }) : undefined
  budget /= 2
  if (!lines) out.push(...hunk(a, b, budget)[0])
  else {
    let removed = '', added = ''
    const flush = () => {
      if (!removed && !added) return
      const [ops, spent] = hunk(removed, added, budget)
      out.push(...ops)
      budget = Math.max(0, budget - spent)
      removed = added = ''
    }
    for (const change of lines) {
      if (change.removed) removed += change.value
      else if (change.added) added += change.value
      else { flush(); out.push([0, change.value]) }
    }
    flush()
  }
  if (tail) out.push([0, before.slice(before.length - tail)])
  return out.filter(([, value]) => value.length)
}
