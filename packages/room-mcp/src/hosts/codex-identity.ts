import type { HostAdapter, IdentityResult, ProcessIdentity, Env } from './types.js'
import { matchingRecord } from './identity-records.js'

/** Strip the known Codex executable, including an unquoted path containing spaces. */
function codexArguments(parent: ProcessIdentity | undefined, commandLine: string): string | undefined {
  if (!parent) return undefined
  const known = parent.executable
  const name = known.split(/[/\\]/).at(-1)
  if (name !== 'codex' && name !== 'codex.exe') return undefined
  const raw = commandLine.trim()
  const after = (prefix: string): string | undefined => raw.startsWith(prefix) && (raw.length === prefix.length || /\s/.test(raw[prefix.length]))
    ? raw.slice(prefix.length).trimStart() : undefined
  for (const prefix of [known, `"${known}"`, `'${known}'`]) {
    const args = after(prefix)
    if (args !== undefined) return args
  }
  if (raw[0] === '"' || raw[0] === "'") {
    const end = raw.indexOf(raw[0], 1)
    if (end > 0 && raw.slice(1, end).split(/[/\\]/).at(-1) === name) return after(raw.slice(0, end + 1))
    return undefined
  }
  const direct = after(name)
  if (direct !== undefined) return direct
  for (const separator of ['/', '\\']) {
    let index = raw.indexOf(`${separator}${name}`)
    while (index >= 0) {
      const args = after(raw.slice(0, index + 1 + name.length))
      if (args !== undefined) return args
      index = raw.indexOf(`${separator}${name}`, index + 1)
    }
  }
  return undefined
}

// Each daemon thread owns its MCP process; every binding in that process shares this identity.
let codexThreadId: string | undefined
function admitCodexThread(id: string): void {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) return
  if (!codexThreadId) codexThreadId = id
  else if (id !== codexThreadId) {
    throw new Error('Room cannot share one MCP process across Codex chats (mcp_connection_sharing + mcp_2026_07_28); disable mcp_connection_sharing for Room, or wait for a Room release that supports pooling.')
  }
}
export function admittedCodexThread(): string | undefined { return codexThreadId }


export function isCodexExecWorker(env: Env = process.env): boolean {
  return !!env.ROOM_WORKER_ID && env.ROOM_WORKER_HOST === 'codex'
}
const CODEX_WORKER_BIND_WAIT_MS = 5_000
export const codexIdentity: Pick<HostAdapter, 'identify' | 'admitToolSession'> = {
  admitToolSession: admitCodexThread,
  identify(e) {
    const pending: IdentityResult = { kind: 'pending', reason: 'unbound', initialJoinWaitMs: isCodexExecWorker(e.env) ? CODEX_WORKER_BIND_WAIT_MS : 0 }
    const bound = (id: string, source: 'hook' | 'log' | 'tool', surface: 'interactive' | 'shared-app-server' | 'exec-worker'): IdentityResult =>
      ({ kind: 'bound', target: { host: 'codex', id, surface }, source })
    if (e.repositoryAvailable === false) return pending
    // Read records even when tool evidence wins, preserving reader errors and acceptance.
    const records = e.records
    if (e.workerId) {
      const record = matchingRecord(e, 'codex', records)
      if (record) return bound(record.session_id, 'hook', 'exec-worker')
      const id = e.logSessionId ?? e.toolSessionId ?? admittedCodexThread()
      return id ? bound(id, e.logSessionId != null ? 'log' : 'tool', 'exec-worker') : pending
    }
    const id = e.toolSessionId ?? admittedCodexThread()
    if (id) return bound(id, 'tool', 'shared-app-server')
    const args = codexArguments(e.parent, e.parentArgs ?? '')
    if (e.appServer || args?.match(/^\S+/)?.[0] === 'app-server' || args === undefined) return pending
    const record = matchingRecord(e, 'codex', records)
    return record ? bound(record.session_id, 'hook', 'interactive') : pending
  },
}
