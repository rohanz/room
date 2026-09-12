import {
  RoomDoc,
  colorFor,
  describeClaim,
  formatMsg,
  type Claim,
  type Kind,
  type Msg,
  type Presence,
  type Scope,
} from '@room/shared'
import { presences, type Conn } from './conn.ts'
import { Editor } from './editor.ts'

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string | null | undefined)[]
) => {
  const element = document.createElement(tag)
  const { class: className, ...rest } = props
  if (className) element.className = className
  Object.assign(element, rest)
  for (const child of children) if (child != null) element.append(child)
  return element
}

const dot = (name: string, title = name) => {
  const element = h('span', { class: 'dot', title })
  element.style.background = colorFor(name)
  return element
}

const absoluteTime = (at: number) => new Date(at).toLocaleString()

export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 5) return 'active now'
  if (seconds < 60) return `active ${seconds}s ago`
  if (seconds < 3600) return `active ${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `active ${Math.floor(seconds / 3600)}h ago`
  return `active ${Math.floor(seconds / 86400)}d ago`
}

export interface ParticipantClaim extends Claim { stale: boolean }
export interface Participant {
  name: string
  online: boolean
  latestActive?: number
  kinds: Kind[]
  statuses: { kind: Kind; status: string }[]
  scope?: Scope
  files: string[]
  claims: ParticipantClaim[]
}

export interface ParticipantInput {
  presences: readonly Presence[]
  scopes: readonly (readonly [string, Scope])[]
  overlayPeople: readonly string[]
  changesByPerson: ReadonlyMap<string, readonly string[]>
  claims: readonly Claim[]
  now?: number
}

/** One card model per person, derived without mutating room state. */
export function deriveParticipants(input: ParticipantInput): Participant[] {
  const now = input.now ?? Date.now()
  const names = new Set<string>()
  for (const presence of input.presences) names.add(presence.user.name)
  for (const [name] of input.scopes) names.add(name)
  for (const name of input.overlayPeople) names.add(name)

  return Array.from(names).sort().map(name => {
    const current = input.presences.filter(presence => presence.user.name === name)
    const latest = new Map<Kind, Presence>()
    for (const presence of current) {
      const previous = latest.get(presence.user.kind)
      if (!previous || (presence.lastActive ?? 0) >= (previous.lastActive ?? 0)) latest.set(presence.user.kind, presence)
    }
    const scope = input.scopes.find(([scopeName]) => scopeName === name)?.[1]
    const kinds = new Set<Kind>(latest.keys())
    if (scope) kinds.add(scope.byKind)
    for (const claim of input.claims) if (claim.by === name) kinds.add(claim.byKind)
    const latestActive = current.reduce<number | undefined>((value, presence) => {
      if (presence.lastActive === undefined) return value
      return value === undefined ? presence.lastActive : Math.max(value, presence.lastActive)
    }, undefined)
    const online = current.length > 0
    return {
      name,
      online,
      latestActive,
      kinds: Array.from(kinds).sort((a, b) => a.localeCompare(b)),
      statuses: Array.from(latest.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, presence]) => ({ kind, status: presence.status ?? 'online' })),
      scope,
      files: [...(input.changesByPerson.get(name) ?? [])].sort(),
      claims: input.claims
        .filter(claim => claim.by === name)
        .map(claim => ({ ...claim, stale: !online && now - claim.at > 10 * 60_000 })),
    }
  })
}

export interface FileRow { path: string; people: string[] }

export function deriveFileRows(changesByPerson: ReadonlyMap<string, readonly string[]>): FileRow[] {
  const byPath = new Map<string, Set<string>>()
  for (const [person, paths] of changesByPerson) {
    for (const path of paths) {
      const people = byPath.get(path) ?? new Set<string>()
      people.add(person)
      byPath.set(path, people)
    }
  }
  return Array.from(byPath, ([path, people]) => ({ path, people: Array.from(people).sort() }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function participantInput(conn: Conn): ParticipantInput {
  const names = new Set([...conn.room.overlays.keys(), ...conn.room.deleted.keys(), ...conn.room.scopes.keys()])
  const changes = new Map<string, string[]>()
  for (const name of names) changes.set(name, conn.room.changedPaths(name))
  return {
    presences: presences(conn.provider),
    scopes: Array.from(conn.room.scopes.entries()),
    // The participant union deliberately follows spec §9: awareness, scopes, overlays.
    overlayPeople: Array.from(conn.room.overlays.keys()),
    changesByPerson: changes,
    claims: conn.room.openClaims(),
  }
}

export function participantsPanel(conn: Conn): HTMLElement {
  const list = h('div', { class: 'participant-list' })
  const element = h('aside', { class: 'participants scroll' }, h('h3', {}, 'Participants'), list)
  const render = () => {
    const participants = deriveParticipants(participantInput(conn))
    list.replaceChildren(...participants.map(participant => {
      const activity = participant.latestActive === undefined ? 'offline' : relativeTime(participant.latestActive)
      const kinds = h('div', { class: 'kind-row' }, ...participant.kinds.map(kind => h('span', { class: `kind-badge ${kind}` }, kind)))
      const statuses = participant.statuses.length
        ? h('div', { class: 'statuses' }, ...participant.statuses.map(item => h('div', {}, `${item.kind}: ${item.status}`)))
        : h('div', { class: 'statuses muted' }, 'offline')
      const scope = participant.scope
        ? h('div', { class: 'scope' },
            h('div', { class: 'scope-title' }, h('span', { class: 'area' }, participant.scope.area), participant.scope.summary),
            h('div', { class: 'path-list mono' }, participant.scope.paths.join(', ') || 'no paths'))
        : h('div', { class: 'muted no-scope' }, 'no scope declared')
      const files = h('div', { class: 'person-files' },
        h('span', { class: 'label' }, 'changed'),
        participant.files.length ? h('div', { class: 'path-list mono' }, participant.files.join(', ')) : h('span', { class: 'muted' }, ' none'))
      const claims = participant.claims.length
        ? h('div', { class: 'person-claims' }, ...participant.claims.map(claim => h('div', {
            class: `person-claim${claim.stale ? ' stale' : ''}`,
            title: describeClaim(claim),
          }, `${claim.path}:${claim.from}-${claim.to}`, claim.stale ? h('span', { class: 'stale-badge' }, 'stale') : null)))
        : null
      return h('article', { class: `participant${participant.online ? '' : ' offline'}` },
        h('div', { class: 'participant-head' }, dot(participant.name), h('strong', {}, participant.name), h('span', { class: 'sp' }), kinds),
        h('div', { class: 'presence-line' }, statuses, h('span', { class: 'activity muted', title: participant.latestActive ? absoluteTime(participant.latestActive) : '' }, activity)),
        scope,
        files,
        claims)
    }))
    if (!participants.length) list.append(h('div', { class: 'empty-note muted' }, 'Waiting for participants…'))
  }
  conn.provider.awareness.on('change', render)
  conn.room.scopes.observe(render)
  conn.room.overlays.observeDeep(render)
  conn.room.deleted.observeDeep(render)
  conn.room.claims.observe(render)
  render()
  return element
}

function changesByPerson(room: RoomDoc): Map<string, string[]> {
  const names = new Set([...room.overlays.keys(), ...room.deleted.keys()])
  return new Map(Array.from(names, name => [name, room.changedPaths(name)]))
}

export function centrePanel(conn: Conn): HTMLElement {
  const fileList = h('div', { class: 'file-list scroll' })
  const pathLabel = h('span', { class: 'selected-path mono muted' }, 'no file selected')
  const personSelect = h('select', { class: 'person-select', title: 'Overlay to display' })
  const host = h('div', { class: 'editor-wrap' })
  const editor = new Editor(host)
  const element = h('main', { class: 'center' },
    h('section', { class: 'center-files' }, h('h3', {}, 'Changed files'), fileList),
    h('section', { class: 'viewer' }, h('div', { class: 'toolbar' }, pathLabel, h('span', { class: 'sp' }), personSelect), host))
  let selectedPath: string | null = null
  let selectedPerson: string | null = null

  const renderViewer = (rows: FileRow[]) => {
    const row = rows.find(candidate => candidate.path === selectedPath)
    if (!row) {
      selectedPath = rows[0]?.path ?? null
      selectedPerson = null
    }
    const selected = rows.find(candidate => candidate.path === selectedPath)
    if (!selected) {
      pathLabel.textContent = 'no file selected'
      pathLabel.classList.add('muted')
      personSelect.replaceChildren()
      personSelect.hidden = true
      editor.empty(rows.length ? 'Select a changed file' : 'Waiting for changed files…')
      return
    }
    if (!selectedPerson || !selected.people.includes(selectedPerson)) selectedPerson = selected.people[0]
    pathLabel.textContent = selected.path
    pathLabel.classList.remove('muted')
    personSelect.hidden = false
    personSelect.replaceChildren(...selected.people.map(person => h('option', { value: person, selected: person === selectedPerson }, person)))
    const person = selectedPerson!
    if (conn.room.deleted.get(person)?.has(selected.path)) {
      editor.empty(`deleted by ${person}`)
      return
    }
    const text = conn.room.text(selected.path, person)
    if (text === undefined) {
      editor.empty(`No overlay available for ${person}`)
      return
    }
    editor.show(selected.path, text, conn.room.claimsFor(selected.path))
  }

  const render = () => {
    const rows = deriveFileRows(changesByPerson(conn.room))
    if (selectedPath && !rows.some(row => row.path === selectedPath)) selectedPath = null
    if (!selectedPath) selectedPath = rows[0]?.path ?? null
    fileList.replaceChildren(...rows.map(row => {
      const item = h('button', { class: `file-item${row.path === selectedPath ? ' active' : ''}`, title: row.path },
        h('span', { class: 'file-path mono' }, row.path),
        h('span', { class: 'file-dots' }, ...row.people.map(person => dot(person, `${person} changed this file`))))
      item.onclick = () => { selectedPath = row.path; selectedPerson = null; render() }
      return item
    }))
    if (!rows.length) fileList.append(h('div', { class: 'empty-note muted' }, 'No changed files'))
    renderViewer(rows)
  }
  personSelect.onchange = () => { selectedPerson = personSelect.value; render() }
  conn.room.overlays.observeDeep(render)
  conn.room.deleted.observeDeep(render)
  conn.room.claims.observe(render)
  render()
  return element
}

export function feedMessages(room: RoomDoc, area: string, onlyLedger: boolean): Msg[] {
  if (area !== 'all') return room.ledger({ area })
  return onlyLedger ? room.ledger() : room.messages()
}

export interface FeedThread { message: Msg; replies: Msg[] }

export function threadFeed(messages: readonly Msg[]): FeedThread[] {
  const questionIds = new Set(messages.filter(message => message.type === 'question').map(message => message.id))
  const threads = new Map<string, FeedThread>()
  const top: FeedThread[] = []
  for (const message of messages) {
    if (message.type === 'answer' && questionIds.has(message.inReplyTo)) continue
    const thread = { message, replies: [] }
    top.push(thread)
    if (message.type === 'question') threads.set(message.id, thread)
  }
  for (const message of messages) {
    if (message.type === 'answer') threads.get(message.inReplyTo)?.replies.push(message)
  }
  return top
}

function feedLine(message: Msg): HTMLElement {
  return h('div', { class: `feed-line ${message.type}` },
    h('span', { class: `priority ${message.priority}` }, message.priority),
    h('span', { class: 'feed-text' }, formatMsg(message)),
    h('time', { class: 'feed-time muted', title: absoluteTime(message.at) }, new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))
}

export function feedPanel(conn: Conn): HTMLElement {
  const areaSelect = h('select', { title: 'Filter feed by area' })
  const ledgerOnly = h('input', { type: 'checkbox' })
  const list = h('div', { class: 'feed-list' })
  const scroll = h('div', { class: 'feed-scroll scroll' }, list)
  const element = h('aside', { class: 'feed' },
    h('div', { class: 'feed-head' }, h('h3', {}, 'Feed'), h('span', { class: 'sp' }), areaSelect,
      h('label', { class: 'ledger-check' }, ledgerOnly, 'only ledger entries')),
    scroll)

  const render = () => {
    const areas = Array.from(new Set(conn.room.allScopes().map(scope => scope.area))).sort()
    const previous = areaSelect.value || 'all'
    const selected = previous === 'all' || areas.includes(previous) ? previous : 'all'
    areaSelect.replaceChildren(h('option', { value: 'all', selected: selected === 'all' }, 'all areas'),
      ...areas.map(area => h('option', { value: area, selected: selected === area }, area)))
    const messages = feedMessages(conn.room, selected, ledgerOnly.checked)
    list.replaceChildren(...threadFeed(messages).map(thread => {
      const question = feedLine(thread.message)
      if (!thread.replies.length) return question
      return h('div', { class: 'feed-thread' }, question,
        h('div', { class: 'feed-replies' }, ...thread.replies.map(feedLine)))
    }))
    if (!messages.length) list.append(h('div', { class: 'empty-note muted' }, 'No matching feed entries'))
    scroll.scrollTop = scroll.scrollHeight
  }
  areaSelect.onchange = render
  ledgerOnly.onchange = render
  conn.room.bus.observe(render)
  conn.room.scopes.observe(render)
  render()
  return element
}

export function header(conn: Conn): HTMLElement {
  const roomName = h('span', { class: 'room-name' }, conn.displayRoomName)
  const base = h('span', { class: 'header-detail mono' }, 'base —')
  const count = h('span', { class: 'header-detail' }, '0 participants')
  const connection = h('span', { class: 'connection' }, 'disconnected')
  const element = h('header', { class: 'header' }, roomName, base, count, h('span', { class: 'sp' }), connection)
  const render = () => {
    const meta = conn.room.meta
    base.textContent = `base ${(meta.base ?? '').slice(0, 7) || '—'}`
    const total = deriveParticipants(participantInput(conn)).length
    count.textContent = `${total} participant${total === 1 ? '' : 's'}`
  }
  conn.room.metaMap.observe(render)
  conn.room.scopes.observe(render)
  conn.room.overlays.observeDeep(render)
  conn.provider.awareness.on('change', render)
  conn.onStatus(connected => {
    connection.textContent = connected ? 'connected' : 'disconnected'
    connection.classList.toggle('online', connected)
  })
  render()
  return element
}
