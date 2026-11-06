/** Shared positional host selection: hooks start at the host or one hook interpreter. */
import type { ProcessIdentity } from '@room/relay/leases'

const HOOK_INTERPRETER = /^(?:sh|bash|dash|zsh|fish|cmd|powershell|pwsh)(?:\.exe)?$/i
const identity = (value: any): value is ProcessIdentity => !!value && Number.isSafeInteger(value.pid) && value.pid > 0
  && typeof value.startTime === 'string' && typeof value.executable === 'string' && !!value.executable

export function sessionHostIdentity(record: { host?: string; chain?: unknown; hostPid?: unknown }): ProcessIdentity | undefined {
  if (record.chain !== undefined) {
    if (!Array.isArray(record.chain) || !identity(record.chain[0])) return undefined
    const first = record.chain[0]
    const host = HOOK_INTERPRETER.test(first.executable) ? record.chain[1] : first
    // A second interpreter is not a host: the host is unknown, never a short-lived hook shell whose exit means nothing.
    return identity(host) && !(host !== first && HOOK_INTERPRETER.test(host.executable)) ? host : undefined
  }
  return Number.isSafeInteger(record.hostPid) && Number(record.hostPid) > 0
    ? { pid: Number(record.hostPid), startTime: '', executable: '' } : undefined
}
