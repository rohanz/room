import { formatPatch, structuredPatch, type StructuredPatch } from 'diff'
import { createHash } from 'node:crypto'

/** Keep Myers work bounded across ALL partitions, with no unbounded second diff pass. */
export function boundedTwoFilesPatch(p: string, before: string, after: string, person: string): string {
  const a = before.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const b = after.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const patch: StructuredPatch = { oldFileName: `a/${p}`, newFileName: `b/${p}`, oldHeader: 'base', newHeader: person, hunks: [] }
  let budget = 2_000_000
  const visit = (a0: number, a1: number, b0: number, b1: number, depth: number): void => {
    // Trim equal edges, retaining three context lines. This also bounds fallback output.
    let head = 0, tail = 0
    while (a0 + head < a1 && b0 + head < b1 && a[a0 + head] === b[b0 + head]) head++
    if (a0 + head === a1 && b0 + head === b1) return
    while (a1 - tail > a0 + head && b1 - tail > b0 + head && a[a1 - tail - 1] === b[b1 - tail - 1]) tail++
    const skipHead = Math.max(0, head - 3), skipTail = Math.max(0, tail - 3)
    a0 += skipHead; b0 += skipHead; a1 -= skipTail; b1 -= skipTail
    const tokens = a1 - a0 + b1 - b0 + 2
    const maxEditLength = Math.min(128, Math.floor(budget / tokens))
    if (maxEditLength > 0) {
      budget -= tokens * maxEditLength
      const part = structuredPatch('', '', a.slice(a0, a1).join(''), b.slice(b0, b1).join(''), undefined, undefined, { context: 3, maxEditLength })
      if (part) {
        for (const hunk of part.hunks) patch.hunks.push({ ...hunk, oldStart: hunk.oldStart + a0, newStart: hunk.newStart + b0 })
        return
      }
    }
    // Split at a shared unique line near the middle. Equal anchors keep large,
    // scattered edits local even when Myers exhausts its budget. At most 16 linear
    // scans along any branch; neither repeated lines nor a rewrite cause quadratic work.
    if (depth < 16) {
      const unique = (lines: string[], start: number, end: number) => {
        const positions = new Map<string, number>()
        for (let i = start; i < end; i++) positions.set(lines[i], positions.has(lines[i]) ? -1 : i)
        return positions
      }
      const left = unique(a, a0, a1), right = unique(b, b0, b1)
      let anchor: [number, number] | undefined, score = Infinity
      for (const [line, ai] of left) {
        const bi = right.get(line)
        if (ai < a0 || bi === undefined || bi < b0 || ai === a1 - 1 || bi === b1 - 1) continue
        const distance = Math.abs((ai - a0) / (a1 - a0) - 0.5) + Math.abs((bi - b0) / (b1 - b0) - 0.5)
        if (distance < score) { score = distance; anchor = [ai, bi] }
      }
      if (anchor) {
        visit(a0, anchor[0] + 1, b0, anchor[1] + 1, depth + 1)
        visit(anchor[0] + 1, a1, anchor[1] + 1, b1, depth + 1)
        return
      }
    }
    const lines: string[] = []
    for (const [text, prefix] of [[a.slice(a0, a1), '-'], [b.slice(b0, b1), '+']] as const) {
      for (const line of text) {
        lines.push(prefix + (line.endsWith('\n') ? line.slice(0, -1) : line))
        if (!line.endsWith('\n')) lines.push('\\ No newline at end of file')
      }
    }
    patch.hunks.push({ oldStart: a0 + 1, oldLines: a1 - a0, newStart: b0 + 1, newLines: b1 - b0, lines })
  }
  visit(0, a.length, 0, b.length, 0)
  // Partition boundaries are not file boundaries. Join nearby hunks and restore
  // global context so Git never interprets a contextless partition end as EOF.
  const context = (start: number, end: number) => a.slice(start, end).flatMap(line => line.endsWith('\n')
    ? [' ' + line.slice(0, -1)] : [' ' + line, '\\ No newline at end of file'])
  const hunks: StructuredPatch['hunks'] = []
  for (const hunk of patch.hunks) {
    const prev = hunks.at(-1)
    const gap = prev ? hunk.oldStart - prev.oldStart - prev.oldLines : Infinity
    if (prev && gap <= 6) {
      for (const line of context(prev.oldStart - 1 + prev.oldLines, hunk.oldStart - 1)) prev.lines.push(line)
      for (const line of hunk.lines) prev.lines.push(line)
      prev.oldLines += gap + hunk.oldLines; prev.newLines += gap + hunk.newLines
    } else hunks.push(hunk)
  }
  for (const hunk of hunks) {
    let leading = 0, trailing = 0
    while (hunk.lines[leading]?.startsWith(' ')) leading++
    while (hunk.lines[hunk.lines.length - 1 - trailing]?.startsWith(' ')) trailing++
    const start = hunk.oldStart - 1, end = start + hunk.oldLines
    const head = Math.min(start, Math.max(0, 3 - leading)), tail = Math.min(a.length - end, Math.max(0, 3 - trailing))
    hunk.lines = [...context(start - head, start), ...hunk.lines, ...context(end, end + tail)]
    hunk.oldStart -= head; hunk.newStart -= head
    hunk.oldLines += head + tail; hunk.newLines += head + tail
  }
  patch.hunks = hunks
  return formatPatch(patch)
}

export const PAGE_CHARS = 12_000

/** Content-bound cursors reject changed output instead of silently skipping new edits. */
export function diffPage(text: string, cursor: unknown, digest = createHash('sha256').update(text).digest('hex')): string {
  let start = 0
  if (cursor !== undefined) {
    const match = typeof cursor === 'string' && /^([a-f0-9]{64}):([1-9][0-9]*)$/.exec(cursor)
    if (!match || !Number.isSafeInteger(Number(match[2]))) return 'error: invalid diff cursor; restart room_read with diff=true and no cursor'
    if (match[1] !== digest || Number(match[2]) >= text.length) return 'error: diff changed since the previous page; restart room_read with diff=true and no cursor'
    start = Number(match[2])
  }
  if (start === 0 && text.length <= PAGE_CHARS) return text
  let end = Math.min(start + PAGE_CHARS, text.length)
  // Do not split an astral Unicode character between pages.
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  const next = end < text.length
    ? `continue room_read with the same person/path, diff=true, cursor="${digest}:${end}"`
    : 'end of diff'
  return `diff page ${start + 1}-${end} of ${text.length} characters (partial patch)\n${text.slice(start, end)}\n[${next}]`
}
