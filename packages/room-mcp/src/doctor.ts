import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './config.js'
import { getCredential, configureCredentials } from './credentials.js'
import { createStaleVersionWarning } from './stale-version.js'
import { claudeWakeAvailable } from './wake-path.js'
import { canonicalRelayWarning, cloneId, deterministicPort, legacyRelayRunning, readRelayInfo, relayFile, relayIdentity } from '@room/relay'
import { gitCommonDir } from '@room/roomd'
import manifest from '../../../plugins/room/.claude-plugin/plugin.json' with { type: 'json' }

const exec = promisify(execFile)
const minimumGit = [2, 31, 0] // git rev-parse --path-format=absolute
export const CODEX_ROOM_HOOK_HASHES = {
  'pre_tool_use:0:0': 'sha256:e95920bb03a10f4f08fc98f3a10872e2c7b350d9fe54f05442bb2c8557bd11fb',
  'session_start:0:0': 'sha256:96fd593f780005aedd3d3796345ed66ef79f6b3751129aed8a120818ddf11d18',
} as const
/** Hash of the frozen hooks.json bytes for which Codex 0.158 produced the identities above. */
export const CODEX_ROOM_HOOKS_FILE_SHA256 = '336c0b90c935ff627f9988ceb92e21c887b44c9b6e904b2c2ddd9a188db4b777'
type Result = { level: 'PASS' | 'WARN' | 'FAIL'; name: string; finding: string; fix?: string }
type Plugin = { version?: string; recordedVersion?: string; root?: string; hooksRoot?: string }
export interface DoctorFacts {
  node?: string; git?: string; repo: boolean; claudeCli: boolean; codexCli: boolean
  claudeListOk?: boolean; codexListOk?: boolean
  claude?: Plugin; codex?: Plugin; claudeVersion?: string; codexTrust?: string
  claudeHooks?: string; codexHooks?: string; wakeBound?: boolean; wakeSession?: boolean
  server?: string; serverHealth?: boolean; serverRedirect?: string; serverSchema?: number; serverHub?: number; serverStorage?: string
  credential?: boolean; sharedToken?: boolean; credentialStatus?: 'valid' | 'rejected' | 'unverified'; credentialLogin?: string
  relayFile?: string; relayHealth?: boolean; legacyRelay?: boolean; canonicalRelayWarning?: string; configError?: string; stale?: string; inSession?: boolean
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
export function hookVersion(text?: string): string | undefined { return text?.match(/export const HOOKS_VERSION = ['"]([^'"]+)['"]/)?.[1] }
export function codexRoomHooksTrusted(toml?: string): boolean {
  return codexRoomHookTrustStatus(toml) === 'trusted'
}
export function codexRoomHookTrustStatus(toml?: string): 'trusted' | 'modified' | 'absent' {
  if (!toml) return 'absent'
  const sections = [...toml.matchAll(/^\[hooks\.state\."room@room:hooks\.json:([^"\]]+)"\]([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)]
  const hashes = Object.entries(CODEX_ROOM_HOOK_HASHES).map(([kind, expected]) => {
    const body = sections.find(m => m[1] === kind)?.[2]
    return { expected, stored: body?.match(/^trusted_hash\s*=\s*"(sha256:[a-f\d]{64})"/m)?.[1] }
  })
  if (hashes.some(h => !h.stored)) return 'absent'
  return hashes.every(h => h.stored === h.expected) ? 'trusted' : 'modified'
}
export function evaluateDoctor(f: DoctorFacts, version = manifest.version): Result[] {
  const rows: Result[] = []
  const add = (level: Result['level'], name: string, finding: string, fix?: string) => rows.push({ level, name, finding, fix })
  add(atLeast(f.node, [22, 0, 0]) ? 'PASS' : 'FAIL', 'Node', f.node ? `${f.node} (need 22+)` : 'not found', 'Install Node 22 or newer')
  add(atLeast(f.git, minimumGit) ? 'PASS' : 'FAIL', 'Git', f.git ? `${f.git} (need 2.31+)` : 'not found', 'Install Git 2.31 or newer')
  add(f.repo ? 'PASS' : 'FAIL', 'repository', f.repo ? 'Git checkout with a commit' : 'not a Git checkout with a commit', 'Run this from a committed Git checkout')
  const installed = [f.claude, f.codex].filter((p): p is Plugin => !!p)
  if (!installed.length) add('WARN', 'Room hosts', 'Room is not installed in Claude Code or Codex', 'Install room@room from rohanz/room')
  for (const [name, cli, listOk, plugin] of [['Claude Code', f.claudeCli, f.claudeListOk, f.claude], ['Codex', f.codexCli, f.codexListOk, f.codex]] as const) {
    if (!cli) { add('PASS', name, 'not installed'); continue }
    if (listOk === false) { add('WARN', name, 'plugin list unavailable', `Retry ${name} plugin list --json`); continue }
    if (!plugin) { add(installed.length ? 'PASS' : 'WARN', name, 'Room not installed', 'Install room@room from rohanz/room'); continue }
    const reinstall = name === 'Claude Code'
      ? 'claude plugin marketplace update room && claude plugin update room@room'
      : 'codex plugin marketplace upgrade room && codex plugin add room@room'
    const match = plugin.version === version
    add(match ? 'PASS' : 'FAIL', name, `loaded Room ${plugin.version ?? 'unknown'}; bundle ${version}`, reinstall)
    if (name === 'Claude Code' && match && plugin.recordedVersion && plugin.recordedVersion !== version)
      add('WARN', 'Claude Code install record', `records Room ${plugin.recordedVersion}; loaded Room ${version}`, 'claude plugin update room@room')
    const stamp = hookVersion(name === 'Codex' ? f.codexHooks : f.claudeHooks)
    add(stamp === version ? 'PASS' : 'FAIL', `${name} hooks`, stamp ? `${stamp}; bundle ${version}` : 'version stamp missing', reinstall)
  }
  if (f.codex) {
    const trust = codexRoomHookTrustStatus(f.codexTrust)
    add(trust === 'trusted' ? 'PASS' : trust === 'modified' ? 'WARN' : 'FAIL', 'Codex hook trust', trust === 'trusted' ? 'Room hooks trusted' : trust === 'modified' ? 'Room hooks changed since trust was granted' : 'Room hooks not trusted', trust === 'modified' ? "Codex will ask to trust Room's hooks again; accept it (or /hooks)" : 'Open Codex and accept the hooks prompt, or trust them in /hooks')
  }
  if (f.claude) {
    const min = process.platform === 'win32' ? [2, 1, 234] : [2, 1, 224]
    add(atLeast(f.claudeVersion, min) ? 'PASS' : 'WARN', 'Claude wake', f.claudeVersion ? `Claude Code ${f.claudeVersion}` : 'version unknown', `Update Claude Code to ${min.join('.')} or newer`)
    if (f.wakeSession) add(f.wakeBound ? 'PASS' : 'WARN', 'Claude inbox', f.wakeBound ? 'wake path bound' : 'wake path unavailable', 'Check /status for a Peer address, or start claude-room')
  }
  if (f.configError) add('FAIL', 'Room config', f.configError, 'Correct ROOM_SERVER or ROOM_URL, then retry')
  else if (f.server) {
    if (f.serverRedirect) add('WARN', 'team server', `server redirected /health (${f.serverRedirect}); check ROOM_SERVER`, 'Check ROOM_SERVER and server status')
    else if (!f.serverHealth) add('WARN', 'team server', '/health unavailable', 'Check ROOM_SERVER and server status')
    else if (f.serverStorage === 'failing') add('FAIL', 'team server', "the server's storage is failing", 'Check server storage before joining')
    else if (f.serverSchema === undefined) add('FAIL', 'team server', 'the server is older than Room 0.17: deploy 0.17', 'Deploy Room 0.17 on the server')
    else if (f.serverSchema !== 2 || f.serverHub !== 1) add('FAIL', 'team server', `server schema ${f.serverSchema}, hub ${f.serverHub ?? 'missing'}; need schema 2, hub 1`, 'Deploy a compatible Room 0.17 server')
    else add('PASS', 'team server', 'schema 2, hub 1; storage healthy')
    if (!f.credential && f.sharedToken) add('PASS', 'team login', 'shared token configured; login check does not apply')
    else if (!f.credential) add('WARN', 'team login', 'login missing', 'Run room_login')
    else if (f.credentialStatus === 'valid') add('PASS', 'team login', `logged in as ${f.credentialLogin}`)
    else if (f.credentialStatus === 'rejected' && f.serverSchema === 2 && f.serverHub === 1) add('FAIL', 'team login', 'saved credential was rejected; log in again (room_login)', 'Run room_login')
    else if (f.credentialStatus === 'rejected') add('WARN', 'team login', 'credential present; the server did not confirm it', 'Deploy Room 0.17, then retry room doctor')
    else add('WARN', 'team login', 'credential present (not verified)', 'Check server connection, then retry room doctor')
  } else add(f.relayFile ? f.relayHealth ? 'PASS' : 'WARN' : 'PASS', 'local relay', f.relayFile ? f.relayHealth ? 'discovery and /health OK' : 'discovery exists; /health unavailable' : 'not started yet', 'Join the local room to start its relay')
  if (f.legacyRelay) add('WARN', 'Room 0.16 session', 'a Room 0.16 local relay is still running in this clone', 'End Room 0.16 sessions here so 0.17 can take over (docs/upgrading.md)')
  if (f.canonicalRelayWarning) add('WARN', 'canonical relay', f.canonicalRelayWarning, 'Quit the older Room session or reconnect Room there')
  add(f.inSession ? f.stale ? 'WARN' : 'PASS' : 'PASS', 'running session', f.inSession ? f.stale ?? 'matches installed bundle' : 'n/a', 'Restart the host session or reconnect Room (/mcp)')
  return rows
}
export function formatDoctor(rows: Result[]): string {
  return rows.map(r => `${r.level}  ${r.name}: ${r.finding}${r.level !== 'PASS' && r.fix ? `\n      fix: ${r.fix}` : ''}`).join('\n')
}
async function command(file: string, args: string[]): Promise<string | undefined> {
  try { return (await exec(file, args, { timeout: 2500, maxBuffer: 256 * 1024 })).stdout.trim() }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : '' }
}
function read(file?: string): string | undefined { try { return file ? fs.readFileSync(file, 'utf8') : undefined } catch { return undefined } }
function manifestVersion(root: string | undefined, host: 'claude' | 'codex'): string | undefined {
  const contents = read(root && path.join(root, host === 'claude' ? '.claude-plugin' : '.codex-plugin', 'plugin.json'))
  try { return (JSON.parse(contents ?? '') as { version?: string }).version } catch { return undefined }
}
export function claudePlugin(row: { version?: string; installPath?: string } | undefined, marketplaces: unknown): Plugin | undefined {
  if (!row) return undefined
  const market = Array.isArray(marketplaces) ? marketplaces.find(m => m?.name === 'room') as { source?: string; path?: string; installLocation?: string } | undefined : undefined
  const root = market?.source?.toLowerCase() === 'directory' && (market.path || market.installLocation)
    ? path.join(market.path ?? market.installLocation!, 'plugins', 'room') : row.installPath
  return { version: manifestVersion(root, 'claude'), recordedVersion: row.version, root }
}
export function codexPlugin(row: { version?: string; marketplaceName?: string } | undefined, marketplaces: unknown, codexHome: string): Plugin | undefined {
  if (!row) return undefined
  const root = row.version && path.join(codexHome, 'plugins', 'cache', 'room', 'room', row.version)
  return { version: manifestVersion(root, 'codex'), recordedVersion: row.version, root, hooksRoot: codexHooksRoot(marketplaces, row.marketplaceName) }
}
/** Codex runs hooks from the marketplace root (a local path or its Git snapshot), not from the plugin cache. */
export function codexHooksRoot(marketplaces: unknown, name: string | undefined): string | undefined {
  const root = (marketplaces as { marketplaces?: { name?: string; root?: string }[] } | undefined)?.marketplaces?.find(m => m?.name === name)?.root
  if (!root) return undefined
  let entry: string | undefined
  try {
    const listing = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'plugins', 'marketplace.json'), 'utf8')) as { plugins?: { name?: string; source?: { path?: string } }[] }
    entry = listing.plugins?.find(p => p?.name === 'room')?.source?.path
  } catch { /* an older marketplace layout */ }
  return path.resolve(root, entry ?? path.join('plugins', 'room'))
}
export async function probeHealth(url: string, fetcher: typeof fetch = fetch): Promise<{ ok: boolean; redirect?: string; schema?: number; hub?: number; storage?: string }> {
  try {
    const r = await fetcher(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' })
    if (!r.ok) return { ok: false, ...(r.status >= 300 && r.status < 400 ? { redirect: `HTTP ${r.status}` } : {}) }
    const body = await r.json() as { ok?: boolean; schema?: number; hub?: number; storage?: string }
    return { ok: body.ok === true, schema: body.schema, hub: body.hub, storage: body.storage }
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
export interface DoctorDestination { server: string; token?: string; credentialsPath?: string }
async function collectDoctorFacts(dir: string, inSession = false, selected?: DoctorDestination): Promise<DoctorFacts> {
  const [gitVersion, head, claudeJson, claudeMarketsJson, codexJson, codexMarketsJson, claudeVersion] = await Promise.all([
    command('git', ['--version']), command('git', ['-C', dir, 'rev-parse', '--verify', 'HEAD']),
    command('claude', ['plugin', 'list', '--json']), command('claude', ['plugin', 'marketplace', 'list', '--json']), command('codex', ['plugin', 'list', '--json']),
    command('codex', ['plugin', 'marketplace', 'list', '--json']), command('claude', ['--version']),
  ])
  let claudeList: unknown, claudeMarkets: unknown, codexList: unknown, codexMarkets: unknown
  try { claudeList = JSON.parse(claudeJson ?? '') } catch { /* CLI unavailable */ }
  try { claudeMarkets = JSON.parse(claudeMarketsJson ?? '') } catch { /* CLI unavailable */ }
  try { codexList = JSON.parse(codexJson ?? '') } catch { /* CLI unavailable */ }
  try { codexMarkets = JSON.parse(codexMarketsJson ?? '') } catch { /* CLI unavailable */ }
  const claudeRow = Array.isArray(claudeList) ? claudeList.find(x => x?.id === 'room@room') : undefined
  const codexRow = (codexList as { installed?: unknown[] } | undefined)?.installed?.find((x: any) => x?.pluginId === 'room@room') as any
  const claude = claudePlugin(claudeRow, claudeMarkets)
  const codex = codexPlugin(codexRow, codexMarkets, process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'))
  const f: DoctorFacts = {
    node: process.version, git: gitVersion, repo: !!head, claudeCli: claudeJson !== undefined, codexCli: codexJson !== undefined,
    claudeListOk: Array.isArray(claudeList), codexListOk: Array.isArray((codexList as { installed?: unknown[] } | undefined)?.installed),
    claude, codex, claudeVersion, inSession, wakeSession: inSession && process.env.ROOM_HOST === 'claude',
    wakeBound: claudeWakeAvailable({ host: 'claude' }),
    claudeHooks: read(claude?.root && path.join(claude.root, 'hooks', 'common.mjs')),
    codexHooks: read(codex?.hooksRoot && path.join(codex.hooksRoot, 'hooks', 'common.mjs')),
    codexTrust: read(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml')),
    stale: inSession ? createStaleVersionWarning(fileURLToPath(import.meta.url))() : undefined,
  }
  try {
    const config = selected ?? await resolveConfig({ dir })
    if (config.server !== 'local') {
      f.server = config.server
      configureCredentials(config.credentialsPath)
      const session = getCredential(config.server)?.session
      f.credential = !!session
      f.sharedToken = !!config.token
      const u = new URL(config.server); u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'; u.pathname = '/health'; u.search = ''
      const health = await probeHealth(u.toString())
      f.serverHealth = health.ok
      f.serverRedirect = health.redirect
      f.serverSchema = health.schema
      f.serverHub = health.hub
      f.serverStorage = health.storage
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
  return f
}
export async function runDoctor(dir: string, inSession = false, selected?: DoctorDestination, sessionWarning?: string): Promise<string> {
  const facts = await collectDoctorFacts(dir, inSession, selected)
  if (sessionWarning) facts.canonicalRelayWarning = sessionWarning
  return formatDoctor(evaluateDoctor(facts))
}
