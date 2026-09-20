import type { MergedLine } from './merged.ts'

export const LARGE_LINES = 3000
export const CONTEXT = 3
export const PAGE = 500
export type Segment = { kind: 'lines'; from: number; to: number } | { kind: 'gap'; from: number; to: number; reason: 'unchanged' | 'more' }
export interface WindowOptions { expanded?: ReadonlySet<string>; all?: boolean }

/** Zero-based, half-open ranges; expanding a more gap reveals one further page. */
export function planWindows(lines: readonly MergedLine[], opts: WindowOptions = {}): Segment[] {
  if (lines.length <= LARGE_LINES || opts.all) return [{ kind: 'lines', from: 0, to: lines.length }]
  const kept: { from: number; to: number }[] = []
  lines.forEach((line, i) => {
    if (!line.conflict && line.side === 'common' && !(Array.isArray(line.changedBy) ? line.changedBy.length : line.changedBy)) return
    const from = Math.max(0, i - CONTEXT), to = Math.min(lines.length, i + CONTEXT + 1)
    const last = kept.at(-1)
    if (last && last.to >= from) last.to = to
    else kept.push({ from, to })
  })
  const result: Segment[] = []
  const page = (from: number, to: number) => {
    let end = Math.min(to, from + PAGE)
    while (end < to && opts.expanded?.has(`${end}-${to}`)) end = Math.min(to, end + PAGE)
    result.push({ kind: 'lines', from, to: end })
    if (end < to) result.push({ kind: 'gap', from: end, to, reason: 'more' })
  }
  const unchanged = (from: number, to: number) => {
    if (from === to) return
    if (opts.expanded?.has(`${from}-${to}`)) page(from, to)
    else result.push({ kind: 'gap', from, to, reason: 'unchanged' })
  }
  let end = 0
  for (const run of kept) { unchanged(end, run.from); page(run.from, run.to); end = run.to }
  unchanged(end, lines.length)
  return result
}
