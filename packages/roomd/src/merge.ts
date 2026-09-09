import diff from 'fast-diff'
import type * as Y from 'yjs'

/**
 * Text-merge helpers for roomd.
 *
 * The daemon keeps a per-path "shadow": the last text known to be identical on disk and
 * in the room. A local edit is `diff(shadow, disk)`; if remote edits landed in the room
 * meanwhile, the room text is `shadow + remote ops`, so local op positions are mapped
 * through `diff(shadow, room)` before being applied to the Y.Text. When nothing landed
 * remotely the mapping is the identity and this degrades to a plain minimal diff.
 */

export type Op = { kind: 'delete'; at: number; len: number } | { kind: 'insert'; at: number; text: string }

/** Minimal character ops that turn `from` into `to`, positions relative to `from`. */
export function opsBetween(from: string, to: string): Op[] {
  const ops: Op[] = []
  let i = 0
  for (const [kind, text] of diff(from, to)) {
    if (kind === diff.EQUAL) i += text.length
    else if (kind === diff.DELETE) ops.push({ kind: 'delete', at: i, len: text.length }), (i += text.length)
    else ops.push({ kind: 'insert', at: i, text })
  }
  return ops
}

/**
 * Build a function mapping an index in `from` to the corresponding index in `to`.
 * Deleted spans collapse to the position of the deletion; inserted spans are skipped.
 */
export function positionMapper(from: string, to: string): (i: number) => number {
  if (from === to) return i => i
  type Seg = { fs: number; fe: number; ts: number; deleted: boolean }
  const seg: Seg[] = []
  let f = 0, t = 0
  for (const [kind, text] of diff(from, to)) {
    if (kind === diff.EQUAL) { seg.push({ fs: f, fe: f + text.length, ts: t, deleted: false }); f += text.length; t += text.length }
    else if (kind === diff.DELETE) { seg.push({ fs: f, fe: f + text.length, ts: t, deleted: true }); f += text.length }
    else t += text.length
  }
  const endTo = t
  return (i: number) => {
    for (const s of seg) {
      if (i >= s.fs && i < s.fe) return s.deleted ? s.ts : s.ts + (i - s.fs)
    }
    return endTo
  }
}

/**
 * Apply the edit `shadow -> local` onto `yt`, whose current text is `shadow` plus any
 * remote edits. Must be called inside a transaction. Ops are applied in reverse order so
 * earlier positions stay valid.
 */
export function applyLocalEdit(yt: Y.Text, shadow: string, local: string): void {
  const room = yt.toString()
  if (room === local) return
  const ops = opsBetween(shadow, local)
  const map = positionMapper(shadow, room)
  for (let k = ops.length - 1; k >= 0; k--) {
    const op = ops[k]
    if (op.kind === 'insert') {
      yt.insert(map(op.at), op.text)
    } else {
      const a = map(op.at), b = map(op.at + op.len)
      if (b > a) yt.delete(a, b - a)
    }
  }
}
