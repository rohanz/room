import { reconnectStatus } from './reconnect.ts'
import { applyTheme, readTheme, nextTheme, type Theme } from './theme.ts'
import { connect } from './conn.ts'
import { centrePanel, createFocusState, h, header, participantsPanel, timelinePanel } from './panels.ts'
import { networkPanel } from './network.ts'
import { boardPanel } from './board.ts'
import { initialView, viewUrl, type View } from './view.ts'

const app = document.getElementById('app')!
try {
  const conn = connect(), focus = createFocusState()
  const files = centrePanel(conn, focus), network = networkPanel(conn, focus)
  const graphButton = h('button', {}, 'Network'), filesButton = h('button', {}, 'Files')
  const chooseGraph = (graph: boolean) => {
    files.hidden = graph; network.hidden = !graph
    for (const [button, active] of [[graphButton, graph], [filesButton, !graph]] as const) { button.classList.toggle('active', active); button.ariaPressed = String(active) }
  }
  graphButton.onclick = () => chooseGraph(true); filesButton.onclick = () => chooseGraph(false); chooseGraph(false)
  const workspace = h('div', { class: 'workspace' }, h('nav', { class: 'workspace-tabs', ariaLabel: 'Inspector view' }, filesButton, graphButton), network, files)
  const people = participantsPanel(conn, focus), timeline = timelinePanel(conn, focus)
  const mobile = h('nav', { class: 'mobile-tabs', ariaLabel: 'Code panels' })
  const code = h('div', { class: 'code-layout', id: 'code-view' }, mobile, people, workspace, timeline)
  const selectPanel = (value: string) => { code.dataset.panel = value; for (const button of mobile.querySelectorAll('button')) { button.classList.toggle('active', button.textContent === value); button.ariaPressed = String(button.textContent === value) } }
  for (const value of ['People', 'Inspector', 'Timeline']) mobile.append(h('button', { onclick: () => selectPanel(value) }, value))
  selectPanel('Inspector')
  const board = boardPanel(conn, name => { focus.set(name); chooseGraph(false); selectPanel('Inspector'); choose('code') })
  board.id = 'board-view'
  const top = header(conn), switcher = h('nav', { class: 'view-switcher', ariaLabel: 'Room view' })
  const boardButton = h('button', { title: 'Board (B)' }, 'Board'), codeButton = h('button', { title: 'Code (C)' }, 'Code')
  const themeSwitcher = h('div', { class: 'view-switcher theme-switcher', role: 'group', ariaLabel: 'Color theme' })
  let theme = readTheme()
  const themeButtons = (['light', 'dark', 'system'] as const).map((value, i) => {
    const label = value[0].toUpperCase() + value.slice(1)
    const icon = h('span', {}, ['☀', '☾', '◐'][i])
    icon.setAttribute('aria-hidden', 'true')
    const button = h('button', { title: label + ' theme (T to cycle)', ariaLabel: label + ' theme', onclick: () => chooseTheme(value) }, icon, h('span', { class: 'theme-label' }, label))
    themeSwitcher.append(button)
    return button
  })
  function chooseTheme(value: Theme) {
    theme = value; applyTheme(value)
    themeButtons.forEach((button, i) => {
      const active = ['light', 'dark', 'system'][i] === theme
      button.classList.toggle('active', active); button.ariaPressed = String(active)
    })
  }
  chooseTheme(theme)
  switcher.append(boardButton, codeButton); top.append(themeSwitcher, switcher)
  const reconnect = h('div', { class: 'reconnecting', role: 'status' }, 'reconnecting…')
  conn.onStatus(reconnectStatus(reconnect))
  function choose(view: View, update = true) {
    board.hidden = view !== 'board'; code.hidden = view !== 'code'
    for (const [button, active] of [[boardButton, view === 'board'], [codeButton, view === 'code']] as const) { button.classList.toggle('active', active); button.ariaPressed = String(active) }
    if (update) history.replaceState(null, '', viewUrl(location.href, view))
  }
  boardButton.onclick = () => choose('board'); codeButton.onclick = () => choose('code')
  document.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable=true]')) return
    if (event.key.toLowerCase() === 't') { event.preventDefault(); if (!event.repeat) chooseTheme(nextTheme(theme)) }
    if (event.key.toLowerCase() === 'b' || event.key.toLowerCase() === 'c') { event.preventDefault(); choose(event.key.toLowerCase() === 'b' ? 'board' : 'code') }
  })
  window.addEventListener('popstate', () => choose(initialView(location.search), false))
  app.replaceChildren(h('div', { class: 'shell' }, top, reconnect, board, code))
  choose(initialView(location.search), false)
  Object.assign(window, { room: conn.room, provider: conn.provider })
} catch (error) {
  app.replaceChildren(h('div', { class: 'fatal' }, h('h2', {}, 'Could not open room'), h('div', { class: 'mono' }, error instanceof Error ? error.message : String(error))))
}
