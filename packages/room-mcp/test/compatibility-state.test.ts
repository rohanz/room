import { expect, it } from 'vitest'
import { createTools } from '../src/tools.js'
import { memorySession } from './fixtures/session.js'

it('keeps the exact affected-side remedy in room_join and room_state after a terminal refusal', async () => {
  const reason = 'Update/restart the server to support hub protocol 1–1'
  const s = { ...memorySession({ name: 'Ada', kind: 'agent' }, process.cwd()), compatibilityRefusal: reason, closed: { reason } }
  const tools = createTools({ getSession: () => s, setSession() {}, cwd: s.dir })
  try {
    expect(await tools.call('room_join', {})).toBe(`error: ${reason}`)
    expect(await tools.call('room_state', {})).toContain(`WARN: ${reason}`)
  } finally { await tools.shutdown(); s.awareness.destroy(); s.room.doc.destroy() }
})
