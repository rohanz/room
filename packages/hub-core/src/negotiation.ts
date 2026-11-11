import type { DocSchema } from '@room/shared'

/** Bootstrap stays independent of the selected hub envelope and application release. */
export const COMPAT_BOOTSTRAP = 1
export const COMPAT_MAX_BYTES = 1024
export const BOOTSTRAP_MAX_BYTES = 8192
export const BOOTSTRAP_SESSION_ID_MAX_LENGTH = 128
export const BOOTSTRAP_HELLO_TIMEOUT_MS = 5000
export const BOOTSTRAP_ACK_TIMEOUT_MS = 5000
export const BOOTSTRAP_MAX_PENDING = 64
export const BOOTSTRAP_MAX_PENDING_PER_PRINCIPAL = 8
export const BOOTSTRAP_MAX_BUFFERED_BYTES = 1024 * 1024
export const COMPAT_CLOSE_CODE = 4406
/** Upper bound understood by this bootstrap format, not a claim to implement every version. */
export const MAX_CONTRACT_VERSION = 65535
export type HubProtocolVersion = number
export type VersionRange = { min: HubProtocolVersion; max: HubProtocolVersion }
export type CapabilityVersions = Record<string, number[]>
export type CompatAdvertisement = {
  bootstrap: 1
  hub: VersionRange
  schemas: { read: DocSchema[]; write: DocSchema[] }
  capabilities: CapabilityVersions
  requiredCapabilities?: CapabilityVersions
  legacy?: { schema: 2; hub: 1 }
  release?: string
}
export type CapabilityName = 'room.generation' | 'room.manifest' | 'room.ledger' | 'room.worker-handover' | 'room.daemon' | 'room.notice-lifecycle'
export type CapabilityContract = {
  scope: 'connection' | 'participant' | 'room'
  wire: string
  documentEffects: string
  versions: Record<number, { hub: VersionRange; schemas: number[]; dependencies: CapabilityVersions }>
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
/** Only implemented baseline semantics are registered. Handover is reserved, with no versions yet. */
export const CAPABILITY_REGISTRY: Readonly<Record<CapabilityName, CapabilityContract>> = freeze({
  'room.generation': { scope: 'connection', wire: 'schema/gen query and 4403/4409 fencing', documentEffects: 'meta.generation identifies a replica epoch', versions: { 1: { hub: { min: 1, max: 1 }, schemas: [2], dependencies: {} } } },
  'room.manifest': { scope: 'room', wire: 'schema-2 manifest records', documentEffects: 'baseline per-participant manifests and sharing revisions', versions: { 1: { hub: { min: 1, max: 1 }, schemas: [2], dependencies: {} } } },
  'room.ledger': { scope: 'room', wire: 'proto-1 ordered post and baseline event vocabulary', documentEffects: 'schema-2 bus, mail, archive, outcomes and receipts; no stronger durability', versions: { 1: { hub: { min: 1, max: 1 }, schemas: [2], dependencies: {} } } },
  'room.daemon': { scope: 'connection', wire: 'negotiated standalone local transport; no in-session takeover', documentEffects: 'client retains its replica across involuntary transport rebinding; delayed snapshot durability unchanged', versions: { 1: { hub: { min: 1, max: 1 }, schemas: [2], dependencies: {} } } },
  'room.worker-handover': { scope: 'participant', wire: 'reserved; not implemented', documentEffects: 'reserved; grants no worker lifecycle guarantee', versions: {} },
  'room.notice-lifecycle': { scope: 'connection', wire: 'optional proto-1 notice-lifecycle requests authorized by private live leases', documentEffects: 'stage 1 same-room exact-id registration with private worker dependencies and worker-retirement endings only; no evaluated endings, restart recovery or projection; unknown/untracked state retains TTL', versions: { 1: { hub: { min: 1, max: 1 }, schemas: [2], dependencies: { 'room.ledger': [1] } } } },
})

function baseline(): CompatAdvertisement {
  return { bootstrap: 1, hub: { min: 1, max: 1 }, schemas: { read: [2], write: [2] }, capabilities: { 'room.generation': [1], 'room.manifest': [1], 'room.ledger': [1] }, legacy: { schema: 2, hub: 1 } }
}
/** Fixed supported 0.17.0–0.17.32 wire profile. Never infer new safety behavior from it. */
export const LEGACY_COMPAT: CompatAdvertisement = freeze(baseline())
export const CURRENT_COMPAT: CompatAdvertisement = freeze({ ...baseline(), capabilities: { ...baseline().capabilities, 'room.notice-lifecycle': [1] } })

export class CompatibilityValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'CompatibilityValidationError' }
}
function invalid(message: string): never { throw new CompatibilityValidationError(message) }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`)
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`${label} has unknown fields`)
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_CONTRACT_VERSION }
function versions(value: unknown, label: string, allowEmpty = false): number[] {
  if (!Array.isArray(value) || value.length > 8 || (!allowEmpty && !value.length) || !value.every(integer) || new Set(value).size !== value.length) invalid(`${label} must be an explicit set of at most eight positive versions`)
  return [...value].sort((a, b) => a - b)
}
function range(value: unknown, label: string): VersionRange {
  const r = object(value, label)
  keys(r, ['min', 'max'], label)
  if (!integer(r.min) || !integer(r.max) || r.min > r.max) invalid(`${label} must be a bounded inclusive version range`)
  return { min: r.min, max: r.max }
}
function capabilities(value: unknown, label: string): CapabilityVersions {
  const caps = object(value, label), entries = Object.entries(caps)
  if (entries.length > 32) invalid(`${label} has more than 32 names`)
  const result: CapabilityVersions = {}
  for (const [name, set] of entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (name.length > 64 || !/^[a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)+$/.test(name)) invalid(`${label} has an invalid namespaced ASCII name`)
    Object.defineProperty(result, name, { value: versions(set, `${label}.${name}`), enumerable: true, writable: true, configurable: true })
  }
  return result
}
function bounded(value: unknown, max: number, label: string): void {
  let json: string | undefined
  try { json = JSON.stringify(value) } catch { invalid(`${label} is not JSON`) }
  if (json === undefined || new TextEncoder().encode(json).length > max) invalid(`${label} exceeds ${max} UTF-8 bytes`)
}
function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max) invalid(`${label} must be a nonempty string of at most ${max} characters`)
  return value
}
/** Validate the entire serialized manifest, including optional/unknown capabilities; never truncate. */
export function parseAdvertisement(value: unknown): CompatAdvertisement {
  bounded(value, COMPAT_MAX_BYTES, 'compat')
  const ad = object(value, 'compat')
  keys(ad, ['bootstrap', 'hub', 'schemas', 'capabilities', 'requiredCapabilities', 'legacy', 'release'], 'compat')
  if (ad.bootstrap !== COMPAT_BOOTSTRAP) invalid('unsupported bootstrap; implement bootstrap 1')
  const schemas = object(ad.schemas, 'schemas'); keys(schemas, ['read', 'write'], 'schemas')
  const result: CompatAdvertisement = { bootstrap: 1, hub: range(ad.hub, 'hub'), schemas: { read: versions(schemas.read, 'schemas.read'), write: versions(schemas.write, 'schemas.write', true) }, capabilities: capabilities(ad.capabilities, 'capabilities') }
  if (ad.requiredCapabilities !== undefined) result.requiredCapabilities = capabilities(ad.requiredCapabilities, 'requiredCapabilities')
  if (ad.legacy !== undefined) {
    const legacy = object(ad.legacy, 'legacy'); keys(legacy, ['schema', 'hub'], 'legacy')
    if (legacy.schema !== 2 || legacy.hub !== 1 || result.hub.min > 1 || !result.schemas.read.includes(2) || !result.schemas.write.includes(2)) invalid('legacy requires the implemented schema-2/proto-1 profile')
    result.legacy = { schema: 2, hub: 1 }
  }
  if (ad.release !== undefined) result.release = text(ad.release, 'release', 128)
  return result
}

export type ContractSelection = { bootstrap: 1; hub: number; schema: DocSchema; capabilities: Record<string, number> }
export type CompatibilitySide = 'client' | 'server' | 'room'
export type RequiredChange = { side: CompatibilitySide; action: 'update' | 'configure'; contract: 'advertisement' | 'hub' | 'schema' | 'capability'; versions?: number[]; range?: VersionRange; capability?: string }
export type CompatibilityRefusal = {
  code: 'invalid-advertisement' | 'hub-incompatible' | 'schema-incompatible' | 'capability-incompatible'
  side: CompatibilitySide
  text: string
  requiredChanges: RequiredChange[]
  missingCapabilities: CapabilityVersions
  supported: { client: CompatAdvertisement | null; server: CompatAdvertisement | null }
}
export type ContractPolicy = { activeSchema: DocSchema; readOnly?: boolean; requiredCapabilities?: CapabilityVersions }
export type ContractResult = { ok: true; selection: ContractSelection } | { ok: false; error: CompatibilityRefusal }

/** Pure selector. The caller supplies authenticated policy; this function grants no permissions. */
export function selectContract(clientInput: CompatAdvertisement, serverInput: CompatAdvertisement, policy: ContractPolicy): ContractResult {
  let client: CompatAdvertisement | null = null, server: CompatAdvertisement | null = null
  const refuse = (code: CompatibilityRefusal['code'], change: RequiredChange, message: string, missingCapabilities: CapabilityVersions = {}): ContractResult => ({ ok: false, error: { code, side: change.side, text: message, requiredChanges: [change], missingCapabilities, supported: { client, server } } })
  try { client = parseAdvertisement(clientInput) } catch (e) { return refuse('invalid-advertisement', { side: 'client', action: 'update', contract: 'advertisement' }, `Update/restart the client with a valid bootstrap-1 advertisement: ${(e as Error).message}`) }
  try { server = parseAdvertisement(serverInput) } catch (e) { return refuse('invalid-advertisement', { side: 'server', action: 'update', contract: 'advertisement' }, `Update/restart the server with a valid bootstrap-1 advertisement: ${(e as Error).message}`) }
  if (!integer(policy.activeSchema)) return refuse('schema-incompatible', { side: 'room', action: 'configure', contract: 'schema', versions: server.schemas.read }, 'Configure the room with an implemented active schema; no migration is automatic')
  const schemaChanges: RequiredChange[] = []
  for (const [side, ad] of [['server', server], ['client', client]] as const) {
    if (!ad.schemas.read.includes(policy.activeSchema) || (!policy.readOnly && !ad.schemas.write.includes(policy.activeSchema))) schemaChanges.push({ side, action: 'update', contract: 'schema', versions: [policy.activeSchema] })
  }
  if (schemaChanges.length) return { ok: false, error: { code: 'schema-incompatible', side: schemaChanges[0].side, text: `Update/restart the ${schemaChanges.map(c => c.side).join(' and ')} to ${policy.readOnly ? 'read' : 'read and write'} document schema ${policy.activeSchema}`, requiredChanges: schemaChanges, missingCapabilities: {}, supported: { client, server } } }
  const min = Math.max(client.hub.min, server.hub.min), max = Math.min(client.hub.max, server.hub.max)
  if (min > max) {
    const side = client.hub.max < server.hub.min ? 'client' : 'server', target = side === 'client' ? server.hub : client.hub
    return refuse('hub-incompatible', { side, action: 'update', contract: 'hub', range: target }, `Update/restart the ${side} to support hub protocol ${target.min}–${target.max}`)
  }
  let roomRequired: CapabilityVersions
  try {
    bounded(policy.requiredCapabilities ?? {}, COMPAT_MAX_BYTES, 'room requirements')
    roomRequired = capabilities(policy.requiredCapabilities ?? {}, 'room requirements')
  } catch (e) { return refuse('invalid-advertisement', { side: 'room', action: 'configure', contract: 'advertisement' }, `Configure valid room requirements: ${(e as Error).message}`) }
  const requirements = [['client', client.requiredCapabilities ?? {}], ['server', server.requiredCapabilities ?? {}], ['room', roomRequired]] as const
  // Stop at the first unregistered requirement. In addition to being unactionable locally, an
  // arbitrary registry must not amplify a small offer into an unbounded list of refusal changes.
  for (const [owner, required] of requirements) for (const [name, set] of Object.entries(required)) {
    const registered = CAPABILITY_REGISTRY[name as CapabilityName]
    if (!registered || !set.some(v => registered.versions[v])) return refuse('capability-incompatible', { side: owner, action: owner === 'room' ? 'configure' : 'update', contract: 'capability', capability: name, versions: set }, `${owner === 'room' ? 'Configure the room requirements' : `Update/restart the ${owner}`} for required capability ${name} version ${set.join(' or ')}; this implementation has no registered version in that set`, { [name]: set })
  }
  let lastFailure: ContractResult | undefined
  // No unbounded expansion of advertised ranges. Only registered version boundaries can change feasibility.
  const candidates = new Set([max, min])
  for (const entry of Object.values(CAPABILITY_REGISTRY)) for (const version of Object.values(entry.versions)) {
    if (version.hub.max >= min && version.hub.max <= max) candidates.add(version.hub.max)
  }
  for (const hub of [...candidates].sort((a, b) => b - a)) {
    const selected: Record<string, number> = {}
    for (const [name, entry] of Object.entries(CAPABILITY_REGISTRY)) {
      const accepted = requirements.flatMap(([, required]) => required[name] ? [required[name]] : [])
      const common = (client.capabilities[name] ?? []).filter(v => server!.capabilities[name]?.includes(v) && accepted.every(set => set.includes(v)))
      for (const v of common.sort((a, b) => b - a)) {
        const rule = entry.versions[v]
        if (rule && hub >= rule.hub.min && hub <= rule.hub.max && rule.schemas.includes(policy.activeSchema)) { selected[name] = v; break }
      }
    }
    let removed: boolean
    do {
      removed = false
      for (const [name, v] of Object.entries(selected)) {
        const dependencies = CAPABILITY_REGISTRY[name as CapabilityName].versions[v].dependencies
        if (Object.entries(dependencies).some(([dep, set]) => !set.includes(selected[dep]))) { delete selected[name]; removed = true }
      }
    } while (removed)
    const changes: RequiredChange[] = [], missing: CapabilityVersions = {}
    for (const [owner, required] of requirements) for (const [name, set] of Object.entries(required)) {
      if (set.includes(selected[name])) continue
      const registered = CAPABILITY_REGISTRY[name as CapabilityName]
      const sides: CompatibilitySide[] = []
      if (!registered || !set.some(v => registered.versions[v])) sides.push(owner)
      else {
        if (!set.some(v => client!.capabilities[name]?.includes(v))) sides.push('client')
        if (!set.some(v => server!.capabilities[name]?.includes(v))) sides.push('server')
        if (!sides.length) sides.push(owner)
      }
      missing[name] = [...new Set([...(missing[name] ?? []), ...set])].sort((a, b) => a - b)
      for (const side of sides) {
        const change: RequiredChange = { side, action: side === 'room' ? 'configure' : 'update', contract: 'capability', capability: name, versions: set }
        if (!changes.some(c => JSON.stringify(c) === JSON.stringify(change))) changes.push(change)
      }
    }
    if (!changes.length) return { ok: true, selection: { bootstrap: 1, hub, schema: policy.activeSchema, capabilities: selected } }
    const guidance = changes.map(c => `${c.side === 'room' ? 'Configure the room' : `Update/restart the ${c.side}`} for ${c.capability} version ${c.versions!.join(' or ')}`)
    lastFailure = { ok: false, error: { code: 'capability-incompatible', side: changes[0].side, text: `${guidance.join('; ')}; required schema/protocol dependencies must also be supported`, requiredChanges: changes, missingCapabilities: missing, supported: { client, server } } }
  }
  return lastFailure!
}

/** Discovery recognition only. Transport security, learned floors and runtime policy remain mandatory. */
export function legacyAdvertisement(health: unknown): CompatAdvertisement | null {
  if (!health || typeof health !== 'object' || Array.isArray(health)) return null
  const h = health as Record<string, unknown>
  return h.ok === true && h.schema === 2 && h.hub === 1 && !Object.hasOwn(h, 'compat') ? baseline() : null
}
export function legacyHello(id: string, client: string, sessionId: string): { v: 1; id: string; op: 'hello'; proto: 1; schema: 2; client: string; sessionId: string } {
  return { v: 1, id, op: 'hello', proto: 1, schema: 2, client, sessionId }
}

export type BootstrapHello = { v: 1; op: 'compat-hello'; id: string; sessionId: string; offer: CompatAdvertisement }
export type BootstrapAck = { v: 1; op: 'compat-ack'; id: string; selectionId: string }
/** The transport emits this only after revalidation and attachment, before any Yjs frame. */
export type BootstrapAcked = { v: 1; re: string; ok: true }
export type BootstrapSelection = { v: 1; re: string; ok: true; selectionId: string; selection: ContractSelection; compat: CompatAdvertisement; generation: string; policyRevision: number; incarnation: number; ttlMs: number; renewMs: number; requiredCapabilities: CapabilityVersions }
export type BootstrapRefusal = { v: 1; re: string; ok: false; error: CompatibilityRefusal }
export type BootstrapFrame = BootstrapHello | BootstrapAck | BootstrapAcked | BootstrapSelection | BootstrapRefusal

/** Authenticate the full server advertisement separately, then validate its selected subset here. */
export function validateSelection(value: unknown, clientInput: CompatAdvertisement, serverInput: CompatAdvertisement, policy: Partial<ContractPolicy> = {}): ContractSelection {
  const s = object(value, 'selection')
  keys(s, ['bootstrap', 'hub', 'schema', 'capabilities'], 'selection')
  if (s.bootstrap !== 1 || !integer(s.hub) || !integer(s.schema)) invalid('invalid selected contract')
  if (policy.activeSchema !== undefined && policy.activeSchema !== s.schema) invalid('selection changed the active room schema')
  const caps = object(s.capabilities, 'selected capabilities')
  const offered = capabilities(Object.fromEntries(Object.entries(caps).map(([name, v]) => [name, [v]])), 'selected capabilities')
  const client = parseAdvertisement(clientInput), server = parseAdvertisement(serverInput)
  for (const [side, peer] of [['client', client], ['server', server]] as const) {
    if (s.hub < peer.hub.min || s.hub > peer.hub.max) invalid(`selection is outside the ${side} hub offer`)
    for (const [name, set] of Object.entries(offered)) if (!peer.capabilities[name]?.includes(set[0])) invalid(`selection is outside the ${side} capability offer: ${name}`)
  }
  // Pin only the chosen protocol/capabilities, preserving both sides' requirements and schema sets.
  const narrow = (peer: CompatAdvertisement): CompatAdvertisement => ({ ...peer, hub: { min: s.hub as number, max: s.hub as number }, capabilities: offered, legacy: undefined })
  const result = selectContract(narrow(client), narrow(server), { ...policy, activeSchema: s.schema })
  if (!result.ok) invalid(result.error.text)
  if (Object.keys(result.selection.capabilities).length !== Object.keys(offered).length) invalid('selection includes an unregistered capability or unsupported dependency')
  return result.selection
}

/** Shape validation occurs after decodeFrame; the transport bounds raw bytes before JSON parsing. */
export function parseBootstrapFrame(value: unknown): BootstrapFrame {
  bounded(value, BOOTSTRAP_MAX_BYTES, 'bootstrap frame')
  const f = object(value, 'bootstrap frame')
  if (f.v !== 1) invalid('bootstrap envelope must be v1')
  if (f.op === 'compat-hello') {
    keys(f, ['v', 'op', 'id', 'sessionId', 'offer'], 'hello')
    return { v: 1, op: 'compat-hello', id: text(f.id, 'id'), sessionId: text(f.sessionId, 'sessionId', BOOTSTRAP_SESSION_ID_MAX_LENGTH), offer: parseAdvertisement(f.offer) }
  }
  if (f.op === 'compat-ack') {
    keys(f, ['v', 'op', 'id', 'selectionId'], 'ack')
    return { v: 1, op: 'compat-ack', id: text(f.id, 'id'), selectionId: text(f.selectionId, 'selectionId') }
  }
  if (f.ok === true && !Object.hasOwn(f, 'selection')) {
    keys(f, ['v', 're', 'ok'], 'acknowledged')
    return { v: 1, re: text(f.re, 're'), ok: true }
  }
  if (f.ok === true) {
    keys(f, ['v', 're', 'ok', 'selectionId', 'selection', 'compat', 'generation', 'policyRevision', 'incarnation', 'ttlMs', 'renewMs', 'requiredCapabilities'], 'selection')
    const s = object(f.selection, 'selection'); keys(s, ['bootstrap', 'hub', 'schema', 'capabilities'], 'selection')
    if (s.bootstrap !== 1 || !integer(s.hub) || !integer(s.schema)) invalid('invalid selected contract')
    const caps = object(s.capabilities, 'selected capabilities'), selected: Record<string, number> = {}
    // Reuse name/count validation without treating a selected integer as a version set.
    capabilities(Object.fromEntries(Object.entries(caps).map(([name, v]) => [name, [v]])), 'selected capabilities')
    for (const [name, v] of Object.entries(caps)) selected[name] = v as number
    for (const key of ['policyRevision', 'incarnation', 'ttlMs', 'renewMs']) if (!Number.isSafeInteger(f[key]) || (f[key] as number) < (key.endsWith('Ms') ? 1 : 0)) invalid(`invalid ${key}`)
    return { v: 1, re: text(f.re, 're'), ok: true, selectionId: text(f.selectionId, 'selectionId'), selection: { bootstrap: 1, hub: s.hub, schema: s.schema, capabilities: selected }, compat: parseAdvertisement(f.compat), generation: text(f.generation, 'generation'), policyRevision: f.policyRevision as number, incarnation: f.incarnation as number, ttlMs: f.ttlMs as number, renewMs: f.renewMs as number, requiredCapabilities: capabilities(f.requiredCapabilities, 'requiredCapabilities') }
  }
  if (f.ok === false) {
    keys(f, ['v', 're', 'ok', 'error'], 'refusal')
    const e = object(f.error, 'refusal error')
    keys(e, ['code', 'side', 'text', 'requiredChanges', 'missingCapabilities', 'supported'], 'refusal error')
    if (!['invalid-advertisement', 'hub-incompatible', 'schema-incompatible', 'capability-incompatible'].includes(e.code as string) || !['client', 'server', 'room'].includes(e.side as string)) invalid('invalid refusal code or side')
    text(e.text, 'error text', 2048)
    if (!Array.isArray(e.requiredChanges) || !e.requiredChanges.length) invalid('missing required changes')
    capabilities(e.missingCapabilities, 'missingCapabilities')
    const supported = object(e.supported, 'supported')
    keys(supported, ['client', 'server'], 'supported')
    for (const side of ['client', 'server']) if (supported[side] !== null) parseAdvertisement(supported[side])
    for (const change of e.requiredChanges) {
      const c = object(change, 'required change')
      keys(c, ['side', 'action', 'contract', 'versions', 'range', 'capability'], 'required change')
      if (!['client', 'server', 'room'].includes(c.side as string) || !['update', 'configure'].includes(c.action as string) || !['advertisement', 'hub', 'schema', 'capability'].includes(c.contract as string)) invalid('invalid required change')
      if (c.versions !== undefined) versions(c.versions, 'required versions')
      if (c.range !== undefined) range(c.range, 'required range')
      if (c.capability !== undefined) capabilities({ [text(c.capability, 'capability', 64)]: [1] }, 'required capability')
    }
    return { v: 1, re: text(f.re, 're'), ok: false, error: e as unknown as CompatibilityRefusal }
  }
  return invalid('unknown bootstrap frame')
}
export function parseBootstrapHello(value: unknown): BootstrapHello {
  const f = parseBootstrapFrame(value)
  if (!('op' in f) || f.op !== 'compat-hello') invalid('expected bootstrap hello')
  return f
}
export function parseBootstrapAck(value: unknown): BootstrapAck {
  const f = parseBootstrapFrame(value)
  if (!('op' in f) || f.op !== 'compat-ack') invalid('expected bootstrap ack')
  return f
}

/** Maintainer decision 3: current plus three minor families back. This never retires an adapter. */
export const SUPPORTED_MINOR_RELEASES_BACK = 3
export const FIRST_SUPPORTED_RELEASE = '0.17.0'
export const MINIMUM_OVERLAP_DAYS = 90
export const BASELINE_FIXTURES = [
  { release: '0.17.0', commit: 'ec13dcd83f67895c622410e3d9e8f53b5c5cb7a2' },
  { release: '0.17.32', commit: '77bf1c448d6ce883b844443204c7c9c7306d0c4c' },
] as const
type Release = { major: number; minor: number; patch: number }
function release(value: string): Release {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (!m) invalid('support policy needs a stable release x.y.z')
  const [major, minor, patch] = m.slice(1).map(Number)
  if (![major, minor, patch].every(Number.isSafeInteger)) invalid('release component out of range')
  return { major, minor, patch }
}
/** Release tooling chooses/pins fixtures; this is not a runtime semver admission gate. */
export function supportWindow(currentRelease: string): { major: number; oldestMinor: number; newestMinor: number; minors: number[]; minimumOverlapDays: number; retirement: 'explicit' } {
  const current = release(currentRelease)
  const floor = current.major === 0 ? 17 : 0
  if (current.minor < floor) invalid('current release predates the stable 0.17 baseline')
  const oldestMinor = Math.max(floor, current.minor - SUPPORTED_MINOR_RELEASES_BACK)
  return { major: current.major, oldestMinor, newestMinor: current.minor, minors: Array.from({ length: current.minor - oldestMinor + 1 }, (_, i) => oldestMinor + i), minimumOverlapDays: MINIMUM_OVERLAP_DAYS, retirement: 'explicit' }
}
