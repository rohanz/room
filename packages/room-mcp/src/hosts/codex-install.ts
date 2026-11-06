import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { parseAdvertisement, type CompatAdvertisement } from '@room/hub-core'
import type { HostAdapter, InstallEvidence } from './types.js'
import { defaultInstallIO, hookVersion, parseInstallListing, readInstallFile, type InstallIO, type InstalledPlugin } from './install-io.js'

export const CODEX_ROOM_HOOK_HASHES = {
  'pre_tool_use:0:0': 'sha256:e95920bb03a10f4f08fc98f3a10872e2c7b350d9fe54f05442bb2c8557bd11fb',
  'session_start:0:0': 'sha256:96fd593f780005aedd3d3796345ed66ef79f6b3751129aed8a120818ddf11d18',
} as const
/** Hash of the frozen hooks.json bytes for which Codex 0.158 produced the identities above. */
export const CODEX_ROOM_HOOKS_FILE_SHA256 = '336c0b90c935ff627f9988ceb92e21c887b44c9b6e904b2c2ddd9a188db4b777'
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
function manifestVersion(root: string | undefined, io: Pick<InstallIO, 'readFile'>): string | undefined {
  const contents = readInstallFile(root && path.join(root, '.codex-plugin', 'plugin.json'), io)
  try { return (JSON.parse(contents ?? '') as { version?: string }).version } catch { return undefined }
}
export function codexPlugin(row: { version?: string; marketplaceName?: string } | undefined, marketplaces: unknown, codexHome: string, io: Pick<InstallIO, 'readFile'> = defaultInstallIO): InstalledPlugin | undefined {
  if (!row) return undefined
  const root = row.version && path.join(codexHome, 'plugins', 'cache', 'room', 'room', row.version)
  return { version: manifestVersion(root, io), recordedVersion: row.version, root, hooksRoot: codexHooksRoot(marketplaces, row.marketplaceName, io) }
}
/** Codex runs hooks from the marketplace root (a local path or its Git snapshot), not from the plugin cache. */
export function codexHooksRoot(marketplaces: unknown, name: string | undefined, io: Pick<InstallIO, 'readFile'> = defaultInstallIO): string | undefined {
  const root = (marketplaces as { marketplaces?: { name?: string; root?: string }[] } | undefined)?.marketplaces?.find(m => m?.name === name)?.root
  if (!root) return undefined
  let entry: string | undefined
  try {
    const listing = JSON.parse(io.readFile(path.join(root, '.agents', 'plugins', 'marketplace.json'))) as { plugins?: { name?: string; source?: { path?: string } }[] }
    entry = listing.plugins?.find(p => p?.name === 'room')?.source?.path
  } catch { /* an older marketplace layout */ }
  return path.resolve(root, entry ?? path.join('plugins', 'room'))
}
export interface WorkerContract { release: string; compat: CompatAdvertisement; workerRecordSchema: number }

/** Resolve the installed entry selected by Codex, then authenticate its descriptor against its executable. */
export function installedCodexRoomContract(env: NodeJS.ProcessEnv = process.env): WorkerContract | undefined {
  try {
    const listing = JSON.parse(execFileSync('codex', ['plugin', 'list', '--json'], { env, encoding: 'utf8', timeout: 2500, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })) as { installed?: { pluginId?: string; version?: string; enabled?: boolean }[] }
    const entries = listing.installed?.filter(row => row.pluginId === 'room@room' && row.enabled !== false)
    if (entries?.length !== 1 || !entries[0].version || !/^[A-Za-z0-9.+_-]+$/.test(entries[0].version)) return undefined
    const root = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'plugins', 'cache', 'room', 'room', entries[0].version, 'server')
    if (fs.statSync(path.join(root, 'compat.json')).size > 4096 || fs.statSync(path.join(root, 'room-mcp.mjs')).size > 64 * 1024 * 1024) return undefined
    const raw = fs.readFileSync(path.join(root, 'compat.json'), 'utf8')
    const descriptor = JSON.parse(raw)
    if (![1, 2].includes(descriptor.v) || descriptor.release !== entries[0].version || (!Number.isSafeInteger(descriptor.workerRecordSchema) || descriptor.workerRecordSchema < 1) || !verifyBundleDigests(root, descriptor)) return undefined
    return { release: descriptor.release, compat: parseAdvertisement(descriptor.compat), workerRecordSchema: descriptor.workerRecordSchema }
  } catch { return undefined }
}

/** Doctor intentionally uses its own permissive first-row listing evidence. Contract verification above
 * requires exactly one enabled selected executable; these readers must not be unified. */
function decodeCodexDoctorListing(listing: unknown): { listed: boolean; row?: { version?: string; marketplaceName?: string } } {
  const installed = (listing as { installed?: unknown[] } | undefined)?.installed
  return { listed: Array.isArray(installed), row: installed?.find((x: any) => x?.pluginId === 'room@room') as any }
}
export function createCodexInstall(env: NodeJS.ProcessEnv = process.env, io: InstallIO = defaultInstallIO) {
  const inspectInstall = async (): Promise<InstallEvidence & { record?: InstalledPlugin; hooks?: string; trust?: string }> => {
    const [json, marketsJson] = await Promise.all([
      io.command('codex', ['plugin', 'list', '--json']),
      io.command('codex', ['plugin', 'marketplace', 'list', '--json']),
    ])
    const { listed, row } = decodeCodexDoctorListing(parseInstallListing(json))
    const plugin = codexPlugin(row, parseInstallListing(marketsJson), env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), io)
    const hooks = readInstallFile(plugin?.hooksRoot && path.join(plugin.hooksRoot, 'hooks', 'common.mjs'), io)
    const trust = readInstallFile(path.join(env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml'), io)
    return {
      record: plugin, cli: json === undefined ? 'absent' : 'present', listing: listed ? 'ok' : 'unknown',
      plugin: plugin ? 'present' : listed ? 'absent' : 'unknown',
      bundleRoot: plugin?.root, hooksRoot: plugin?.hooksRoot, loadedVersion: plugin?.version, recordedVersion: plugin?.recordedVersion,
      hooks, hooksVersion: hookVersion(hooks), trust, hookTrust: codexRoomHookTrustStatus(trust),
      remedies: ['codex plugin marketplace upgrade room && codex plugin add room@room'],
    }
  }
  return { inspectInstall } satisfies Pick<HostAdapter, 'inspectInstall'>
}

/** v1 pins retain their historical single-file layout; v2 must cover every emitted executable. */
export const EXECUTABLE_BUNDLES = ['room-mcp.mjs', 'room-mcp-app.mjs', 'room-daemon.mjs', 'room-daemon-app.mjs', 'room-state.mjs', 'room-state-app.mjs', 'parse-worker.mjs', 'gate-worker.mjs'] as const
export function verifyBundleDigests(root: string, descriptor: { v: number; bundleSha256: unknown }): boolean {
  const digest = (name: string) => {
    const file = path.join(root, name)
    if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('executable exceeds bundle limit')
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  }
  try {
    if (descriptor.v === 1) return !EXECUTABLE_BUNDLES.filter(name => name.endsWith('-app.mjs')).some(name => fs.existsSync(path.join(root, name))) && descriptor.bundleSha256 === digest('room-mcp.mjs')
    const hashes = descriptor.bundleSha256
    if (descriptor.v !== 2 || !hashes || typeof hashes !== 'object' || Array.isArray(hashes)
      || Object.keys(hashes).length !== EXECUTABLE_BUNDLES.length) return false
    return EXECUTABLE_BUNDLES.every(name => (hashes as Record<string, unknown>)[name] === digest(name))
  } catch { return false }
}
