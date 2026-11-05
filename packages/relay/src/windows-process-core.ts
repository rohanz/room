/** Dependency-free Windows process table reader, shared by the relay and hooks (emitted as hooks/windows-process-core.mjs). */
import path from 'node:path'

export interface WindowsProcessRow { ppid: number; startTime?: string; executable?: string }

/** Windows uses case-insensitive executable basenames; only the terminal .exe suffix is removed. */
export function windowsProcessName(name: string): string {
  return path.win32.basename(name).toLowerCase().replace(/\.exe$/, '')
}

/** JSON projected by windowsProcessCommand; preserve all seven fractional birth digits. */
export function parseWindowsProcessTable(output: string): Map<number, WindowsProcessRow> {
  const table = new Map<number, WindowsProcessRow>()
  let parsed: unknown
  try { parsed = JSON.parse(output.replace(/^\uFEFF/, '').trim()) } catch { return table }
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!row || typeof row !== 'object') continue
    const { pid, ppid, creationDate, name } = row as Record<string, unknown>
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || !Number.isSafeInteger(ppid) || (ppid as number) < 0) continue
    let startTime: string | undefined
    if (typeof creationDate === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(creationDate)) {
      // Date.parse truncates precision and normalizes impossible days; validate without using it as the token.
      const millis = Date.parse(creationDate)
      if (Number.isFinite(millis) && new Date(millis).toISOString() === creationDate.slice(0, 23) + 'Z') startTime = `windows:${creationDate}`
    }
    const executable = typeof name === 'string' && name ? windowsProcessName(name) || undefined : undefined
    table.set(pid as number, { ppid: ppid as number, startTime, executable })
  }
  return table
}

/**
 * PowerShell arguments reading Win32_Process (one PID when given). WMI is queried through the built-in
 * [wmisearcher] type and the JSON is built by hand: Get-CimInstance and ConvertTo-Json auto-load modules, which
 * depends on PSModulePath and the module analysis cache and took 18-30 s per start without that cache (Windows CI,
 * 2026-11-06). CreationDate is the same WMI value Get-CimInstance converts, so the token format is unchanged.
 */
export function windowsProcessCommand(pid?: number): string[] | undefined {
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) return undefined
  const filter = pid === undefined ? '' : ` WHERE ProcessId = ${pid}`
  const script = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
    + `$searcher = [wmisearcher]'SELECT ProcessId, ParentProcessId, CreationDate, Name FROM Win32_Process${filter}'; `
    + '$rows = foreach ($p in $searcher.Get()) { '
    + '$c = if ($p.CreationDate) { \'"\' + [Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate).ToUniversalTime().ToString(\'o\', [Globalization.CultureInfo]::InvariantCulture) + \'"\' } else { \'null\' }; '
    + '$n = [regex]::Replace(([string]$p.Name).Replace(\'\\\', \'\\\\\').Replace(\'"\', \'\\"\'), \'[\\x00-\\x1f]\', { param($m) \'\\u{0:x4}\' -f [int][char]$m.Value }); '
    + "'{\"pid\":' + [int]$p.ProcessId + ',\"ppid\":' + [int]$p.ParentProcessId + ',\"creationDate\":' + $c + ',\"name\":\"' + $n + '\"}' }; "
    + "'[' + ($rows -join ',') + ']'"
  return ['-NoProfile', '-NonInteractive', '-Command', script]
}
