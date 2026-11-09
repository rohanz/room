import { daemonCutoverRows, inspectDaemonCutover } from './daemon-cutover.js'
import fs from 'node:fs'
import { compatibilityFromHealth } from './client-compat.js'
import { createSessionBinding } from './binding.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './config.js'
import { credentialsPath, getCredential } from './credentials.js'
import type { DeliveryHealth } from './wake-reconciler.js'
import { canonicalRelayWarning, cloneId, deterministicPort, legacyRelayRunning, readRelayInfo, relayFile, relayIdentity } from '@room/relay'
import { gitCommonDir } from '@room/roomd'
import { collectLocalState } from './local-state-gc.js'
import manifest from '../../../plugins/room/.claude-plugin/plugin.json' with { type: 'json' }

const minimumGit = [2, 31, 0] // git rev-parse --path-format=absolute
/** INFO states context that proves no problem; it never carries a fix. */
export type Result = { level: 'PASS' | 'INFO' | 'WARN' | 'FAIL'; name: string; finding: string; fix?: string }
import { hostDoctorRows, hostDoctorFacts, deliveryLimitation, type DoctorFacts } from './hosts/diagnostics.js'
/** Counts refer only to retained ledger entries. Handoff means host content, never model comprehension. */
export function formatDeliveryHealth(h?: DeliveryHealth): string {
  if (!h) return ''
  const status = h.path
  const mode = status ? `${status.mode}; ${status.transport} ${status.availability}` : 'transport unobserved'
  const state = h.state ? `; last state ${h.state.kind} (${h.state.source}${h.state.reason ? `: ${h.state.reason}` : ''})` : ''
  const attempt = h.attempt ? `${h.attempt.via} ${h.attempt.outcome} ${Math.max(0, Math.floor((Date.now() - h.attempt.at) / 1000))}s ago${h.attempt.fallback ? ` (${h.attempt.fallback})` : ''}` : 'none observed'
  const pending = `${h.pendingAddressed}${h.oldestPendingMs === undefined ? '' : ` (oldest ${Math.floor(h.oldestPendingMs / 1000)}s)`}`
  const limitation = deliveryLimitation(h.host)
  return [
    `${h.degraded || status?.availability === 'unavailable' ? 'WARN' : 'INFO'}  delivery: ${h.host}; ${mode}${state}${h.degraded ? `; ${h.degraded}` : ''}`,
    `INFO  delivery evidence: retained addressed ${h.retainedAddressed}${h.sampled ? ' (sample capped at 1000 entries)' : ''}; pending ${pending}; retained wake records: submitted ${h.wakeRecorded}, uncertain ${h.uncertainWakeRecorded} (pruned after handoff); content handed to host ${h.handedToHost}; answers from requested recipients ${h.answersRecorded}; last wake attempt ${attempt}`,
    `INFO  delivery limits: ${limitation}; wakes and handoffs do not prove reading or action`,
  ].join('\n')
}

export function formatDeliveryDegradation(reason?: DeliveryHealth['degraded']): string {
  return reason ? `WARN  delivery: ${reason}; pending content stays in Room (room_state check=true for details)` : ''
}

function triple(raw?: string): number[] | undefined {
  const match = raw?.match(/(?:^|\s|v)(\d+)\.(\d+)(?:\.(\d+))?/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined
}
function atLeast(raw: string | undefined, min: number[]): boolean {
  const got = triple(raw)
  if (!got) return false
  for (let i = 0; i < 3; i++) if (got[i] !== min[i]) return got[i] > min[i]
  return true
}
export function evaluateDoctor(f: DoctorFacts, version = manifest.version): Result[] {
  const rows: Result[] = []
  const add = (level: Result['level'], name: string, finding: string, fix?: string) => rows.push({ level, name, finding, fix })
  add(atLeast(f.node, [22, 0, 0]) ? 'PASS' : 'FAIL', 'Node', f.node ? `${f.node} (need 22+)` : 'not found', 'Install Node 22 or newer')
  add(atLeast(f.git, minimumGit) ? 'PASS' : 'FAIL', 'Git', f.git ? `${f.git} (need 2.31+)` : 'not found', 'Install Git 2.31 or newer')
  add(f.repo ? 'PASS' : 'FAIL', 'repository', f.repo ? 'Git checkout with a commit' : 'not a Git checkout with a commit', 'Run this from a committed Git checkout')
  rows.push(...hostDoctorRows(f, version))
  if (f.configError) add('FAIL', 'Room config', f.configError, 'Correct ROOM_SERVER or ROOM_URL, then retry')
  else if (f.server) {
    if (f.serverRedirect) add('WARN', 'team server', `server redirected /health (${f.serverRedirect}); check ROOM_SERVER`, 'Check ROOM_SERVER and server status')
    else if (!f.serverHealth) add('WARN', 'team server', '/health unavailable', 'Check ROOM_SERVER and server status')
    else if (f.serverStorage === 'failing') add('FAIL', 'team server', "the server's storage is failing", 'Check server storage before joining')
    // Without an advertisement the exact 0.17 baseline is the contract; a server reporting anything else predates it.
    else if (!('serverCompat' in f) && f.serverSchema === undefined) add('FAIL', 'team server', 'the server is older than Room 0.17; update the server to 0.17.0 or newer', 'Deploy Room 0.17 or newer on the server')
    else if (!('serverCompat' in f) && (f.serverSchema !== 2 || f.serverHub !== 1)) add('FAIL', 'team server', `the server reports schema ${f.serverSchema}, hub ${f.serverHub ?? 'missing'}; the supported contract without negotiation is schema 2, hub 1: update the server`, 'Deploy a compatible Room server')
    else {
      try {
        const profile = compatibilityFromHealth({ ok: true, schema: f.serverSchema, hub: f.serverHub, ...('serverCompat' in f ? { compat: f.serverCompat } : {}) })
        const ad = profile.offer
        add('PASS', 'team server', `hub ${ad.hub.min}${ad.hub.max === ad.hub.min ? '' : `–${ad.hub.max}`}; read schemas ${ad.schemas.read.join(',')}; write schemas ${ad.schemas.write.join(',')}; ${profile.legacy ? 'legacy adapter' : 'negotiating contract'}; storage healthy`)
      } catch (error) {
        add('FAIL', 'team server', error instanceof Error ? error.message : String(error), 'Update the affected Room client or server, then reconnect Room (/mcp) or restart the session')
      }
    }
    if (f.credentialError) add('FAIL', 'team login', f.credentialError, 'Repair or move aside the credentials file, then run room_login')
    else if (!f.credential && f.sharedToken) add('PASS', 'team login', 'shared token configured; login check does not apply')
    else if (!f.credential) add('WARN', 'team login', 'login missing', 'Run room_login')
    else if (f.credentialStatus === 'valid') add('PASS', 'team login', `logged in as ${f.credentialLogin}`)
    else if (f.credentialStatus === 'rejected' && f.serverSchema === 2 && f.serverHub === 1) add('FAIL', 'team login', 'saved credential was rejected; log in again (room_login)', 'Run room_login')
    else if (f.credentialStatus === 'rejected') add('WARN', 'team login', 'credential present; the server did not confirm it', 'Deploy Room 0.17, then retry room doctor')
    else add('WARN', 'team login', 'credential present (not verified)', 'Check server connection, then retry room doctor')
  } else add(f.relayFile ? f.relayHealth ? 'PASS' : 'WARN' : 'PASS', 'local relay', f.relayFile ? f.relayHealth ? 'discovery and /health OK' : 'discovery exists; /health unavailable' : 'not started yet', 'Join the local room to start its relay')
  if (f.unknownLocalState?.length) add('WARN', 'local state', `${f.unknownLocalState.length} unlisted entr${f.unknownLocalState.length === 1 ? 'y' : 'ies'} under the clone's room directory: ${f.unknownLocalState.slice(0, 5).join(', ')}${f.unknownLocalState.length > 5 ? ', …' : ''}`, 'Room never removes files its table does not name (docs/reference.md, Local state); remove them by hand if they are leftovers')
  if (f.hookCompatibility) add('WARN', 'hook delivery contract', f.hookCompatibility, 'Update the hook or reconnect Room (/mcp) or restart the session')
  if (f.legacyRelay) add('WARN', 'Room 0.16 session', 'a Room 0.16 local relay is still running in this clone', 'End Room 0.16 sessions here so 0.17 can take over (docs/upgrading.md)')
  if (f.canonicalRelayWarning) add('WARN', 'canonical relay', f.canonicalRelayWarning, 'Quit the older Room session or reconnect Room there')
  add(f.inSession ? f.stale ? 'WARN' : 'PASS' : 'PASS', 'running session', f.inSession ? f.stale ?? 'matches installed bundle' : 'n/a', 'Restart the host session or reconnect Room (/mcp)')
  return rows
}
export function formatDoctor(rows: Result[]): string {
  return rows.map(r => `${r.level}  ${r.name}: ${r.finding}${r.level !== 'PASS' && r.fix ? `\n      fix: ${r.fix}` : ''}`).join('\n')
}
/** Codex runs hooks from the marketplace root (a local path or its Git snapshot), not from the plugin cache. */
export async function probeHealth(url: string, fetcher: typeof fetch = fetch): Promise<{ ok: boolean; redirect?: string; schema?: number; hub?: number; storage?: string; compat?: unknown }> {
  try {
    const r = await fetcher(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' })
    if (!r.ok) return { ok: false, ...(r.status >= 300 && r.status < 400 ? { redirect: `HTTP ${r.status}` } : {}) }
    const body = await r.json() as { ok?: boolean; schema?: number; hub?: number; storage?: string; compat?: unknown }
    return { ok: body.ok === true, schema: body.schema, hub: body.hub, storage: body.storage, ...('compat' in body ? { compat: body.compat } : {}) }
  } catch { return { ok: false } }
}
export async function probeCredential(url: string, session: string, fetcher: typeof fetch = fetch): Promise<{ status: 'valid' | 'rejected' | 'unverified'; login?: string }> {
  try {
    const r = await fetcher(url, { headers: { Authorization: `Bearer ${session}` }, signal: AbortSignal.timeout(3000), redirect: 'manual' })
    if (r.status === 401) return { status: 'rejected' }
    if (!r.ok) return { status: 'unverified' }
    const body = await r.json() as { login?: string }
    return typeof body.login === 'string' && body.login ? { status: 'valid', login: body.login } : { status: 'unverified' }
  } catch { return { status: 'unverified' } }
}
/** A failed negotiation is local diagnostic state, scoped to the live endpoint; never a receipt. */
export function hookCompatibilityWarning(dir?: string): string | undefined {
  if (!dir) return undefined
  try {
    const parse = (name: string) => {
      const file = path.join(dir, name)
      if (fs.statSync(file).size > 4096) throw new Error('oversize hook endpoint diagnostic')
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    }
    const endpoint = parse('mcp.json'), status = parse('hook-compat.json')
    if (status.degraded && typeof endpoint.incarnation === 'string' && status.incarnation === endpoint.incarnation && status.pid === endpoint.pid)
      return 'Room hook and running MCP have no verified common contract; update the hook or reconnect Room (/mcp) or restart the session. Messages remain owed.'
  } catch { /* missing, stale or partially written diagnostic */ }
}

export interface DoctorDestination { server: string; token?: string; credentialsPath?: string }
async function collectDoctorFacts(dir: string, inSession = false, selected?: DoctorDestination): Promise<DoctorFacts> {
  const f = await hostDoctorFacts(dir, inSession, fileURLToPath(import.meta.url))
  try {
    const config = selected ?? await resolveConfig({ dir })
    if (config.server !== 'local') {
      f.server = config.server
      let session: string | undefined
      try { session = getCredential(config.credentialsPath ?? credentialsPath(), config.server)?.session }
      catch (error) { f.credentialError = error instanceof Error ? error.message : String(error) }
      f.credential = !!session
      f.sharedToken = !!config.token
      const u = new URL(config.server); u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'; u.pathname = '/health'; u.search = ''
      const health = await probeHealth(u.toString())
      f.serverHealth = health.ok
      f.serverRedirect = health.redirect
      f.serverSchema = health.schema
      f.serverHub = health.hub
      f.serverStorage = health.storage
      if ('compat' in health) f.serverCompat = health.compat
      if (session) {
        u.pathname = '/auth/me'
        const credential = await probeCredential(u.toString(), session)
        f.credentialStatus = credential.status
        f.credentialLogin = credential.login
      }
    } else if (f.repo) {
      const common = await gitCommonDir(dir)
      const info = readRelayInfo(common)
      f.legacyRelay = legacyRelayRunning(common)
      f.relayFile = info ? relayFile(common) : undefined
      if (info) f.relayHealth = (await probeHealth(`http://127.0.0.1:${info.port}/health`)).ok
      const port = deterministicPort(common)
      const identity = await relayIdentity(port, info?.key ?? '')
      if (identity && !(identity.proven && identity.health.clone === cloneId(common) && identity.health.schema === 2))
        f.canonicalRelayWarning = canonicalRelayWarning(port, common, identity, info).warning
    }
  } catch (error) { f.configError = error instanceof Error ? error.message : String(error) }
  f.hookCompatibility = hookCompatibilityWarning(createSessionBinding(dir).dir())
  if (f.repo) try { f.unknownLocalState = collectLocalState(await gitCommonDir(dir), { dryRun: true }).unknown } catch { /* unreadable state directory: nothing to report */ }
  return f
}
export interface DoctorOptions {
  /** Called from a running Room session (room_state check=true) rather than the CLI. */
  inSession?: boolean
  /** The joined room's destination; otherwise the directory's configuration is resolved. */
  selected?: DoctorDestination
  /** The session's canonical-relay warning, which replaces the probed one. */
  sessionWarning?: string
  /** Whether the session identified its host session; undefined when it has no binding. */
  sessionBound?: boolean
}
export async function runDoctor(dir: string, { inSession = false, selected, sessionWarning, sessionBound }: DoctorOptions = {}): Promise<string> {
  const facts = await collectDoctorFacts(dir, inSession, selected)
  if (sessionWarning) facts.canonicalRelayWarning = sessionWarning
  if (inSession && sessionBound !== undefined) facts.sessionBound = sessionBound
  const report = formatDoctor(evaluateDoctor(facts))
  if (!inSession && facts.repo && !facts.server) {
    try { return [report, ...daemonCutoverRows(await inspectDaemonCutover(await gitCommonDir(dir)))].join('\n') }
    catch (error) { return `${report}\nFAIL  local daemon cutover: ${error instanceof Error ? error.message : String(error)}` }
  }
  return report
}
