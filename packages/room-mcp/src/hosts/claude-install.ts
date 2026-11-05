import path from 'node:path'
import os from 'node:os'
import type { HostAdapter, InstallEvidence } from './types.js'
import { defaultInstallIO, hookVersion, parseInstallListing, readInstallFile, type InstallIO, type InstalledPlugin } from './install-io.js'

function manifestVersion(root: string | undefined, io: Pick<InstallIO, 'readFile'>): string | undefined {
  const contents = readInstallFile(root && path.join(root, '.claude-plugin', 'plugin.json'), io)
  try { return (JSON.parse(contents ?? '') as { version?: string }).version } catch { return undefined }
}
export function claudePlugin(row: { version?: string; installPath?: string } | undefined, marketplaces: unknown, io: Pick<InstallIO, 'readFile'> = defaultInstallIO): InstalledPlugin | undefined {
  if (!row) return undefined
  const market = Array.isArray(marketplaces) ? marketplaces.find(m => m?.name === 'room') as { source?: string; path?: string; installLocation?: string } | undefined : undefined
  const root = market?.source?.toLowerCase() === 'directory' && (market.path || market.installLocation)
    ? path.join(market.path ?? market.installLocation!, 'plugins', 'room') : row.installPath
  return { version: manifestVersion(root, io), recordedVersion: row.version, root, cached: root === row.installPath }
}

export function leadClaudePluginDir(env: NodeJS.ProcessEnv = process.env, modulePath: string, installedPath?: string, io: Pick<InstallIO, 'readFile'> = defaultInstallIO): string | undefined {
  const root = env.CLAUDE_PLUGIN_ROOT || (path.basename(path.dirname(modulePath)) === 'server' ? path.dirname(path.dirname(modulePath)) : undefined)
  if (!root) return undefined
  const resolved = path.resolve(root)
  if (installedPath === undefined) {
    try {
      const file = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'installed_plugins.json')
      const installs = JSON.parse(io.readFile(file)) as { plugins?: { 'room@room'?: { installPath?: string }[] } }
      installedPath = installs.plugins?.['room@room']?.at(-1)?.installPath
    } catch { /* A development plugin may have no installed copy. */ }
  }
  return installedPath && path.resolve(installedPath) === resolved ? undefined : resolved
}

export function createClaudeInstall(io: InstallIO = defaultInstallIO) {
  const inspectInstall = async (): Promise<InstallEvidence & { record?: InstalledPlugin; hooks?: string }> => {
    const [json, marketsJson, version] = await Promise.all([
      io.command('claude', ['plugin', 'list', '--json']),
      io.command('claude', ['plugin', 'marketplace', 'list', '--json']),
      io.command('claude', ['--version']),
    ])
    const listing = parseInstallListing(json), marketplaces = parseInstallListing(marketsJson)
    const listed = Array.isArray(listing)
    const plugin = claudePlugin(listed ? listing.find(x => x?.id === 'room@room') : undefined, marketplaces, io)
    const hooks = readInstallFile(plugin?.root && path.join(plugin.root, 'hooks', 'common.mjs'), io)
    return {
      record: plugin, cli: json === undefined ? 'absent' : 'present', version,
      listing: listed ? 'ok' : 'unknown', plugin: plugin ? 'present' : listed ? 'absent' : 'unknown',
      bundleRoot: plugin?.root, loadedVersion: plugin?.version, recordedVersion: plugin?.recordedVersion,
      source: plugin ? plugin.cached ? 'cache' : 'directory' : undefined, cached: plugin?.cached,
      hooksRoot: plugin?.root, hooks, hooksVersion: hookVersion(hooks), hookTrust: 'not-applicable',
      remedies: ['claude plugin marketplace update room && claude plugin update room@room'],
    }
  }
  return { inspectInstall } satisfies Pick<HostAdapter, 'inspectInstall'>
}
