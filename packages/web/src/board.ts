import { subscribeRender } from './scheduler.ts'
import { activityLabel, formatCount, areaMembershipSummary, participantClaimLine, personLine, type NoteMsg, type Participant, type ShareLevel } from '@room/shared'
import type { Conn } from './conn.ts'
import { h as element, conflictCard, messageBody, participantInput, participantGroups, groupedPeople, compactChips, timelinePeople, TIMELINE_WINDOW, relativeTime } from './panels.ts'
import { collapseConflictTimeline } from './timeline.ts'

import { bindTooltip } from './tooltip.ts'

// Floating descriptions belong to Board cards; code uses inline details.
const h: typeof element = (tag, props = {}, ...children) => {
  const node = element(tag, { ...props, title: undefined }, ...children)
  if (props.title) bindTooltip(node, props.title)
  return node
}

/** Presentation only: the room remains the source of truth. */
export function boardPanel(conn: Conn, inspect: (name: string) => void): HTMLElement {
  const grid = h('div', { class: 'board-grid' })
  const offline = h('details', { class: 'offline-group' })
  const feed = h('div', { class: 'board-feed' })
  const filters = h('div', { class: 'filter-chips', ariaLabel: 'Filter timeline' })
  const hide = h('button', { type: 'button', ariaPressed: 'false' }, 'Hide offline')
  let hideOffline = false
  try { hideOffline = localStorage.getItem('room.hideOffline') === 'true' } catch { /* storage may be disabled */ }
  const element = h('main', { class: 'board scroll' },
    h('div', { class: 'board-heading' }, h('div', {}, h('h2', {}, 'People at work'), h('p', { class: 'muted' }, 'Live intent, shared changes, and the conversation around them.')),
      h('div', { class: 'view-switcher offline-toggle' }, hide)),
    grid, offline,
    h('section', { class: 'board-timeline' }, h('div', { class: 'board-heading' }, h('h2', {}, 'Timeline'), h('span', { class: 'muted' }, 'Newest first')), filters, feed))
  let showMoreFilters = false, windowSize = TIMELINE_WINDOW
  let personFilter: string | null = null, areaFilter: string | null = null
  const expandedConflicts = new Set<string>()
  const expandedWorkers = new Set<string>()
  const render = () => {
    const input = participantInput(conn)
    const groups = participantGroups(conn)
    const messages = conn.room.messages()
    const lastMessage = (name: string) => [...messages].reverse().find(m => m.from === name)
    const card = (person: Participant): HTMLElement => {
      const raw = [...conn.provider.awareness.getStates().values()].filter(p => p?.user?.name === person.name)
      const presence = raw.find(p => p.user.kind === 'agent') ?? raw[0]
      const share: ShareLevel = ['intent', 'declared', 'full'].includes(presence?.share) ? presence.share : 'full'
      const worker = [...conn.room.workers.values()].find(w => w.name === person.name)
      const label = worker?.status === 'failed' ? 'failed' : personLine({ name: person.name, scope: person.scope, presences: input.presences, changedPaths: person.files, messages: messages.filter((m): m is NoteMsg => m.type === 'note'), share })
      const name = h('button', { class: 'person-open mono', title: `Inspect ${person.name}'s files`, onclick: () => inspect(person.name) }, person.name)
      const areas = [...new Set([...(person.scope?.areas ?? []), ...(person.scope ? [person.scope.area] : [])])]
      const last = lastMessage(person.name)
      const el = h('article', { class: `board-card${person.online ? '' : ' offline'}` },
        h('div', { class: 'participant-head' }, h('span', { class: `presence-dot ${person.online ? 'online' : ''}`, title: person.online ? 'Online' : 'Offline' }), name,
          ...person.kinds.map(kind => h('span', { class: 'kind-badge' }, kind))),
        person.identity ? h('div', { class: 'muted participant-identity', title: person.identity }, person.identity) : null,
        h('div', { class: 'area-chips', title: areaMembershipSummary(areas) }, ...areas.map(area => h('span', { class: 'area-chip' }, area))),
        h('p', { class: 'participant-line', title: label }, label),
        h('div', { class: 'sharing muted' }, `Sharing: ${share}`),
        h('div', { class: 'person-claims' }, ...(person.claims.length ? person.claims.map(claim => h('div', { class: 'person-claim', title: participantClaimLine(claim), tabIndex: 0 }, participantClaimLine(claim))) : [h('p', { class: 'muted' }, 'No claims yet — agents claim lines before editing')])),
        h('div', { class: 'board-card-footer' }, h('span', {}, formatCount(person.files.length, 'changed file')), h('span', { class: 'muted', title: person.online ? 'Online' : 'Offline' }, person.online || worker ? activityLabel(person.latestActive, Date.now(), { worker }) : 'Offline')),
        h('div', { class: 'last-message' }, last ? h('span', {}, ...messageBody(last)) : h('span', { class: 'muted' }, 'No messages yet')))
      return el
    }
    const grouped = groupedPeople(groups, card, expandedWorkers)
    grid.replaceChildren(...grouped.active)
    if (!grouped.active.length) grid.append(h('div', { class: 'board-empty muted' }, 'No one is active yet — join this room from your agent.'))
    hide.ariaPressed = String(hideOffline)
    hide.classList.toggle('active', hideOffline)
    offline.hidden = hideOffline || !grouped.offline.length
    offline.replaceChildren(h('summary', {}, `${groups.offlineTeammates.length} offline · worker history`), h('div', { class: 'board-grid' }, ...grouped.offline))
    const events = collapseConflictTimeline(messages, conn.room.openClaims(), conn.room.meta.base).reverse()
    const areaOf = (m: typeof messages[number]) => 'area' in m && typeof m.area === 'string' ? m.area : conn.room.scopes.get(m.from)?.area ?? 'other'
    const chip = (text: string, active: boolean, action: () => void) => h('button', { class: `filter-chip${active ? ' active' : ''}`, ariaPressed: String(active), onclick: action }, text)
    const matching = events.filter(({ message: m, conflict }) => (!personFilter || m.from === personFilter || conflict?.people.includes(personFilter)) && (!areaFilter || areaOf(m) === areaFilter))
    const visible = matching.slice(0, windowSize)
    const prominent = new Set([...groups.active.map(p => p.name), ...timelinePeople(visible.flatMap(e => e.conflict ? e.conflict.events : [e.message]))])
    const prominentAreas = new Set([...groups.active.flatMap(p => p.scope ? [p.scope.area] : []), ...visible.map(e => areaOf(e.message))].filter(area => !area.endsWith('/')))
    const names = [...new Set([...groups.active.map(p => p.name), ...groups.offlineTeammates.map(p => p.name), ...groups.retiredWorkers.map(w => w.name), ...timelinePeople(messages, [...groups.active, ...groups.offlineTeammates].map(p => p.name))])].sort()
    const areas = [...new Set([...events.map(e => areaOf(e.message)), ...prominentAreas])].sort()
    filters.replaceChildren(chip('All', !personFilter && !areaFilter, () => { personFilter = areaFilter = null; windowSize = TIMELINE_WINDOW; render() }),
      ...compactChips([
        ...names.map(name => ({ key: name, selected: personFilter === name, node: chip(name, personFilter === name, () => { personFilter = personFilter === name ? null : name; windowSize = TIMELINE_WINDOW; render() }) })),
        ...areas.map(area => ({ key: 'area:' + area, selected: areaFilter === area, node: chip(`Area: ${area}`, areaFilter === area, () => { areaFilter = areaFilter === area ? null : area; windowSize = TIMELINE_WINDOW; render() }) })),
      ], new Set([...prominent, ...[...prominentAreas].map(a => 'area:' + a), ...(personFilter ? [personFilter] : []), ...(areaFilter ? ['area:' + areaFilter] : [])]), showMoreFilters, open => { showMoreFilters = open }))
    feed.replaceChildren(...visible.map(({ message: m, conflict }) => {
      if (conflict) return conflictCard(conflict, expandedConflicts)
      const kind = m.type === 'done' || (m.type === 'note' && m.text.startsWith('done')) ? 'done' : m.priority
      return h('article', { class: 'feed-event' }, h('time', { title: new Date(m.at).toLocaleString() }, relativeTime(m.at)), h('div', {}, h('div', { class: 'feed-meta' }, h('strong', { class: 'mono' }, m.from), h('span', { class: 'area-chip' }, areaOf(m))), h('div', {}, ...messageBody(m))), h('span', { class: `priority ${kind}` }, kind))
    }))
    if (matching.length > visible.length) feed.append(h('button', { class: 'timeline-more', onclick: () => { windowSize += TIMELINE_WINDOW; render() } }, 'Show older events'))
    if (!visible.length) feed.append(h('p', { class: 'muted' }, 'No events yet — room activity will appear here.'))
  }
  hide.onclick = () => { hideOffline = !hideOffline; try { localStorage.setItem('room.hideOffline', String(hideOffline)) } catch { /* optional preference */ }; render() }
  subscribeRender(conn, render)
  // Refresh relative ages while leaving a focused control undisturbed.
  const refresh = setInterval(() => { if (!element.hidden && !element.contains(document.activeElement)) render() }, 15_000)
  conn.room.doc.on('destroy', () => clearInterval(refresh))
  render()
  return element
}
