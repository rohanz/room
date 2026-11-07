import path from 'node:path'
import type { Result } from '../doctor.js'
import type { WakePathStatus } from './wake-types.js'
import { wakePathStatus } from './wake.js'
import { claudeWakeAvailable } from './claude-wake.js'
import { createClaudeInstall } from './claude-install.js'
import { createCodexInstall, codexRoomHookTrustStatus } from './codex-install.js'
import { hookVersion, installCommand as command, type InstalledPlugin } from './install-io.js'
import { createStaleVersionWarning } from '../stale-version.js'
/** `cached`: Claude loads this plugin from the install record's cache path (not a directory marketplace). */
type Plugin = InstalledPlugin
export interface DoctorFacts {
  node?: string; git?: string; repo: boolean; claudeCli: boolean; codexCli: boolean
  claudeListOk?: boolean; codexListOk?: boolean
  claude?: Plugin; codex?: Plugin; claudeVersion?: string; codexTrust?: string
  claudeHooks?: string; codexHooks?: string; wakeBound?: boolean; wakeSession?: boolean
  /** The host running this Room session, when the check runs inside one. */
  sessionHost?: 'claude' | 'codex'
  /** Whether this MCP has identified its host session (binding.ts); false means no wake can be addressed. */
  sessionBound?: boolean
  deliveryPath?: WakePathStatus
  deliveryHost?: string
  server?: string; serverHealth?: boolean; serverRedirect?: string; serverSchema?: number; serverHub?: number; serverStorage?: string; serverCompat?: unknown
  credential?: boolean; credentialError?: string; sharedToken?: boolean; credentialStatus?: 'valid' | 'rejected' | 'unverified'; credentialLogin?: string
  hookCompatibility?: string; relayFile?: string; relayHealth?: boolean; legacyRelay?: boolean; canonicalRelayWarning?: string; configError?: string; stale?: string; inSession?: boolean
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
export function deliveryLimitation(host: string): string {
  return host === 'claude' ? 'socket/channel writes do not confirm acceptance; inbound hold/refuse may prevent receipt'
    : 'exec/--no-daemon and disconnected apps may need tool/hook handoff; no tool interruption'
}
export function hostDoctorRows(f: DoctorFacts, version: string): Result[] {
  const rows: Result[] = []
  const add = (level: Result['level'], name: string, finding: string, fix?: string) => rows.push({ level, name, finding, fix })
  const installed = [f.claude, f.codex].filter((p): p is Plugin => !!p)
  // "Not installed anywhere" needs evidence from every present CLI: a failed listing is not absence,
  // and a running Room session proves its host loaded Room (perhaps via --plugin-dir, which no list shows).
  const listed = (!f.claudeCli || f.claudeListOk !== false) && (!f.codexCli || f.codexListOk !== false)
  const absent = !installed.length && listed && !f.sessionHost
  if (absent) add('WARN', 'Room hosts', 'Room is not installed in Claude Code or Codex', 'Install room@room from rohanz/room')
  for (const [name, host, cli, listOk, plugin] of [['Claude Code', 'claude', f.claudeCli, f.claudeListOk, f.claude], ['Codex', 'codex', f.codexCli, f.codexListOk, f.codex]] as const) {
    if (!cli) { add('PASS', name, 'not installed'); continue }
    // Room ran the listing itself; a timeout or error proves nothing about the plugin and gives the
    // user no command to run. Say what went unchecked, and that this session's Room is still checked.
    if (listOk === false) {
      add('INFO', name, `plugin list did not answer within 2.5 s or failed; Room's version and hooks for ${name} were not checked${f.sessionHost === host ? " (this session's Room is checked under running session)" : ''}`)
      continue
    }
    if (!plugin) { add(absent ? 'WARN' : 'PASS', name, 'Room not installed', 'Install room@room from rohanz/room'); continue }
    const reinstall = name === 'Claude Code'
      ? 'claude plugin marketplace update room && claude plugin update room@room'
      : 'codex plugin marketplace upgrade room && codex plugin add room@room'
    const match = plugin.version === version
    add(match ? 'PASS' : 'FAIL', name, `loaded Room ${plugin.version ?? 'unknown'}; bundle ${version}${name === 'Claude Code' && plugin.cached === false ? ' (directory marketplace)' : ''}`, reinstall)
    // installed_plugins.json is bookkeeping. Claude loads a directory marketplace from its checkout, so a
    // stale record there changes nothing that runs and gets no row (a 2026-11-03 lead blamed a missing wake
    // on it). Only when Claude loads from the recorded cache path can the record disagree with what runs;
    // a mismatched cache manifest already fails the row above, so this covers a record that lags its cache.
    if (name === 'Claude Code' && match && plugin.cached && plugin.recordedVersion && plugin.recordedVersion !== version)
      add('WARN', 'Claude Code install record', `cache records Room ${plugin.recordedVersion}; its files are Room ${version}`, 'claude plugin update room@room')
    const stamp = hookVersion(name === 'Codex' ? f.codexHooks : f.claudeHooks)
    add(stamp === version ? 'PASS' : 'FAIL', `${name} hooks`, stamp ? `${stamp}; bundle ${version}` : 'version stamp missing', reinstall)
  }
  if (f.codex) {
    const trust = codexRoomHookTrustStatus(f.codexTrust)
    add(trust === 'trusted' ? 'PASS' : trust === 'modified' ? 'WARN' : 'FAIL', 'Codex hook trust', trust === 'trusted' ? 'Room hooks trusted' : trust === 'modified' ? 'Room hooks changed since trust was granted' : 'Room hooks not trusted', trust === 'modified' ? "Codex will ask to trust Room's hooks again; accept it (or /hooks)" : 'Open Codex and accept the hooks prompt, or trust them in /hooks')
  }
  if (f.claude) {
    const min = process.platform === 'win32' ? [2, 1, 234] : [2, 1, 224]
    // An unreadable version is missing evidence, not an old Claude Code.
    if (!triple(f.claudeVersion)) add('INFO', 'Claude wake', 'Claude Code version unknown; wake support not checked')
    else add(atLeast(f.claudeVersion, min) ? 'PASS' : 'WARN', 'Claude wake', `Claude Code ${f.claudeVersion}`, `Update Claude Code to ${min.join('.')} or newer`)
    if (f.wakeSession) {
      const disabled = f.deliveryPath?.mode === 'off'
      if (!disabled && f.sessionBound === false)
        add('WARN', 'Claude inbox', 'wake path configured but this session is not bound: nothing can wake it', 'Start Claude inside the git repository (git init first), then restart the session')
      else add(disabled || f.wakeBound ? 'PASS' : 'WARN', 'Claude inbox', disabled ? 'disabled (ROOM_WAKE=off); messages wait for tool/hook handoff' : f.wakeBound ? 'wake path configured' : 'wake path unavailable', disabled ? undefined : 'Check /status for a Peer address, or start claude-room')
    }
  }
  if (f.deliveryPath) {
    const p = f.deliveryPath
    // Configuration only: the Claude inbox row and the runtime delivery lines carry the evidence and the WARN.
    add('INFO', `${f.deliveryHost ?? 'Host'} delivery configuration`,
      `${p.mode}; ${p.transport} ${p.availability}; configuration only, no receipt evidence${f.deliveryHost === 'Claude' ? '; inbound hold/refuse may prevent receipt' : '; exec/--no-daemon require tool/hook fallback when host state is unknown'}`)
  }
  return rows
}
export async function hostDoctorFacts(dir: string, inSession: boolean, modulePath: string): Promise<DoctorFacts> {
  const [gitVersion, head, claudeInstall, codexInstall] = await Promise.all([
    command('git', ['--version']), command('git', ['-C', dir, 'rev-parse', '--verify', 'HEAD']),
    createClaudeInstall().inspectInstall(), createCodexInstall().inspectInstall(),
  ])
  const claude = claudeInstall.record, codex = codexInstall.record
  const f: DoctorFacts = {
    node: process.version, git: gitVersion, repo: !!head, claudeCli: claudeInstall.cli !== 'absent', codexCli: codexInstall.cli !== 'absent',
    claudeListOk: claudeInstall.listing === 'ok', codexListOk: codexInstall.listing === 'ok',
    claude, codex, claudeVersion: claudeInstall.version, inSession, wakeSession: inSession && process.env.ROOM_HOST === 'claude',
    wakeBound: claudeWakeAvailable({ host: 'claude' }),
    ...(inSession && (process.env.ROOM_HOST === 'codex' || process.env.ROOM_HOST === 'claude') ? {
      sessionHost: process.env.ROOM_HOST, deliveryPath: wakePathStatus({ host: process.env.ROOM_HOST }), deliveryHost: process.env.ROOM_HOST === 'claude' ? 'Claude' : 'Codex',
    } : {}),
    claudeHooks: claudeInstall.hooks,
    codexHooks: codexInstall.hooks,
    codexTrust: codexInstall.trust,
    stale: inSession ? createStaleVersionWarning(modulePath)() : undefined,
  }
  return f
}
