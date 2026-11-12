import { expect, it } from 'vitest'
import { memorySession } from './fixtures/session.js'
import { createTools } from '../src/tools.js'

it('does not report a retired migration as running when its old flag survives in a saved room', async () => {
  const session = memorySession({ name: 'alice', kind: 'agent' }, process.cwd())
  session.room.metaMap.set('localMigrating', 1)
  const tools = createTools({ getSession: () => session, setSession() {}, cwd: process.cwd() })
  try {
    const state = await tools.call('room_state', {})
    expect(state).not.toContain('migrating from a running Room 0.16 session')
  } finally { await tools.shutdown(); session.awareness.destroy(); session.room.doc.destroy() }
})
