/**
 * Which room a clone joins, chosen by instruction and remembered per clone.
 *
 * Precedence: explicit `where` argument > ROOM_SERVER env > the choice remembered in the clone
 * (`<git common dir>/room-choice.json`) > local. Joining the team room from a clone that never
 * has is always an explicit instruction (argument or env), never inferred: that is the moment
 * uncommitted work becomes visible to the repo's room members.
 */
import fs from 'node:fs'
import path from 'node:path'
import { gitCommonDir } from '@room/roomd/local'
import { DEFAULT_SERVER, LOCAL, resolveServer } from './session.js'

export const CHOICE_FILE = 'room-choice.json'

export interface RoomChoice { where: string; at: number; by?: string; /** worktree paths already told that their work is visible to the team */ warned?: string[] }

export type ChoiceRule = 'argument' | 'env' | 'remembered' | 'default'

export interface ServerChoice {
  /** `local`, or a ws(s) server URL. */
  server: string
  /** What decided it. */
  rule: ChoiceRule
  /** The normalised `where` word: local | team | <url>. */
  where: string
}

/** "team"/"hosted" → the hosted server; "local" or empty → local; anything else is a server URL. */
export function normaliseWhere(where?: string): string | undefined {
  const w = where?.trim()
  if (!w) return undefined
  if (w === 'team' || w === 'hosted' || w === 'web' || w === 'shared') return 'team'
  if (w === LOCAL) return LOCAL
  return w
}

function serverFor(where: string): string {
  if (where === 'team') return DEFAULT_SERVER
  return resolveServer(where)
}

export async function choiceFile(dir: string): Promise<string> {
  return path.join(await gitCommonDir(dir), CHOICE_FILE)
}

export async function readChoice(dir: string): Promise<RoomChoice | undefined> {
  try {
    const c = JSON.parse(fs.readFileSync(await choiceFile(dir), 'utf8')) as RoomChoice
    return c && typeof c.where === 'string' ? c : undefined
  } catch { return undefined }
}

export async function writeChoice(dir: string, where: string, by?: string): Promise<RoomChoice> {
  where = where.replace(/\?.*$/, '') // never remember a token; it comes from ROOM_SERVER/ROOM_TOKEN at join time
  const prev = await readChoice(dir)
  const c: RoomChoice = { where, at: Date.now(), ...(by ? { by } : {}), ...(prev?.where === where && prev.warned?.length ? { warned: prev.warned } : {}) }
  const file = await choiceFile(dir)
  fs.writeFileSync(file, JSON.stringify(c) + '\n', { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* best effort */ }
  return c
}

/** Has this worktree been told its uncommitted work is visible to the team? Marks it told and says whether it was new. */
export async function markWarned(dir: string, worktree: string): Promise<boolean> {
  const c = await readChoice(dir)
  if (!c) return true
  const key = path.resolve(worktree)
  const warned = c.warned ?? []
  if (warned.includes(key)) return false
  try { const file = await choiceFile(dir); fs.writeFileSync(file, JSON.stringify({ ...c, warned: [...warned, key].slice(-50) }) + '\n', { mode: 0o600 }); fs.chmodSync(file, 0o600) } catch { /* best effort */ }
  return true
}

export async function clearChoice(dir: string): Promise<boolean> {
  try { fs.rmSync(await choiceFile(dir)); return true } catch { return false }
}

/** Decide the server for a join. `where` is the tool argument; `env` is ROOM_SERVER. */
export async function chooseServer(dir: string, where?: string, env?: string): Promise<ServerChoice> {
  const arg = normaliseWhere(where)
  if (arg) return { server: serverFor(arg), rule: 'argument', where: arg }
  const e = normaliseWhere(env)
  if (e) return { server: serverFor(e), rule: 'env', where: e }
  const remembered = await readChoice(dir).catch(() => undefined)
  if (remembered) {
    const w = normaliseWhere(remembered.where) ?? LOCAL
    return { server: serverFor(w), rule: 'remembered', where: w }
  }
  return { server: LOCAL, rule: 'default', where: LOCAL }
}

/** One word for humans: "local" or "team", else the URL. */
export function describeWhere(server: string): string {
  if (server === LOCAL) return 'local (this machine)'
  if (server === DEFAULT_SERVER) return `team (${DEFAULT_SERVER})`
  return `team (${server})`
}
