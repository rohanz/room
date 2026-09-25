/**
 * Which room a clone joins, chosen by instruction and remembered per clone.
 *
 * Precedence: explicit `where` argument > ROOM_SERVER/ROOM_URL env > the choice remembered in the clone
 * (`<git common dir>/room-choice.json`) > local. Joining the team room from a clone that never
 * has is always an explicit instruction (argument or env), never inferred: that is the moment
 * uncommitted work becomes visible to the repo's room members.
 */
import fs from 'node:fs'
import path from 'node:path'
import { git } from '@room/roomd/git'
import { gitCommonDir } from '@room/roomd/local'
import type { ShareLevel } from '@room/roomd'
import { DEFAULT_SERVER, LOCAL, normaliseWhere } from './config.js'
import { acquireOwnedFile } from './owned-file.js'

export const CHOICE_FILE = 'room-choice.json'

export interface RoomChoice { where: string; at: number; by?: string; share?: ShareLevel; /** Explicit local room selected by room_join; absent in older choices. */ room?: string; /** Auto-selected labels keyed by canonical worktree root; empty means the bare login. */ tags?: Record<string, string>; /** worktree/destination keys already told what they share */ warned?: string[]; /** most recently disclosed level for each warning key */ warnedLevels?: Record<string, ShareLevel> }

/** "team"/"hosted" → the hosted server; "local" or empty → local; anything else is a server URL. */
export { normaliseWhere }

export async function choiceFile(dir: string): Promise<string> {
  return path.join(await gitCommonDir(dir), CHOICE_FILE)
}

/** Canonical top-level directory, even when called from a subdirectory or symlink. */
export async function worktreePath(dir: string): Promise<string> {
  return fs.realpathSync((await git(dir, ['rev-parse', '--show-toplevel'])).trim())
}

export async function readChoice(dir: string): Promise<RoomChoice | undefined> {
  try {
    const file = await choiceFile(dir)
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as RoomChoice & { tag?: string }
    if (!c || typeof c.where !== 'string') return undefined
    const { tag, ...choice } = c
    if (typeof tag === 'string') {
      const main = fs.realpathSync(path.dirname(path.dirname(file)))
      choice.tags = { [main]: tag, ...choice.tags }
    }
    return choice
  } catch { return undefined }
}

export async function writeChoice(dir: string, where: string, by?: string, share?: ShareLevel, room?: string): Promise<RoomChoice> {
  where = where.replace(/\?.*$/, '') // never remember a token; it comes from ROOM_SERVER/ROOM_TOKEN at join time
  const prev = await readChoice(dir)
  const same = prev?.where === where
  const rememberedShare = share ?? (same ? prev?.share : undefined)
  const c: RoomChoice = { where, at: Date.now(), ...(by ? { by } : {}), ...(rememberedShare ? { share: rememberedShare } : {}), ...(where === LOCAL && room ? { room } : {}), ...(prev?.tags ? { tags: prev.tags } : {}), ...(same && prev.warned?.length ? { warned: prev.warned } : {}), ...(same && prev.warnedLevels ? { warnedLevels: prev.warnedLevels } : {}) }
  const file = await choiceFile(dir)
  fs.writeFileSync(file, JSON.stringify(c) + '\n', { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* best effort */ }
  return c
}

/** Remember a live human sharing choice without changing the clone's destination. */
export async function rememberShare(dir: string, share: ShareLevel): Promise<RoomChoice> {
  const prev = await readChoice(dir) ?? { where: LOCAL, at: Date.now() }
  const c: RoomChoice = { ...prev, share, at: Date.now() }
  const file = await choiceFile(dir)
  fs.writeFileSync(file, JSON.stringify(c) + '\n', { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* best effort */ }
  return c
}

/** Remember an automatically assigned identity without changing this clone's room choice. */
export async function rememberTag(dir: string, tag: string): Promise<RoomChoice> {
  const file = await choiceFile(dir)
  const lock = `${file}.lock`
  const deadline = Date.now() + 5000
  let release: (() => void) | undefined
  while (!release) {
    release = acquireOwnedFile(lock, { pid: process.pid })
    if (release) break
    if (Date.now() >= deadline) throw new Error('timed out waiting to remember Room name')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try {
    const prev = await readChoice(dir)
    const key = await worktreePath(dir)
    const c: RoomChoice = { ...(prev ?? { where: LOCAL, at: Date.now() }), tags: { ...prev?.tags, [key]: tag } }
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    try { fs.writeFileSync(temp, JSON.stringify(c) + '\n', { mode: 0o600 }); fs.renameSync(temp, file) }
    finally { fs.rmSync(temp, { force: true }) }
    return c
  } finally {
    release()
  }
}

/** Has this worktree been told its uncommitted work is visible to the team? Marks it told and says whether it was new. */
export async function markWarned(dir: string, worktree: string, destination?: string, share?: ShareLevel): Promise<boolean> {
  const c = await readChoice(dir) ?? { where: LOCAL, at: Date.now() }
  const key = path.resolve(worktree) + (destination ? '#' + destination : '')
  const warned = c.warned ?? []
  const previous = c.warnedLevels?.[key]
  const rank = (level: ShareLevel) => level === 'intent' ? 0 : level === 'declared' ? 1 : 2
  const tell = share === undefined ? !warned.includes(key) : previous ? rank(share) > rank(previous) : !warned.includes(key)
  if (!tell && share === undefined) return false
  const next = { ...c, warned: [...warned.filter(k => k !== key), key].slice(-50), ...(share ? { warnedLevels: { ...c.warnedLevels, [key]: share } } : {}) }
  try { const file = await choiceFile(dir); fs.writeFileSync(file, JSON.stringify(next) + '\n', { mode: 0o600 }); fs.chmodSync(file, 0o600) } catch { /* best effort */ }
  return tell
}

export async function clearChoice(dir: string): Promise<boolean> {
  try { fs.rmSync(await choiceFile(dir)); return true } catch { return false }
}

/** One word for humans: "local" or "team", else the URL. */
export function describeWhere(server: string): string {
  if (server === LOCAL) return 'local (this machine)'
  if (server === DEFAULT_SERVER) return `team (${DEFAULT_SERVER})`
  return `team (${server})`
}
