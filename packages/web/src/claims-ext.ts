import { StateField, StateEffect, RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from '@codemirror/view'
import { RangeSet } from '@codemirror/state'
import { colorFor, describeClaim, type Claim } from '@room/shared'

export const setClaims = StateEffect.define<Claim[]>()

function clamp(c: Claim, lines: number): { from: number; to: number } | null {
  const from = Math.max(1, Math.min(c.from, lines))
  const to = Math.max(from, Math.min(c.to, lines))
  return from <= lines ? { from, to } : null
}

class ClaimMarker extends GutterMarker {
  constructor(readonly color: string, readonly title: string) { super() }
  eq(o: ClaimMarker) { return o.color === this.color && o.title === this.title }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-claim-mark'
    el.style.background = this.color
    el.title = this.title
    return el
  }
}

interface Built { deco: DecorationSet; marks: RangeSet<GutterMarker> }

function build(claims: Claim[], view: { doc: { lines: number; line(n: number): { from: number } } }): Built {
  const lines = view.doc.lines
  const perLine = new Map<number, Claim[]>()
  for (const c of claims) {
    const r = clamp(c, lines); if (!r) continue
    for (let n = r.from; n <= r.to; n++) { const a = perLine.get(n) ?? []; a.push(c); perLine.set(n, a) }
  }
  const db = new RangeSetBuilder<Decoration>()
  const mb = new RangeSetBuilder<GutterMarker>()
  for (const n of Array.from(perLine.keys()).sort((a, b) => a - b)) {
    const cs = perLine.get(n)!
    const first = cs[0]
    const color = colorFor(first.by)
    const title = cs.map(describeClaim).join('\n')
    const pos = view.doc.line(n).from
    db.add(pos, pos, Decoration.line({ attributes: { style: `background: ${color}1c`, title, 'data-claim': first.id } }))
    mb.add(pos, pos, new ClaimMarker(color, title))
  }
  return { deco: db.finish(), marks: mb.finish() }
}

const claimField = StateField.define<{ claims: Claim[] } & Built>({
  create: state => ({ claims: [], ...build([], state) }),
  update(v, tr) {
    let claims = v.claims
    let dirty = false
    for (const e of tr.effects) if (e.is(setClaims)) { claims = e.value; dirty = true }
    if (!dirty && !tr.docChanged) return v
    return { claims, ...build(claims, tr.state) }
  },
  provide: f => EditorView.decorations.from(f, v => v.deco),
})

export function claimsExtension(): Extension {
  return [
    claimField,
    gutter({ class: 'cm-claim-gutter', markers: v => v.state.field(claimField).marks }),
  ]
}
