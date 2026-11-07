import { CURRENT_COMPAT, selectContract } from '@room/hub-core'
import { WORKER_RECORD_SCHEMA } from '@room/shared'
import pluginManifest from '../../../../plugins/room/.claude-plugin/plugin.json' with { type: 'json' }
import { installedCodexRoomContract, type WorkerContract } from './codex-install.js'
export function codexRoomCompatibilityMismatch(
  lead: WorkerContract = { release: pluginManifest.version, compat: CURRENT_COMPAT, workerRecordSchema: WORKER_RECORD_SCHEMA },
  installed: WorkerContract | undefined = undefined,
  diagnostic?: (line: string) => void,
): string | undefined {
  if (arguments.length < 2) installed = installedCodexRoomContract()
  if (!installed) return "Codex's installed Room executable contract is unverified; update Room for Codex, then reconnect Room with /mcp or restart the session before spawning a worker"
  const selected = selectContract(installed.compat, lead.compat, { activeSchema: 2 })
  if (selected.ok && installed.workerRecordSchema === lead.workerRecordSchema) {
    if (installed.release !== lead.release) diagnostic?.(`Codex Room ${installed.release} and lead Room ${lead.release} have compatible protocol and worker record contracts`)
    return undefined
  }
  const newer = installed.release.localeCompare(lead.release, undefined, { numeric: true }) > 0
  const reason = installed.workerRecordSchema !== lead.workerRecordSchema
    ? `worker record schemas differ (lead ${lead.workerRecordSchema}, Codex ${installed.workerRecordSchema})`
    : selected.ok ? '' : selected.error.text
  return `Codex has Room ${installed.release}, but this lead runs Room ${lead.release}: ${reason}; ${newer ? 'reconnect Room with /mcp or restart the session to load the installed Room contract' : 'update Room for Codex to a compatible protocol and worker record schema'}`
}

export function workerContractWarning(host: string, diagnostic?: (line: string) => void): string | undefined {
  if (host === 'codex' && (process.env.ROOM_HOST || process.env.CLAUDE_PLUGIN_ROOT)) return codexRoomCompatibilityMismatch(undefined, installedCodexRoomContract(), diagnostic)
}
