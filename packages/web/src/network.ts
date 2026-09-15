import type { GraphSnapshot } from '@room/shared'
import { presences, type Conn } from './conn.ts'
import { h, type FocusState } from './panels.ts'
import { deriveNetwork, deriveContractImpact, deriveWorkImpact, type NetworkNode } from './network-model.ts'

const NS = 'http://www.w3.org/2000/svg'
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) {
  const el = document.createElementNS(NS, tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
  if (text !== undefined) el.textContent = text
  return el
}
const roles = ['upstream', 'work', 'downstream', 'context'] as const
const labels = { upstream: 'UPSTREAM · WHAT I RELY ON', work: 'MY EDITS & PLANS', downstream: 'DOWNSTREAM · MY PLAN IMPACT', context: 'OTHER FILES' }

export function networkPanel(conn: Conn, shared?: FocusState): HTMLElement {
  const person = h('select', { title: 'View changes as participant' })
  person.setAttribute('aria-label', 'View changes as participant')
  const search = h('input', { type: 'search', placeholder: 'Find a file…' })
  search.setAttribute('aria-label', 'Find a file in the network')
  const focus = h('input', { type: 'checkbox', checked: true })
  let zoom = 100
  const minus = h('button', { ariaLabel: 'Zoom out' }, '−')
  const plus = h('button', { ariaLabel: 'Zoom in' }, '+')
  const percentage = h('span', { class: 'network-percentage', ariaLive: 'polite' }, '100%')
  const fit = h('button', { title: 'Fit the full network in the available width' }, 'Fit')
  const expand = h('button', { title: 'Give the network the full workspace width' }, 'Expand')
  expand.setAttribute('aria-pressed', 'false')
  const status = h('div', { class: 'network-status' })
  const stats = h('div', { class: 'network-stats' })
  const canvas = h('div', { class: 'network-canvas' })
  const details = h('div', { class: 'network-details' })
  const tooltip = h('div', { class: 'network-tooltip', hidden: true })
  tooltip.id = 'network-tooltip'; tooltip.setAttribute('role', 'tooltip')
  const help = h('span', { class: 'network-help' }, h('button', { ariaLabel: 'About contract risks' }, '?'),
    h('span', { class: 'network-help-text', role: 'tooltip' }, 'No declared contract plans of yours; ordinary edits do not imply downstream breakage. Impact is inferred from declared plans and symbol references; the merged-tree test run is the proof.'))
  const emptyDetails = () => details.replaceChildren(h('div', { class: 'network-details-empty muted' }, 'Select a file to inspect its dependencies, current owners, and declared plans.'))
  const root = h('section', { class: 'network-panel' },
    h('div', { class: 'network-heading' }, h('div', {}, h('h2', {}, 'My work & contract risks', help), h('p', { class: 'muted' }, 'Upstream risks → my edits and plans → consumers of my planned changes')), h('label', {}, 'Viewing as ', person)),
    h('div', { class: 'network-controls' }, search, h('label', {}, focus, ' Relevant to my work'), h('div', { class: 'view-switcher network-zoom', role: 'group', ariaLabel: 'Network zoom' }, minus, fit, plus), percentage, expand),
    stats,
    h('div', { class: 'network-legend' }, h('span', { class: 'legend-changed' }, 'Edits'), h('span', { class: 'legend-contract' }, 'Declared plans'), h('span', { class: 'legend-impact' }, 'Consumers')),
    status, canvas, details, tooltip)
  let selectedPerson = new URLSearchParams(location.search).get('participant') ?? new URLSearchParams(location.search).get('name') ?? ''
  let selectedPath = ''
  let drawing: SVGSVGElement | undefined
  let fitMode = true
  let fileSet = ''
  let impact: ReturnType<typeof deriveContractImpact>
  let workView: ReturnType<typeof deriveWorkImpact>
  const hideTooltip = () => { tooltip.hidden = true }
  const risk = (path: string) => workView.work.has(path) ? 'work' : workView.upstream.has(path) ? 'upstream' : workView.downstream.has(path) ? 'downstream' : 'context'
  const contractStyle = (path: string) => impact.contracts.has(path) ? 'contract' : impact.direct.has(path) ? 'direct' : impact.indirect.has(path) ? 'indirect' : 'neutral'
  const exposure = (path: string) => [...(impact.direct.get(path) ?? []), ...(impact.indirect.get(path) ?? [])]
  const sizeDrawing = () => {
    if (!canvas.clientWidth) { fitMode = true; return }
    if (!drawing) return
    const width = drawing.viewBox.baseVal.width
    if (fitMode) zoom = Math.max(1, Math.floor(canvas.clientWidth / width * 100))
    percentage.textContent = `${zoom}%`
    fit.classList.toggle('active', fitMode)
    fit.ariaPressed = String(fitMode)
    drawing.style.width = `${width * zoom / 100}px`
  }

  const showDetails = (node: NetworkNode, snapshot: GraphSnapshot) => {
    hideTooltip()
    selectedPath = node.path
    const upstream = snapshot.edges.filter(e => e.target === node.path)
    const downstream = snapshot.edges.filter(e => e.source === node.path)
    const changers = [...new Set([...conn.room.overlays.keys(), ...conn.room.deleted.keys()])]
      .filter(p => conn.room.changedPaths(p).includes(node.path))
    const claims = conn.room.claimsFor(node.path)
    const ownedPlans = impact.contracts.get(node.path) ?? []
    const directConsumers = [...impact.direct].filter(([, plans]) => plans.some(p => ownedPlans.includes(p)))
    const indirectConsumers = [...impact.indirect].filter(([, plans]) => plans.some(p => ownedPlans.includes(p)))
    const linkList = (title: string, edges: typeof upstream, incoming: boolean) => h('div', {}, h('h3', {}, title),
      ...edges.map(e => h('div', { class: 'network-dependency mono' }, `${incoming ? e.source : e.target} · ${e.symbols.join(', ')}`)),
      edges.length ? null : h('span', { class: 'muted' }, 'None in this snapshot'))
    const clear = h('button', { class: 'network-clear', title: 'Clear file selection' }, 'Clear selection')
    clear.onclick = () => { selectedPath = ''; render() }
    details.replaceChildren(h('div', { class: 'network-detail-head' }, h('strong', { class: 'mono' }, node.path), clear),
      h('p', { class: 'muted' }, `${node.deleted ? 'Deleted locally. ' : ''}${changers.length ? `Changed by ${changers.join(', ')}.` : 'No current overlay changes.'}`),
      h('p', {}, risk(node.path) === 'work' ? 'Your current work: edited locally or held in one of your open claims.' : risk(node.path) === 'upstream' ? 'Your work depends on this file. Contract exposures below are scoped to paths reaching your work.' : risk(node.path) === 'downstream' ? 'Potential consumer impact from your declared contract changes.' : 'Outside your current work and its contract-impact paths.'),
      h('div', { class: 'network-contract-details' },
        ...(impact.contracts.get(node.path) ?? []).map(p => h('p', {}, `Declared ${p.kind} · ${p.symbol} · ${p.owner}: ${p.detail}`)),
        ...(impact.direct.get(node.path) ?? []).map(p => h('p', {}, `Direct consumer of ${p.owner}'s ${p.symbol} in ${p.path} · ${p.kind}: ${p.detail}`)),
        ...(impact.indirect.get(node.path) ?? []).map(p => h('p', {}, `Further downstream of ${p.owner}'s ${p.symbol} in ${p.path} · potential transitive impact`)),
        ownedPlans.length ? h('div', {}, h('h3', {}, 'Potentially affected consumers in this view'),
          ...directConsumers.map(([path]) => h('div', { class: 'network-dependency mono' }, `Direct · ${path}`)),
          h('p', { class: 'muted' }, `${indirectConsumers.length} additional downstream exposures; behavior has not been tested.`)) : null,
        impact.contracts.has(node.path) && !snapshot.edges.some(e => e.source === node.path && (impact.contracts.get(node.path) ?? []).some(p => e.symbols.includes(p.symbol))) ? h('p', { class: 'muted' }, 'No matching consumer in this snapshot. This does not establish compatibility; the symbol may already have changed or be unresolved.') : null,
        h('p', { class: 'muted' }, 'Plan status: declared. Modified code does not establish that the plan is implemented. Run consumer tests to confirm compatibility.')),
      h('div', { class: 'network-detail-columns' }, linkList('All indexed dependencies (context)', upstream, true), linkList('All indexed consumers (context)', downstream, false)),
      ...claims.map(c => h('p', {}, `${c.by}: ${c.intent}${c.plans?.length ? ` · ${c.plans.map(p => `${p.kind} ${p.symbol}: ${p.detail ?? ''}`).join('; ')}` : ''}`)))
    drawing?.querySelectorAll('[data-path]').forEach(el => el.classList.toggle('selected', el.getAttribute('data-path') === selectedPath))
    drawing?.classList.add('has-selection')
    drawing?.querySelectorAll('.network-edge').forEach(el => el.classList.toggle('selected', el.getAttribute('data-source') === selectedPath || el.getAttribute('data-target') === selectedPath))
  }

  const render = () => {
    hideTooltip()
    const names = [...new Set([...conn.room.graphs.keys(), ...conn.room.overlays.keys(), ...conn.room.deleted.keys(), ...conn.room.scopes.keys(), ...presences(conn.provider).map(p => p.user.name)])].sort()
    if (!names.includes(selectedPerson)) selectedPerson = names[0] ?? ''
    person.replaceChildren(...names.map(name => h('option', { value: name, selected: name === selectedPerson }, name)))
    const snapshot = conn.room.graphs.get(selectedPerson)
    if (!snapshot || snapshot.version !== 1) {
      stats.replaceChildren(); status.textContent = ''
      canvas.replaceChildren(h('div', { class: 'network-empty' }, h('h2', {}, 'Waiting for a dependency snapshot'), h('p', {}, 'Join with the updated Room MCP server to publish the source graph from your clone.'), h('p', { class: 'muted' }, 'Your changed files will be highlighted once indexing completes.')))
      emptyDetails(); fileSet = ''; return
    }
    const changed = conn.room.changedPaths(selectedPerson)
    const model = deriveNetwork(snapshot, changed, [...(conn.room.deleted.get(selectedPerson)?.keys() ?? [])], false)
    workView = deriveWorkImpact(snapshot, conn.room.openClaims(), selectedPerson, changed)
    impact = workView.impact
    for (const path of new Set([...workView.work, ...impact.contracts.keys()])) if (!model.nodes.some(n => n.path === path)) model.nodes.push({ path, role: 'context', deleted: false })
    stats.replaceChildren(...[[workView.upstreamPlans, 'upstream contract risks'], [workView.work.size, 'my work files'], [workView.ownPlans, 'my declared plans'], [workView.downstream.size, 'potential consumers']].map(([count, label]) => h('div', {}, h('strong', {}, String(count)), h('span', {}, String(label)))))
    const online = presences(conn.provider).some(p => p.user.name === selectedPerson)
    const notices = [snapshot.status === 'ready' ? '' : snapshot.status === 'error' ? 'Index failed — showing last available data.' : 'Indexing — dependencies may be incomplete.',
      !online ? 'Participant offline — retained snapshot.' : '', snapshot.base !== conn.room.meta.base ? 'Snapshot is on an older room base.' : '', snapshot.truncated ? 'Indexer limits reached; graph is partial.' : '',
      !workView.work.size ? 'No edits or open claims for this participant. Turn off Relevant to my work to explore the repository.' : '',
      workView.work.size && !workView.upstreamPlans ? 'No matching upstream contract risk in this snapshot.' : ''].filter(Boolean)
    status.textContent = `${notices.join(' ')} Snapshot ${new Date(snapshot.at).toLocaleTimeString()} · base ${snapshot.base.slice(0, 7)}`
    const query = search.value.toLowerCase().trim()
    const matching = model.nodes.filter(n => (!focus.checked || risk(n.path) !== 'context') && (!query || n.path.toLowerCase().includes(query)))
    const rank = (n: NetworkNode) => workView.work.has(n.path) ? -2 : impact.contracts.has(n.path) ? -1 : roles.indexOf(risk(n.path))
    const ranked = [...matching].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
    const nodes = ranked.slice(0, 250)
    if (matching.length > nodes.length) status.textContent += ` · Showing ${nodes.length} of ${matching.length} files; narrow the search.`
    if (!nodes.length) {
      canvas.replaceChildren(h('div', { class: 'network-empty' }, 'No matching work. Select a participant with edits or claims, clear the search, or turn off Relevant to my work.'))
      emptyDetails(); fileSet = ''; return
    }
    const nextFileSet = JSON.stringify([selectedPerson, nodes.map(n => n.path).sort()])
    if (nextFileSet !== fileSet) { fitMode = true; fileSet = nextFileSet }
    const compact = nodes.length > 30
    const nodeHeight = compact ? 30 : 60, rowGap = compact ? 42 : 88
    const columns = roles.filter(role => role !== 'context' || nodes.some(n => risk(n.path) === role))
    const width = Math.max(740, columns.length * 300 + 50)
    const height = Math.max(380, Math.max(...columns.map(role => nodes.filter(n => risk(n.path) === role).length)) * rowGap + 105)
    drawing = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': `Dependency network for ${selectedPerson}` })
    drawing.style.width = `${width * zoom / 100}px`
    const defs = svg('defs')
    const bothFill = svg('linearGradient', { id: 'network-both-fill', x1: '0%', y1: '0%', x2: '100%', y2: '100%' })
    bothFill.append(svg('stop', { offset: '50%', 'stop-color': '#075fa8' }), svg('stop', { offset: '50%', 'stop-color': '#9624b5' }))
    defs.append(bothFill)
    const marker = svg('marker', { id: 'network-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' })
    marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'context-stroke' })); defs.append(marker); drawing.append(defs)
    const positions = new Map<string, { x: number; y: number }>()
    columns.forEach((role, col) => {
      const x = 28 + col * 300
      drawing!.append(svg('text', { x: String(x), y: '35', class: 'network-column-label' }, labels[role]))
      nodes.filter(n => risk(n.path) === role).sort((a, b) => a.path.localeCompare(b.path)).forEach((n, row) => positions.set(n.path, { x, y: 65 + row * rowGap }))
    })
    for (const e of model.edges) {
      if (focus.checked && !workView.edges.has(JSON.stringify([e.source, e.target]))) continue
      const a = positions.get(e.source), b = positions.get(e.target)
      if (!a || !b) continue
      const forward = b.x > a.x
      const sameColumn = a.x === b.x
      const start = a.x + (forward ? 244 : 0), end = b.x + (forward || sameColumn ? 0 : 244)
      const bend = sameColumn ? -30 : (end - start) / 2
      const mid = nodeHeight / 2
      const edge = svg('path', { d: `M ${start} ${a.y + mid} C ${start + bend} ${a.y + mid}, ${sameColumn ? end + bend : end - bend} ${b.y + mid}, ${end} ${b.y + mid}`, class: `network-edge${impact.affectedEdges.has(JSON.stringify([e.source, e.target])) ? ' impact' : ' background'}`, 'marker-end': 'url(#network-arrow)' })
      edge.setAttribute('data-source', e.source); edge.setAttribute('data-target', e.target)
      edge.append(svg('title', {}, `${e.source} → ${e.target}: ${e.symbols.join(', ')}`)); drawing.append(edge)
    }
    for (const node of nodes) {
      const { x, y } = positions.get(node.path)!
      const editedBy = [...new Set([...conn.room.overlays.keys(), ...conn.room.deleted.keys()])].filter(p => conn.room.changedPaths(p).includes(node.path))
      const declared = impact.contracts.has(node.path)
      const group = svg('g', { transform: `translate(${x} ${y})`, class: `network-node ${contractStyle(node.path)}${workView.work.has(node.path) ? ' my-work' : ''}${node.role === 'changed' ? ' own-edit' : ''}${node.path === selectedPath ? ' selected' : ''}`, tabindex: '0', role: 'button', 'aria-label': `${node.path}, ${risk(node.path)}, ${contractStyle(node.path)}${node.role === 'changed' ? ', my edits' : ''}`, 'data-path': node.path })
      group.classList.toggle('file-edited', editedBy.length > 0)
      group.classList.toggle('exposed', impact.direct.has(node.path) || impact.indirect.has(node.path))
      group.setAttribute('aria-label', `${node.path}, ${risk(node.path)}${declared ? ', contract change declared' : ''}${editedBy.length ? `, file modified by ${editedBy.join(', ')}` : ', no file edits'}`)
      group.append(svg('rect', { width: '244', height: String(nodeHeight), rx: compact ? '6' : '10' }))
      if (declared) group.append(svg('path', { d: compact ? 'M 14 9 L 20 15 L 14 21 L 8 15 Z' : 'M 14 16 L 20 22 L 14 28 L 8 22 Z', class: 'contract-marker' }))
      else group.append(svg('circle', { cx: '14', cy: compact ? '15' : '22', r: '3.5' }))
      const filename = node.path.split('/').slice(compact ? -2 : -1).join('/')
      const maxLabel = editedBy.length ? 22 : 28
      group.append(svg('text', { x: '25', y: compact ? '19' : '26', class: 'network-filename' }, filename.length > maxLabel ? `${filename.slice(0, maxLabel - 2)}…` : filename))
      if (editedBy.length) {
        const badge = svg('g', { class: 'edit-badge', transform: `translate(203 ${compact ? 7 : 14})` })
        badge.append(svg('rect', { width: '34', height: '16', rx: '4' }), svg('text', { x: '17', y: '11', 'text-anchor': 'middle' }, 'EDIT'), svg('title', {}, `File modified by ${editedBy.join(', ')}; contract implementation is not verified`))
        group.append(badge)
      }
      const subtitle = node.deleted ? 'DELETED' : node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : 'repository root'
      if (!compact) group.append(svg('text', { x: '16', y: '46', class: 'network-directory' }, subtitle.length > 33 ? `…${subtitle.slice(-32)}` : subtitle))
      const preview = () => {
        const plans = impact.contracts.get(node.path) ?? [], affected = exposure(node.path)
        tooltip.replaceChildren(h('strong', { class: 'mono' }, node.path),
          h('div', {}, risk(node.path) === 'work' ? 'My edited or planned work' : risk(node.path) === 'upstream' ? 'Upstream dependency of my work' : risk(node.path) === 'downstream' ? 'Consumer of my planned contract change' : 'Other file'),
          h('div', {}, plans.length ? `${plans.length} declared contract change(s)` : affected.length ? 'Potential consumer impact — not verified breakage' : 'No declared contract impact'),
          h('div', {}, editedBy.length ? `Actual file edits: ${editedBy.join(', ')}. Contract implementation is not verified.` : 'No actual file edits in the room; plans can exist before editing.'),
          ...plans.slice(0, 2).map(p => h('div', {}, `${p.owner} · ${p.kind} ${p.symbol}: ${p.detail}`)),
          ...affected.slice(0, 2).map(p => h('div', {}, `Depends on ${p.symbol} · ${p.owner}`)),
          h('div', { class: 'muted' }, `${node.role === 'changed' ? 'You have edits here. ' : ''}Click for full plans and dependency details.`))
        tooltip.hidden = false
        const box = group.getBoundingClientRect()
        tooltip.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - tooltip.offsetWidth - 8))}px`
        tooltip.style.top = `${Math.max(8, Math.min(box.bottom + 8, window.innerHeight - tooltip.offsetHeight - 8))}px`
        group.setAttribute('aria-describedby', tooltip.id)
      }
      group.onpointerenter = preview; group.onpointerleave = hideTooltip
      group.onfocus = preview; group.onblur = hideTooltip
      group.onclick = () => showDetails(node, snapshot)
      group.onkeydown = e => { if (e.key === 'Escape') hideTooltip(); if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetails(node, snapshot) } }
      drawing.append(group)
    }
    canvas.replaceChildren(drawing)
    sizeDrawing()
    const selection = nodes.find(n => n.path === selectedPath)
    if (selection) showDetails(selection, snapshot)
    else emptyDetails()
  }
  person.onchange = () => { selectedPerson = person.value; selectedPath = ''; shared?.set(selectedPerson || null); render() }
  // The People column's click-to-focus drives this view too.
  shared?.subscribe(() => { if (shared.person && shared.person !== selectedPerson) { selectedPerson = shared.person; selectedPath = ''; render() } })
  search.oninput = render; focus.onchange = render
  canvas.addEventListener('scroll', hideTooltip)
  minus.onclick = () => { fitMode = false; zoom = Math.max(10, zoom - 10); sizeDrawing() }
  plus.onclick = () => { fitMode = false; zoom = Math.min(200, zoom + 10); sizeDrawing() }
  fit.onclick = () => { fitMode = true; sizeDrawing() }
  expand.onclick = () => {
    const expanded = root.classList.toggle('expanded')
    expand.textContent = expanded ? 'Collapse' : 'Expand'
    expand.setAttribute('aria-pressed', String(expanded))
  }
  new ResizeObserver(sizeDrawing).observe(canvas)
  conn.room.graphs.observe(render); conn.room.overlays.observeDeep(render); conn.room.deleted.observeDeep(render)
  conn.room.claims.observe(render); conn.room.scopes.observe(render); conn.room.metaMap.observe(render)
  conn.provider.awareness.on('change', render)
  render()
  return root
}
