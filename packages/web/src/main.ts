import { connect } from './conn.ts'
import { activityGraphPanel, centrePanel, createFocusState, h, header, participantsPanel, timelinePanel } from './panels.ts'

const app = document.getElementById('app')!

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  app.replaceChildren(h('div', { class: 'fatal' }, h('h2', {}, 'Could not open room'), h('div', { class: 'mono' }, message)))
}

function main(): void {
  try {
    const conn = connect()
    const focus = createFocusState()
    app.replaceChildren(h('div', { class: 'layout' },
      header(conn),
      participantsPanel(conn, focus),
      centrePanel(conn, focus),
      timelinePanel(conn, focus),
      activityGraphPanel(conn, focus)))
    Object.assign(window as Window & { room?: unknown; provider?: unknown }, { room: conn.room, provider: conn.provider })
  } catch (error) {
    showError(error)
  }
}

main()
