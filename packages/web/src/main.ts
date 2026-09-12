import { connect } from './conn.ts'
import { centrePanel, feedPanel, h, header, participantsPanel } from './panels.ts'

const app = document.getElementById('app')!

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  app.replaceChildren(h('div', { class: 'fatal' }, h('h2', {}, 'Could not open room'), h('div', { class: 'mono' }, message)))
}

function main(): void {
  try {
    const conn = connect()
    app.replaceChildren(h('div', { class: 'layout' },
      header(conn),
      participantsPanel(conn),
      centrePanel(conn),
      feedPanel(conn)))
    Object.assign(window as Window & { room?: unknown; provider?: unknown }, { room: conn.room, provider: conn.provider })
  } catch (error) {
    showError(error)
  }
}

main()
