import { describe, expect, it } from 'vitest'
import { generationGate, FRESH_GENERATION } from '@room/shared'
import {
  BOOTSTRAP_MAX_BYTES, CAPABILITY_REGISTRY, COMPAT_MAX_BYTES,
  CURRENT_COMPAT, CompatibilityValidationError,
  decodeFrame, encodeFrame, parseAdvertisement,
  parseBootstrapAck, parseBootstrapFrame, parseBootstrapHello, selectContract, validateSelection,
  type BootstrapSelection, type CompatAdvertisement, type ContractPolicy,
} from '../src/index.js'

const ad = (patch: Partial<CompatAdvertisement> = {}): CompatAdvertisement => ({ ...structuredClone(CURRENT_COMPAT), ...patch })
const policy: ContractPolicy = { activeSchema: 2 }
const selected = (client = ad(), server = ad(), p = policy) => {
  const result = selectContract(client, server, p)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.text)
  return result.selection
}

describe('baseline and advertisement', () => {
  it('keeps independently versioned axes and only implemented capability versions', () => {
    expect(CURRENT_COMPAT.hub).toEqual({ min: 1, max: 1 })
    expect(CURRENT_COMPAT.schemas).toEqual({ read: [2], write: [2] })
    expect(CAPABILITY_REGISTRY['room.worker-handover'].versions).toEqual({})
    expect(CURRENT_COMPAT.capabilities).not.toHaveProperty('room.worker-handover')
    expect(new TextEncoder().encode(JSON.stringify(CURRENT_COMPAT)).length).toBeLessThan(COMPAT_MAX_BYTES)
    expect(parseAdvertisement(CURRENT_COMPAT)).toEqual(CURRENT_COMPAT)
  })
  it('ignores only the advisory legacy field while retaining every admission constraint', () => {
    const retained = { ...ad(), legacy: { schema: 2, hub: 1 } }
    expect(parseAdvertisement(retained)).toEqual(ad())
    expect(() => parseAdvertisement({ ...retained, another: true })).toThrow(/unknown fields/)
    expect(() => parseAdvertisement({ ...retained, legacy: 'x'.repeat(COMPAT_MAX_BYTES) })).toThrow(/UTF-8 bytes/)
    expect(selectContract({ ...retained, requiredCapabilities: { 'other.required': [1] } }, ad(), policy).ok).toBe(false)
    expect(() => validateSelection({ ...selected(), capabilities: { 'other.selected': 1 } }, retained, ad())).toThrow()
    expect(selectContract({ ...retained, schemas: { read: [3], write: [3] } }, ad(), policy).ok).toBe(false)
  })
  it('returns detached canonical data without changing the advertisement', () => {
    const input = ad({ schemas: { read: [3, 2], write: [3, 2] }, capabilities: { 'other.optional': [2, 1] } })
    const before = structuredClone(input), parsed = parseAdvertisement(input)
    expect(parsed.schemas.read).toEqual([2, 3])
    parsed.schemas.read.push(4)
    expect(input).toEqual(before)
  })
  it('protects process-wide registry and baseline constants from consumer mutations', () => {
    expect(Object.isFrozen(CURRENT_COMPAT.capabilities['room.generation'])).toBe(true)
    expect(Object.isFrozen(CAPABILITY_REGISTRY['room.generation'].versions[1].schemas)).toBe(true)
    expect(() => { CURRENT_COMPAT.schemas.read.push(3) }).toThrow()
  })
  const invalidAds: [string, (value: any) => void][] = [
    ['bootstrap', a => { a.bootstrap = 2 }], ['zero min', a => { a.hub.min = 0 }],
    ['fraction', a => { a.hub.max = 1.5 }], ['infinite', a => { a.hub.max = Infinity }],
    ['implementation bound', a => { a.hub.max = 65536 }], ['reversed', a => { a.hub = { min: 3, max: 2 } }],
    ['schema range', a => { a.schemas.read = { min: 2, max: 3 } }], ['empty readable set', a => { a.schemas.read = [] }],
    ['duplicate schema', a => { a.schemas.write = [2, 2] }], ['unknown field', a => { a.extra = true }],
    ['range extra', a => { a.hub.release = 'same' }], ['invalid name', a => { a.capabilities = { plain: [1] } }],
    ['unicode name', a => { a.capabilities = { 'room.é': [1] } }], ['long name', a => { a.capabilities = { ['room.' + 'a'.repeat(60)]: [1] } }],
    ['empty capability', a => { a.capabilities = { 'room.generation': [] } }], ['capability range', a => { a.capabilities = { 'room.generation': { min: 1, max: 2 } } }],
    ['nine versions', a => { a.capabilities = { 'room.generation': [1, 2, 3, 4, 5, 6, 7, 8, 9] } }],
    ['33 names', a => { a.capabilities = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x.c${i}`, [1]])) }],
    ['oversized all required', a => { a.requiredCapabilities = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`room.${'a'.repeat(40)}${i}`, [1]])) }],
    ['invalid required version', a => { a.requiredCapabilities = { 'room.ledger': [0] } }],
  ]
  it.each(invalidAds)('rejects malformed advertisements: %s', (_name, mutate) => {
    const value = ad(); mutate(value)
    expect(() => parseAdvertisement(value)).toThrow(CompatibilityValidationError)
  })
  it('counts UTF-8 bytes, not characters, and never truncates a required capability', () => {
    const value = ad({ release: 'é'.repeat(120), capabilities: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`room.${'a'.repeat(30)}${i}`, [1]])) })
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(COMPAT_MAX_BYTES)
    expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeGreaterThan(COMPAT_MAX_BYTES)
    expect(() => parseAdvertisement(value)).toThrow(/UTF-8 bytes/)
  })
})

describe('deterministic contract selection', () => {
  it.each([
    [{ min: 1, max: 1 }, { min: 1, max: 1 }, 1],
    [{ min: 1, max: 2 }, { min: 1, max: 2 }, 2],
    [{ min: 1, max: 3 }, { min: 1, max: 2 }, 2],
    [{ min: 2, max: 3 }, { min: 1, max: 2 }, 2],
    [{ min: 1, max: 65535 }, { min: 1, max: 65535 }, 65535],
  ])('chooses highest common protocol without changing schema (%j / %j)', (c, s, expected) => {
    expect(selected(ad({ hub: c }), ad({ hub: s })).hub).toBe(expected)
  })
  it.each([
    [ad({ hub: { min: 1, max: 1 } }), ad({ hub: { min: 2, max: 3 } }), 'hub-incompatible', 'client', { min: 2, max: 3 }],
    [ad({ hub: { min: 2, max: 3 } }), ad(), 'hub-incompatible', 'server', { min: 2, max: 3 }],
  ])('names the older side and the exact protocol target', (client, server, code, side, target) => {
    const result = selectContract(client, server, policy)
    expect(result).toMatchObject({ ok: false, error: { code, side, requiredChanges: [{ side, action: 'update', contract: 'hub', range: target }] } })
  })
  it.each([
    ['0.16 client', ad({ schemas: { read: [1], write: [1] } }), ad(), 2, 'client', [2]],
    ['0.16 server', ad(), ad({ schemas: { read: [1], write: [1] } }), 2, 'server', [2]],
    ['retired baseline', ad(), ad({ schemas: { read: [3], write: [3] } }), 3, 'client', [3]],
    ['explicit schema gap', ad({ schemas: { read: [2, 4], write: [2, 4] } }), ad({ schemas: { read: [2, 3, 4], write: [2, 3, 4] } }), 3, 'client', [3]],
  ])('refuses %s with exact schema guidance', (_name, client, server, schema, side, target) => {
    expect(selectContract(client, server, { activeSchema: schema })).toMatchObject({ ok: false, error: { code: 'schema-incompatible', side, requiredChanges: [{ versions: target }] } })
  })
  it('allows read-only schema support without granting write support', () => {
    const reader = ad({ schemas: { read: [2], write: [] } })
    expect(selected(reader, ad(), { activeSchema: 2, readOnly: true }).schema).toBe(2)
    expect(selectContract(reader, ad(), policy)).toMatchObject({ ok: false, error: { side: 'client', code: 'schema-incompatible' } })
  })
  it('does not migrate schema just because both peers can write it', () => {
    const both = ad({ schemas: { read: [2, 3], write: [2, 3] } })
    expect(selected(both, both).schema).toBe(2)
    expect(selected(both, both, { activeSchema: 3 }).schema).toBe(3)
  })
  it('names both peers when both lack the active schema', () => {
    expect(selectContract(ad(), ad(), { activeSchema: 3 })).toMatchObject({ ok: false, error: { requiredChanges: [
      { side: 'server', versions: [3] }, { side: 'client', versions: [3] },
    ] } })
  })
  it.each([
    ['generation-unaware RC', null, 'update'], ['stale replica', 'old-generation', 'stale'],
    ['fresh baseline', FRESH_GENERATION, 'accept'], ['matching baseline', 'current-generation', 'accept'],
  ] as const)('keeps generation fencing independent of the selected schema/protocol: %s', (_name, generation, expected) => {
    expect(selected().schema).toBe(2)
    expect(generationGate(generation, 'current-generation')).toBe(expected)
  })
  it('intersects registered versions and ignores unknown optional capabilities', () => {
    const client = ad({ capabilities: { 'room.generation': [1, 2], 'x.optional': [1] } })
    const server = ad({ capabilities: { 'room.generation': [1], 'x.optional': [1], 'room.ledger': [1] } })
    expect(selected(client, server).capabilities).toEqual({ 'room.generation': 1 })
  })
  it('does not interpret a reserved capability as implemented', () => {
    const peer = ad({ capabilities: { 'room.worker-handover': [1] } })
    expect(selected(peer, peer).capabilities).toEqual({})
    expect(selectContract(peer, peer, { activeSchema: 2, requiredCapabilities: { 'room.worker-handover': [1] } })).toMatchObject({ ok: false, error: { side: 'room', missingCapabilities: { 'room.worker-handover': [1] } } })
  })
  it.each(['client', 'server', 'room'] as const)('fails unknown required capability owned by %s', owner => {
    const requiredCapabilities = { 'room.unknown': [1] }
    expect(selectContract(ad(owner === 'client' ? { requiredCapabilities } : {}), ad(owner === 'server' ? { requiredCapabilities } : {}), { activeSchema: 2, ...(owner === 'room' ? { requiredCapabilities } : {}) })).toMatchObject({ ok: false, error: { side: owner, missingCapabilities: requiredCapabilities } })
  })
  it.each(['client', 'server'] as const)('tells %s exactly which required capability to implement', side => {
    const empty = ad({ capabilities: {} })
    expect(selectContract(side === 'client' ? empty : ad(), side === 'server' ? empty : ad(), { activeSchema: 2, requiredCapabilities: { 'room.generation': [1] } })).toMatchObject({ ok: false, error: { side, requiredChanges: [{ side, capability: 'room.generation', versions: [1] }] } })
  })
  it('reports every missing required capability and both sides when both must change', () => {
    const empty = ad({ capabilities: {} }), requiredCapabilities = { 'room.generation': [1], 'room.ledger': [1] }
    const result = selectContract(empty, empty, { activeSchema: 2, requiredCapabilities })
    expect(result).toMatchObject({ ok: false, error: { missingCapabilities: requiredCapabilities, requiredChanges: [
      { side: 'client', capability: 'room.generation', versions: [1] },
      { side: 'server', capability: 'room.generation', versions: [1] },
      { side: 'client', capability: 'room.ledger', versions: [1] },
      { side: 'server', capability: 'room.ledger', versions: [1] },
    ] } })
  })
  it('bounds unknown-registry refusal amplification and authority requirements', () => {
    const requiredCapabilities = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`room.${'a'.repeat(30)}${i}`, [1]]))
    const result = selectContract(ad({ requiredCapabilities }), ad({ requiredCapabilities }), { activeSchema: 2, requiredCapabilities })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const frame = { v: 1, re: 'h', ok: false, error: result.error } as const
    expect(new TextEncoder().encode(JSON.stringify(frame)).length).toBeLessThan(BOOTSTRAP_MAX_BYTES)
    expect(parseBootstrapFrame(frame)).toEqual(frame)
    expect(selectContract(ad(), ad(), { activeSchema: 2, requiredCapabilities: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`room.${'a'.repeat(40)}${i}`, [1]])) })).toMatchObject({ ok: false, error: { code: 'invalid-advertisement', side: 'room' } })
  })
  it('checks registry schema/protocol dependencies and searches lower common protocols', () => {
    const peer = ad({ hub: { min: 1, max: 2 }, requiredCapabilities: { 'room.generation': [1] } })
    expect(selected(peer, peer).hub).toBe(1)
    const proto2 = ad({ hub: { min: 2, max: 2 }, requiredCapabilities: { 'room.generation': [1] } })
    expect(selectContract(proto2, proto2, policy)).toMatchObject({ ok: false, error: { code: 'capability-incompatible' } })
    const schema3 = ad({ schemas: { read: [3], write: [3] }, requiredCapabilities: { 'room.generation': [1] } })
    expect(selectContract(schema3, schema3, { activeSchema: 3 })).toMatchObject({ ok: false, error: { code: 'capability-incompatible' } })
  })
  it('validates required version sets, policy and malformed peers without throwing or fallback', () => {
    expect(selectContract(ad({ bootstrap: 2 } as any), ad(), policy)).toMatchObject({ ok: false, error: { code: 'invalid-advertisement', side: 'client' } })
    expect(selectContract(ad(), ad({ bootstrap: 2 } as any), policy)).toMatchObject({ ok: false, error: { code: 'invalid-advertisement', side: 'server' } })
    expect(selectContract(ad(), ad(), { activeSchema: 0 })).toMatchObject({ ok: false, error: { side: 'room' } })
    expect(selectContract(ad(), ad(), { activeSchema: 2, requiredCapabilities: { 'room.generation': [] } })).toMatchObject({ ok: false, error: { side: 'room', code: 'invalid-advertisement' } })
  })
  it('is deterministic and independent of release text, version order and input mutation', () => {
    const a = ad({ release: 'arbitrary' }), b = ad({ release: 'older' })
    const before = structuredClone([a, b])
    expect(selected(a, b)).toEqual(selected(b, a))
    expect([a, b]).toEqual(before)
  })
})

describe('bootstrap shapes', () => {
  const hello = { v: 1, op: 'compat-hello', id: 'h', sessionId: 's', offer: CURRENT_COMPAT } as const
  const ack = { v: 1, op: 'compat-ack', id: 'a', selectionId: 'selection' } as const
  const reply: BootstrapSelection = { v: 1, re: 'h', ok: true, selectionId: 'selection', selection: selected(), compat: CURRENT_COMPAT, generation: '0', policyRevision: 0, incarnation: 1, ttlMs: 45000, renewMs: 15000, requiredCapabilities: {} }
  it.each([hello, ack, reply, { v: 1, re: 'a', ok: true } as const])('round-trips bounded type-7 frames', frame => {
    expect(parseBootstrapFrame(decodeFrame(encodeFrame(frame)))).toEqual(frame)
  })
  it('validates a selected subset independently of release identity', () => {
    expect(validateSelection(reply.selection, CURRENT_COMPAT, CURRENT_COMPAT)).toEqual(reply.selection)
    expect(validateSelection({ ...reply.selection, capabilities: {} }, CURRENT_COMPAT, CURRENT_COMPAT)).toMatchObject({ capabilities: {} })
    const newer = ad({ hub: { min: 1, max: 2 } })
    expect(validateSelection(reply.selection, newer, newer)).toEqual(reply.selection)
  })
  it.each([
    { bootstrap: 2, hub: 1, schema: 2, capabilities: {} },
    { bootstrap: 1, hub: 2, schema: 2, capabilities: {} },
    { bootstrap: 1, hub: 1, schema: 3, capabilities: {} },
    { bootstrap: 1, hub: 1, schema: 2, capabilities: { 'room.ledger': 2 } },
    { bootstrap: 1, hub: 1, schema: 2, capabilities: { 'room.unknown': 1 } },
    { bootstrap: 1, hub: 1, schema: 2, capabilities: { 'room.ledger': [1] } },
  ])('rejects selections outside the offered/implemented contract %j', value => {
    expect(() => validateSelection(value, CURRENT_COMPAT, CURRENT_COMPAT)).toThrow(CompatibilityValidationError)
  })
  it('checks selection requirements, read-only permissions and active schema', () => {
    const empty = { ...reply.selection, capabilities: {} }
    const requiredCapabilities = { 'room.ledger': [1] }
    expect(() => validateSelection(empty, ad({ requiredCapabilities }), ad())).toThrow()
    expect(() => validateSelection(empty, ad(), ad({ requiredCapabilities }))).toThrow()
    expect(() => validateSelection(empty, ad(), ad(), { requiredCapabilities })).toThrow()
    expect(() => validateSelection(reply.selection, ad(), ad(), { activeSchema: 3 })).toThrow()
    const reader = ad({ schemas: { read: [2], write: [] } })
    expect(() => validateSelection(empty, reader, ad())).toThrow()
    expect(validateSelection(empty, reader, ad(), { readOnly: true })).toEqual(empty)
  })
  it('validates refusal shape and exact required changes', () => {
    const result = selectContract(ad(), ad({ hub: { min: 2, max: 2 } }), policy)
    if (result.ok) throw new Error('expected refusal')
    const frame = { v: 1, re: 'h', ok: false, error: result.error } as const
    expect(parseBootstrapFrame(frame)).toEqual(frame)
    expect(() => parseBootstrapFrame({ ...frame, error: { ...result.error, side: 'any' } })).toThrow()
    expect(() => parseBootstrapFrame({ ...frame, error: { ...result.error, requiredChanges: [{}] } })).toThrow()
  })
  it.each([
    null, {}, { ...hello, v: 2 }, { ...hello, proto: 1 }, { ...hello, sessionId: '' },
    { ...ack, selectionId: '' }, { ...ack, offer: CURRENT_COMPAT },
    { ...hello, sessionId: 's'.repeat(129) }, { v: 1, re: 'a', ok: true, selectionId: 'incomplete' },
    { ...reply, policyRevision: -1 }, { ...reply, incarnation: 0.5 }, { ...reply, renewMs: 0 },
    { ...reply, selection: { ...reply.selection, hub: 0 } },
    { ...reply, selection: { ...reply.selection, capabilities: { 'room.ledger': [1] } } },
    { ...reply, compat: { ...CURRENT_COMPAT, bootstrap: 2 } },
    { ...hello, id: 'x'.repeat(BOOTSTRAP_MAX_BYTES) },
  ])('rejects invalid/oversized frames %j', frame => {
    expect(() => parseBootstrapFrame(frame)).toThrow(CompatibilityValidationError)
  })
  it('does not accept the wrong step parser', () => {
    expect(parseBootstrapHello(hello)).toEqual(hello)
    expect(parseBootstrapAck(ack)).toEqual(ack)
    expect(() => parseBootstrapHello(ack)).toThrow()
    expect(() => parseBootstrapAck(hello)).toThrow()
  })
})

describe('release diagnostics do not select the contract', () => {
  it('does not infer runtime compatibility from release equality', () => {
    expect(selected(ad({ release: '0.1.0' }), ad({ release: '9.9.9' })).schema).toBe(2)
    expect(selectContract(ad({ release: 'same' }), ad({ release: 'same', schemas: { read: [3], write: [3] } }), { activeSchema: 3 }).ok).toBe(false)
  })
})
