import * as Y from 'yjs'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import type { Claim, Cursor, Presence } from '@room/shared'
import type { Conn } from './conn.ts'
import { claimsExtension, setClaims } from './claims-ext.ts'
import { remoteCursorsExtension, setRemoteCursors } from './remote-cursors.ts'
import { presences } from './conn.ts'

function langFor(path: string): Extension {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'py') return python()
  if (['js', 'mjs', 'cjs'].includes(ext)) return javascript()
  if (['ts', 'mts', 'cts'].includes(ext)) return javascript({ typescript: true })
  if (ext === 'jsx') return javascript({ jsx: true })
  if (ext === 'tsx') return javascript({ jsx: true, typescript: true })
  return []
}

export class Editor {
  path: string | null = null
  private view: EditorView | null = null
  private ytext: Y.Text | null = null
  private readOnly = new Compartment()
  private cursorTimer: number | null = null
  private lastCursor: Cursor | undefined
  onCursor: (c: Cursor | undefined) => void = () => {}
  onSelection: (sel: { from: number; to: number } | null) => void = () => {}

  constructor(private host: HTMLElement, private conn: Conn) {
    conn.provider.awareness.on('change', () => this.refreshRemoteCursors())
  }

  /** Bound Y.Text instance (used to detect re-creation by the daemon). */
  get boundText() { return this.ytext }

  open(path: string) {
    // phase 2: the read-only view will expose an explicit person selector.
    const person = this.conn.room.overlayText(this.conn.me.name, path)
      ? this.conn.me.name
      : this.conn.room.whoChanged(path)[0]
    const ytext = person ? this.conn.room.overlayText(person, path) : undefined
    if (!ytext) { this.close(); return }
    if (this.view && this.ytext === ytext) return
    this.close()
    this.path = path
    this.ytext = ytext
    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        keymap.of(yUndoManagerKeymap),
        langFor(path),
        // awareness deliberately not passed: see remote-cursors.ts
        yCollab(ytext, null),
        claimsExtension(),
        remoteCursorsExtension(),
        this.readOnly.of(this.roExt(!this.conn.connected)),
        EditorView.updateListener.of(u => {
          if (u.selectionSet || u.docChanged || u.focusChanged) this.scheduleCursor()
        }),
      ],
    })
    this.host.replaceChildren()
    this.view = new EditorView({ state, parent: this.host })
    this.setClaims(this.conn.room.claimsFor(path))
    this.refreshRemoteCursors()
    this.scheduleCursor()
  }

  close() {
    this.view?.destroy(); this.view = null; this.ytext = null; this.path = null
    this.host.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Open a file from the tree' }))
    this.publishCursor(undefined)
    this.onSelection(null)
  }

  setClaims(claims: Claim[]) { this.view?.dispatch({ effects: setClaims.of(claims) }) }

  /** Move the cursor to a 1-based line and scroll it into view (centred). */
  scrollTo(line: number) {
    if (!this.view) return
    const n = Math.max(1, Math.min(line, this.view.state.doc.lines))
    const pos = this.view.state.doc.line(n).from
    this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
    this.view.focus()
  }

  refreshRemoteCursors() {
    if (!this.view || !this.path) return
    const mine = this.conn.provider.awareness.clientID
    const ps: Presence[] = presences(this.conn.provider).filter(x => x.clientId !== mine && x.p.cursor?.path === this.path).map(x => x.p)
    this.view.dispatch({ effects: setRemoteCursors.of(ps) })
  }

  private roExt(ro: boolean): Extension { return [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)] }
  setReadOnly(ro: boolean) { this.view?.dispatch({ effects: this.readOnly.reconfigure(this.roExt(ro)) }) }

  /** Current selection as 1-based inclusive line range. */
  selectionLines(): { from: number; to: number } | null {
    if (!this.view) return null
    const sel = this.view.state.selection.main
    const doc = this.view.state.doc
    return { from: doc.lineAt(sel.from).number, to: doc.lineAt(sel.to).number }
  }

  private scheduleCursor() {
    if (this.cursorTimer !== null) return
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = null
      const r = this.selectionLines()
      this.onSelection(r)
      this.publishCursor(r && this.path ? { path: this.path, ...r } : undefined)
    }, 100)
  }

  private publishCursor(c: Cursor | undefined) {
    const l = this.lastCursor
    if (l && c && l.path === c.path && l.from === c.from && l.to === c.to) return
    if (!l && !c) return
    this.lastCursor = c
    this.conn.setCursor(c)
    this.onCursor(c)
  }
}
