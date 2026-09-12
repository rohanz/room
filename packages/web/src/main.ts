import { connect } from './conn.ts'
import { centrePanel, feedPanel, h, header, participantsPanel } from './panels.ts'
import { networkPanel } from './network.ts'

const app = document.getElementById('app')!

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  app.replaceChildren(h('div', { class: 'fatal' }, h('h2', {}, 'Could not open room'), h('div', { class: 'mono' }, message)))
}

function main(): void {
  try {
    const conn = connect()
    const files = centrePanel(conn)
    const network = networkPanel(conn)
    const networkButton = h('button', { class: 'active' }, 'Network')
    const filesButton = h('button', {}, 'Changed files')
    const choose = (graph: boolean) => {
      files.hidden = graph; network.hidden = !graph
      networkButton.classList.toggle('active', graph); filesButton.classList.toggle('active', !graph)
      networkButton.setAttribute('aria-pressed', String(graph)); filesButton.setAttribute('aria-pressed', String(!graph))
    }
    networkButton.onclick = () => choose(true); filesButton.onclick = () => choose(false)
    choose(true)
    const workspace = h('div', { class: 'workspace' }, h('nav', { class: 'workspace-tabs' }, networkButton, filesButton), network, files)
    app.replaceChildren(h('div', { class: 'layout' },
      header(conn),
      participantsPanel(conn),
      workspace,
      feedPanel(conn)))
    Object.assign(window as Window & { room?: unknown; provider?: unknown }, { room: conn.room, provider: conn.provider })
  } catch (error) {
    showError(error)
  }
}

main()
