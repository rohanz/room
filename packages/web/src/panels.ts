import {
  RoomDoc,
  colorFor,
  describeClaim,
  formatPlans,
  scopeCovers,
  type Claim,
  type Kind,
  type Msg,
  type Presence,
  type Scope,
} from '@room/shared'
import { presences, type Conn } from './conn.ts'
import { Editor } from './editor.ts'
import { buildActivityGraph, type OverlayVersion } from './activity-graph.ts'
import { classifyMergedLines, classifyThreeWay, unifiedDiffLines, type MergedLine } from './merged.ts'
import { groupEpisodes, type Episode, type TimelineItem } from './timeline.ts'

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
const clockTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export interface FocusState {
  person: string | null
  set(person: string | null): void
  subscribe(listener: () => void): void
}

export function createFocusState(): FocusState {
  const listeners = new Set<() => void>()
  return {
    person: null,
    set(person) {
      if (this.person === person) return
      this.person = person
      for (const listener of listeners) listener()
    },
    subscribe(listener) { listeners.add(listener) },
  }
}

export interface ParticipantClaim extends Claim { stale: boolean }
export interface Participant {
  name: string
  online: boolean
  behindBase: boolean
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
  roomBase?: string
  basesByPerson?: ReadonlyMap<string, string>
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
    const ownBase = input.basesByPerson?.get(name)
    return {
      name,
      online,
      behindBase: Boolean(input.roomBase && ownBase && ownBase !== input.roomBase),
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

/** Derives the single prominent state shown on a person card. */
export function deriveStatePill(person: Pick<Participant, 'online' | 'behindBase' | 'statuses' | 'claims'>): string {
  if (!person.online) return 'offline'
  const statuses = person.statuses.map(item => item.status.trim()).filter(Boolean)
  const waiting = statuses.find(status => status.toLowerCase().startsWith('waiting'))
  if (waiting) return `waiting${waiting.slice(7)}`
  if (person.behindBase || statuses.some(status => status.toLowerCase().includes('behind'))) return 'behind base'
  if (statuses.some(status => /ahead|unpushed/i.test(status))) return 'ahead (unpushed)'
  const explicitEditing = statuses.find(status => status.toLowerCase().startsWith('editing '))
  if (explicitEditing) return `editing${explicitEditing.slice(7)}`
  const claim = person.claims[0]
  if (claim) return `editing ${claim.plans?.[0]?.symbol ?? claim.path}`
  return 'idle'
}

export interface FileRow { path: string; people: string[]; area: string; claimCount: number }

export function deriveFileRows(
  changesByPerson: ReadonlyMap<string, readonly string[]>,
  scopes: readonly Scope[] = [],
  claims: readonly Claim[] = [],
): FileRow[] {
  const byPath = new Map<string, Set<string>>()
  for (const [person, paths] of changesByPerson) {
    for (const path of paths) {
      const people = byPath.get(path) ?? new Set<string>()
      people.add(person)
      byPath.set(path, people)
    }
  }
  return Array.from(byPath, ([path, people]) => {
    const area = [...scopes].sort((a, b) => b.at - a.at).find(scope => scopeCovers(scope, path))?.area ?? 'other'
    return { path, people: Array.from(people).sort(), area, claimCount: claims.filter(claim => claim.path === path).length }
  }).sort((a, b) => a.area.localeCompare(b.area) || a.path.localeCompare(b.path))
}

function changesByPerson(room: RoomDoc): Map<string, string[]> {
  const names = new Set([...room.overlays.keys(), ...room.deleted.keys()])
  return new Map(Array.from(names, name => [name, room.changedPaths(name)]))
}

function participantInput(conn: Conn): ParticipantInput {
  const names = new Set([...conn.room.overlays.keys(), ...conn.room.deleted.keys(), ...conn.room.scopes.keys()])
  const changes = new Map<string, string[]>()
  for (const name of names) changes.set(name, conn.room.changedPaths(name))
  return {
    presences: presences(conn.provider),
    scopes: Array.from(conn.room.scopes.entries()),
    overlayPeople: Array.from(conn.room.overlays.keys()),
    changesByPerson: changes,
    claims: conn.room.openClaims(),
    roomBase: conn.room.meta.base,
    basesByPerson: new Map(conn.room.bases.entries()),
  }
}

function displayPlans(plans: NonNullable<Claim['plans']>): string {
  return plans.map(plan => `→ ${plan.kind} ${plan.symbol}${plan.detail ? ` to ${plan.detail}` : ''}`).join(' · ')
}

function planText(claim: Claim): string {
  return claim.plans?.length ? ` ${displayPlans(claim.plans)}` : ''
}

export function participantsPanel(conn: Conn, focus: FocusState): HTMLElement {
  const list = h('div', { class: 'participant-list' })
  const element = h('aside', { class: 'participants scroll' }, h('div', { class: 'panel-title' }, 'People'), list)
  const render = () => {
    const participants = deriveParticipants(participantInput(conn))
    list.replaceChildren(...participants.map(participant => {
      const state = deriveStatePill(participant)
      const card = h('button', {
        class: `participant${participant.online ? '' : ' offline'}${focus.person === participant.name ? ' focused' : ''}`,
        title: focus.person === participant.name ? `Clear ${participant.name} focus` : `Focus on ${participant.name}`,
      },
      h('div', { class: 'participant-head' }, dot(participant.name), h('strong', {}, participant.name), h('span', { class: 'sp' }),
        h('span', { class: `state-pill ${state.split(' ')[0]}` }, state)),
      participant.scope
        ? h('div', { class: 'scope-line' }, h('strong', {}, `${participant.scope.area}:`), ` ${participant.scope.summary}`)
        : h('div', { class: 'scope-line muted' }, 'no area declared'),
      participant.claims.length
        ? h('div', { class: 'person-claims' }, ...participant.claims.map(claim => h('div', {
            class: `person-claim${claim.stale ? ' stale' : ''}`,
            title: describeClaim(claim),
          }, `${claim.path}:${claim.from}-${claim.to} · ${claim.intent}${planText(claim)}`)))
        : h('div', { class: 'micro muted' }, 'no active claims'),
      h('div', { class: 'files-summary' }, h('span', { class: 'micro-label' }, 'FILES'),
        h('span', { class: `mono ${participant.files.length ? '' : 'muted'}` }, participant.files.join(', ') || 'none')),
      h('div', { class: 'card-foot muted' }, participant.latestActive ? relativeTime(participant.latestActive) : 'not connected'))
      card.onclick = () => focus.set(focus.person === participant.name ? null : participant.name)
      return card
    }))
    if (!participants.length) list.append(h('div', { class: 'empty-note muted' }, 'Waiting for participants…'))
  }
  conn.provider.awareness.on('change', render)
  conn.room.scopes.observe(render)
  conn.room.overlays.observeDeep(render)
  conn.room.deleted.observeDeep(render)
  conn.room.claims.observe(render)
  conn.room.bases.observe(render)
  focus.subscribe(render)
  render()
  return element
}

function recentPeople(room: RoomDoc, path: string, people: readonly string[]): string[] {
  const score = new Map(people.map(person => [person, 0]))
  for (const message of room.messages()) {
    if (message.type === 'changed' && message.paths.includes(path) && score.has(message.from)) score.set(message.from, message.at)
  }
  return [...people].sort((a, b) => (score.get(b)! - score.get(a)!) || a.localeCompare(b))
}

function lineElement(line: MergedLine, names: [string, string], prefix = ''): HTMLElement {
  const owner = line.side === 'a' ? names[0] : line.side === 'b' ? names[1] : ''
  const row = h('div', { class: `code-line side-${line.side}${line.conflict ? ' conflict-line' : ''}` },
    h('span', { class: 'conflict-gutter' }, line.conflict ? 'conflict?' : ''),
    h('span', { class: 'line-number' }, line.aLine?.toString() ?? ''),
    h('span', { class: 'line-number' }, line.bLine?.toString() ?? ''),
    h('span', { class: 'diff-prefix' }, prefix),
    h('code', {}, line.text || ' '))
  if (owner) row.style.setProperty('--line-owner', colorFor(owner))
  return row
}

function renderCodeLines(host: HTMLElement, lines: readonly (MergedLine & { prefix?: string })[], names: [string, string]): void {
  host.replaceChildren(h('div', { class: 'code-scroll scroll mono' }, ...lines.map(line => lineElement(line, names, line.prefix))))
}

export function centrePanel(conn: Conn, focus: FocusState): HTMLElement {
  const fileList = h('div', { class: 'file-list scroll' })
  const pathLabel = h('span', { class: 'selected-path mono muted' }, 'no file selected')
  const personSelect = h('select', { class: 'person-select', title: 'Person whose overlay to display' })
  const compareLabel = h('span', { class: 'compare-label muted' })
  const legend = h('div', { class: 'legend' })
  const host = h('div', { class: 'editor-wrap' })
  const editor = new Editor(host)
  const tabs = ['Merged', 'Diff', 'File'] as const
  type Tab = typeof tabs[number]
  let tab: Tab = 'Merged'
  let selectedPath: string | null = null
  let selectedPerson: string | null = null
  let render = () => {}
  const tabStrip = h('div', { class: 'tabs' }, ...tabs.map(value => {
    const button = h('button', { class: `tab${value === tab ? ' active' : ''}` }, value)
    button.onclick = () => { tab = value; render() }
    return button
  }))
  const element = h('main', { class: 'center' },
    h('section', { class: 'center-files' }, h('div', { class: 'panel-title' }, 'Changed files'), fileList),
    h('section', { class: 'viewer' },
      h('div', { class: 'viewer-top' }, tabStrip, h('div', { class: 'toolbar' }, pathLabel, h('span', { class: 'sp' }), compareLabel, personSelect)),
      legend,
      host))

  const showViewer = (rows: FileRow[]) => {
    const selected = rows.find(candidate => candidate.path === selectedPath)
    if (!selected) {
      editor.empty(rows.length ? 'Select a changed file' : 'Waiting for changed files…')
      pathLabel.textContent = 'no file selected'
      personSelect.hidden = true
      compareLabel.hidden = true
      legend.replaceChildren()
      return
    }
    pathLabel.textContent = selected.path
    pathLabel.classList.remove('muted')
    const people = recentPeople(conn.room, selected.path, selected.people)
    if (focus.person && people.includes(focus.person)) selectedPerson = focus.person
    if (!selectedPerson || !people.includes(selectedPerson)) selectedPerson = people[0]
    personSelect.replaceChildren(...people.map(person => h('option', { value: person, selected: person === selectedPerson }, person)))
    personSelect.hidden = tab === 'Merged'
    compareLabel.hidden = tab !== 'Diff'

    if (tab === 'File') {
      legend.replaceChildren()
      compareLabel.textContent = ''
      const person = selectedPerson!
      if (conn.room.deleted.get(person)?.has(selected.path)) return editor.empty(`deleted by ${person}`)
      const text = conn.room.text(selected.path, person)
      if (text === undefined) return editor.empty(`No overlay available for ${person}`)
      editor.show(selected.path, text, conn.room.claimsFor(selected.path))
      return
    }
    editor.empty()
    if (people.length < 2) {
      const person = people[0]
      legend.replaceChildren(h('span', {}, dot(person), ` lines by ${person}`))
      const text = conn.room.text(selected.path, person) ?? ''
      renderCodeLines(host, text.split('\n').filter((_, index, all) => index < all.length - 1 || all[index] !== '').map((value, index) => ({
        text: value, side: 'common' as const, conflict: false, aLine: index + 1,
      })), [person, person])
      return
    }

    if (tab === 'Merged') {
      const pair = people.slice(0, 2) as [string, string]
      legend.replaceChildren(h('span', {}, dot(pair[0]), ` lines by ${pair[0]}`), h('span', {}, dot(pair[1]), ` lines by ${pair[1]}`))
      const a = conn.room.text(selected.path, pair[0]) ?? '', b = conn.room.text(selected.path, pair[1]) ?? ''
      const sha = conn.room.baseOf(pair[0])
      const base = sha ? conn.room.baseText(sha, selected.path) : undefined
      renderCodeLines(host, base !== undefined ? classifyThreeWay(base, a, b) : classifyMergedLines(a, b), pair)
      return
    }

    const person = selectedPerson!
    const other = people.length > 2 ? (people[0] === person ? people[1] : people[0]) : people.find(value => value !== person)!
    compareLabel.textContent = `vs ${other}`
    legend.replaceChildren(h('span', {}, dot(other), ` removed from ${other}`), h('span', {}, dot(person), ` added by ${person}`))
    renderCodeLines(host, unifiedDiffLines(conn.room.text(selected.path, other) ?? '', conn.room.text(selected.path, person) ?? ''), [other, person])
  }

  render = () => {
    for (const button of tabStrip.querySelectorAll('.tab')) button.classList.toggle('active', button.textContent === tab)
    const claims = conn.room.openClaims()
    const rows = deriveFileRows(changesByPerson(conn.room), conn.room.allScopes(), claims)
    if (!selectedPath || !rows.some(row => row.path === selectedPath)) selectedPath = rows[0]?.path ?? null
    if (focus.person && !rows.find(row => row.path === selectedPath)?.people.includes(focus.person)) {
      selectedPath = rows.find(row => row.people.includes(focus.person!))?.path ?? selectedPath
    }
    const grouped = new Map<string, FileRow[]>()
    for (const row of rows) grouped.set(row.area, [...(grouped.get(row.area) ?? []), row])
    fileList.replaceChildren(...Array.from(grouped, ([area, areaRows]) => h('div', { class: 'file-group' },
      h('div', { class: 'file-area' }, area),
      ...areaRows.map(row => {
        const item = h('button', { class: `file-item${row.path === selectedPath ? ' active' : ''}`, title: row.path },
          h('span', { class: 'file-path mono' }, row.path),
          row.claimCount ? h('span', { class: 'claim-count', title: `${row.claimCount} active claim${row.claimCount === 1 ? '' : 's'}` }, String(row.claimCount)) : null,
          h('span', { class: 'file-dots' }, ...row.people.map(person => dot(person, `${person} changed this file`))))
        item.onclick = () => { selectedPath = row.path; selectedPerson = focus.person; render() }
        return item
      }))))
    if (!rows.length) fileList.append(h('div', { class: 'empty-note muted' }, 'No changed files'))
    showViewer(rows)
  }
  personSelect.onchange = () => { selectedPerson = personSelect.value; render() }
  conn.room.overlays.observeDeep(render)
  conn.room.deleted.observeDeep(render)
  conn.room.claims.observe(render)
  conn.room.scopes.observe(render)
  conn.room.bus.observe(render)
  focus.subscribe(render)
  render()
  return element
}

function priorityBadge(message: Msg): HTMLElement | null {
  if (message.priority === 'fyi') return null
  return h('span', { class: `priority ${message.priority}` }, message.priority)
}

function copyChips(names: readonly string[]): HTMLElement[] {
  return names.map(name => h('span', { class: 'link-chip' }, `→ also sent to ${name}`))
}

function messageBody(message: Msg): (Node | string | null)[] {
  switch (message.type) {
    case 'claim': return [h('strong', {}, 'claimed '), h('span', { class: 'mono' }, `${message.path}:${message.from_line}-${message.to_line}`), ` · ${message.intent}${message.plans?.length ? ` ${displayPlans(message.plans)}` : ''}`]
    case 'release': return [h('strong', {}, 'released '), h('span', { class: 'mono' }, message.path), message.summary ? ` · ${message.summary}` : '', message.unfulfilled?.length ? h('span', { class: 'unfulfilled' }, ` not done: ${formatPlans(message.unfulfilled)}`) : null]
    case 'changed': return [h('strong', {}, 'changed '), h('span', { class: 'mono' }, message.paths.join(', ')), ` · ${message.summary}`, message.symbols?.length ? h('span', { class: 'symbol-list' }, message.symbols.join(', ')) : null]
    case 'conflict': return [h('strong', {}, 'conflict '), h('span', { class: 'mono' }, message.path), ` · ${message.text}`]
    case 'note': return [message.text]
    case 'question': return [h('strong', {}, 'asked '), message.text]
    case 'answer': return [h('strong', {}, 'answered '), message.text]
    case 'base': return [`${message.from} pushed ${message.commits} commit${message.commits === 1 ? '' : 's'}: ${message.summary} (base → ${message.base.slice(0, 7)})`]
    case 'plan': return [h('strong', {}, `${message.status} plan `), formatPlans([message.plan]), message.replacedBy ? ` → now ${formatPlans([message.replacedBy])}` : '', ` · ${message.text}`]
    case 'scope': return []
  }
}

function timelineItem(item: TimelineItem): HTMLElement {
  const message = item.message
  if (message.type === 'base') return h('div', { class: 'base-divider' }, ...messageBody(message))
  const other = message.type === 'question' ? message.to ?? item.replies[0]?.message.from : message.type === 'answer' ? message.from : undefined
  return h('div', { class: `timeline-item ${message.type} priority-${message.priority}` },
    h('div', { class: 'item-main' },
      h('time', { title: absoluteTime(message.at) }, clockTime(message.at)),
      h('div', { class: 'item-copy' }, ...messageBody(message), other ? h('span', { class: 'link-chip' }, `↗ ${other}`) : null, ...copyChips(item.alsoSentTo)),
      priorityBadge(message)),
    item.replies.length ? h('div', { class: 'thread-replies' }, ...item.replies.map(timelineItem)) : null)
}

function episodeCard(episode: Episode): HTMLElement {
  return h('article', { class: 'episode' },
    h('div', { class: 'episode-head' }, dot(episode.person), h('strong', {}, episode.person), h('span', { class: 'area-chip' }, episode.area),
      h('span', { class: `episode-status ${episode.status === 'done' ? 'done' : ''}` }, episode.status)),
    h('div', { class: 'episode-summary' }, episode.summary, ...copyChips(episode.alsoSentTo)),
    h('div', { class: 'episode-items' }, ...episode.items.map(timelineItem)))
}

export function timelinePanel(conn: Conn, focus: FocusState): HTMLElement {
  const filters = h('div', { class: 'filter-chips' })
  const list = h('div', { class: 'timeline-list' })
  const scroll = h('div', { class: 'timeline-scroll scroll' }, list)
  const element = h('aside', { class: 'timeline' }, h('div', { class: 'timeline-head' }, h('div', { class: 'panel-title' }, 'Timeline'), filters), scroll)
  let areaFilter: string | null = null
  let followNewest = true
  scroll.onscroll = () => { followNewest = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48 }

  const render = () => {
    const shouldFollow = followNewest
    const episodes = groupEpisodes(conn.room.messages())
    const areas = Array.from(new Set(episodes.map(episode => episode.area))).sort()
    const people = Array.from(new Set(episodes.map(episode => episode.person))).sort()
    const chip = (label: string, active: boolean, action: () => void) => {
      const button = h('button', { class: `filter-chip${active ? ' active' : ''}` }, label)
      button.onclick = action
      return button
    }
    filters.replaceChildren(
      chip('All', !areaFilter && !focus.person, () => { areaFilter = null; focus.set(null); render() }),
      ...areas.map(area => chip(area, areaFilter === area && !focus.person, () => { areaFilter = area; focus.set(null); render() })),
      ...people.map(person => chip(person, focus.person === person, () => { areaFilter = null; focus.set(focus.person === person ? null : person) })),
    )
    const visible = episodes.filter(episode => focus.person ? episode.person === focus.person : !areaFilter || episode.area === areaFilter)
    list.replaceChildren(...visible.map(episodeCard))
    if (!visible.length) list.append(h('div', { class: 'empty-note muted' }, 'No matching episodes'))
    if (shouldFollow) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight })
  }
  conn.room.bus.observe(render)
  focus.subscribe(render)
  render()
  return element
}

function overlays(room: RoomDoc): OverlayVersion[] {
  const result: OverlayVersion[] = []
  for (const [person, files] of room.overlays) for (const [path, text] of files) result.push({ person, path, text: text.toString() })
  return result
}

export function activityGraphPanel(conn: Conn, focus: FocusState): HTMLElement {
  const content = h('div', { class: 'graph-content' })
  const toggle = h('button', { class: 'graph-toggle', title: 'Collapse activity graph' }, 'Activity graph', h('span', { class: 'chevron' }, '⌄'))
  const element = h('section', { class: 'activity-graph' }, toggle, content)
  let collapsed = false
  toggle.onclick = () => {
    collapsed = !collapsed
    element.classList.toggle('collapsed', collapsed)
    toggle.title = `${collapsed ? 'Expand' : 'Collapse'} activity graph`
    toggle.querySelector('.chevron')!.textContent = collapsed ? '⌃' : '⌄'
  }
  const render = () => {
    const model = buildActivityGraph({
      overlays: overlays(conn.room),
      claims: conn.room.openClaims(),
      scopes: conn.room.allScopes(),
      changesByPerson: changesByPerson(conn.room),
      focusPerson: focus.person,
    })
    const plans = model.nodes.filter(node => node.kind === 'plan')
    const files = model.nodes.filter(node => node.kind === 'file')
    if (!plans.length) {
      content.replaceChildren(h('div', { class: 'graph-empty muted' }, 'no planned changes'))
      return
    }
    const rowHeight = 28
    const height = Math.max(48, Math.max(plans.length, files.length) * rowHeight + 12)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', `0 0 1000 ${height}`)
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', 'Open plans and files that use their symbols')
    const positions = new Map<string, { x: number; y: number }>()
    plans.forEach((node, index) => positions.set(node.id, { x: 22, y: 20 + index * rowHeight }))
    files.forEach((node, index) => positions.set(node.id, { x: 700, y: 20 + index * rowHeight }))
    for (const edge of model.edges) {
      const from = positions.get(edge.from); const to = positions.get(edge.to)
      if (!from || !to) continue
      const path = document.createElementNS(svg.namespaceURI, 'path')
      path.setAttribute('d', `M ${from.x + 250} ${from.y} C 470 ${from.y}, 530 ${to.y}, ${to.x - 10} ${to.y}`)
      path.setAttribute('class', 'graph-edge')
      svg.append(path)
    }
    for (const node of model.nodes) {
      const position = positions.get(node.id)!
      const group = document.createElementNS(svg.namespaceURI, 'g')
      const circle = document.createElementNS(svg.namespaceURI, 'circle')
      circle.setAttribute('cx', String(position.x)); circle.setAttribute('cy', String(position.y)); circle.setAttribute('r', '5')
      circle.setAttribute('fill', node.owner ? colorFor(node.owner) : '#98a0ad')
      const text = document.createElementNS(svg.namespaceURI, 'text')
      text.setAttribute('x', String(position.x + 12)); text.setAttribute('y', String(position.y + 4)); text.textContent = node.label
      group.append(circle, text); svg.append(group)
    }
    content.replaceChildren(svg)
  }
  conn.room.overlays.observeDeep(render)
  conn.room.claims.observe(render)
  conn.room.scopes.observe(render)
  focus.subscribe(render)
  render()
  return element
}

export function header(conn: Conn): HTMLElement {
  const roomName = h('span', { class: 'room-name' }, conn.displayRoomName)
  const base = h('span', { class: 'header-detail mono' }, 'base —')
  const count = h('span', { class: 'header-detail' }, '0 participants')
  const connection = h('span', { class: 'connection' }, 'disconnected')
  const element = h('header', { class: 'header' }, h('span', { class: 'product-mark' }, 'ROOM'), roomName, base, count, h('span', { class: 'sp' }), connection)
  const render = () => {
    base.textContent = `base ${(conn.room.meta.base ?? '').slice(0, 7) || '—'}`
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
