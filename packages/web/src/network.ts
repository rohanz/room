import type { GraphSnapshot } from '@room/shared'
import { presences, type Conn } from './conn.ts'
import { h } from './panels.ts'
import { deriveNetwork, type NetworkNode } from './network-model.ts'

const NS = 'http://www.w3.org/2000/svg'
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) {
  const el = document.createElementNS(NS, tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
  if (text !== undefined) el.textContent = text
  return el
}
const roles = ['upstream', 'changed', 'downstream', 'context'] as const
const labels = { upstream: 'UPSTREAM DEPENDENCIES', changed: 'MY CURRENT CHANGES', downstream: 'DOWNSTREAM CONSUMERS', context: 'OTHER FILES' }

export function networkPanel(conn: Conn): HTMLElement {
  const person = h('select', { title: 'View changes as participant' })
  person.setAttribute('aria-label', 'View changes as participant')
  const search = h('input', { type: 'search', placeholder: 'Find a file…' })
  search.setAttribute('aria-label', 'Find a file in the network')
  const focus = h('input', { type: 'checkbox', checked: new URLSearchParams(location.search).get('network') !== 'all' })
  const zoom = h('input', { type: 'range', min: '30', max: '160', value: '100', title: 'Network zoom' })
  const fit = h('button', { title: 'Fit the full network in the available width' }, 'Fit')
  const expand = h('button', { title: 'Give the network the full workspace width' }, 'Expand')
  expand.setAttribute('aria-pressed', 'false')
  zoom.setAttribute('aria-label', 'Network zoom')
  const status = h('div', { class: 'network-status' })
  const stats = h('div', { class: 'network-stats' })
  const canvas = h('div', { class: 'network-canvas' })
  const details = h('div', { class: 'network-details' })
  const root = h('section', { class: 'network-panel' },
    h('div', { class: 'network-heading' }, h('div', {}, h('h2', {}, 'Your work, in context'), h('p', { class: 'muted' }, 'Follow dependencies before they become surprises.')), h('label', {}, 'Viewing as ', person)),
    h('div', { class: 'network-controls' }, search, h('label', {}, focus, ' My neighborhood'), h('label', { class: 'network-zoom' }, 'Zoom ', zoom), fit, expand),
    stats,
    h('div', { class: 'network-legend' }, h('span', { class: 'legend-changed' }, '● My changes'), h('span', { class: 'legend-upstream' }, '● Upstream'), h('span', {}, '○ Downstream / other'), h('span', {}, 'Provider → consumer')),
    status, canvas, details,
    h('div', { class: 'network-footnote' }, 'Inferred symbol references · Python AST / JS & TS names · May miss or overstate dependencies. Each snapshot prefers your overlay, then a teammate’s, then the room base.'))
  let selectedPerson = new URLSearchParams(location.search).get('participant') ?? new URLSearchParams(location.search).get('name') ?? ''
  let selectedPath = ''
  let drawing: SVGSVGElement | undefined
  let fitMode = false
  const sizeDrawing = () => {
    if (!drawing || !canvas.clientWidth) return
    const width = drawing.viewBox.baseVal.width
    if (fitMode) zoom.value = String(Math.max(30, Math.min(160, Math.floor(canvas.clientWidth / width * 100))))
    drawing.style.width = `${width * Number(zoom.value) / 100}px`
  }

  const showDetails = (node: NetworkNode, snapshot: GraphSnapshot) => {
    selectedPath = node.path
    const upstream = snapshot.edges.filter(e => e.target === node.path)
    const downstream = snapshot.edges.filter(e => e.source === node.path)
    const changers = [...new Set([...conn.room.overlays.keys(), ...conn.room.deleted.keys()])]
      .filter(p => conn.room.changedPaths(p).includes(node.path))
    const claims = conn.room.claimsFor(node.path)
    const linkList = (title: string, edges: typeof upstream, incoming: boolean) => h('div', {}, h('h3', {}, title),
      ...edges.map(e => h('div', { class: 'network-dependency mono' }, `${incoming ? e.source : e.target} · ${e.symbols.join(', ')}`)),
      edges.length ? null : h('span', { class: 'muted' }, 'None in this snapshot'))
    const clear = h('button', { class: 'network-clear', title: 'Clear file selection' }, 'Clear selection')
    clear.onclick = () => { selectedPath = ''; render() }
    details.replaceChildren(h('div', { class: 'network-detail-head' }, h('strong', { class: 'mono' }, node.path), clear),
      h('p', { class: 'muted' }, `${node.deleted ? 'Deleted locally. ' : ''}${changers.length ? `Changed by ${changers.join(', ')}.` : 'No current overlay changes.'}`),
      h('div', { class: 'network-detail-columns' }, linkList('Depends on', upstream, true), linkList('Used by', downstream, false)),
      ...claims.map(c => h('p', {}, `${c.by}: ${c.intent}${c.plans?.length ? ` · ${c.plans.map(p => `${p.kind} ${p.symbol}: ${p.detail ?? ''}`).join('; ')}` : ''}`)))
    drawing?.querySelectorAll('[data-path]').forEach(el => el.classList.toggle('selected', el.getAttribute('data-path') === selectedPath))
    drawing?.classList.add('has-selection')
    drawing?.querySelectorAll('.network-edge').forEach(el => el.classList.toggle('selected', el.getAttribute('data-source') === selectedPath || el.getAttribute('data-target') === selectedPath))
  }

  const render = () => {
    const names = [...new Set([...conn.room.graphs.keys(), ...conn.room.overlays.keys(), ...conn.room.deleted.keys(), ...conn.room.scopes.keys(), ...presences(conn.provider).map(p => p.user.name)])].sort()
    if (!names.includes(selectedPerson)) selectedPerson = names[0] ?? ''
    person.replaceChildren(...names.map(name => h('option', { value: name, selected: name === selectedPerson }, name)))
    const snapshot = conn.room.graphs.get(selectedPerson)
    if (!snapshot || snapshot.version !== 1) {
      stats.replaceChildren(); status.textContent = ''
      canvas.replaceChildren(h('div', { class: 'network-empty' }, h('h2', {}, 'Waiting for a dependency snapshot'), h('p', {}, 'Join with the updated Room MCP server to publish the source graph from your clone.'), h('p', { class: 'muted' }, 'Your changed files will be highlighted once indexing completes.')))
      details.replaceChildren(); return
    }
    const changed = conn.room.changedPaths(selectedPerson)
    const model = deriveNetwork(snapshot, changed, [...(conn.room.deleted.get(selectedPerson)?.keys() ?? [])], focus.checked)
    stats.replaceChildren(...[[changed.length, 'current changes'], [model.upstream.size, 'upstream files'], [model.downstream.size, 'downstream files']].map(([count, label]) => h('div', {}, h('strong', {}, String(count)), h('span', {}, String(label)))))
    const online = presences(conn.provider).some(p => p.user.name === selectedPerson)
    const notices = [snapshot.status === 'ready' ? '' : snapshot.status === 'error' ? 'Index failed — showing last available data.' : 'Indexing — dependencies may be incomplete.',
      !online ? 'Participant offline — retained snapshot.' : '', snapshot.base !== conn.room.meta.base ? 'Snapshot is on an older room base.' : '', snapshot.truncated ? 'Indexer limits reached; graph is partial.' : '',
      !changed.length ? 'No current changes. Showing the indexed network.' : ''].filter(Boolean)
    status.textContent = `${notices.join(' ')} Snapshot ${new Date(snapshot.at).toLocaleTimeString()} · base ${snapshot.base.slice(0, 7)}`
    const query = search.value.toLowerCase().trim()
    const matching = model.nodes.filter(n => !query || n.path.toLowerCase().includes(query))
    const ranked = [...matching].sort((a, b) => (a.role === 'changed' ? -1 : roles.indexOf(a.role)) - (b.role === 'changed' ? -1 : roles.indexOf(b.role)) || a.path.localeCompare(b.path))
    const nodes = ranked.slice(0, 250)
    if (matching.length > nodes.length) status.textContent += ` · Showing ${nodes.length} of ${matching.length} files; narrow the search.`
    if (!nodes.length) {
      canvas.replaceChildren(h('div', { class: 'network-empty' }, 'No matching files. Clear the search or turn off My neighborhood.'))
      details.replaceChildren(); return
    }
    const columns = roles.filter(role => nodes.some(n => n.role === role))
    const width = Math.max(740, columns.length * 300 + 50)
    const height = Math.max(380, Math.max(...columns.map(role => nodes.filter(n => n.role === role).length)) * 88 + 105)
    drawing = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': `Dependency network for ${selectedPerson}` })
    drawing.style.width = `${width * Number(zoom.value) / 100}px`
    const defs = svg('defs')
    const marker = svg('marker', { id: 'network-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' })
    marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'context-stroke' })); defs.append(marker); drawing.append(defs)
    const positions = new Map<string, { x: number; y: number }>()
    columns.forEach((role, col) => {
      const x = 28 + col * 300
      drawing!.append(svg('text', { x: String(x), y: '35', class: 'network-column-label' }, labels[role]))
      nodes.filter(n => n.role === role).sort((a, b) => a.path.localeCompare(b.path)).forEach((n, row) => positions.set(n.path, { x, y: 65 + row * 88 }))
    })
    for (const e of model.edges) {
      const a = positions.get(e.source), b = positions.get(e.target)
      if (!a || !b) continue
      const forward = b.x > a.x
      const sameColumn = a.x === b.x
      const start = a.x + (forward ? 244 : 0), end = b.x + (forward || sameColumn ? 0 : 244)
      const bend = sameColumn ? -30 : (end - start) / 2
      const edge = svg('path', { d: `M ${start} ${a.y + 29} C ${start + bend} ${a.y + 29}, ${sameColumn ? end + bend : end - bend} ${b.y + 29}, ${end} ${b.y + 29}`, class: `network-edge${model.upstream.has(e.source) && (model.upstream.has(e.target) || changed.includes(e.target)) ? ' upstream' : ''}`, 'marker-end': 'url(#network-arrow)' })
      edge.setAttribute('data-source', e.source); edge.setAttribute('data-target', e.target)
      edge.append(svg('title', {}, `${e.source} → ${e.target}: ${e.symbols.join(', ')}`)); drawing.append(edge)
    }
    for (const node of nodes) {
      const { x, y } = positions.get(node.path)!
      const group = svg('g', { transform: `translate(${x} ${y})`, class: `network-node ${node.role}${node.path === selectedPath ? ' selected' : ''}`, tabindex: '0', role: 'button', 'aria-label': `${node.path}, ${node.deleted ? 'deleted, ' : ''}${node.role}`, 'data-path': node.path })
      group.append(svg('rect', { width: '244', height: '60', rx: '10' }), svg('circle', { cx: '17', cy: '22', r: '4' }))
      const filename = node.path.split('/').pop()!
      group.append(svg('text', { x: '30', y: '26', class: 'network-filename' }, filename.length > 25 ? `${filename.slice(0, 23)}…` : filename))
      const subtitle = node.deleted ? 'DELETED' : node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : 'repository root'
      group.append(svg('text', { x: '16', y: '46', class: 'network-directory' }, subtitle.length > 33 ? `…${subtitle.slice(-32)}` : subtitle), svg('title', {}, node.path))
      group.onclick = () => showDetails(node, snapshot)
      group.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetails(node, snapshot) } }
      drawing.append(group)
    }
    canvas.replaceChildren(drawing)
    sizeDrawing()
    const selection = nodes.find(n => n.path === selectedPath)
    if (selection) showDetails(selection, snapshot)
    else details.replaceChildren(h('span', { class: 'muted' }, 'Select a file to inspect its dependencies, current owners, and declared plans.'))
  }
  person.onchange = () => { selectedPerson = person.value; selectedPath = ''; render() }
  search.oninput = render; focus.onchange = render
  zoom.oninput = () => { fitMode = false; sizeDrawing() }
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
