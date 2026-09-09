import { StateField, StateEffect, RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { displayName, type Presence } from '@room/shared'

/**
 * Remote cursors from the room schema's awareness `cursor: {path, from, to}` (1-based lines).
 * y-codemirror.next's own selection plugin is not used: it stores `{anchor, head}` in the same
 * awareness field and would both crash on ours and overwrite it.
 */
export const setRemoteCursors = StateEffect.define<Presence[]>()

class Label extends WidgetType {
  constructor(readonly name: string, readonly color: string) { super() }
  eq(o: Label) { return o.name === this.name && o.color === this.color }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-remote-label'
    el.textContent = this.name
    el.style.background = this.color
    return el
  }
  ignoreEvent() { return true }
}

function build(ps: Presence[], doc: { lines: number; line(n: number): { from: number; to: number } }): DecorationSet {
  type Mark = { pos: number; deco: Decoration; startSide: number }
  const marks: Mark[] = []
  for (const p of ps) {
    const c = p.cursor!
    const from = Math.max(1, Math.min(c.from, doc.lines))
    const to = Math.max(from, Math.min(c.to, doc.lines))
    for (let n = from; n <= to; n++) {
      const pos = doc.line(n).from
      marks.push({ pos, startSide: -2, deco: Decoration.line({ attributes: { style: `box-shadow: inset 3px 0 0 ${p.user.color}` } }) })
      if (n === from) marks.push({ pos: doc.line(n).to, startSide: 1, deco: Decoration.widget({ widget: new Label(displayName(p.user), p.user.color), side: 1 }) })
    }
  }
  marks.sort((a, b) => a.pos - b.pos || a.startSide - b.startSide)
  const b = new RangeSetBuilder<Decoration>()
  for (const m of marks) b.add(m.pos, m.pos, m.deco)
  return b.finish()
}

const field = StateField.define<{ ps: Presence[]; deco: DecorationSet }>({
  create: () => ({ ps: [], deco: Decoration.none }),
  update(v, tr) {
    let ps = v.ps, dirty = false
    for (const e of tr.effects) if (e.is(setRemoteCursors)) { ps = e.value; dirty = true }
    if (!dirty && !tr.docChanged) return v
    return { ps, deco: build(ps, tr.state.doc) }
  },
  provide: f => EditorView.decorations.from(f, v => v.deco),
})

export function remoteCursorsExtension(): Extension { return field }
