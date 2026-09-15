/**
 * Room login credentials: one opaque session id per server, from GitHub device login.
 * ~/.config/room/credentials.json (0600); XDG_CONFIG_HOME honoured; ROOM_CREDENTIALS overrides the path.
 * The GitHub token itself never reaches this machine: the server holds it.
 */
import fs from 'node:fs'
import { resolveCredentialsPath } from './config.js'
import path from 'node:path'

let configuredPath: string | undefined
/** Set by resolveConfig consumers so credential storage follows the same precedence as other settings. */
export function configureCredentials(file?: string): void { configuredPath = file }

export interface Credential { session: string; login: string; at: number }
/** A login that was started but not yet confirmed; survives an MCP restart. Stored under "pending:<server>".
 *  GitHub device flow carries user_code + verification_uri; OIDC carries the authorize url. */
export interface PendingLogin { provider: 'github' | 'oidc'; device: string; expires_in: number; interval: number; startedAt: number; user_code?: string; verification_uri?: string; url?: string }
export function getPending(server: string): PendingLogin | undefined {
  const p = (loadCredentials() as Record<string, unknown>)[`pending:${serverKey(server)}`] as PendingLogin | undefined
  return p && Date.now() - p.startedAt < p.expires_in * 1000 ? p : undefined
}
export function setPending(server: string, p: PendingLogin | undefined): void {
  const all = loadCredentials() as Record<string, unknown>
  if (p) all[`pending:${serverKey(server)}`] = p; else delete all[`pending:${serverKey(server)}`]
  save(all as Record<string, Credential>)
}

export function credentialsPath(): string {
  return configuredPath ?? resolveCredentialsPath()
}

/** Servers are keyed by origin: "wss://host" (no path, no trailing slash). */
export function serverKey(server: string): string {
  try { const u = new URL(server); return `${u.protocol}//${u.host}` } catch { return server.replace(/\/+$/, '') }
}

export function loadCredentials(): Record<string, Credential> {
  try { return JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')) as Record<string, Credential> } catch { return {} }
}

function save(all: Record<string, Credential>): void {
  const file = credentialsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(all, null, 1) + '\n', { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* best effort */ }
}

export function getCredential(server: string): Credential | undefined { return loadCredentials()[serverKey(server)] }
export function setCredential(server: string, c: Credential): void { const all = loadCredentials(); all[serverKey(server)] = c; save(all) }
export function removeCredential(server: string): boolean {
  const all = loadCredentials(); const k = serverKey(server)
  if (!(k in all)) return false
  delete all[k]; save(all); return true
}
