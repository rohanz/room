import { areaMembershipSummary, deriveParticipants, participantClaimLine, personLine, workerLine, type NoteMsg, type Participant, type ShareLevel } from '@room/shared'
import type { Conn } from './conn.ts'
import { h, messageBody, participantInput, relativeTime } from './panels.ts'
import { foldUpgradeCopies } from './timeline.ts'

/** Presentation only: the room remains the source of truth. */
export function boardPanel(conn: Conn, inspect: (name: string) => void): HTMLElement {
  const grid = h('div', { class: 'board-grid' })
  const offline = h('details', { class: 'offline-group' })
  const feed = h('div', { class: 'board-feed' })
  const filters = h('div', { class: 'filter-chips', ariaLabel: 'Filter timeline' })
  const hide = h('input', { type: 'checkbox' })
  try { hide.checked = localStorage.getItem('room.hideOffline') === 'true' } catch { /* storage may be disabled */ }
  const element = h('main', { class: 'board scroll' },
    h('div', { class: 'board-heading' }, h('div', {}, h('h2', {}, 'People at work'), h('p', { class: 'muted' }, 'Live intent, shared changes, and the conversation around them.')),
      h('label', {}, hide, ' Hide offline')),
    grid, offline,
    h('section', { class: 'board-timeline' }, h('div', { class: 'board-heading' }, h('h2', {}, 'Timeline'), h('span', { class: 'muted' }, 'Newest first')), filters, feed))
  let personFilter: string | null = null, areaFilter: string | null = null
  const expandedWorkers = new Set<string>()
  const render = () => {
    const input = participantInput(conn)
    const people = deriveParticipants(input)
    const messages = conn.room.messages()
    const workers = [...conn.room.workers.values()]
    // Older clients may not retain a lead presence/scope after disconnecting.
    for (const name of workers.map(w => w.lead)) if (!people.some(p => p.name === name)) people.push({ name, online: false, behindBase: false, kinds: ['agent'], identity: '', statuses: [], files: conn.room.changedPaths(name), claims: [] })
    const lastMessage = (name: string) => [...messages].reverse().find(m => m.from === name)
    const card = (person: Participant): HTMLElement => {
      const raw = [...conn.provider.awareness.getStates().values()].filter(p => p?.user?.name === person.name)
      const presence = raw.find(p => p.user.kind === 'agent') ?? raw[0]
      const share: ShareLevel = ['intent', 'declared', 'full'].includes(presence?.share) ? presence.share : 'full'
      const label = personLine({ name: person.name, scope: person.scope, presences: input.presences, changedPaths: person.files, messages: messages.filter((m): m is NoteMsg => m.type === 'note'), share })
      const name = h('button', { class: 'person-open mono', title: `Inspect ${person.name}'s files`, onclick: () => inspect(person.name) }, person.name)
      const areas = [...new Set([...(person.scope?.areas ?? []), ...(person.scope ? [person.scope.area] : [])])]
      const last = lastMessage(person.name)
      const el = h('article', { class: `board-card${person.online ? '' : ' offline'}` },
        h('div', { class: 'participant-head' }, h('span', { class: `presence-dot ${person.online ? 'online' : ''}`, title: person.online ? 'Online' : 'Offline' }), name,
          ...person.kinds.map(kind => h('span', { class: 'kind-badge' }, kind))),
        person.identity ? h('div', { class: 'muted' }, person.identity) : null,
        h('div', { class: 'area-chips', title: areaMembershipSummary(areas) }, ...areas.map(area => h('span', { class: 'area-chip' }, area))),
        h('p', { class: 'participant-line', title: label }, label),
        h('div', { class: 'sharing muted' }, `Sharing: ${share}`),
        h('div', { class: 'person-claims' }, ...(person.claims.length ? person.claims.map(claim => h('div', { class: 'person-claim', title: participantClaimLine(claim), tabIndex: 0 }, participantClaimLine(claim))) : [h('p', { class: 'muted' }, 'No claims yet — agents claim lines before editing')])),
        h('div', { class: 'board-card-footer' }, h('span', {}, `${person.files.length} changed files`), h('span', { class: 'muted', title: person.online ? 'Online' : 'Offline' }, person.latestActive ? `active ${relativeTime(person.latestActive)}` : person.online ? 'Online · activity unknown' : 'Offline')),
        h('div', { class: 'last-message' }, last ? h('span', {}, ...messageBody(last)) : h('span', { class: 'muted' }, 'No messages yet')))
      const ownWorkers = workers.filter(w => w.lead === person.name)
      if (ownWorkers.length) {
        const details = h('details', { class: 'workers', open: expandedWorkers.has(person.name) }, h('summary', {}, `${ownWorkers.length} workers`))
        details.ontoggle = () => { if (details.open) expandedWorkers.add(person.name); else expandedWorkers.delete(person.name) }
        for (const worker of ownWorkers) {
          const lines = workerLine({ worker, changedCount: conn.room.changedPaths(worker.name).length })
          details.append(h('button', { class: 'worker-row', onclick: () => inspect(worker.name) }, ...lines.map(line => h('span', {}, line.trim()))))
        }
        el.append(details)
      }
      return el
    }
    const leads = people.filter(p => !workers.some(w => w.name === p.name && w.lead !== p.name))
    const online = leads.filter(p => p.online), away = leads.filter(p => !p.online)
    grid.replaceChildren(...online.map(card))
    if (!online.length) grid.append(h('div', { class: 'board-empty muted' }, 'No one is online yet — join this room from your agent.'))
    offline.hidden = hide.checked || !away.length
    offline.replaceChildren(h('summary', {}, `${away.length} offline`), h('div', { class: 'board-grid' }, ...away.map(card)))
    const events = foldUpgradeCopies(messages).reverse()
    const areaOf = (m: typeof messages[number]) => 'area' in m && typeof m.area === 'string' ? m.area : conn.room.scopes.get(m.from)?.area ?? 'other'
    const chip = (text: string, active: boolean, action: () => void) => h('button', { class: `filter-chip${active ? ' active' : ''}`, ariaPressed: String(active), onclick: action }, text)
    filters.replaceChildren(chip('All', !personFilter && !areaFilter, () => { personFilter = areaFilter = null; render() }),
      ...[...new Set(events.map(e => e.message.from))].sort().map(name => chip(name, personFilter === name, () => { personFilter = personFilter === name ? null : name; render() })),
      ...[...new Set(events.map(e => areaOf(e.message)))].sort().map(area => chip(`Area: ${area}`, areaFilter === area, () => { areaFilter = areaFilter === area ? null : area; render() })))
    const visible = events.filter(({ message: m }) => (!personFilter || m.from === personFilter) && (!areaFilter || areaOf(m) === areaFilter))
    feed.replaceChildren(...visible.map(({ message: m }) => {
      const kind = m.type === 'done' || (m.type === 'note' && m.text.startsWith('done')) ? 'done' : m.priority
      return h('article', { class: 'feed-event' }, h('time', { title: new Date(m.at).toLocaleString() }, relativeTime(m.at)), h('div', {}, h('div', { class: 'feed-meta' }, h('strong', { class: 'mono' }, m.from), h('span', { class: 'area-chip' }, areaOf(m))), h('div', {}, ...messageBody(m))), h('span', { class: `priority ${kind}` }, kind))
    }))
    if (!visible.length) feed.append(h('p', { class: 'muted' }, 'No events yet — room activity will appear here.'))
  }
  hide.onchange = () => { try { localStorage.setItem('room.hideOffline', String(hide.checked)) } catch { /* optional preference */ }; render() }
  conn.room.doc.on('update', render)
  conn.provider.awareness.on('change', render)
  // Refresh relative ages while leaving a focused control undisturbed.
  setInterval(() => { if (!element.hidden && !element.contains(document.activeElement)) render() }, 15_000)
  render()
  return element
}
