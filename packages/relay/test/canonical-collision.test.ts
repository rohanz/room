import { expect, it } from 'vitest'
import { canonicalRelayWarning, cloneId } from '../src/index.js'

it('classifies old and mismatched-key Room relays without a socket', () => {
  const common = '/tmp/room-collision-test'
  const port = 46115
  const info = { schema: 2 as const, port, pid: 321, room: 'local/test', startedAt: Date.UTC(2026, 8, 28), key: 'stale' }
  for (const health of [{ ok: true, local: true }, { ok: true, local: true, schema: 2, hub: 1, clone: cloneId(common) }]) {
    const warning = canonicalRelayWarning(port, common, { health, proven: false }, info).warning
    expect(warning).toBe("an older Room session (pid 321, started 2026-09-28T00:00:00.000Z) still holds this room's relay on 127.0.0.1:46115; quit it or reconnect Room there")
  }
  expect(canonicalRelayWarning(port, common, { health: { ok: true }, proven: false }, info)).toEqual({ roomRelay: false })
})
