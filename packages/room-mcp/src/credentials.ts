/**
 * Room login credentials: one opaque session id per server, from GitHub device login.
 * ~/.config/room/credentials.json (0600); XDG_CONFIG_HOME honoured; ROOM_CREDENTIALS overrides the path.
 * The GitHub token itself never reaches this machine: the server holds it.
 *
 * Every operation takes the store file explicitly: a login or join captures it at entry, so a later
 * login with another store cannot redirect a pending approval. Only an absent file reads as empty;
 * any other read or parse failure is reported and the file is left as it is, since replacing it would
 * erase every other saved login. Writes replace the file atomically.
 */
import fs from 'node:fs'
import { resolveCredentialsPath } from './config.js'
import { writeAtomic } from './leases.js'

/** The default store from the environment (ROOM_CREDENTIALS, then XDG_CONFIG_HOME / ~/.config). */
export function credentialsPath(): string { return resolveCredentialsPath() }

export interface Credential { session: string; login: string; at: number }
/** A login that was started but not yet confirmed; survives an MCP restart. Stored under "pending:<server>".
 *  GitHub device flow carries user_code + verification_uri; OIDC carries the authorize url. */
export interface PendingLogin { provider: 'github' | 'oidc'; device: string; expires_in: number; interval: number; startedAt: number; user_code?: string; verification_uri?: string; url?: string }
type Store = Record<string, Credential | PendingLogin>

export function getPending(file: string, server: string): PendingLogin | undefined {
  const p = load(file)[`pending:${serverKey(server)}`] as PendingLogin | undefined
  return p && Date.now() - p.startedAt < p.expires_in * 1000 ? p : undefined
}
export function setPending(file: string, server: string, p: PendingLogin | undefined): void {
  const all = load(file), key = `pending:${serverKey(server)}`
  if (p) all[key] = p
  else if (key in all) delete all[key]
  else return
  writeAtomic(file, all)
}

/** Servers are keyed by origin: "wss://host" (no path, no trailing slash). */
function serverKey(server: string): string {
  try { const u = new URL(server); return `${u.protocol}//${u.host}` } catch { return server.replace(/\/+$/, '') }
}

function load(file: string): Store {
  let text: string
  try { text = fs.readFileSync(file, 'utf8') }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw unreadable(file, e)
  }
  let value: unknown
  try { value = JSON.parse(text) } catch (e) { throw unreadable(file, e) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unreadable(file, new Error('expected a JSON object'))
  return value as Store
}

function unreadable(file: string, cause: unknown): Error {
  const reason = cause instanceof SyntaxError ? `invalid JSON (${cause.message})` : cause instanceof Error ? cause.message : String(cause)
  return new Error(`cannot read saved Room logins in ${file}: ${reason}. The file was left unchanged; repair or move it aside, then log in again`, { cause })
}

export function getCredential(file: string, server: string): Credential | undefined { return load(file)[serverKey(server)] as Credential | undefined }
export function setCredential(file: string, server: string, c: Credential): void { const all = load(file); all[serverKey(server)] = c; writeAtomic(file, all) }
export function removeCredential(file: string, server: string): boolean {
  const all = load(file); const k = serverKey(server)
  if (!(k in all)) return false
  delete all[k]; writeAtomic(file, all); return true
}
