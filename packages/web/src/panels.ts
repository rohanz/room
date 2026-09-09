import type * as Y from 'yjs'
import { colorFor, displayName, formatMsg, type ChatItem, type Msg, type NoteMsg } from '@room/shared'
import { presences, type Conn } from './conn.ts'

export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string | null | undefined)[]) => {
  const el = document.createElement(tag)
  const { class: cls, ...rest } = props
  if (cls) el.className = cls
  Object.assign(el, rest)
  for (const k of kids) if (k != null) el.append(k)
  return el
}
const dot = (name: string) => { const d = h('span', { class: 'dot' }); d.style.background = colorFor(name); return d }
const timeStr = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// ---- left column ---------------------------------------------------------
export function roomHeader(conn: Conn) {
  const name = h('div', { class: 'name' }, '…')
  const sub = h('div', { class: 'sub' })
  const pill = h('span', { class: 'pill' }, 'offline')
  const me = h('div', { class: 'me' }, dot(conn.me.name), ' ', h('b', {}, conn.me.name), h('span', { class: 'muted' }, ' (you)'))
  const el = h('div', { class: 'section room-head' }, name, sub, pill, me)
  const render = () => {
    const m = conn.room.meta
    name.textContent = m.repo ?? 'room'
    sub.replaceChildren(m.branch ?? '—', ' · ', h('span', { class: 'mono' }, (m.base ?? '').slice(0, 7) || '—'))
  }
  conn.room.metaMap.observe(render); render()
  conn.onStatus(c => { pill.textContent = c ? 'connected' : 'disconnected'; pill.classList.toggle('on', c) })
  return el
}

export function participants(conn: Conn) {
  const list = h('div')
  const el = h('div', { class: 'section' }, h('h3', {}, 'Participants'), list)
  const render = () => {
    list.replaceChildren(...presences(conn.provider).map(({ p }) => {
      const cur = p.cursor ? `${p.cursor.path}:${p.cursor.from}${p.cursor.to !== p.cursor.from ? '–' + p.cursor.to : ''}` : ''
      return h('div', { class: 'person' }, dot(p.user.name),
        h('div', {}, h('div', { class: 'who' }, displayName(p.user)),
          h('div', { class: 'st' }, [p.status, cur].filter(Boolean).join(' · ')))
      )
    }))
    if (!list.children.length) list.append(h('div', { class: 'muted' }, 'nobody yet'))
  }
  conn.provider.awareness.on('change', render); render()
  return el
}

interface TreeNode { name: string; path: string; kids?: Map<string, TreeNode> }
export function fileTree(conn: Conn, onOpen: (p: string) => void) {
  const tree = h('div', { class: 'tree' })
  const el = h('div', { class: 'section grow scroll' }, h('h3', {}, 'Files'), tree)
  let active: string | null = null
  const render = () => {
    const root: TreeNode = { name: '', path: '', kids: new Map() }
    for (const p of conn.room.paths()) {
      let cur = root
      const parts = p.split('/')
      parts.forEach((seg, i) => {
        const full = parts.slice(0, i + 1).join('/')
        let n = cur.kids!.get(seg)
        if (!n) { n = { name: seg, path: full, kids: i < parts.length - 1 ? new Map() : undefined }; cur.kids!.set(seg, n) }
        cur = n
      })
    }
    const draw = (n: TreeNode): HTMLElement => {
      if (n.kids) {
        const entries = Array.from(n.kids.values()).sort((a, b) => Number(!!b.kids) - Number(!!a.kids) || a.name.localeCompare(b.name))
        const kids = h('div', { class: 'kids' }, ...entries.map(draw))
        return n.path ? h('div', {}, h('div', { class: 'node dir' }, n.name + '/'), kids) : kids
      }
      const f = h('div', { class: 'node file' + (n.path === active ? ' active' : ''), textContent: n.name, title: n.path })
      f.onclick = () => onOpen(n.path)
      return f
    }
    tree.replaceChildren(draw(root))
    if (!conn.room.paths().length) tree.append(h('div', { class: 'muted' }, 'no files yet — waiting for a daemon to seed'))
  }
  conn.room.files.observe(render); render()
  return { el, setActive(p: string | null) { active = p; render() } }
}

// ---- right column --------------------------------------------------------
export function feedPane(conn: Conn) {
  const list = h('div', { class: 'feed' })
  const scroll = h('div', { class: 'scroll grow' }, list)
  const input = h('input', { placeholder: 'Post a note to the room…' })
  const send = () => {
    const text = input.value.trim(); if (!text) return
    conn.room.post<NoteMsg>(conn.me, { type: 'note', text })
    input.value = ''
  }
  input.onkeydown = e => { if (e.key === 'Enter') send() }
  const el = h('div', { class: 'pane' }, scroll, h('div', { class: 'composer' }, input, h('button', { onclick: send }, 'Post')))
  const line = (m: Msg) => h('div', { class: 'line' }, dot(m.from),
    h('span', { class: 'badge ' + m.type }, m.type),
    h('span', { class: 't', title: timeStr(m.at) }, formatMsg(m)))
  const append = (ms: Msg[]) => {
    for (const m of ms) list.append(line(m))
    scroll.scrollTop = scroll.scrollHeight
  }
  append(conn.room.messages())
  conn.room.bus.observe(e => {
    const added: Msg[] = []
    e.changes.added.forEach(item => added.push(...(item.content.getContent() as Msg[])))
    append(added)
  })
  return el
}

export function chatPane(conn: Conn) {
  const list = h('div', { class: 'chat' })
  const scroll = h('div', { class: 'scroll grow' }, list)
  const input = h('textarea', { placeholder: `Message ${conn.me.name}'s agent… (Enter to send)`, rows: 2 })
  const send = () => {
    const text = input.value.trim(); if (!text) return
    conn.room.say(conn.me.name, { role: 'human', text })
    input.value = ''
  }
  input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }
  const el = h('div', { class: 'pane' }, scroll, h('div', { class: 'composer' }, input, h('button', { class: 'primary', onclick: send }, 'Send')))
  const item = (it: ChatItem) => h('div', { class: 'msg ' + it.role, title: it.meta ? Object.entries(it.meta).map(([k, v]) => `${k}: ${v}`).join('\n') : '' },
    it.text, it.role === 'human' || it.role === 'agent' ? h('time', {}, timeStr(it.at)) : null)
  let bound: Y.Array<ChatItem> | null = null
  const bind = () => {
    const arr = conn.room.chat(conn.me.name)
    if (arr === bound) return
    bound = arr
    list.replaceChildren(...arr.toArray().map(item))
    scroll.scrollTop = scroll.scrollHeight
    arr.observe(e => {
      e.changes.added.forEach(c => (c.content.getContent() as ChatItem[]).forEach(it => list.append(item(it))))
      scroll.scrollTop = scroll.scrollHeight
    })
  }
  bind()
  conn.room.chats.observe(bind) // the runner or another client may (re)create my chat array
  return el
}

export function tabs(panes: { label: string; el: HTMLElement }[]) {
  const bar = h('div', { class: 'tabs' })
  const wrap = h('div', { class: 'col' }, bar, ...panes.map(p => p.el))
  const activate = (i: number) => {
    panes.forEach((p, j) => p.el.classList.toggle('active', i === j))
    Array.from(bar.children).forEach((b, j) => b.classList.toggle('active', i === j))
  }
  panes.forEach((p, i) => bar.append(h('button', { textContent: p.label, onclick: () => activate(i) })))
  activate(0)
  return wrap
}

export function toaster() {
  const el = h('div', { class: 'toasts' })
  document.body.append(el)
  return (text: string, ms = 4500) => {
    const t = h('div', { class: 'toast' }, text)
    el.append(t)
    setTimeout(() => t.remove(), ms)
  }
}
