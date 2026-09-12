import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import type { Claim } from '@room/shared'
import { claimsExtension, setClaims } from './claims-ext.ts'

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
  private view: EditorView | null = null
  private path: string | null = null

  constructor(private host: HTMLElement) {}

  show(path: string, text: string, claims: Claim[]): void {
    if (!this.view || this.path !== path) {
      this.view?.destroy()
      this.host.replaceChildren()
      this.path = path
      this.view = new EditorView({
        parent: this.host,
        state: EditorState.create({
          doc: text,
          extensions: [
            basicSetup,
            langFor(path),
            claimsExtension(),
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
          ],
        }),
      })
    } else if (this.view.state.doc.toString() !== text) {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } })
    }
    this.view.dispatch({ effects: setClaims.of(claims) })
  }

  empty(message = 'Select a changed file'): void {
    this.view?.destroy()
    this.view = null
    this.path = null
    this.host.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: message }))
  }
}
