import { subscribeRender } from './scheduler.ts'
import { LARGE_LINES, PAGE, planWindows, type WindowOptions } from './line-window.ts'
import { inlineDetails } from './inline-detail.ts'
import { deriveConflictSpans } from './conflicts.ts'
import {
  RoomDoc,
  type ConflictSpan,
  areaMembershipSummary,
  colorFor,
  deriveParticipants,
  describeClaim,
  formatPlans,
  participantClaimLine,
  presentPeople,
  scopeCovers,
  roomNameParts,
  type Claim,
  type Msg,
  type Participant,
  type ParticipantClaim,
  type ParticipantInput,
  type Scope,
} from '@room/shared'
export { deriveParticipants, type Participant, type ParticipantClaim, type ParticipantInput } from '@room/shared'
import { presences, type Conn } from './conn.ts'
import { Editor } from './editor.ts'
import { buildActivityGraph, type OverlayVersion } from './activity-graph.ts'
import { classifyNWay, unifiedDiffLines, type MergedLine } from './merged.ts'
import { collapseConflictTimeline, groupEpisodes, type Episode, type TimelineItem } from './timeline.ts'

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string | null | undefined)[]
) => {
  const element = document.createElement(tag)
  const { class: className, title, ...rest } = props
  if (className) element.className = className
  Object.assign(element, rest)
  if (title) element.title = title
  for (const child of children) if (child != null) element.append(child)
  return element
}

const dot = (name: string, title = name, room?: RoomDoc) => {
  const element = h('span', { class: 'dot', title })
  element.style.background = colorFor(name, room)
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

/** Pill text fit for one line: keep the state word, shorten the detail to a symbol or file basename. */
export function shortPill(state: string, max = 26): string {
  const m = state.match(/^(editing|waiting on|waiting|done|behind base|ahead|working|idle|offline)\s*(.*)$/)
  if (!m) return state.length > max ? state.slice(0, max - 1) + '…' : state
  let detail = m[2].replace(/^[:\s]+/, '')
  // "api/handlers.py:22-24 — Use Order..." -> "handlers.py:22-24"; "create_order — intent" -> "create_order"
  detail = detail.split(/\s+[—–-]\s+/)[0].split(':')[0].replace(/^.*\//, '') + (detail.match(/:(\d+-\d+)/) ? `:${detail.match(/:(\d+-\d+)/)![1]}` : '')
  const out = detail ? `${m[1]} ${detail}` : m[1]
  return out.length > max ? out.slice(0, max - 1) + '…' : out
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
  if (statuses.some(status => status.toLowerCase().startsWith('done'))) return 'done'
  if (statuses.some(status => status.toLowerCase().startsWith('on '))) return 'working'
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

export function participantInput(conn: Conn): ParticipantInput {
  const names = new Set([...conn.room.overlays.keys(), ...conn.room.deleted.keys(), ...conn.room.scopes.keys()])
  const changes = new Map<string, string[]>()
  for (const name of names) changes.set(name, conn.room.changedPaths(name))
  return {
    presences: presences(conn.provider, conn.room),
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

export function participantsPanel(conn: Conn, focus: FocusState): HTMLElement {
  const list = h('div', { class: 'participant-list' })
  const element = h('aside', { class: 'participants scroll' }, h('div', { class: 'panel-title' }, 'People'), list)
  const render = () => {
    const input = participantInput(conn)
    const participants = deriveParticipants(input).map(p => ({ ...p, online: input.presences.some(entry => entry.user.name === p.name) }))
    list.replaceChildren(...participants.map(participant => {
      const state = deriveStatePill(participant)
      const short = shortPill(state)
      const card = h('button', {
        class: `participant${participant.online ? '' : ' offline'}${focus.person === participant.name ? ' focused' : ''}`,
        title: focus.person === participant.name ? `Clear ${participant.name} focus` : `Focus on ${participant.name}`,
      },
      h('div', { class: 'participant-head' }, dot(participant.name, participant.name, conn.room), h('strong', {}, participant.name), h('span', { class: 'sp' }),
        h('span', { class: `state-pill ${state.split(' ')[0]}`, title: state }, short)),
      participant.identity ? h('div', { class: 'micro muted' }, participant.identity) : null,
      participant.scope
        ? h('div', { class: 'scope-line' }, h('strong', {}, `${participant.scope.area}:`), ` ${participant.scope.summary}`)
        : h('div', { class: 'scope-line muted' }, 'no area declared'),
      participant.scope?.areas?.length ? h('div', { class: 'micro muted' }, `in ${areaMembershipSummary(participant.scope.areas)}`) : null,
      participant.claims.length
        ? h('div', { class: 'person-claims' }, ...participant.claims.map(claim => h('div', {
            class: `person-claim${claim.stale ? ' stale' : ''}`,
            title: describeClaim(claim),
          }, participantClaimLine(claim))))
        : h('div', { class: 'micro muted' }, 'no active claims'),
      h('div', { class: 'files-summary' }, h('span', { class: 'micro-label' }, 'FILES'),
        h('span', { class: `mono ${participant.files.length ? '' : 'muted'}` }, participant.files.join(', ') || 'none')),
      h('div', { class: 'card-foot muted', title: participant.online ? 'Online' : 'Offline' }, participant.online ? participant.latestActive !== undefined ? `Online · idle ${Math.max(0, Math.floor((Date.now() - participant.latestActive) / 1000))}s` : 'Online · activity unknown' : 'Offline'))
      card.onclick = () => focus.set(focus.person === participant.name ? null : participant.name)
      return card
    }))
    if (!participants.length) list.append(h('div', { class: 'empty-note muted' }, 'Waiting for participants…'))
  }
  subscribeRender(conn, render)
  // Match Board's refresh: awareness can recover while this rail is hidden.
  const refresh = setInterval(() => { if (!element.contains(document.activeElement)) render() }, 15_000)
  conn.room.doc.on('destroy', () => clearInterval(refresh))
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

/** Claims covering a given line of a person's version of the selected file. */
export type ClaimsAt = (person: string, line: number) => readonly Claim[]

function authors(line: MergedLine, names: readonly string[]): string[] {
  return Array.isArray(line.changedBy) ? line.changedBy : line.changedBy === 'both' ? [...names] : line.changedBy ? [names[line.changedBy === 'a' ? 0 : 1]] : line.side === 'common' ? [] : [names[line.side === 'a' ? 0 : 1]]
}
function sourceLines(line: MergedLine, names: readonly string[]): [string, number | undefined][] {
  return line.lineNumbers ? Object.entries(line.lineNumbers) : [[names[0], line.aLine], [names[1], line.bLine]]
}

/** Hover text for a merged/diff line: who wrote it, and any claim covering it. */
export function lineHoverText(line: MergedLine, names: readonly string[], claimsAt?: ClaimsAt): string {
  const parts: string[] = []
  if (line.conflict) parts.push(`CONFLICT: ${(line.conflictPair ?? names).join(' and ')} changed this differently; this is ${line.conflictOwner ?? (line.side === 'a' ? names[0] : names[1])}'s version`)
  else if (Array.isArray(line.changedBy) && line.changedBy.length) parts.push(`changed by ${line.changedBy.join(' and ')}`)
  else if (line.changedBy === 'both') parts.push(`changed by ${names[0]} and ${names[1]}`)
  else if (line.side === 'a') parts.push(`added by ${names[0]}`)
  else if (line.side === 'b') parts.push(`added by ${names[1]}`)
  else parts.push('unchanged from base')
  const claims = sourceLines(line, names).flatMap(([person, n]) => n === undefined ? [] : claimsAt?.(person, n) ?? [])
  const seen = new Set<string>()
  for (const c of claims) if (!seen.has(c.id)) { seen.add(c.id); parts.push(`claimed by ${c.by}: ${c.intent}${c.plans?.length ? ` (plans: ${formatPlans(c.plans)})` : ''}`) }
  return parts.join('\n')
}

const MAX_LINE_CHARS = 2000
const MAX_FILE_ROWS = 300
type CodeWindowState = WindowOptions & { expanded?: Set<string>; expandedLines?: Map<number, string> }

function lineElement(line: MergedLine, names: readonly string[], prefix = '', claimsAt?: ClaimsAt, mergedNumber?: number, room?: RoomDoc, expandedLines?: Map<number, string>, index = 0): HTMLElement {
  const changed = authors(line, names)
  const owner = line.conflictOwner ?? changed[0] ?? ''
  const changedOwner = changed[0] ?? ''
  const marker = owner ? h('span', { class: 'dot' }) : null
  if (marker) marker.style.background = colorFor(owner, room)
  const clipped = line.text.length > MAX_LINE_CHARS && expandedLines?.get(index) !== line.text
  const code = h('code', {}, (clipped ? line.text.slice(0, MAX_LINE_CHARS) : line.text) || ' ')
  if (clipped) {
    const show = h('button', { class: 'line-text-show muted', type: 'button' }, `… +${(line.text.length - MAX_LINE_CHARS).toLocaleString('en-US')} chars · show`)
    show.onclick = event => {
      event.stopPropagation()
      expandedLines?.set(index, line.text)
      code.replaceChildren(line.text)
      code.onscroll?.call(code, event)
    }
    show.onkeydown = event => event.stopPropagation()
    code.append(show)
  }
  const row = h('div', { class: `code-line side-${line.side}${changed.length ? ' changed-line' : ''}${line.conflict ? ' conflict-line' : ''}` },
    h('span', { class: 'line-gutter' },
      h('span', { class: 'line-number' }, mergedNumber?.toString() ?? line.aLine?.toString() ?? ''),
      mergedNumber !== undefined
        ? h('span', { class: 'side-marker' }, marker)
        : h('span', { class: 'line-number' }, line.bLine?.toString() ?? ''),
      h('span', { class: 'diff-prefix' }, prefix)),
    code)
  if (changed.length) {
    row.dataset.changedBy = Array.isArray(line.changedBy) ? changed.join(', ') : line.changedBy ?? changed.join(', ')
    row.style.setProperty('--line-change-owner', changedOwner ? colorFor(changedOwner, room) : 'var(--muted)')
  }
  if (owner) { row.style.setProperty('--line-owner', colorFor(owner, room)); row.dataset.owner = owner }
  return row
}

export function resolutionLabel(span: ConflictSpan): string {
  const r = span.resolvedBy
  return r ? `resolved · ${r.who ? `${r.who} ` : ''}${r.how} · ${clockTime(r.at)}` : `conflict · ${span.people.join(' ↔ ')}`
}

export function conflictCard(span: ConflictSpan, expanded?: Set<string>): HTMLElement {
  const details = h('details', { open: expanded?.has(span.id) ?? false },
    h('summary', {}, `${span.events.length} events`),
    ...span.events.map(m => h('div', { class: 'timeline-item' }, h('time', {}, clockTime(m.at)), ' · ', ...messageBody(m))))
  details.ontoggle = () => { if (details.open) expanded?.add(span.id); else expanded?.delete(span.id) }
  return h('article', { class: `conflict-card${span.resolvedBy ? ' resolved' : ''}` },
    h('strong', {}, span.people.join(' ↔ ') || 'Claim conflict'),
    h('div', {}, `Opened ${clockTime(span.at)} · ${span.path}${span.from !== undefined ? `:${span.from}-${span.to}` : ' · range unavailable'}`),
    h('div', {}, resolutionLabel(span)), details)
}

// Replacing the host invalidates pending frames, including selection changes to empty files.
export function renderCodeLines(host: HTMLElement, lines: readonly (MergedLine & { prefix?: string })[], names: readonly string[], claimsAt?: ClaimsAt, conflicts: readonly ConflictSpan[] = [], merged = true, room?: RoomDoc, state: CodeWindowState = {}): void {
  state.expandedLines ??= new Map<number, string>()
  if (lines.length <= LARGE_LINES) {
    renderCodeBatch(host, lines, names, claimsAt, conflicts, merged, room, 0, state.expandedLines)
    return
  }
  state.expanded ??= new Set<string>()
  const pane = h('div', { class: 'code-scroll scroll mono' })
  const content = h('div', { class: 'code-windows' })
  pane.append(content)
  const notice = h('div', { class: 'large-file-notice micro muted' })
  host.replaceChildren(notice, pane)
  let generation = 0
  const paint = () => {
    const current = ++generation
    content.replaceChildren()
    let shown = 0
    const updateNotice = () => { notice.textContent = `Large file: ${lines.length.toLocaleString('en-US')} lines, showing ${shown.toLocaleString('en-US')}. Unchanged regions are collapsed.` }
    const segments = planWindows(lines, state)
    const jobs: (() => void)[] = []
    for (const segment of segments) {
      if (segment.kind === 'lines') {
        for (let from = segment.from; from < segment.to; from += PAGE) {
          const begin = from, end = Math.min(segment.to, from + PAGE)
          jobs.push(() => {
            const temp = h('div')
            renderCodeBatch(temp, lines.slice(begin, end), names, claimsAt, conflicts, merged, room, begin, state.expandedLines)
            const batchPane = temp.firstElementChild as HTMLElement
            content.append(...Array.from(batchPane.children))
            shown += end - begin
            updateNotice()
          })
        }
      } else {
        jobs.push(() => {
          const count = (segment.to - segment.from).toLocaleString('en-US')
          const button = h('button', { class: 'line-gap-show muted' }, `⋯ ${count} ${segment.reason === 'unchanged' ? 'unchanged lines · show' : 'more lines · show next 500'}`)
          button.onclick = () => { state.expanded!.add(`${segment.from}-${segment.to}`); paint() }
          const row = h('div', { class: 'line-gap' }, button)
          if (segment.reason === 'more') {
            const all = h('button', { class: 'muted' }, 'show all')
            all.onclick = () => { state.all = true; paint() }
            row.append(' · ', all)
          }
          content.append(row)
        })
      }
    }
    updateNotice()
    let job = 0
    const next = () => {
      if (current !== generation || pane.parentElement !== host) return
      jobs[job++]?.()
      if (job < jobs.length) requestAnimationFrame(next)
    }
    if (lines.length > 20000 && state.all) next()
    else for (const job of jobs) job()
  }
  pane.onscroll = event => {
    for (const code of content.querySelectorAll('code')) code.onscroll?.call(code, event)
  }
  paint()
}

function renderCodeBatch(host: HTMLElement, lines: readonly (MergedLine & { prefix?: string })[], names: readonly string[], claimsAt?: ClaimsAt, conflicts: readonly ConflictSpan[] = [], merged = true, room?: RoomDoc, offset = 0, expandedLines?: Map<number, string>): void {
  const rows = lines.map((line, i) => lineElement(line, names, line.prefix, claimsAt, merged ? offset + i + 1 : undefined, room, expandedLines, offset + i))
  const spans: { start: number; end: number; people: readonly string[]; detail: string; resolution?: string; resolved: boolean; claimOnly?: boolean; textConflict?: boolean }[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].conflict) continue
    const start = i
    const pair = lines[i].conflictPair ?? names
    while (i + 1 < lines.length && lines[i + 1].conflict && (lines[i + 1].conflictPair ?? names).join('\0') === pair.join('\0')) i++
    const intents = new Map<string, string>()
    for (let row = start; row <= i; row++) {
      for (const [person, line] of sourceLines(lines[row], names)) {
        if (line !== undefined) for (const claim of claimsAt?.(person, line) ?? []) intents.set(claim.id, person + ': ' + claim.intent + (claim.plans?.length ? ` (plans: ${formatPlans(claim.plans)})` : ''))
      }
    }
    spans.push({ start, end: i, people: pair, detail: pair.join(' ↔ ') + `\nMerged lines ${offset + start + 1}-${offset + i + 1}\nUnresolved: both sides changed these lines\n` + ([...intents.values()].join('\n') || 'Claim intents unavailable'), resolved: false, textConflict: true })
  }
  for (const s of conflicts) {
    if (s.hidden || s.from === undefined || s.to === undefined) continue
    const indices = lines.flatMap((line, i) => sourceLines(line, names).filter(([person]) => s.people.includes(person)).some(([, n]) => n !== undefined && n >= s.from! && n <= s.to!) ? [i] : [])
    if (!indices.length) continue
    const start = indices[0], end = indices.at(-1)!
    const regionClaims = new Map(s.claims.map(c => [c.id, c]))
    for (const i of indices) for (const [person, n] of sourceLines(lines[i], names)) {
      if (n !== undefined) for (const c of claimsAt?.(person, n) ?? []) regionClaims.set(c.id, c)
    }
    const claimOnly = merged && s.claims.some(a => s.claims.some(b => a.by !== b.by && a.path === b.path && a.from <= b.to && b.from <= a.to))
    const people = [...new Set([...s.people, ...[...regionClaims.values()].map(c => c.by)])]
    const detail = people.join(' ↔ ') + '\n' + s.path + ':' + s.from + '-' + s.to + '\n' +
      (s.resolvedBy ? resolutionLabel(s) : claimOnly ? 'Unresolved: both claimed' : 'Unresolved conflict') + '\n' +
      people.map(person => {
        const cs = [...regionClaims.values()].filter(c => c.by === person)
        return cs.length ? cs.map(c => person + ': ' + c.intent + (c.plans?.length ? ' (plans: ' + formatPlans(c.plans) + ')' : '')).join('\n') : person + ': intent unavailable'
      }).join('\n')
    // Text conflicts own their marker, including any intersecting claim details.
    const textRegions = merged ? spans.filter(r => r.textConflict && !r.resolved && r.start <= end && r.end >= start && r.people.every(p => people.includes(p))) : []
    if (textRegions.length && !s.resolvedBy) {
      for (const r of textRegions) r.detail += '\n' + detail
      // Keep claim-only portions outside the text conflict visible in amber.
      let run = -1
      for (let i = start; i <= end + 1; i++) {
        const uncovered = i <= end && !textRegions.some(r => i >= r.start && i <= r.end)
        if (uncovered && run < 0) run = i
        if (!uncovered && run >= 0) { spans.push({ start: run, end: i - 1, people, detail, resolved: false, claimOnly }); run = -1 }
      }
    } else spans.push({ start, end, people, detail, resolution: s.resolvedBy ? resolutionLabel(s) : undefined, resolved: !!s.resolvedBy, claimOnly })
  }
  // Prefer the recorded region's richer tooltip over its duplicate merge preview.
  const regions = spans.filter((s, index) => !spans.some((other, j) => j > index &&
    other.start === s.start && other.end === s.end && other.resolved === s.resolved &&
    other.people.length === s.people.length && other.people.every(p => s.people.includes(p))))
  // All rows share the widest line; the pane owns scrolling and both edges stick.
  const text = h('div', { class: 'line-text' }, ...rows)
  text.style.gridRow = '1 / ' + (lines.length + 1)
  const grid = h('div', { class: 'conflict-code-grid' + (merged ? ' merged-code' : '') }, text)
  rows.forEach((row, i) => { row.style.gridRow = String(i + 1); row.style.gridColumn = '1' })
  const gutter = h('div', { class: 'conflict-edge' })
  gutter.style.gridRow = '1 / ' + (lines.length + 1)
  const tagSlots = rows.map(row => {
    const slot = h('div', { class: 'line-tags' })
    row.append(h('div', { class: 'line-band' }, slot))
    return slot
  })
  const annotations = rows.map(() => h('div', { class: 'line-annotation' }))
  const bars: { bar: HTMLElement; start: number; end: number }[] = []
  const layout = (open: number | null) => {
    const track = (i: number) => i + 1 + (open !== null && i > open ? 1 : 0)
    text.style.gridRow = gutter.style.gridRow = '1 / ' + (lines.length + 1 + (open === null ? 0 : 1))
    rows.forEach((row, i) => { row.style.gridRow = String(track(i)) })
    for (const { bar, start, end } of bars) bar.style.gridRow = track(start) + ' / ' + (track(end) + 1)
  }
  const bindDetail = inlineDetails(layout)
  const bindRows = rows.map((row, i) => bindDetail(row, annotations[i], i,
    merged ? offset + i + 1 : lines[i].bLine ?? lines[i].aLine ?? i + 1, {
      owners: authors(lines[i], names),
      claims: sourceLines(lines[i], names).flatMap(([person, n]) => n === undefined ? [] : claimsAt?.(person, n) ?? []),
      conflicts: regions.filter(s => s.start <= i && s.end >= i).map(s => ({
        people: s.people, resolved: s.resolved, resolution: s.resolution,
        range: `Merged lines ${offset + s.start + 1}-${offset + s.end + 1}`,
        status: s.resolved ? 'Resolved' : s.textConflict ? 'Unresolved: both sides changed these lines' : s.claimOnly ? 'Unresolved: both claimed' : 'Unresolved conflict',
      })),
    }))
  const laneEnds: number[] = []
  const tagOffsets = new Map<typeof regions[number], { text: string; detail: string }>()
  regions.sort((a, b) => a.start - b.start || Number(a.resolved) - Number(b.resolved) || a.end - b.end)
  for (const start of new Set(regions.map(s => s.start))) {
    const group = regions.filter(s => s.start === start)
    const resolved = group.filter(s => s.resolved)
    const collapse = resolved.length > 1
    for (const s of group) {
      if (collapse && s.resolved && s !== resolved[0]) continue
      tagOffsets.set(s, {
        text: collapse && s.resolved ? resolved.length + ' resolved' : s.resolved ? 'resolved' : s.claimOnly ? 'both claimed' : 'conflict',
        detail: collapse && s.resolved ? resolved.map(r => r.detail).join('\n\n') : s.detail,
      })
    }
  }
  regions.forEach(s => {
    let lane = laneEnds.findIndex(end => end < s.start)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = s.end
    const bar = h('div', { class: 'conflict-bar' + (s.claimOnly ? ' claim-overlap' : '') + (s.resolved ? ' resolved' : '') })
    const tag = tagOffsets.get(s)
    if (tag) {
      const label = h('button', { class: 'conflict-tag' + (s.resolved ? ' resolved' : s.claimOnly ? ' claim-overlap' : ''), ariaLabel: tag.detail }, tag.text)
      bindRows[s.start](label)
      tagSlots[s.start].append(label)
    }
    bar.style.gridRow = s.start + 1 + ' / ' + (s.end + 2)
    bar.style.gridColumn = String(lane + 1)
    for (let i = s.start; i <= s.end; i++) {
      rows[i].classList.add(s.resolved ? 'resolved-conflict-line' : s.claimOnly ? 'claim-overlap-line' : 'conflict-line')
      if (s.claimOnly) rows[i].classList.add('claim-overlap-line')
    }
    bars.push({ bar, start: s.start, end: s.end })
    gutter.append(bar)
  })
  gutter.style.gridTemplateColumns = 'repeat(' + Math.max(1, laneEnds.length) + ', 2px)'
  grid.style.gridTemplateColumns = 'minmax(0, 1fr) 96px'
  grid.append(gutter)
  layout(null)
  const pane = h('div', { class: 'code-scroll scroll mono' }, grid)
  // The detail controller masks hovered text; refresh it when the pane moves.
  pane.onscroll = event => {
    for (const row of rows) {
      const code = row.querySelector('code')!
      code.onscroll?.call(code, event)
    }
  }
  host.replaceChildren(pane)
}

/** Length plus FNV-1a: linear in text size, without retaining extra copies of inputs. */
function textIdentity(text: string | undefined): string {
  if (text === undefined) return 'missing'
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return text.length + ':' + (hash >>> 0)
}

export function centrePanel(conn: Conn, focus: FocusState): HTMLElement {
  const fileList = h('div', { class: 'file-list scroll' })
  const pathLabel = h('span', { class: 'selected-path mono muted' }, 'no file selected')
  const personSelect = h('select', { class: 'person-select', title: 'Person whose overlay to display' })
  const compareLabel = h('span', { class: 'compare-label muted' })
  const legend = h('div', { class: 'legend' })
  const chips = h('div', { class: 'merge-chips', role: 'group', ariaLabel: 'Participants in merge' })
  const chipHint = h('div', { class: 'merge-hint muted' })
  const excluded = new Map<string, Set<string>>()
  const included = (path: string, people: readonly string[]) => {
    if (!excluded.has(path)) {
      const defaults = new Set(presentPeople(people, presences(conn.provider, conn.room)))
      excluded.set(path, new Set(defaults.size ? people.filter(person => !defaults.has(person)) : []))
    }
    return people.filter(p => !excluded.get(path)!.has(p))
  }
  const host = h('div', { class: 'editor-wrap' })
  const editor = new Editor(host, conn.room)
  let windowState: CodeWindowState = {}
  let windowKey = ''
  let cached: { key: string; lines: MergedLine[] } | undefined
  let paintedKey = ''
  const tabs = ['Merged', 'Diff', 'File'] as const
  type Tab = typeof tabs[number]
  let tab: Tab = 'Merged'
  let showAllFiles = false
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
      chips, chipHint, legend,
      host))

  const empty = (message: string) => {
    const key = JSON.stringify(['empty', selectedPath, selectedPerson, tab, message])
    cached = undefined
    if (paintedKey === key) return
    editor.empty(message); paintedKey = key
  }
  const showViewer = (rows: FileRow[]) => {
    chipHint.hidden = true
    chipHint.textContent = ''
    chips.replaceChildren()
    chips.hidden = tab !== 'Merged'
    const selected = rows.find(candidate => candidate.path === selectedPath)
    if (!selected) {
      empty(rows.length ? 'Select a changed file' : 'Waiting for changed files…')
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
    const key = `${selectedPath}\0${tab}\0${selectedPerson}`
    if (key !== windowKey) { windowState = {}; windowKey = key }
    personSelect.replaceChildren(...people.map(person => h('option', { value: person, selected: person === selectedPerson }, person)))
    personSelect.hidden = tab === 'Merged'
    compareLabel.hidden = tab !== 'Diff'

    const conflicts = deriveConflictSpans(conn.room.messages(), conn.room.openClaims(), conn.room.meta.base).filter(s => s.path === selected.path)
    // Text computations and annotations have separate invalidation: new claims must
    // repaint gutters, but cannot make us repeat an unchanged merge or diff.
    const paint = (names: string[], texts: (string | undefined)[], compute: () => MergedLine[], merged: boolean, spans = conflicts) => {
      const inputKey = JSON.stringify([selected.path, tab, names, texts.map(textIdentity), names.map(name => conn.room.deleted.get(name)?.has(selected.path) ?? false)])
      if (cached?.key !== inputKey) cached = { key: inputKey, lines: compute() }
      const claims = conn.room.claimsFor(selected.path)
      const domKey = JSON.stringify([inputKey, windowKey, claims, spans, names.map(name => colorFor(name, conn.room))])
      if (paintedKey === domKey) return
      const claimsAt: ClaimsAt = (owner, n) => claims.filter(c => c.by === owner && n >= c.from && n <= c.to)
      renderCodeLines(host, cached.lines, names, claimsAt, spans, merged, conn.room, windowState)
      paintedKey = domKey
    }
    if (tab === 'File') {
      legend.replaceChildren()
      compareLabel.textContent = ''
      const person = selectedPerson!
      if (conn.room.deleted.get(person)?.has(selected.path)) return empty(`deleted by ${person}`)
      const text = conn.room.text(selected.path, person)
      if (text === undefined) return empty(`No overlay available for ${person}`)
      const sha = conn.room.baseOf(person)
      const base = sha ? conn.room.baseText(sha, selected.path) : undefined
      paint([person], [base, text], () => classifyNWay(base ?? '', [{ name: person, text }]).map(line => ({ ...line, aLine: line.lineNumbers[person] })), false)
      return
    }
    if (tab === 'Merged') {
      const active = included(selected.path, people)
      chips.replaceChildren(...people.map(person => {
        const button = h('button', { class: 'merge-chip', ariaPressed: String(active.includes(person)) }, dot(person, person, conn.room), person)
        button.onclick = () => {
          const off = excluded.get(selected.path) ?? new Set<string>()
          if (off.has(person)) off.delete(person); else off.add(person)
          excluded.set(selected.path, off); render()
        }
        return button
      }))
      const online = new Set(presentPeople(people, presences(conn.provider, conn.room)))
      const hiddenOffline = people.filter(person => !online.has(person) && !active.includes(person)).length
      chipHint.textContent = hiddenOffline
        ? `${hiddenOffline} offline participants hidden — toggle their chips to include them`
        : !online.size && active.length === people.length ? `Showing ${active.length} participants' changes` : ''
      chipHint.hidden = !chipHint.textContent
      legend.replaceChildren(...active.map(person => h('span', {}, dot(person, person, conn.room), ` lines by ${person}`)))
      const sha = conn.room.baseOf(people[0])
      const base = sha ? conn.room.baseText(sha, selected.path) : undefined
      if (base === undefined) legend.append(h('span', { class: 'muted' }, 'Base unavailable; showing changes against an empty file'))
      const versions = active.map(name => ({ name, text: conn.room.text(selected.path, name) ?? '' }))
      paint(active, [base, ...versions.map(v => v.text)], () => classifyNWay(base ?? '', versions), true, conflicts.filter(s => s.people.every(p => active.includes(p))))
      return
    }

    const person = selectedPerson!
    const other = people.length > 2 ? (people[0] === person ? people[1] : people[0]) : people.find(value => value !== person) ?? person
    compareLabel.textContent = `vs ${other}`
    legend.replaceChildren(h('span', {}, dot(other, other, conn.room), ` removed from ${other}`), h('span', {}, dot(person, person, conn.room), ` added by ${person}`))
    const before = conn.room.text(selected.path, other), after = conn.room.text(selected.path, person)
    paint([other, person], [before, after], () => unifiedDiffLines(before ?? '', after ?? ''), false)
  }

  render = () => {
    for (const button of tabStrip.querySelectorAll('.tab')) button.classList.toggle('active', button.textContent === tab)
    const claims = conn.room.openClaims()
    const rows = deriveFileRows(changesByPerson(conn.room), conn.room.allScopes(), claims).filter(row => !focus.person || row.people.includes(focus.person))
    if (!selectedPath || !rows.some(row => row.path === selectedPath)) selectedPath = rows[0]?.path ?? null
    if (focus.person && !rows.find(row => row.path === selectedPath)?.people.includes(focus.person)) {
      selectedPath = rows.find(row => row.people.includes(focus.person!))?.path ?? selectedPath
    }
    const visibleRows = showAllFiles ? rows : rows.filter((row, index) => index < MAX_FILE_ROWS || row.path === selectedPath)
    const grouped = new Map<string, FileRow[]>()
    for (const row of visibleRows) {
      if (!grouped.has(row.area)) grouped.set(row.area, [])
      grouped.get(row.area)!.push(row)
    }
    fileList.replaceChildren(...Array.from(grouped, ([area, areaRows]) => h('div', { class: 'file-group' },
      h('div', { class: 'file-area' }, area),
      ...areaRows.map(row => {
        const item = h('button', { class: `file-item${row.path === selectedPath ? ' active' : ''}`, title: row.path },
          h('span', { class: 'file-path mono' }, row.path),
          row.claimCount ? h('span', { class: 'claim-count', title: `${row.claimCount} active claim${row.claimCount === 1 ? '' : 's'}` }, String(row.claimCount)) : null,
          h('span', { class: 'file-dots' }, ...row.people.map(person => {
            const online = presentPeople([person], presences(conn.provider, conn.room)).length > 0
            const marker = dot(person, online ? `${person} changed this file` : 'offline', conn.room)
            if (!online) { marker.style.opacity = '0.5'; marker.title = 'offline' }
            return marker
          })))
        item.onclick = () => { selectedPath = row.path; selectedPerson = focus.person; render() }
        return item
      }))))
    if (visibleRows.length < rows.length) {
      const more = h('button', { class: 'file-more muted', type: 'button' }, `and ${(rows.length - visibleRows.length).toLocaleString('en-US')} more files · show all`)
      more.onclick = () => { showAllFiles = true; render() }
      fileList.append(more)
    }
    if (!rows.length) fileList.append(h('div', { class: 'empty-note muted' }, 'No changed files'))
    showViewer(rows)
  }
  personSelect.onchange = () => { selectedPerson = personSelect.value; render() }
  subscribeRender(conn, render)
  focus.subscribe(render)
  render()
  return element
}

function priorityBadge(message: Msg): HTMLElement | null {
  const kind = message.type === 'done' || (message.type === 'note' && message.text.startsWith('done')) ? 'done' : message.priority
  return h('span', { class: `priority ${kind}` }, kind)
}

function copyChips(names: readonly string[]): HTMLElement[] {
  return names.map(name => h('span', { class: 'link-chip' }, `→ also sent to ${name}`))
}

export function messageBody(message: Msg): (Node | string | null)[] {
  switch (message.type) {
    case 'claim': return [h('strong', {}, 'claimed '), h('span', { class: 'mono' }, `${message.path}:${message.from_line}-${message.to_line}`), ` · ${message.intent}${message.plans?.length ? ` ${displayPlans(message.plans)}` : ''}`]
    case 'release': return [h('strong', {}, 'released '), h('span', { class: 'mono' }, message.path), message.summary ? ` · ${message.summary}` : '', message.unfulfilled?.length ? h('span', { class: 'unfulfilled' }, ` not done: ${formatPlans(message.unfulfilled)}`) : null]
    case 'changed': return [h('strong', {}, 'changed '), h('span', { class: 'mono' }, message.paths.join(', ')), ` · ${message.summary}`, message.symbols?.length ? h('span', { class: 'symbol-list' }, message.symbols.join(', ')) : null]
    case 'conflict': return [h('strong', {}, 'conflict '), h('span', { class: 'mono' }, message.path), ` · ${message.text}`]
    case 'contract': return [h('strong', {}, 'contract change '), h('span', { class: 'mono' }, message.path), ` · ${message.text}`]
    case 'note': return [message.text]
    case 'question': return [h('strong', {}, 'asked '), message.text]
    case 'answer': return [h('strong', {}, 'answered '), message.text]
    case 'base': return [`${message.from} pushed ${message.commits} commit${message.commits === 1 ? '' : 's'}: ${message.summary} (base → ${message.base.slice(0, 7)})`]
    case 'plan': return [h('strong', {}, `${message.status} plan `), formatPlans([message.plan]), message.replacedBy ? ` → now ${formatPlans([message.replacedBy])}` : '', ` · ${message.text}`]
    case 'scope': return [message.summary]
    case 'done': return [h('strong', {}, `worker ${message.tag} finished `), message.summary, message.changed.length ? h('span', { class: 'mono' }, ` · ${message.changed.join(', ')}`) : null]
  }
}

function timelineItem(item: TimelineItem): HTMLElement {
  const message = item.message
  if (message.type === 'base') return h('div', { class: 'base-divider' }, ...messageBody(message))
  const other = message.type === 'question' ? message.to ?? item.replies[0]?.message.from : message.type === 'answer' ? message.from : undefined
  return h('div', { class: `timeline-item ${message.type} priority-${message.priority}` },
    h('div', { class: 'item-main' },
      h('time', { title: absoluteTime(message.at) }, clockTime(message.at)),
      h('div', { class: 'item-copy' }, item.addressed ? h('span', { class: 'link-chip' }, `${message.from} → ${message.to}`) : null, ...messageBody(message), other ? h('span', { class: 'link-chip' }, `↗ ${other}`) : null, ...copyChips(item.alsoSentTo)),
      priorityBadge(message)),
    item.replies.length ? h('div', { class: 'thread-replies' }, ...item.replies.map(timelineItem)) : null)
}

/** Ids rendered before; anything not in here gets the enter animation on this render. */
function episodeCard(episode: Episode, seen?: Set<string>, room?: RoomDoc): HTMLElement {
  const fresh = (id: string) => { if (!seen) return false; if (seen.has(id)) return false; seen.add(id); return true }
  const card = h('article', { class: `episode${fresh(`ep:${episode.id}`) ? ' enter' : ''}` },
    h('div', { class: 'episode-head' }, dot(episode.person, episode.person, room), h('strong', {}, episode.person), h('span', { class: 'area-chip' }, episode.area),
      h('span', { class: `episode-status ${episode.status === 'done' ? 'done' : ''}` }, episode.status)),
    h('div', { class: 'episode-summary' }, episode.summary, ...copyChips(episode.alsoSentTo)),
    h('div', { class: 'episode-items' }, ...episode.items.map(item => {
      const el = timelineItem(item)
      if (fresh(item.message.id)) el.classList.add('enter')
      return el
    })))
  return card
}

export function timelinePanel(conn: Conn, focus: FocusState): HTMLElement {
  const filters = h('div', { class: 'filter-chips' })
  const list = h('div', { class: 'timeline-list' })
  const scroll = h('div', { class: 'timeline-scroll scroll' }, list)
  const element = h('aside', { class: 'timeline' }, h('div', { class: 'timeline-head' }, h('div', { class: 'panel-title' }, 'Timeline'), filters), scroll)
  let areaFilter: string | null = null
  let followNewest = true
  const seen = new Set<string>()
  let primed = false
  const expandedConflicts = new Set<string>()
  scroll.onscroll = () => { followNewest = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48 }

  const render = () => {
    const shouldFollow = followNewest
    const entries = collapseConflictTimeline(conn.room.messages(), conn.room.openClaims(), conn.room.meta.base)
    const conflicts = entries.flatMap(e => e.conflict ? [e.conflict] : [])
    const episodes = groupEpisodes(entries.filter(e => !e.conflict).map(e => e.message))
    // Everything present at first paint is "old"; only later arrivals animate in.
    if (!primed) { for (const e of episodes) { seen.add(`ep:${e.id}`); for (const it of e.items) seen.add(it.message.id) }; primed = true }
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
    const cards = conflicts.filter(s => (!focus.person || s.people.includes(focus.person)) && (!areaFilter || s.people.some(p => conn.room.scopes.get(p)?.area === areaFilter)))
    list.replaceChildren(...[...visible.map(e => ({ at: e.at, el: episodeCard(e, seen, conn.room) })), ...cards.map(s => ({ at: s.at, el: conflictCard(s, expandedConflicts) }))].sort((a, b) => a.at - b.at).map(x => x.el))
    if (!visible.length && !cards.length) list.append(h('div', { class: 'empty-note muted' }, 'No matching episodes'))
    if (shouldFollow) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight })
  }
  subscribeRender(conn, render, false)
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
  const toggle = h('button', { class: 'graph-toggle', ariaLabel: 'Collapse activity graph' }, 'Activity graph', h('span', { class: 'chevron' }, '⌄'))
  const element = h('section', { class: 'activity-graph' }, toggle, content)
  let collapsed = false
  toggle.onclick = () => {
    collapsed = !collapsed
    element.classList.toggle('collapsed', collapsed)
    toggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} activity graph`)
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
      circle.setAttribute('fill', node.owner ? colorFor(node.owner, conn.room) : '#98a0ad')
      const text = document.createElementNS(svg.namespaceURI, 'text')
      text.setAttribute('x', String(position.x + 12)); text.setAttribute('y', String(position.y + 4)); text.textContent = node.label
      group.append(circle, text); svg.append(group)
    }
    content.replaceChildren(svg)
  }
  subscribeRender(conn, render, false)
  focus.subscribe(render)
  render()
  return element
}

export function header(conn: Conn): HTMLElement {
  const parts = roomNameParts(conn.displayRoomName)
  const label = parts.owner ? parts.owner + ' / ' + parts.repo : parts.repo
  const roomName = h('span', { class: 'room-name', title: conn.displayRoomName }, h('bdi', { dir: 'ltr' }, label))
  const local = parts.local ? h('span', { class: 'room-chip mono' }, 'local') : null
  const branch = parts.branch ? h('span', { class: 'room-chip mono', title: parts.branch }, h('bdi', { dir: 'ltr' }, parts.branch)) : null
  const base = h('span', { class: 'header-detail mono' }, 'base —')
  const count = h('span', { class: 'header-detail' }, '0 participants')
  const connection = h('span', { class: 'connection' }, 'disconnected')
  const element = h('header', { class: 'header' }, h('span', { class: 'product-mark' }, h('img', { src: '/logo.png', alt: 'Room', width: 40, height: 40 })), h('span', { class: 'header-divider' }), roomName, local, branch, base, count, h('span', { class: 'sp' }), connection)
  const render = () => {
    base.textContent = `base ${(conn.room.meta.base ?? '').slice(0, 7) || '—'}`
    const total = deriveParticipants(participantInput(conn)).length
    count.textContent = `${total} participant${total === 1 ? '' : 's'}`
  }
  subscribeRender(conn, render)
  conn.onStatus(connected => {
    connection.textContent = connected ? 'connected' : 'disconnected'
    connection.classList.toggle('online', connected)
  })
  render()
  return element
}
