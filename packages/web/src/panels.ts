import type * as Y from 'yjs'
import { colorFor, displayName, formatMsg, type ChatItem, type Claim, type Cursor, type Msg, type NoteMsg, type Presence } from '@room/shared'
import { presences, type Conn } from './conn.ts'

export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string | null | undefined)[]) => {
  const el = document.createElement(tag)
  const { class: cls, ...rest } = props
  if (cls) el.className = cls
  Object.assign(el, rest)
  for (const k of kids) if (k != null) el.append(k)
  return el
}
const dot = (name: string, title?: string) => { const d = h('span', { class: 'dot', title: title ?? name }); d.style.background = colorFor(name); return d }
const timeStr = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
export const relTime = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return timeStr(t)
}

// ---- people: one entry per person, folding their human + agent presences -------------
export interface Person { name: string; human?: Presence; agent?: Presence }
export function agentPresence(conn: Conn, name: string): Presence | undefined {
  return presences(conn.provider).find(({ p }) => p.user.name === name && p.user.kind === 'agent')?.p
}
export function people(conn: Conn): Person[] {
  const m = new Map<string, Person>()
  for (const { p } of presences(conn.provider)) {
    const e = m.get(p.user.name) ?? { name: p.user.name }
    if (p.user.kind === 'agent') e.agent ??= p
    // daemon + browser both publish a human presence for one name: prefer the one with a cursor
    else if (!e.human || (!e.human.cursor && p.cursor)) e.human = p
    m.set(p.user.name, e)
  }
  return Array.from(m.values()).sort((a, b) => Number(b.name === conn.me.name) - Number(a.name === conn.me.name) || a.name.localeCompare(b.name))
}
/** Where a person "is": human cursor, else agent cursor, else the agent's newest claim. */
export function whereIs(conn: Conn, p: Person): Cursor | undefined {
  if (p.human?.cursor) return p.human.cursor
  if (p.agent?.cursor) return p.agent.cursor
  const c = conn.room.openClaims().filter(c => c.by === p.name).pop()
  return c ? { path: c.path, from: c.from, to: c.to } : undefined
}
const agentLabel = (p: Person) => {
  if (!p.agent) return 'no agent'
  const s = p.agent.status ?? 'idle'
  const c = p.agent.cursor
  if (c && /^editing/.test(s)) return `editing ${c.path.split('/').pop()} ${c.from}-${c.to}`
  return s
}

// ---- touched files ---------------------------------------------------------------
/**
 * Files whose text is likely to differ from the committed base. The daemon does not publish
 * committed text or base hashes, so this is a heuristic: changed in the room since this page
 * loaded, named in any `changed` bus message, or has/had a claim. Labelled "touched" to be
 * honest. True committed-vs-live needs the daemon to publish per-file base hashes — day two.
 */
export function touchedTracker(conn: Conn) {
  const set = new Set<string>()
  const listeners: (() => void)[] = []
  const emit = () => listeners.forEach(f => f())
  const add = (ps: Iterable<string>) => { let n = 0; for (const p of ps) if (!set.has(p)) { set.add(p); n++ }; if (n) emit() }
  const scanBus = (ms: Msg[]) => add(ms.flatMap(m => m.type === 'changed' ? m.paths : m.type === 'claim' || m.type === 'release' || m.type === 'conflict' ? [m.path] : []))
  scanBus(conn.room.messages())
  conn.room.bus.observe(e => { const ms: Msg[] = []; e.changes.added.forEach(i => ms.push(...(i.content.getContent() as Msg[]))); scanBus(ms) })
  const scanClaims = () => add(conn.room.openClaims().map(c => c.path))
  scanClaims(); conn.room.claims.observe(scanClaims)
  // text edits: only after the initial sync, otherwise every file looks touched
  let live = conn.provider.synced
  conn.provider.once('sync', () => { live = true })
  conn.room.files.observeDeep(evs => {
    if (!live) return
    add(evs.flatMap(ev => ev.target !== conn.room.files ? [String(ev.path[0] ?? '')] : []).filter(Boolean))
  })
  return { has: (p: string) => set.has(p), get size() { return set.size }, onChange(f: () => void) { listeners.push(f) } }
}
export type Touched = ReturnType<typeof touchedTracker>

// ---- header ----------------------------------------------------------------------
export interface HeaderOpts { touched: Touched; onJump(c: Cursor): void; unread: UnreadTracker }
export function header(conn: Conn, o: HeaderOpts) {
  const repo = h('span', { class: 'repo' }, '…')
  const sub = h('span', { class: 'sub muted' })
  const count = h('span', { class: 'sub muted' })
  const chips = h('div', { class: 'chips' })
  const pill = h('span', { class: 'pill' }, 'offline')
  const el = h('header', { class: 'header' }, h('div', { class: 'meta' }, repo, sub, count), chips, pill)
  const renderMeta = () => {
    const m = conn.room.meta
    repo.textContent = m.repo ?? 'room'
    sub.replaceChildren(m.branch ?? '—', '@', h('span', { class: 'mono' }, (m.base ?? '').slice(0, 7) || '—'))
    count.textContent = `${o.touched.size} touched`
  }
  const renderChips = () => {
    chips.replaceChildren(...people(conn).map(p => {
      const me = p.name === conn.me.name
      const where = whereIs(conn, p)
      const n = o.unread.countFrom(p.name)
      const chip = h('button', { class: 'chip person' + (me ? ' me' : ''), title: where ? `${where.path}:${where.from}` : 'no location' },
        dot(p.name), h('span', { class: 'nm' }, p.name, me ? h('span', { class: 'muted' }, ' (you)') : null),
        h('span', { class: 'ag muted' }, 'agent: ', h('span', { class: 'st ' + (p.agent ? (p.agent.status ?? 'idle').split(/[\s:]/)[0] : 'none') }, agentLabel(p))),
        n ? h('span', { class: 'unread', title: `${n} unread for you` }, String(n)) : null)
      chip.onclick = () => { if (where) o.onJump(where); o.unread.clearFrom(p.name) }
      return chip
    }))
  }
  conn.room.metaMap.observe(renderMeta); renderMeta()
  o.touched.onChange(renderMeta)
  conn.provider.awareness.on('change', renderChips)
  conn.room.claims.observe(renderChips)
  o.unread.onChange(renderChips)
  renderChips()
  conn.onStatus(c => { pill.textContent = c ? 'connected' : 'disconnected'; pill.classList.toggle('on', c) })
  return el
}

/** Unread question/conflict messages addressed to me, keyed by sender. */
export function unreadTracker(conn: Conn) {
  const ids = new Map<string, string>() // msg id -> sender
  const listeners: (() => void)[] = []
  const emit = () => listeners.forEach(f => f())
  const seen = (m: Msg) => m.to === conn.me.name && (m.type === 'question' || m.type === 'conflict') && Date.now() - m.at < 10 * 60_000
  conn.room.bus.observe(e => {
    let n = 0
    e.changes.added.forEach(i => (i.content.getContent() as Msg[]).forEach(m => { if (seen(m)) { ids.set(m.id, m.from); n++ } }))
    if (n) emit()
  })
  return {
    countFrom: (name: string) => Array.from(ids.values()).filter(v => v === name).length,
    clearFrom(name: string) { let n = 0; for (const [k, v] of ids) if (v === name) { ids.delete(k); n++ }; if (n) emit() },
    /** Called when the agent panel shows the event: clears after 10s of being viewed. */
    viewed(msgId: string, delay = 10_000) { if (ids.has(msgId)) setTimeout(() => { if (ids.delete(msgId)) emit() }, delay) },
    clear(msgId: string) { if (ids.delete(msgId)) emit() },
    onChange(f: () => void) { listeners.push(f) },
  }
}
export type UnreadTracker = ReturnType<typeof unreadTracker>

// ---- file tree ---------------------------------------------------------------------
interface TreeNode { name: string; path: string; kids?: Map<string, TreeNode> }
export function fileTree(conn: Conn, touched: Touched, onOpen: (p: string) => void) {
  const tree = h('div', { class: 'tree' })
  const el = h('aside', { class: 'files scroll' }, h('h3', {}, 'Files'), tree)
  let active: string | null = null
  const partiesIn = (path: string): string[] => {
    const names = new Set<string>()
    for (const { p } of presences(conn.provider)) if (p.cursor?.path === path) names.add(p.user.name)
    for (const c of conn.room.claimsFor(path)) names.add(c.by)
    return Array.from(names).sort()
  }
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
      const t = touched.has(n.path)
      const f = h('div', { class: 'node file' + (n.path === active ? ' active' : '') + (t ? ' touched' : ''), title: n.path + (t ? ' · touched (changed in this room, claimed, or in a changed message)' : '') },
        h('span', { class: 'fn' }, n.name),
        h('span', { class: 'dots' }, ...partiesIn(n.path).map(nm => dot(nm, `${nm} is here`))),
        t ? h('span', { class: 'gitmark', title: 'touched' }, 'M') : null)
      f.onclick = () => onOpen(n.path)
      return f
    }
    tree.replaceChildren(draw(root))
    if (!conn.room.paths().length) tree.append(h('div', { class: 'muted' }, 'no files yet — waiting for a daemon to seed'))
  }
  conn.room.files.observe(render)
  conn.room.claims.observe(render)
  conn.provider.awareness.on('change', render)
  touched.onChange(render)
  render()
  return { el, setActive(p: string | null) { active = p; render() } }
}

// ---- right panel: your agent --------------------------------------------------------
export function agentPane(conn: Conn, unread: UnreadTracker) {
  const status = h('span', { class: 'ast' }, 'offline')
  const stop = h('button', { class: 'stop', textContent: 'Stop', hidden: true })
  const head = h('div', { class: 'ahead' }, dot(conn.me.name), h('span', { class: 'ttl' }, `${conn.me.name}'s agent`), h('span', { class: 'muted' }, ' · '), status, h('span', { class: 'sp' }), stop)
  const list = h('div', { class: 'chat' })
  const scroll = h('div', { class: 'scroll grow' }, list)
  const input = h('textarea', { placeholder: `Message ${conn.me.name}'s agent… (Enter to send)`, rows: 2 })
  const send = () => {
    const text = input.value.trim(); if (!text) return
    conn.room.say(conn.me.name, { role: 'human', text })
    input.value = ''
  }
  input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }
  const el = h('section', { class: 'agent' }, head, scroll, h('div', { class: 'composer' }, input, h('button', { class: 'primary', onclick: send }, 'Send')))

  let stopRequested = false
  stop.onclick = () => { conn.room.say(conn.me.name, { role: 'human', text: '/stop' }); stopRequested = true; renderStatus() }
  const renderStatus = () => {
    const ag = agentPresence(conn, conn.me.name)
    const s = ag ? (ag.status ?? 'idle') : 'offline'
    const running = !!ag && s !== 'idle' && s !== 'offline'
    if (!running) stopRequested = false
    status.textContent = s
    status.className = 'ast ' + s.split(/[\s:]/)[0]
    stop.hidden = !running
    stop.textContent = stopRequested ? 'stop requested' : 'Stop'
    stop.disabled = stopRequested
  }
  conn.provider.awareness.on('change', renderStatus); renderStatus()

  const item = (it: ChatItem) => {
    const addressed = it.role === 'event' && (it.meta?.type === 'question' || it.meta?.type === 'conflict')
    const el = h('div', { class: 'msg ' + it.role + (addressed ? ' addressed' : ''), title: it.meta ? Object.entries(it.meta).map(([k, v]) => `${k}: ${v}`).join('\n') : '' },
      it.text, it.role === 'human' || it.role === 'agent' ? h('time', {}, timeStr(it.at)) : null)
    const id = it.meta?.msg_id
    if (addressed && id) { unread.viewed(id); el.onclick = () => unread.clear(id) }
    return el
  }
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
  return el
}

// ---- agents channel: the bus as a group chat ------------------------------------------
const LOUD = new Set<Msg['type']>(['question', 'answer', 'conflict'])
export function agentsPane(conn: Conn) {
  const list = h('div', { class: 'bus' })
  const scroll = h('div', { class: 'scroll grow' }, list)
  const input = h('input', { placeholder: 'Post a note to the room…' })
  const send = () => {
    const text = input.value.trim(); if (!text) return
    conn.room.post<NoteMsg>(conn.me, { type: 'note', text })
    input.value = ''
  }
  input.onkeydown = e => { if (e.key === 'Enter') send() }
  const el = h('section', { class: 'agents' }, h('div', { class: 'ahead' }, h('span', { class: 'ttl' }, 'Agents'), h('span', { class: 'muted' }, ' · room channel')), scroll,
    h('div', { class: 'composer' }, input, h('button', { onclick: send }, 'Post')))

  const threads = new Map<string, HTMLElement>() // question msg id -> replies container
  const quiet = (m: Msg) => h('div', { class: 'line quiet' }, dot(m.from), h('span', { class: 'badge ' + m.type }, m.type), h('span', { class: 't', title: timeStr(m.at) }, formatMsg(m)), h('span', { class: 'muted rel' }, relTime(m.at)))
  const bubble = (m: Msg) => {
    const who = displayName({ name: m.from, kind: m.fromKind })
    const text = m.type === 'conflict' ? `Conflict on ${m.path}: ${m.text}` : m.type === 'question' || m.type === 'answer' ? m.text : formatMsg(m)
    const b = h('div', { class: 'bub ' + m.type + (m.to === conn.me.name ? ' tome' : '') },
      h('div', { class: 'who' }, dot(m.from), h('b', {}, who), m.to ? h('span', { class: 'muted' }, ` → ${m.to}'s agent`) : null, h('span', { class: 'badge ' + m.type }, m.type), h('span', { class: 'muted rel', title: timeStr(m.at) }, relTime(m.at))),
      h('div', { class: 'txt' }, text))
    if (m.type === 'question') { const replies = h('div', { class: 'replies' }); threads.set(m.id, replies); return h('div', { class: 'thread' }, b, replies) }
    return b
  }
  const append = (ms: Msg[]) => {
    for (const m of ms) {
      const node = LOUD.has(m.type) ? bubble(m) : quiet(m)
      const parent = m.type === 'answer' ? threads.get(m.inReplyTo) : undefined
      ;(parent ?? list).append(node)
    }
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

export function toaster() {
  const el = h('div', { class: 'toasts' })
  document.body.append(el)
  return (text: string, ms = 4500) => {
    const t = h('div', { class: 'toast' }, text)
    el.append(t)
    setTimeout(() => t.remove(), ms)
  }
}

export type { Claim }
