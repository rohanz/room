import { cursorInClaim, describeClaim, type ClaimMsg, type ConflictMsg, type Msg, type ReleaseMsg } from '@room/shared'
import { connect, storedName, NAME_KEY, type Conn } from './conn.ts'
import { Editor } from './editor.ts'
import { chatPane, feedPane, fileTree, h, participants, roomHeader, tabs, toaster } from './panels.ts'

const app = document.getElementById('app')!

function nameGate(): Promise<string> {
  return new Promise(resolve => {
    const input = h('input', { placeholder: 'Your name', autofocus: true })
    const form = h('form', {}, h('h2', {}, 'Join the room'), h('div', { class: 'muted' }, 'Pick the name your daemon and agent use.'), input, h('button', { class: 'primary', type: 'submit' }, 'Join'))
    form.onsubmit = e => {
      e.preventDefault()
      const n = input.value.trim(); if (!n) return
      try { localStorage.setItem(NAME_KEY, n) } catch {}
      resolve(n)
    }
    app.replaceChildren(h('div', { class: 'gate' }, form))
    input.focus()
  })
}

function centre(conn: Conn, toast: (t: string) => void) {
  const banners = h('div')
  const fname = h('span', { class: 'fname muted' }, 'no file')
  const claimBtn = h('button', { textContent: 'Claim selection', disabled: true })
  const intentInput = h('input', { placeholder: 'intent — what are you doing here?' })
  const intentForm = h('form', { class: 'intent-form', hidden: true }, intentInput, h('button', { class: 'primary', type: 'submit' }, 'Claim'), h('button', { type: 'button', class: 'ghost', onclick: () => { intentForm.hidden = true } }, 'Cancel'))
  const myClaims = h('div', { class: 'myclaims' })
  const host = h('div', { class: 'editor-wrap' })
  const el = h('div', { class: 'col center' }, banners, h('div', { class: 'toolbar' }, fname, h('span', { class: 'sp' }), claimBtn, intentForm), myClaims, host)

  const editor = new Editor(host, conn)
  editor.close()
  let selection: { from: number; to: number } | null = null
  editor.onSelection = s => { selection = s; claimBtn.disabled = !s || !conn.connected }
  claimBtn.onclick = () => { intentForm.hidden = false; intentInput.focus() }
  intentForm.onsubmit = e => {
    e.preventDefault()
    const intent = intentInput.value.trim()
    if (!intent || !selection || !editor.path) return
    const c = conn.room.addClaim({ path: editor.path, from: selection.from, to: selection.to, by: conn.me.name, byKind: 'human', intent })
    conn.room.post<ClaimMsg>(conn.me, { type: 'claim', claimId: c.id, path: c.path, from_line: c.from, to_line: c.to, intent })
    intentInput.value = ''; intentForm.hidden = true
  }

  const renderMine = () => {
    myClaims.replaceChildren(...conn.room.openClaims().filter(c => c.by === conn.me.name && c.byKind === 'human').map(c => {
      const release = h('button', { textContent: 'Release', onclick: () => {
        conn.room.removeClaim(c.id)
        conn.room.post<ReleaseMsg>(conn.me, { type: 'release', claimId: c.id, path: c.path })
      } })
      return h('span', { class: 'chip', title: describeClaim(c) }, h('span', { class: 'rng' }, `${c.path}:${c.from}-${c.to}`), h('span', { class: 'muted' }, c.intent), release)
    }))
  }
  conn.room.claims.observe(() => {
    renderMine()
    if (editor.path) editor.setClaims(conn.room.claimsFor(editor.path))
    checkEnter()
  })
  renderMine()

  // toast once per claim when my cursor enters another party's claim
  const warned = new Set<string>()
  let cursor: { path: string; from: number; to: number } | undefined
  const checkEnter = () => {
    if (!cursor) return
    for (const c of conn.room.openClaims()) {
      if (c.by === conn.me.name || warned.has(c.id)) continue
      if (cursorInClaim(cursor, c)) { warned.add(c.id); toast(`Heads up: you're inside a claim — ${describeClaim(c)}`) }
    }
  }
  editor.onCursor = c => { cursor = c; checkEnter() }

  // conflict banners: new conflicts, plus recent ones that arrive with the initial sync
  const showConflict = (m: ConflictMsg) => {
    const b = h('div', { class: 'banner' }, h('span', { class: 'text' }, `Conflict on ${m.path}: ${m.text}`), h('button', { textContent: 'Dismiss', onclick: () => b.remove() }))
    banners.append(b)
  }
  conn.room.bus.observe(e => {
    e.changes.added.forEach(item => (item.content.getContent() as Msg[]).forEach(m => { if (m.type === 'conflict' && Date.now() - m.at < 10 * 60_000) showConflict(m) }))
  })

  conn.onStatus(c => { editor.setReadOnly(!c); claimBtn.disabled = !selection || !c })

  const open = (path: string) => {
    editor.open(path)
    fname.textContent = editor.path ?? 'no file'
    fname.classList.toggle('muted', !editor.path)
    editor.setReadOnly(!conn.connected)
    tree.setActive(editor.path)
  }
  // a daemon may delete/recreate a file: rebind or close
  conn.room.files.observe(() => {
    if (!editor.path) return
    const yt = conn.room.files.get(editor.path)
    if (!yt) open(editor.path)
    else if (yt !== editor.boundText) open(editor.path)
  })
  const tree = fileTree(conn, open)
  return { el, tree, open }
}

async function main() {
  const name = storedName() ?? await nameGate()
  const conn = connect(name)
  const toast = toaster()
  const c = centre(conn, toast)
  const left = h('div', { class: 'col left' }, roomHeader(conn), participants(conn), c.tree.el)
  const right = tabs([{ label: 'Feed', el: feedPane(conn) }, { label: 'My agent', el: chatPane(conn) }])
  right.classList.add('right')
  app.replaceChildren(h('div', { class: 'layout' }, left, c.el, right))

  // open the first file once synced, if none open
  conn.provider.once('sync', () => {
    const q = new URLSearchParams(location.search).get('file')
    const first = q && conn.room.hasFile(q) ? q : conn.room.paths()[0]
    if (first) c.open(first)
  })
  Object.assign(window as any, { room: conn.room, provider: conn.provider }) // debugging aid
}
main()
