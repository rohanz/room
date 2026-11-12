import { expect, it } from 'vitest'
import { parseBootstrapFrame, selectContract } from '@room/hub-core'
import { compatibilityFromHealth, LOCAL_CLIENT_COMPAT } from '../src/server-compat.js'

// Literal wire values transcribed from v0.17.38 and v0.17.48:
// hub-core/src/negotiation.ts baseline()/CURRENT_COMPAT; relay/src/index.ts
// docOptions.compat, /health, and attachNegotiating's selection response.
// The only capability addition between those tags is room.notice-lifecycle.
for (const release of ['0.17.38', '0.17.48']) {
  const daemonOffer = {
    bootstrap: 1 as const, hub: { min: 1, max: 1 }, schemas: { read: [2], write: [2] },
    capabilities: { 'room.generation': [1], 'room.manifest': [1], 'room.ledger': [1],
      ...(release === '0.17.48' ? { 'room.notice-lifecycle': [1] } : {}), 'room.daemon': [1] },
    legacy: { schema: 2, hub: 1 },
  }
  it(`accepts the still-running ${release} daemon's health advertisement`, () => {
    expect(() => compatibilityFromHealth({ ok: true, local: true, schema: 2, hub: 1,
      discovery: 1, runtime: 'daemon', compat: daemonOffer }, LOCAL_CLIENT_COMPAT)).not.toThrow()
  })
  it(`accepts the still-running ${release} daemon's authenticated selection frame`, () => {
    const selection = { bootstrap: 1, hub: 1, schema: 2,
      capabilities: Object.fromEntries(Object.keys(daemonOffer.capabilities).map(name => [name, 1])) }
    expect(() => parseBootstrapFrame({ v: 1, re: 'compat-hello', ok: true,
      selectionId: '0123456789abcdef0123456789abcdef', selection, compat: daemonOffer,
      generation: '0', policyRevision: 1, incarnation: 1, ttlMs: 45000, renewMs: 15000,
      requiredCapabilities: { 'room.daemon': [1] } })).not.toThrow()
  })
  it(`admits a still-open ${release} session into the new daemon`, () => {
    // client-compat.ts LOCAL_CLIENT_COMPAT plus session.ts's diagnostic release.
    const offer = { ...daemonOffer, release, requiredCapabilities: { 'room.daemon': [1] } }
    expect(() => parseBootstrapFrame({ v: 1, op: 'compat-hello', id: 'compat-hello',
      sessionId: 'retained-session', offer })).not.toThrow()
    expect(selectContract(offer, LOCAL_CLIENT_COMPAT, { activeSchema: 2,
      requiredCapabilities: { 'room.daemon': [1] } }).ok).toBe(true)
  })
}
